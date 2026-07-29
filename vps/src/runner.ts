// Expand UV threadpool BEFORE any dns.lookup() or I/O calls.
// Default is 4 threads — far too few when running 250+ concurrent checks.
// c-ares (dns-cache.ts) bypasses the threadpool for DNS, but other I/O
// (TLS handshakes, file ops) still uses it.
// NOTE: Under PM2, ecosystem.config.cjs sets this to 128 via env before Node
// starts, so libuv uses that value. This line is a fallback for npm start/dev.
process.env.UV_THREADPOOL_SIZE ??= '128';

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';

// Load .env BEFORE any shared module imports.
// GOOGLE_APPLICATION_CREDENTIALS must be in process.env before init.ts calls
// applicationDefault(), and all API secrets (Clerk, Resend, Twilio) must be
// available before defineSecret().value() reads from process.env.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

// Now import shared modules. init.ts will call applicationDefault() which
// picks up GOOGLE_APPLICATION_CREDENTIALS from the .env we just loaded.
// All modules resolve from functions/node_modules/ — the VPS has no
// firebase-admin of its own, avoiding dual-instance issues.
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { processOneCheck } = await import('../../functions/lib/checks.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { checkRestEndpoint, checkTcpEndpoint, checkUdpEndpoint, checkPingEndpoint, checkWebSocketEndpoint, checkDnsEndpoint } = await import('../../functions/lib/check-utils.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { firestore, getUserTier, auth } = await import('../../functions/lib/init.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { setStatusUpdateHook, initializeStatusFlush, flushStatusUpdates, statusUpdateBuffer, markShuttingDown: markStatusBufferShuttingDown, setHeartbeatDeferEnabled, flushDeferredHeartbeats, getHeartbeatDeferStats } = await import('../../functions/lib/status-buffer.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { insertCheckHistory, flushBigQueryInserts, markShuttingDown: markBigQueryShuttingDown, getBigQueryInsertBufferSize } = await import('../../functions/lib/bigquery.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { drainQueuedWebhookRetries, enableDeferredBudgetWrites, flushDeferredBudgetWrites, fetchAlertSettingsFromFirestore } = await import('../../functions/lib/alert.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { invalidatePeerSettingsCache, peekPeerSettings } = await import('../../functions/lib/peer-settings.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { getPeerCircuitSnapshot } = await import('../../functions/lib/peer-confirm.js');
import { CheckSchedule } from './check-schedule.js';
import { attachWsServer, broadcastState, broadcastUpdate, getDeepWsStats, getWsStats } from './ws-server.js';
import { LIVE_FIELD_NAMES, type ChartPoint, type CheckStateKind, type LiveCheck, type LiveFields, type StateSegment } from './ws-protocol.js';
import { CheckTimeseries } from './check-timeseries.js';
import { CheckTimeseriesStore } from './check-timeseries-store.js';
import { CheckState } from './check-state.js';
import { CheckStateStore } from './check-state-store.js';

// Region ID is read from env so the same runner code can run on multiple
// VPSes (Frankfurt, Boston, …). Defaults to vps-eu-1 to preserve existing
// Frankfurt behavior if the env var is unset. Must match a value in the
// CheckRegion union (functions/src/check-region.ts) — invalid values fail
// fast at startup rather than silently subscribing to a region with no
// checks (which would be catastrophic for Frankfurt).
const VALID_VPS_REGIONS = ['vps-eu-1', 'vps-us-1'] as const;
type VpsRegion = typeof VALID_VPS_REGIONS[number];
const envRegion = process.env.VPS_REGION_ID || 'vps-eu-1';
if (!VALID_VPS_REGIONS.includes(envRegion as VpsRegion)) {
  console.error(`[FATAL] VPS_REGION_ID=${envRegion} is not a valid region. Must be one of: ${VALID_VPS_REGIONS.join(', ')}`);
  process.exit(1);
}
const REGION = envRegion as VpsRegion;
const DISPATCH_INTERVAL_MS = 500; // Dispatcher tick: 500ms
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CHECKS_OVERRIDE) || 200;

// ── Concurrency ramp ──────────────────────────────────────────────────
// When the dispatcher resumes (process start OR deploy_mode lifting), it
// otherwise jumps from 0 to MAX_CONCURRENT instantly. With 250+ checks
// hitting the local DNS resolver simultaneously, c-ares saturates and
// healthy targets time out at 30s, producing false DOWN alerts. Ramp the
// effective cap up over ~90s so the resolver has time to keep up.
let dispatcherResumeAt = Date.now();
const DISPATCHER_RAMP_STAGES: { untilMs: number; max: number }[] = [
  { untilMs: 30_000, max: 25 },
  { untilMs: 90_000, max: 100 },
];

function getEffectiveConcurrency(): number {
  const elapsed = Date.now() - dispatcherResumeAt;
  for (const stage of DISPATCHER_RAMP_STAGES) {
    if (elapsed < stage.untilMs) return Math.min(stage.max, MAX_CONCURRENT);
  }
  return MAX_CONCURRENT;
}

// ── Semaphore for concurrency control ──────────────────────────────────
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(max: number) { this.permits = max; }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next(); // transfer permit directly — no increment needed
    } else {
      this.permits++;
    }
  }

  get available(): number { return this.permits; }
  get queued(): number { return this.waiting.length; }
}

// ── Manual Check HTTP API ──
// Firebase Cloud Functions proxy manual check requests here so the network
// request originates from the VPS static IP (allowlistable by users).
const VPS_CHECK_SECRET = process.env.VPS_MANUAL_CHECK_SECRET;
const HTTP_PORT = Number(process.env.VPS_HTTP_PORT) || 3100;

type CheckType = 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect' | 'dns' | 'heartbeat';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — a check payload is < 10 KB
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30;           // max requests per window
const rateLimitHits: number[] = [];

// Peer-confirm has a separate, much higher budget than manual-check. A
// correlated outage can cause every failing probe to fan out a peer call;
// the ceiling is set high so peer-confirm doesn't degrade precisely when
// it's most needed. The 429-counter on /health tells us if we're approaching
// the cap so we can tune.
const PEER_CONFIRM_RATE_LIMIT_MAX = 5000;
const peerConfirmRateLimitHits: number[] = [];
let peerConfirmRequests = 0;
let peerConfirmRateLimitedRequests = 0;
let peerConfirmLastError: { message: string; at: number } | null = null;

function isRateLimited(): boolean {
  const now = Date.now();
  // Evict expired entries
  while (rateLimitHits.length > 0 && rateLimitHits[0] <= now - RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.shift();
  }
  if (rateLimitHits.length >= RATE_LIMIT_MAX) return true;
  rateLimitHits.push(now);
  return false;
}

function isPeerConfirmRateLimited(): boolean {
  const now = Date.now();
  while (peerConfirmRateLimitHits.length > 0 && peerConfirmRateLimitHits[0] <= now - RATE_LIMIT_WINDOW_MS) {
    peerConfirmRateLimitHits.shift();
  }
  if (peerConfirmRateLimitHits.length >= PEER_CONFIRM_RATE_LIMIT_MAX) return true;
  peerConfirmRateLimitHits.push(now);
  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isAuthorized(header: string | undefined): boolean {
  if (!VPS_CHECK_SECRET || !header) return false;
  const expectedBuf = Buffer.from(`Bearer ${VPS_CHECK_SECRET}`);
  const actualBuf = Buffer.from(header);
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

async function handleManualCheck(req: IncomingMessage, res: ServerResponse) {
  if (!isAuthorized(req.headers.authorization)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (isRateLimited()) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  try {
    const body = await readBody(req);
    const { website, checkType } = JSON.parse(body) as { website: Record<string, unknown>; checkType: CheckType };

    const result =
      checkType === 'dns' ? await checkDnsEndpoint(website)
      : checkType === 'tcp' ? await checkTcpEndpoint(website)
      : checkType === 'udp' ? await checkUdpEndpoint(website)
      : checkType === 'ping' ? await checkPingEndpoint(website)
      : checkType === 'websocket' ? await checkWebSocketEndpoint(website)
      : checkType === 'heartbeat' ? evaluateHeartbeatManualCheck(website)
      : await checkRestEndpoint(website);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[ManualCheck] Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
  }
}

// ── Peer Confirm HTTP API ──
// Multi-region Phase 2: when the primary VPS observes a failure, it asks
// the peer VPS to probe the same target. Read-only on Firestore/BigQuery
// (no writes, no alerts, no processOneCheck). The primary makes the
// suppress/commit decision from this response.
//
// IMPORTANT: this endpoint must apply the exact same offline-classification
// logic as processOneCheck — otherwise asymmetric validation produces
// silent false negatives where the peer says "online" only because it
// skipped a filter the primary applied. Today that's the responseTimeLimit
// flip from checks.ts. If a future post-dispatch filter is added in
// processOneCheck, it MUST be mirrored here.
async function handlePeerConfirm(req: IncomingMessage, res: ServerResponse) {
  if (!isAuthorized(req.headers.authorization)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (isPeerConfirmRateLimited()) {
    peerConfirmRateLimitedRequests++;
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  peerConfirmRequests++;

  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as {
      checkId?: string;
      website: Record<string, unknown>;
      checkType: CheckType;
      originRegion?: string;
    };
    const { website, checkType, originRegion } = parsed;

    // Heartbeat is structurally inverted (we receive the ping, can't probe
    // it from another region). Primary should never call us for one — this
    // 503 is defense-in-depth.
    if (checkType === 'heartbeat') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_supported', reason: 'heartbeat checks cannot be peer-confirmed' }));
      return;
    }

    if (originRegion) {
      console.debug(`[PeerConfirm] from ${originRegion} for ${parsed.checkId ?? '<no-id>'} type=${checkType}`);
    }

    const result = await (
      checkType === 'dns' ? checkDnsEndpoint(website)
      : checkType === 'tcp' ? checkTcpEndpoint(website)
      : checkType === 'udp' ? checkUdpEndpoint(website)
      : checkType === 'ping' ? checkPingEndpoint(website)
      : checkType === 'websocket' ? checkWebSocketEndpoint(website)
      : checkRestEndpoint(website)
    ) as {
      status: 'online' | 'offline';
      responseTime: number;
      statusCode?: number;
      error?: string;
    };

    // Mirror the responseTimeLimit flip from processOneCheck
    // (checks.ts:1303-1314). The dispatcher returns "online" for any
    // 2xx-or-expected response; the primary then flips it to offline if
    // it exceeded the user's response-time SLA. Without this mirror, the
    // peer would falsely disagree on slow-but-reachable targets.
    const responseTimeLimitMs =
      typeof website.responseTimeLimit === 'number' ? website.responseTimeLimit : undefined;
    if (
      result.status === 'online' &&
      typeof responseTimeLimitMs === 'number' &&
      responseTimeLimitMs > 0 &&
      result.responseTime > responseTimeLimitMs
    ) {
      result.status = 'offline';
      result.error = `Response time ${result.responseTime}ms exceeded limit of ${responseTimeLimitMs}ms`;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      region: REGION,
      status: result.status,
      responseTime: result.responseTime,
      statusCode: typeof result.statusCode === 'number' ? result.statusCode : null,
      checkedAt: Date.now(),
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    peerConfirmLastError = { message: msg.slice(0, 200), at: Date.now() };
    console.error('[PeerConfirm] Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

// ── Heartbeat Ping Handler ─────────────────────────────────────────────
async function handleHeartbeatPing(req: IncomingMessage, res: ServerResponse) {
  const token = req.url!.slice('/heartbeat/'.length);
  if (!token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const checkId = heartbeatTokenIndex.get(token);
  if (!checkId) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  // Parse optional JSON body for POST requests
  let metadata: { status?: string; duration?: number; message?: string } | null = null;
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (body.trim()) {
        const parsed = JSON.parse(body);
        metadata = {
          ...(typeof parsed.status === 'string' ? { status: parsed.status.slice(0, 200) } : {}),
          ...(typeof parsed.duration === 'number' ? { duration: parsed.duration } : {}),
          ...(typeof parsed.message === 'string' ? { message: parsed.message.slice(0, 1000) } : {}),
        };
      }
    } catch {
      // Invalid JSON body — ignore, still record the ping
    }
  }

  const pingAt = Date.now();
  heartbeatPingState.set(checkId, { lastPingAt: pingAt, metadata });

  // Throttle steady-state doc writes: skip when the last committed write is
  // recent and the ping carries no status change. In-memory state above is
  // always fresh — only the Firestore mirror is coalesced.
  const lastWritten = heartbeatLastWritten.get(checkId);
  const metadataStatus = metadata?.status ?? null;
  if (
    !lastWritten ||
    metadataStatus !== lastWritten.metadataStatus ||
    pingAt - lastWritten.lastPingAt >= HEARTBEAT_MIN_WRITE_INTERVAL_MS
  ) {
    heartbeatPingPendingWrites.add(checkId);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── Worker Pool State ──────────────────────────────────────────────────
const sem = new Semaphore(MAX_CONCURRENT);
const inFlight = new Set<string>(); // prevents double-runs of same check
// Checks whose processOneCheck invocation is still running (checkId -> task).
// The status hook deliberately releases a check from inFlight as
// soon as nextCheckAt is known (so a buffer-flush stall can't block
// rescheduling), but some code paths write an immediate nextCheckAt
// mid-invocation and keep working — e.g. maintenance auto-expiry (checks.ts)
// writes nextCheckAt=now and then falls through to probe. Without this second
// guard the dispatcher would start a concurrent run of the same check within
// one tick: duplicate history rows and racing alert state. Cleared in the
// worker's finally; the watchdog tick evicts entries stuck past
// EXECUTING_STUCK_MS so one wedged invocation can't silently unmonitor a
// check until restart.
//
// The value is a task record rather than a bare timestamp so that the slot it
// owns (semaphore permit + inFlight entry) can be reclaimed exactly once, by
// whichever of the worker or the watchdog gets there first. See releaseSlot().
interface WorkerTask {
  id: string;
  start: number;
  /** Set by releaseSlot() — the permit and inFlight entry are already returned. */
  released: boolean;
  /** Aborted when the invocation exceeds CHECK_INVOCATION_TIMEOUT_MS. */
  controller: AbortController;
}
const executing = new Map<string, WorkerTask>();

// Return a task's pool resources exactly once.
//
// Both the worker's finally and the watchdog's stuck-entry eviction call this.
// Before 2026-07-28 the eviction path only dropped the `executing` entry, which
// left the semaphore permit and the inFlight guard leaked forever — 249 of 250
// permits drained that way and wedged the Frankfurt pool with a healthy event
// loop and a silent watchdog. Reclaiming here is what makes eviction real.
//
// Returns true if this call performed the release (i.e. the caller owns the
// completion), false if the slot had already been reclaimed. A late-settling
// zombie gets false and must not then double-release the permit or record its
// bogus multi-minute duration as throughput.
function releaseSlot(task: WorkerTask): boolean {
  if (task.released) return false;
  task.released = true;
  sem.release();
  inFlight.delete(task.id);
  // Owner-checked: if this task was evicted and a newer run re-registered under
  // the same id, the newer run owns the guard and must keep it.
  if (executing.get(task.id) === task) executing.delete(task.id);
  return true;
}
const schedule = new CheckSchedule();
// Phase 1 of live-charts.md: in-memory 24h response-time history per check.
// Appended to from the status-buffer hook on every probe completion.
const timeseries = new CheckTimeseries();
// Phase 2: append-on-write NDJSON store so chart history survives deploys
// and clean restarts. Initialized later (before attachWsServer) once the
// data dir is known. Persistence is fail-open — if init can't open the
// dir, append() becomes a no-op and the runner keeps serving in-memory
// charts.
const timeseriesStore = new CheckTimeseriesStore();
// Default to /var/lib/exit1/chart-points on prod (matches the dir the
// systemd / PM2 deploy is expected to pre-create with the runner's user
// as owner). Override via env for dev / non-Linux boxes.
const CHART_POINTS_DIR = process.env.CHART_POINTS_DIR || '/var/lib/exit1/chart-points';

// State-segment store — tracks maintenance/disabled windows per check
// so the live-chart can shade bands for non-running periods. Same
// retention + crash-safety contract as the timeseries store.
const checkState = new CheckState();
const checkStateStore = new CheckStateStore();
const STATE_SEGMENTS_DIR = process.env.STATE_SEGMENTS_DIR || '/var/lib/exit1/state-segments';

// ── Throughput tracking (Phase 3: observability) ───────────────────────
let lastMinuteChecks = 0;
let lastMinuteAvgMs = 0;
let lastMinuteMaxMs = 0;
let thisMinuteChecks = 0;
let thisMinuteTotalMs = 0;
let thisMinuteMaxMs = 0;
setInterval(() => {
  lastMinuteChecks = thisMinuteChecks;
  lastMinuteAvgMs = thisMinuteChecks > 0 ? Math.round(thisMinuteTotalMs / thisMinuteChecks) : 0;
  lastMinuteMaxMs = thisMinuteMaxMs;
  thisMinuteChecks = 0;
  thisMinuteTotalMs = 0;
  thisMinuteMaxMs = 0;
}, 60_000);

// ── Liveness watchdog ──────────────────────────────────────────────────
// On 2026-05-24, a wedged gRPC connection to Firestore stopped check
// execution for 13h while PM2 still reported the process as `online`. The
// event loop kept spinning (heartbeat flush retried every ~5s), so PM2's
// crash detection never fired. This watchdog detects "running but not
// working" and exits non-zero so PM2 restarts — which (today) clears any
// stale runtimeLocks doc as a side effect.
//
// We track when the worker pool last completed any check (up/down/error —
// what matters is the pool is moving). If progress stalls AND there's
// queued work AND we aren't in deploy mode AND we're past the boot ramp,
// we exit and let PM2 bring us back fresh.
let lastSuccessfulCheckCompletedAt = Date.now();
const WATCHDOG_STALL_MS = Number(process.env.WATCHDOG_STALL_MS) || 5 * 60 * 1000;
const WATCHDOG_TICK_MS = 30_000;
const WATCHDOG_DUE_THRESHOLD = 50;
const WATCHDOG_RESUME_GRACE_MS = 120_000;
// An executing entry should never outlive its worker by this much. process-
// OneCheck has un-timed awaits (Firestore writes, alert sends) that can wedge
// individually; without eviction a single wedged invocation would pin its
// check out of dispatch forever with no signal. Evicting restores probing —
// worst case a duplicate run if the zombie worker ever settles.
const EXECUTING_STUCK_MS = 10 * 60 * 1000;

// ── Arm 3: real-throughput stall ───────────────────────────────────────
// The arm above keys off lastSuccessfulCheckCompletedAt, which any completion
// nudges — including ones that did no work at all. On 2026-07-28 that was
// enough to keep it silent through a total wedge: 249 of 250 permits were
// leaked, and the single free permit re-dispatched a check that returned early
// from processOneCheck (~1ms, no probe, no write) every 500ms tick, refreshing
// the timestamp forever while real throughput sat at exactly zero.
//
// This arm keys off a signal that early returns cannot forge: the status-buffer
// write counters. Every check that actually completes calls addStatusUpdate,
// which increments writesDeferred or writesImmediate before any I/O — so the
// sum is a monotonic count of genuine completions.
//
// Flat counters alone are not sufficient evidence: a pool with nothing but
// early-returning checks at the head of its schedule is degenerate but not
// wedged, and restarting would just loop. So we additionally require the pool
// to be near-fully occupied for the whole window. A wedge pins occupancy at
// ~100% (permits leaked); a degenerate-but-live pool sits near 0%.
const WATCHDOG_PROGRESS_STALL_MS =
  Number(process.env.WATCHDOG_PROGRESS_STALL_MS) || 5 * 60 * 1000;
// Fraction of the pool that must be continuously occupied to treat flat write
// counters as a wedge. Deliberately below 1.0: the incident held 249/250, so a
// strict "zero permits free" test would have missed it.
const WATCHDOG_SATURATION_RATIO = 0.9;
// Minimum status writes a saturated pool must produce across the window to be
// considered alive. This is a volume test, not a "did the counter move" test:
// the same class of mistake that defeated arm 2 — one trivial event refreshing
// a liveness marker — would otherwise apply here, since a single manual check
// served off the HTTP API also increments these counters. A healthy saturated
// pool writes hundreds per window; a wedged one writes ~0.
// Parsed so that an explicit 0 DISABLES arm 3 rather than falling through to
// the default (`Number(x) || default` would treat 0 as unset). That 0 is the
// ops kill switch: if this arm ever false-positives in prod it can be turned
// off with an env var and a restart, no rebuild, while the older arms keep
// running. Setting it is the correct response to a restart loop.
const WATCHDOG_MIN_PROGRESS_WRITES = (() => {
  const raw = process.env.WATCHDOG_MIN_PROGRESS_WRITES;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return Math.max(10, Math.floor(MAX_CONCURRENT / 10));
})();
let lastProgressCounter = -1;
let lastProgressChangeAt = Date.now();
let poolSaturatedSince = 0;
// Tumbling-window anchors for the write-volume test. Anchoring the window at
// saturation START would go blind on a late wedge: a mass outage can hold the
// pool legitimately saturated for an hour with writes flowing, and if permits
// then leak, a since-saturation-start counter is already far past any
// threshold. Instead the window re-anchors every WATCHDOG_PROGRESS_STALL_MS,
// so each evaluation only sees the writes of its own window. Worst-case
// detection latency is ~2 windows (the wedge lands mid-window and the first
// close doesn't yet see a fully-saturated window).
let progressWindowAnchorAt = Date.now();
let progressAtWindowAnchor = 0;

function readProgressCounter(): number {
  try {
    const s = getHeartbeatDeferStats() as { writesDeferred?: number; writesImmediate?: number };
    return (s.writesDeferred ?? 0) + (s.writesImmediate ?? 0);
  } catch {
    // Never let a stats hiccup take down the watchdog — returning the last
    // known value keeps the timestamp frozen rather than faking progress,
    // and the saturation conjunct still gates any exit.
    return lastProgressCounter;
  }
}

const watchdogTimer = setInterval(() => {
  try {
    // A graceful shutdown legitimately stalls the pool while it drains and
    // flushes — exiting 1 here would discard those flushes.
    if (shuttingDown) return;
    const now = Date.now();
    for (const [id, task] of executing) {
      if (now - task.start > EXECUTING_STUCK_MS) {
        // Reclaim, don't just forget. releaseSlot() returns the semaphore
        // permit and the inFlight guard as well as the executing entry; the
        // worker's finally is idempotent against this, so a zombie that
        // settles later cannot double-release.
        const reclaimed = releaseSlot(task);
        console.warn(
          `[watchdog] check ${id} stuck in executing for ${Math.round((now - task.start) / 1000)}s — ` +
          `${reclaimed ? 'reclaimed its permit and re-armed dispatch' : 'slot already reclaimed'}`
        );
        // Abort so the hung invocation stops doing further work and cannot
        // write a stale status update if it ever settles.
        try { task.controller.abort(); } catch { /* ignore */ }
      }
    }

    const dueNow = schedule.getStats().dueNow;

    // Track real-throughput progress and pool occupancy every tick, whether or
    // not we go on to evaluate an exit.
    const progress = readProgressCounter();
    if (progress !== lastProgressCounter) {
      lastProgressCounter = progress;
      lastProgressChangeAt = now;
    }
    const occupied = MAX_CONCURRENT - sem.available;
    if (occupied >= MAX_CONCURRENT * WATCHDOG_SATURATION_RATIO) {
      if (poolSaturatedSince === 0) poolSaturatedSince = now;
    } else {
      poolSaturatedSince = 0;
    }
    // Close the current window if it has run its course. Capture the verdict
    // before re-anchoring, and re-anchor regardless of suppression below — a
    // suppressed tick must not stretch the next window's span.
    let windowVerdict: { writes: number; saturatedWholeWindow: boolean } | null = null;
    if (now - progressWindowAnchorAt >= WATCHDOG_PROGRESS_STALL_MS) {
      windowVerdict = {
        writes: progress - progressAtWindowAnchor,
        // Saturation must predate the window: a pool that saturated mid-window
        // had free permits for part of it, so low volume proves nothing yet.
        saturatedWholeWindow:
          poolSaturatedSince !== 0 && poolSaturatedSince <= progressWindowAnchorAt,
      };
      progressWindowAnchorAt = now;
      progressAtWindowAnchor = progress;
    }

    // Shared suppressions for both exit arms.
    const suppressed =
      dueNow <= WATCHDOG_DUE_THRESHOLD ||
      // Don't fight deploy mode — it legitimately pauses dispatch. But only
      // trust the latch while its cache is actually refreshing: the deploy-
      // mode read re-runs every 30s, so an active flag with no refresh for
      // over 3 minutes means dispatch() is wedged inside that read — the
      // exact zombie this watchdog exists to kill.
      (deployModeActive && now - deployModeLastChecked < DEPLOY_MODE_CACHE_MS * 6) ||
      // Boot/warmup grace: don't kill ourselves before the first checks
      // have had time to complete after a fresh resume.
      now - dispatcherResumeAt < WATCHDOG_RESUME_GRACE_MS;
    if (suppressed) return;

    // Arm 3 — a pool that was pinned for an entire window while producing
    // essentially no status writes is wedged, whatever the liveness timestamp
    // says. Disabled entirely when the threshold is set to 0 (ops kill switch).
    if (
      WATCHDOG_MIN_PROGRESS_WRITES > 0 &&
      windowVerdict &&
      windowVerdict.saturatedWholeWindow &&
      windowVerdict.writes < WATCHDOG_MIN_PROGRESS_WRITES
    ) {
      console.error(
        `[watchdog] worker pool wedged — ${windowVerdict.writes} status writes ` +
        `(<${WATCHDOG_MIN_PROGRESS_WRITES}) in ${Math.round(WATCHDOG_PROGRESS_STALL_MS / 1000)}s ` +
        `with ${occupied}/${MAX_CONCURRENT} permits held since ` +
        `${Math.round((now - poolSaturatedSince) / 1000)}s ago and ${dueNow} due — exiting for restart`
      );
      process.exit(1);
    }

    // Arm 2 — no completions at all. Kept for wedges that leave the pool idle
    // rather than saturated, which arm 3 deliberately ignores.
    const stallMs = now - lastSuccessfulCheckCompletedAt;
    if (stallMs <= WATCHDOG_STALL_MS) return;
    console.error(
      `[watchdog] no progress for ${Math.round(stallMs / 1000)}s with ${dueNow} due — exiting for restart`
    );
    // Skip the graceful shutdown path on purpose: that path awaits
    // pending Firestore writes, which is exactly what's wedged.
    process.exit(1);
  } catch (err) {
    // Watchdog must never silently die. Log and let the next tick try
    // again — Date.now() doesn't throw, but schedule.getStats() could
    // trip on an unexpected internal state.
    console.warn('[watchdog] tick failed:', err);
  }
}, WATCHDOG_TICK_MS);

// ── Event-loop lag (rolling 1-min p99) ─────────────────────────────────
// Surfaces dispatcher saturation before WS broadcast load lands in Phase 3.
// monitorEventLoopDelay reports in nanoseconds; we expose ms with 1-decimal
// precision. The histogram is reset every minute so /health reflects the
// previous minute's tail latency, not lifetime accumulation.
const eldHistogram = monitorEventLoopDelay({ resolution: 10 });
eldHistogram.enable();
let lastMinuteEldP99Ns = 0;
let lastMinuteEldMeanNs = 0;
let lastMinuteEldMaxNs = 0;
setInterval(() => {
  lastMinuteEldP99Ns = eldHistogram.percentile(99);
  lastMinuteEldMeanNs = eldHistogram.mean;
  lastMinuteEldMaxNs = eldHistogram.max;
  eldHistogram.reset();
}, 60_000);

function nsToMs1dp(ns: number): number {
  if (!Number.isFinite(ns) || ns <= 0) return 0;
  return Math.round(ns / 100_000) / 10;
}

// ── Shared ProcessOneCheck context ─────────────────────────────────────
// Caches live for the process lifetime. TTL-based eviction prevents
// unbounded growth. getUserTier is memoized per-user with 5-min TTL.

// Both per-user caches below memoize the in-flight PROMISE, not the resolved
// value, so concurrent probes for the same user share one Firestore read. That
// is a real win — and it was the amplifier in the 2026-07-28 wedge.
//
// Each cache evicts on rejection, but a promise that NEVER SETTLES is neither
// resolved nor rejected: it stays in the map, and every subsequent check owned
// by that user awaits the same dead promise and parks its worker. One hung
// gRPC read became hundreds of hung workers. Worse, on TTL expiry a fresh read
// starts and re-poisons the entry.
//
// Bounding the read closes it: a wedged channel now poisons a user for at most
// the timeout, then rejects, evicts, and the next probe retries. Without this,
// bounding processOneCheck alone would only convert a permanent wedge into
// every affected check burning a full invocation timeout.
const USER_READ_TIMEOUT_MS = Number(process.env.USER_READ_TIMEOUT_MS) || 15_000;

const TIER_CACHE_TTL_MS = 5 * 60 * 1000;
// getUserTier fails open to 'free' on any Firestore/Clerk error, so a 'free'
// result may be a transient blip rather than the user's real tier — and
// processOneCheck persists it onto the check doc. Cache 'free' for a shorter
// window so a paying user isn't pinned to free-tier behavior for 5 minutes.
const TIER_FREE_TTL_MS = 2 * 60 * 1000;
const tierCache = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

function getEffectiveTierForUser(uid: string): Promise<unknown> {
  const cached = tierCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const raw = withTimeout(getUserTier(uid), USER_READ_TIMEOUT_MS, `getUserTier(${uid})`);
  // getUserTier's contract is fail-open — 'free' on any Firestore/Clerk
  // error — and the timeout must honor it, not break it. The tier lookup runs
  // AFTER a successful probe (checks.ts, denormalised-tier fallthrough), so a
  // rejection here would land in processOneCheck's catch and record a false
  // check failure for an endpoint that just answered fine. Serve 'free' to
  // whoever is already waiting; the rejection handler below still evicts the
  // entry so the next probe retries the real read.
  const p = raw.catch(() => 'free' as unknown);
  const entry = { value: p, expiresAt: Date.now() + TIER_CACHE_TTL_MS };
  tierCache.set(uid, entry);
  raw.then(
    (tier: unknown) => {
      if (tier === 'free' && tierCache.get(uid) === entry) {
        entry.expiresAt = Math.min(entry.expiresAt, Date.now() + TIER_FREE_TTL_MS);
      }
    },
    // Timeout (or a future rejecting getUserTier): a memoized dead read must
    // not poison every probe of this user until the TTL.
    () => {
      if (tierCache.get(uid) === entry) tierCache.delete(uid);
    },
  );
  return p;
}

const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;
const settingsCache = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

function getUserSettings(uid: string): Promise<unknown> {
  const cached = settingsCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const p = withTimeout(
    fetchAlertSettingsFromFirestore(uid), USER_READ_TIMEOUT_MS, `alertSettings(${uid})`,
  );
  const entry = { value: p, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  settingsCache.set(uid, entry);
  // fetchAlertSettingsFromFirestore has no internal catch — one transient
  // Firestore error would otherwise be memoized for the full TTL, making
  // processOneCheck throw (post-probe, pre-hook) for every check this user
  // owns: no alert evaluation AND no nextCheckAt advance, so the dispatcher
  // hot-loops the probe. Evict on rejection so the next call retries. The
  // timeout above routes a hung read into this same eviction path.
  p.catch(() => {
    if (settingsCache.get(uid) === entry) settingsCache.delete(uid);
  });
  return p;
}

// Throttle and budget caches — cleared periodically to prevent unbounded growth
const throttleCache = new Set<string>();
const budgetCache = new Map<string, number>();
const emailMonthlyBudgetCache = new Map<string, number>();
const smsThrottleCache = new Set<string>();
const smsBudgetCache = new Map<string, number>();
const smsMonthlyBudgetCache = new Map<string, number>();

// ── Heartbeat in-memory state ────────────────────────────────────────────
// tokenIndex: maps heartbeat token -> checkId (populated on boot + check_edits)
// pingState: maps checkId -> last ping timestamp + optional metadata
// pendingWrites: checkIds with unflushed Firestore writes (coalesced on the flush tick)
// lastWritten: per-check snapshot of the last committed Firestore write, used
//   to throttle steady-state ping writes (firestore-write-reduction.md Tier 1c)
const heartbeatTokenIndex = new Map<string, string>();
const heartbeatPingState = new Map<string, { lastPingAt: number; metadata: { status?: string; duration?: number; message?: string } | null }>();
const heartbeatPingPendingWrites = new Set<string>();
const heartbeatLastWritten = new Map<string, { lastPingAt: number; metadataStatus: string | null }>();
const HEARTBEAT_WRITE_FLUSH_MS = 5_000;
// Cap on steady-state lastPingAt write frequency per check. Pings landing
// inside this window only update in-memory state (which the evaluator and
// manual checks read); the Firestore doc catches up on the next ping outside
// the window. This caps write amplification from fast pingers (a 10s cron
// loop — or an abusive one — otherwise lands a doc write every 5s flush
// tick). 60s keeps doc staleness far below the minimum useful checkFrequency
// (1 min), so restart hydration (which seeds pingState from the doc) can't
// inflate the evaluator's elapsed-time math enough to cause a false DOWN.
// A metadata.status change bypasses the throttle — it's the only ping field
// that signals a state change rather than recency.
const HEARTBEAT_MIN_WRITE_INTERVAL_MS = 60_000;

async function flushHeartbeatWrites(): Promise<void> {
  if (heartbeatPingPendingWrites.size === 0) return;
  const pending = Array.from(heartbeatPingPendingWrites);
  heartbeatPingPendingWrites.clear();

  const batch = firestore.batch();
  const written: Array<{ checkId: string; lastPingAt: number; metadataStatus: string | null }> = [];
  for (const checkId of pending) {
    const state = heartbeatPingState.get(checkId);
    if (!state) continue;
    const ref = firestore.collection('checks').doc(checkId);
    batch.update(ref, {
      lastPingAt: state.lastPingAt,
      lastPingMetadata: state.metadata,
    });
    written.push({ checkId, lastPingAt: state.lastPingAt, metadataStatus: state.metadata?.status ?? null });
  }
  if (written.length === 0) return;

  try {
    await batch.commit();
    // Record committed values so the ping handler can throttle steady-state
    // writes against what's actually durable (not what was merely attempted).
    for (const w of written) {
      heartbeatLastWritten.set(w.checkId, { lastPingAt: w.lastPingAt, metadataStatus: w.metadataStatus });
    }
  } catch (err) {
    // Re-queue for retry. Individual doc failures (e.g. deleted check)
    // will keep erroring, but removal callback clears pending entries, so
    // this self-heals on the next edit notification.
    for (const id of pending) heartbeatPingPendingWrites.add(id);
    console.warn('[Heartbeat] Failed to flush ping writes:', err);
  }
}

// Manual "Check Now" evaluator for heartbeat checks. The scheduled path
// evaluates heartbeats via processOneCheck (checks.ts), but manual checks
// go through handleManualCheck which normally dispatches to an outbound
// network probe — meaningless for a heartbeat. We evaluate lastPingAt
// against the configured frequency, preferring the in-memory state (which
// may be up to HEARTBEAT_WRITE_FLUSH_MS fresher than Firestore).
function evaluateHeartbeatManualCheck(website: Record<string, unknown>) {
  const checkId = typeof website.id === 'string' ? website.id : '';
  const memState = checkId ? heartbeatPingState.get(checkId) : undefined;
  const docLastPingAt = typeof website.lastPingAt === 'number' ? website.lastPingAt : null;
  const lastPingAt = memState?.lastPingAt ?? docLastPingAt;
  const freqMinutes = typeof website.checkFrequency === 'number' ? website.checkFrequency : 60;
  const checkFreqMs = freqMinutes * 60 * 1000;

  if (lastPingAt == null) {
    return {
      status: 'offline' as const,
      detailedStatus: 'DOWN' as const,
      responseTime: 0,
      statusCode: 0,
      error: 'No heartbeat ping received yet',
    };
  }

  const elapsed = Date.now() - lastPingAt;
  if (elapsed <= checkFreqMs) {
    return {
      status: 'online' as const,
      detailedStatus: 'UP' as const,
      responseTime: 0,
      statusCode: 0,
    };
  }
  return {
    status: 'offline' as const,
    detailedStatus: 'DOWN' as const,
    responseTime: 0,
    statusCode: 0,
    error: `No heartbeat ping received in ${Math.round(elapsed / 1000)}s (expected every ${Math.round(checkFreqMs / 1000)}s)`,
  };
}

// Clear throttle/budget caches every 10 minutes
setInterval(() => {
  throttleCache.clear();
  budgetCache.clear();
  emailMonthlyBudgetCache.clear();
  smsThrottleCache.clear();
  smsBudgetCache.clear();
  smsMonthlyBudgetCache.clear();
  // Also evict expired tier/settings cache entries
  const now = Date.now();
  for (const [k, v] of tierCache) { if (v.expiresAt <= now) tierCache.delete(k); }
  for (const [k, v] of settingsCache) { if (v.expiresAt <= now) settingsCache.delete(k); }
}, 10 * 60 * 1000);

// ProcessOneCheckContext is exported from functions/src/checks.ts but we import
// from compiled JS without .d.ts. Type is structurally matched at the source level.
// `deployModeDisabledAt` is mutated by checkDeployMode() whenever the cached
// state refreshes, so processOneCheck always reads the current value.
const checkCtx: Record<string, unknown> = {
  getEffectiveTierForUser,
  getUserSettings,
  enqueueHistoryRecord: (record: unknown) => insertCheckHistory(record).catch((err: unknown) => {
    console.error('Failed to enqueue history record:', err);
  }),
  throttleCache,
  budgetCache,
  emailMonthlyBudgetCache,
  smsThrottleCache,
  smsBudgetCache,
  smsMonthlyBudgetCache,
  region: REGION,
  deployModeDisabledAt: 0,
};

// Per-invocation view of the shared context, carrying the worker's abort
// signal. The signal is armed when the invocation exceeds
// CHECK_INVOCATION_TIMEOUT_MS (or when the watchdog evicts a stuck worker).
//
// Note on scope: the Firestore Node SDK does not accept an AbortSignal on
// get()/set(), so an in-flight gRPC call cannot actually be cancelled. What the
// signal buys is that an abandoned invocation stops initiating NEW work — no
// further settings/tier reads, no BigQuery insert — and, via the guard in
// checks.ts, no stale status write landing minutes after the worker gave up
// and rescheduled the check. Bounding the individual reads (see
// USER_READ_TIMEOUT_MS above) is what keeps a wedged channel from parking the
// calls in the first place.
//
// The spread snapshots deployModeDisabledAt at dispatch time rather than
// exposing the live mirror. Safe because checkDeployMode() updates that mirror
// before dispatch() proceeds within the same tick, and no checks are dispatched
// while deploy mode is active — so a snapshot taken here is always the
// post-lift value, and it stays consistent for the whole invocation.
function buildCheckCtx(signal: AbortSignal): Record<string, unknown> {
  return {
    ...checkCtx,
    signal,
    getEffectiveTierForUser: (uid: string) => {
      if (signal.aborted) return Promise.reject(new Error('check invocation aborted'));
      return getEffectiveTierForUser(uid);
    },
    getUserSettings: (uid: string) => {
      if (signal.aborted) return Promise.reject(new Error('check invocation aborted'));
      return getUserSettings(uid);
    },
    enqueueHistoryRecord: (record: unknown) => {
      // Dropping the row is the right call here: the worker has already
      // rescheduled this check, so a fresh probe will produce a current row
      // shortly. Writing the abandoned one risks out-of-order history.
      if (signal.aborted) return Promise.resolve();
      return insertCheckHistory(record).catch((err: unknown) => {
        console.error('Failed to enqueue history record:', err);
      });
    },
  };
}

// ── Health endpoint ────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const uptime = process.uptime();
    const stats = schedule.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      region: REGION,
      uptimeSeconds: Math.round(uptime),
      workers: {
        maxConcurrency: MAX_CONCURRENT,
        effectiveConcurrency: getEffectiveConcurrency(),
        secondsSinceResume: Math.round((Date.now() - dispatcherResumeAt) / 1000),
        active: MAX_CONCURRENT - sem.available,
        queued: sem.queued,
        inFlight: inFlight.size,
        // processOneCheck invocations still running (inFlight may be
        // early-released by the status hook before the worker finishes).
        executing: executing.size,
      },
      schedule: stats,
      throughput: {
        checksLastMinute: lastMinuteChecks,
        avgResponseTimeMs: lastMinuteAvgMs || null,
        maxResponseTimeMs: lastMinuteMaxMs || null,
      },
      watchdog: {
        secondsSinceProgress: Math.round((Date.now() - lastSuccessfulCheckCompletedAt) / 1000),
        stallThresholdSeconds: Math.round(WATCHDOG_STALL_MS / 1000),
        // Arm 3 — real throughput. secondsSinceProgress above can be nudged by
        // completions that did no work; these two cannot. A wedge shows up as
        // both climbing together.
        secondsSinceStatusWrite: Math.round((Date.now() - lastProgressChangeAt) / 1000),
        secondsSaturated: poolSaturatedSince === 0
          ? 0 : Math.round((Date.now() - poolSaturatedSince) / 1000),
        progressStallThresholdSeconds: Math.round(WATCHDOG_PROGRESS_STALL_MS / 1000),
      },
      caches: {
        tierCacheSize: tierCache.size,
        settingsCacheSize: settingsCache.size,
        throttleCacheSize: throttleCache.size,
      },
      heartbeat: {
        tokensIndexed: heartbeatTokenIndex.size,
        activePings: heartbeatPingState.size,
      },
      peerConfirm: {
        // Incoming requests served by *this* runner.
        requests: peerConfirmRequests,
        rateLimitedRequests: peerConfirmRateLimitedRequests,
        lastError: peerConfirmLastError,
        // Outgoing calls *this* runner makes to its peer. Populated by
        // peer-confirm.ts (Phase 2 Step 3/4).
        outgoingCircuit: getPeerCircuitSnapshot(),
        // Cached feature-flag snapshot. null = haven't read yet.
        settings: peekPeerSettings(),
      },
      // WS server stats (Phase 1: stub handler — accepts then closes after 5s).
      ws: getWsStats(),
      // Phase 7: heartbeat-defer mode + counters so operators can see
      // how many writes are deferred vs. immediate without grepping logs.
      heartbeatDefer: getHeartbeatDeferStats(),
      // Event-loop lag over the last completed minute, in ms. Watch the p99
      // to detect dispatcher saturation before broadcast load lands.
      loopLag: {
        p99Ms: nsToMs1dp(lastMinuteEldP99Ns),
        meanMs: nsToMs1dp(lastMinuteEldMeanNs),
        maxMs: nsToMs1dp(lastMinuteEldMaxNs),
      },
    }));
  } else if (req.method === 'POST' && req.url === '/api/manual-check') {
    handleManualCheck(req, res);
  } else if (req.method === 'POST' && req.url === '/api/peer-confirm') {
    handlePeerConfirm(req, res);
  } else if (req.method === 'GET' && req.url === '/admin/ws-stats') {
    // Bearer-auth deep WS stats: per-user connection counts, broadcast volume,
    // replay buffer depth, IP bucket size. Same secret as /admin/refresh-flags
    // so on-call doesn't need a second credential.
    if (!isAuthorized(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ region: REGION, ...getDeepWsStats() }));
  } else if (req.method === 'POST' && req.url === '/admin/refresh-flags') {
    // Emergency cache-bust for system_settings flags. Used to make a flag
    // change take effect within seconds instead of waiting out the 30s
    // peer-settings TTL — useful for rolling peer-confirmation back during
    // an incident.
    if (!isAuthorized(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    invalidatePeerSettingsCache();
    // Also expire the deploy-mode cache so the next dispatch tick re-reads.
    // Expire by exactly one TTL rather than zeroing the timestamp: the
    // watchdog reads a very stale deployModeLastChecked as "dispatcher
    // wedged inside the deploy-mode read" and would restart mid-pause.
    deployModeLastChecked = Date.now() - DEPLOY_MODE_CACHE_MS;
    console.info('[admin] flags cache invalidated via /admin/refresh-flags');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url?.startsWith('/heartbeat/')) {
    if (req.method === 'GET' || req.method === 'POST') {
      handleHeartbeatPing(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Phase 3: attach the broadcast-enabled WS server. URL is scoped to `/ws`
// inside ws-server.ts so existing HTTP endpoints are untouched. The reverse
// proxy in front of this VPS (Traefik / Caddy) terminates TLS at
// `live-<region>.exit1.dev/ws` and forwards the upgrade here.
//
// verifyIdToken delegates to the singleton firebase-admin Auth instance
// exported from functions/src/init.ts. checkRevoked=false: the cost of an
// extra DB roundtrip per ID-token verify isn't worth it for streaming
// status updates — a compromised refresh token gives an attacker at most
// ~1h of stream access until the next exp, which is acceptable for the
// data sensitivity (live check status, no account changes possible over WS).
//
// getChecksForUser pulls the user's checks out of the in-memory schedule
// and projects them down to just the LIVE_FIELD_NAMES the protocol carries.
// Doing the projection here (not inside ws-server) keeps ws-server unaware
// of the full Website schema.
type VerifiedTokenLike = { uid: string; exp: number };
function toLiveCheck(check: Record<string, unknown> & { id: string }): LiveCheck {
  const live: LiveCheck = { checkId: check.id };
  const liveBag = live as unknown as Record<string, unknown>;
  for (const key of LIVE_FIELD_NAMES) {
    const val = check[key];
    if (val !== undefined) liveBag[key] = val;
  }
  return live;
}
// live-charts.md Phase 2: hydrate the in-memory timeseries from disk
// BEFORE attaching the WS server. If clients reconnect immediately after
// a restart and the buffer is empty, subscribe_history would return [] —
// the chart would render a single live point and ramp up from there.
// Replaying first means the first frame after restart already shows the
// pre-restart context. Failures here are non-fatal: persistence is
// fail-open and the in-memory path keeps working.
await timeseriesStore.init(CHART_POINTS_DIR);
{
  const replayStart = Date.now();
  await timeseriesStore.replay(replayStart, (p) => {
    const point: ChartPoint = { t: p.t, rt: p.rt, st: p.st };
    if (typeof p.sc === 'number') point.sc = p.sc;
    if (typeof p.dn === 'number') point.dn = p.dn;
    if (typeof p.cn === 'number') point.cn = p.cn;
    if (typeof p.tl === 'number') point.tl = p.tl;
    if (typeof p.ft === 'number') point.ft = p.ft;
    timeseries.append(p.c, point);
  });
  const elapsed = Date.now() - replayStart;
  const stats = timeseries.stats();
  console.info(
    `[timeseries] hydrated ${stats.checks} checks / ${stats.totalPoints} points ` +
      `(~${Math.round(stats.approxBytes / 1024 / 1024)} MB) in ${elapsed}ms`
  );
}

// State-segment store — same lifecycle as the timeseries store, just for
// maintenance/disabled windows. Replayed open segments are reconciled
// against current check state after schedule.init() so a restart that
// missed a close-record doesn't leave stale bands extending to "now".
await checkStateStore.init(STATE_SEGMENTS_DIR);
{
  const replayStart = Date.now();
  await checkStateStore.replay(replayStart, (checkId, seg) => {
    checkState.applyReplayed(checkId, seg);
  });
  const elapsed = Date.now() - replayStart;
  const stats = checkState.stats();
  console.info(
    `[state] hydrated ${stats.checks} checks / ${stats.totalSegments} segments ` +
      `(${stats.openSegments} open) in ${elapsed}ms`
  );
}

attachWsServer(server, {
  verifyIdToken: (token: string) =>
    (auth as { verifyIdToken: (t: string, c?: boolean) => Promise<VerifiedTokenLike> })
      .verifyIdToken(token, false),
  getChecksForUser: (userId: string) =>
    (schedule.getChecksForUser(userId) as Array<Record<string, unknown> & { id: string }>)
      .map(toLiveCheck),
  // Ownership-guarded read for the subscribe_history handler. We pass uid
  // so ws-server can verify before we waste a buffer slice on someone
  // else's check.
  userOwnsCheck: (userId: string, checkId: string) =>
    schedule.getCheckOwner(checkId) === userId,
  getTimeseriesWindow: (checkId: string, windowMs: number) =>
    timeseries.window(checkId, windowMs, Date.now()),
  getStateWindow: (checkId: string, windowMs: number) =>
    checkState.window(checkId, windowMs, Date.now()),
  getTimeseriesStats: () => timeseries.stats(),
  // ws-server treats this as an opaque bag and surfaces it verbatim
  // under /admin/ws-stats; the cast widens StoreStats (a closed shape)
  // to the Record signature the option expects.
  getTimeseriesStoreStats: () => timeseriesStore.stats() as unknown as Record<string, unknown>,
  getStateStoreStats: () => checkStateStore.stats() as unknown as Record<string, unknown>,
});

server.listen(HTTP_PORT, () => {
  console.info(`VPS Manual Check API listening on port ${HTTP_PORT}`);
});

// ── Initialize ─────────────────────────────────────────────────────────
console.info(`VPS Worker Pool starting for region: ${REGION}`);
console.info(`Max concurrency: ${MAX_CONCURRENT}, dispatch interval: ${DISPATCH_INTERVAL_MS}ms`);

// Clear any stale lock left by a previous batch-model process
const LOCK_DOC = `checkAllChecks-${REGION}`;
try {
  await firestore.collection('runtimeLocks').doc(LOCK_DOC).delete();
  console.info(`Cleared stale lock: runtimeLocks/${LOCK_DOC}`);
} catch (err) {
  console.warn(`Could not clear stale lock (will expire via TTL):`, err);
}

// One-time Firestore read of all checks for this region, then start
// real-time sync via onSnapshot for user edits.
await schedule.init(REGION, firestore);

// State-segment reconciliation. The NDJSON replay above rebuilt the
// in-memory state, but a segment can be implicitly stale: e.g. the user
// re-enabled a check while the VPS was offline, leaving the on-disk
// record as "still open" forever. Walk the authoritative check snapshot
// here and reconcile each side:
//   - Check is currently disabled/maintenanceMode but no open segment:
//     open one at `disabledAt` / `maintenanceStartedAt`, falling back to
//     `now` if Firestore didn't carry the timestamp.
//   - Check is no longer disabled/maintenanceMode but a stale open
//     segment exists: close it at `now`. We can't recover the actual
//     transition time after a restart gap, but `now` is the upper bound
//     and only one "now" close per check matters in practice.
{
  const recNow = Date.now();
  let opened = 0;
  let closedStale = 0;
  for (const check of schedule.allChecks()) {
    const kinds: Array<{ k: CheckStateKind; on: boolean; at: number | undefined }> = [
      {
        k: 'disabled',
        on: Boolean((check as { disabled?: boolean }).disabled),
        at: (check as { disabledAt?: number | null }).disabledAt ?? undefined,
      },
      {
        k: 'maintenance',
        on: Boolean((check as { maintenanceMode?: boolean }).maintenanceMode),
        at: (check as { maintenanceStartedAt?: number }).maintenanceStartedAt,
      },
    ];
    for (const { k, on, at } of kinds) {
      const isOpen = checkState.isOpen(check.id, k);
      if (on && !isOpen) {
        const seg = checkState.open(check.id, k, typeof at === 'number' ? at : recNow);
        if (seg) {
          checkStateStore.append(check.id, seg);
          opened++;
        }
      } else if (!on && isOpen) {
        const seg = checkState.close(check.id, k, recNow);
        if (seg) {
          checkStateStore.append(check.id, seg);
          closedStale++;
        }
      }
    }
  }
  if (opened > 0 || closedStale > 0) {
    console.info(
      `[state] reconciliation: opened ${opened} segments from current state, ` +
        `closed ${closedStale} stale open segments`
    );
  }
}

// Hand the store an iterator over currently-open segments so it can
// rewrite them into the active file on rotation and on the periodic
// refresh below. Without this the store's mtime-based pruning can drop
// a file whose only relevant content is a long-lived open record.
checkStateStore.setOpenSegmentsProvider(() => checkState.iterateOpenSegments());

// Periodic refresh: re-append every open segment into the active file
// once an hour so its mtime advances even when no real state activity
// happens. Bounded write volume — a few opens × hourly × tiny lines —
// and what makes the 24h retention invariant safe for open segments
// that outlive their original file.
const OPEN_SEGMENT_REFRESH_MS = 60 * 60 * 1000;
const stateRefreshTimer = setInterval(() => {
  try {
    checkStateStore.refreshOpenSegments();
    // Refreshing fills the file faster than steady-state state-changes
    // would; nudge the rotation check so size/age limits are honored.
    checkStateStore.checkRotation();
  } catch (err) {
    console.warn('[state-store] refresh failed:', err);
  }
}, OPEN_SEGMENT_REFRESH_MS);

// Helper to apply a live state-segment transition: opens or closes a
// segment, persists the record, and broadcasts to subscribed clients.
// Idempotent — calling open() twice is a no-op (preserves the original
// start), as is close() when no segment is open.
function applyStateOpen(checkId: string, kind: CheckStateKind, start: number, ownerUid: string | undefined): void {
  const seg = checkState.open(checkId, kind, start);
  if (!seg) return;
  checkStateStore.append(checkId, seg);
  if (ownerUid) broadcastState(checkId, ownerUid, seg);
}
function applyStateClose(checkId: string, kind: CheckStateKind, end: number, ownerUid: string | undefined): void {
  const seg = checkState.close(checkId, kind, end);
  if (!seg) return;
  checkStateStore.append(checkId, seg);
  if (ownerUid) broadcastState(checkId, ownerUid, seg);
}

// Hydrate heartbeat token index and prior ping state from loaded checks.
// Without this, a VPS restart would wipe lastPingAt and evaluator would
// incorrectly see every check as "never pinged" until the next real ping.
for (const { checkId, token } of schedule.getHeartbeatTokens()) {
  heartbeatTokenIndex.set(token, checkId);
  const check = schedule.getCheck(checkId);
  if (check?.lastPingAt != null) {
    heartbeatPingState.set(checkId, {
      lastPingAt: check.lastPingAt,
      metadata: check.lastPingMetadata ?? null,
    });
    // The doc value is by definition the last committed write — seed the
    // write throttle from it so a fast pinger doesn't get a free immediate
    // write just because the process restarted.
    heartbeatLastWritten.set(checkId, {
      lastPingAt: check.lastPingAt,
      metadataStatus: check.lastPingMetadata?.status ?? null,
    });
  }
}
console.info(
  `[Heartbeat] Loaded ${heartbeatTokenIndex.size} tokens, ${heartbeatPingState.size} with prior ping state`
);

const heartbeatFlushTimer = setInterval(() => {
  flushHeartbeatWrites().catch((err: unknown) =>
    console.warn('[Heartbeat] Unexpected flush error:', err)
  );
}, HEARTBEAT_WRITE_FLUSH_MS);

// Register callback to keep token index in sync with check_edits
schedule.setHeartbeatChangeCallback((action, checkId, check) => {
  if (action === 'removed') {
    for (const [token, id] of heartbeatTokenIndex) {
      if (id === checkId) {
        heartbeatTokenIndex.delete(token);
        break;
      }
    }
    heartbeatPingState.delete(checkId);
    heartbeatPingPendingWrites.delete(checkId);
    heartbeatLastWritten.delete(checkId);
  } else if (check?.heartbeatToken) {
    // Remove old token if exists (handles token regeneration)
    for (const [token, id] of heartbeatTokenIndex) {
      if (id === checkId) {
        heartbeatTokenIndex.delete(token);
        break;
      }
    }
    heartbeatTokenIndex.set(check.heartbeatToken, checkId);
  }
});

// WS bridge for user-driven edits. The status-buffer hook (registered
// below via setStatusUpdateHook) covers probe-driven changes — every
// check execution fans out its delta. But edits made through the API/UI
// (toggling disabled, maintenanceMode, changing frequency) flow through
// `check_edits` → schedule.handleCheckEdit, which is a path the status
// buffer never touches. Without this bridge, the frontend's Firestore
// watcher sees those edits while WS doesn't, which Phase 4 shadow
// telemetry correctly flags as `firestoreOnly` mismatches.
schedule.setLiveFieldsChangeCallback((checkId, ownerUid, delta) => {
  broadcastUpdate(checkId, ownerUid, delta);
  // Pivot disabled / maintenanceMode transitions into state-segment
  // ops. The schedule has already swapped in the new doc by this point,
  // so we read the start timestamps directly from the fresh check — this
  // is the authoritative path for user-driven toggles.
  if (delta.disabled !== undefined || delta.maintenanceMode !== undefined) {
    const fresh = schedule.getCheck(checkId);
    const at = Date.now();
    if (delta.disabled === true) {
      const start = (fresh as { disabledAt?: number | null } | undefined)?.disabledAt;
      applyStateOpen(checkId, 'disabled', typeof start === 'number' ? start : at, ownerUid);
    } else if (delta.disabled === false) {
      applyStateClose(checkId, 'disabled', at, ownerUid);
    }
    if (delta.maintenanceMode === true) {
      const start = (fresh as { maintenanceStartedAt?: number } | undefined)?.maintenanceStartedAt;
      applyStateOpen(checkId, 'maintenance', typeof start === 'number' ? start : at, ownerUid);
    } else if (delta.maintenanceMode === false) {
      applyStateClose(checkId, 'maintenance', at, ownerUid);
    }
  }
});

// Evict the per-user settings cache when the user edits alert settings
// (email/SMS/webhooks). Without this, an unchecked email alert keeps firing
// for up to SETTINGS_CACHE_TTL_MS while alerts evaluate stale settings.
schedule.setSettingsEditCallback((userId) => {
  if (settingsCache.delete(userId)) {
    console.info(`[Settings] Cache evicted for ${userId} (settings edit)`);
  }
});

schedule.startRealtimeSync();

// Initialize the status buffer's periodic flush (already exists in status-buffer.ts)
initializeStatusFlush();

// Enable deferred budget writes — batches email/SMS budget tracking writes
// instead of writing to Firestore per-alert. Flush every 30 seconds.
enableDeferredBudgetWrites();
const budgetFlushTimer = setInterval(() => {
  flushDeferredBudgetWrites().catch((err: unknown) =>
    console.warn('Failed to flush deferred budget writes:', err)
  );
}, 30_000);

// Wire status buffer hook so the schedule learns new nextCheckAt values
// after each check execution (synchronous callback, no async overhead).
setStatusUpdateHook((checkId: string, data: {
  nextCheckAt?: number;
  disabled?: boolean;
  status?: string;
  detailedStatus?: string;
  consecutiveFailures?: number;
  consecutiveSuccesses?: number;
  lastChecked?: number;
  lastFailureTime?: number | null;
  lastDowntime?: number;
  lastHistoryAt?: number;
  lastError?: string | null;
  pendingDownEmail?: boolean;
  pendingUpEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpSince?: number | null;
  pendingDownSms?: boolean;
  pendingUpSms?: boolean;
  pendingDownWebhooks?: boolean;
  pendingUpWebhooks?: boolean;
  sslCertificate?: {
    valid: boolean;
    lastChecked?: number;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  sslAlertedState?: 'ok' | 'warning' | 'error';
}) => {
  if (data.nextCheckAt != null) {
    schedule.updateNextCheckAt(checkId, data.nextCheckAt);
    // Release from inFlight immediately — the schedule is updated, so the
    // dispatcher can reschedule this check without waiting for the buffer
    // flush that may block processOneCheck's addStatusUpdate for seconds.
    inFlight.delete(checkId);
  }
  // Capture the prior `disabled` value before updateCheck swaps it, so
  // we can detect runner-driven toggles (e.g. quota-exceeded auto-disable)
  // and open/close a state segment. User-driven toggles flow through the
  // `onLiveFieldsChange` path and are handled there; both paths are
  // idempotent on the underlying state store.
  const priorDisabled = data.disabled != null
    ? Boolean((schedule.getCheck(checkId) as { disabled?: boolean } | undefined)?.disabled)
    : null;
  const patch: Record<string, unknown> = {};
  if (data.disabled != null) patch.disabled = data.disabled;
  if (data.status != null) patch.status = data.status;
  if (data.detailedStatus != null) patch.detailedStatus = data.detailedStatus;
  if (data.consecutiveFailures != null) patch.consecutiveFailures = data.consecutiveFailures;
  if (data.consecutiveSuccesses != null) patch.consecutiveSuccesses = data.consecutiveSuccesses;
  // lastChecked must be propagated so the post-deploy baseline rule can tell
  // whether a check has run since deploy_mode lifted. Without this, every probe
  // of every check sees the stale pre-deploy lastChecked and re-baselines
  // forever — silently suppressing all real alerts until the 12h fullResync
  // or a runner restart.
  if (data.lastChecked != null) patch.lastChecked = data.lastChecked;
  if ('lastFailureTime' in data) patch.lastFailureTime = data.lastFailureTime;
  if (data.lastDowntime != null) patch.lastDowntime = data.lastDowntime;
  if ('lastError' in data) patch.lastError = data.lastError;
  if ('pendingDownEmail' in data) patch.pendingDownEmail = data.pendingDownEmail;
  if ('pendingUpEmail' in data) patch.pendingUpEmail = data.pendingUpEmail;
  if ('pendingDownSince' in data) patch.pendingDownSince = data.pendingDownSince;
  if ('pendingUpSince' in data) patch.pendingUpSince = data.pendingUpSince;
  // Per-channel SMS retry flags — without propagation the in-memory check would
  // lag and the next probe wouldn't see the pending SMS retry (recovery-SMS bug).
  if ('pendingDownSms' in data) patch.pendingDownSms = data.pendingDownSms;
  if ('pendingUpSms' in data) patch.pendingUpSms = data.pendingUpSms;
  // Webhook re-drive flags (gate-suppressed dispatch) — same staleness hazard.
  if ('pendingDownWebhooks' in data) patch.pendingDownWebhooks = data.pendingDownWebhooks;
  if ('pendingUpWebhooks' in data) patch.pendingUpWebhooks = data.pendingUpWebhooks;

  // Propagate sslCertificate so the in-memory check has fresh SSL data.
  // Without this, sslFresh is always false (stale lastChecked), causing
  // a fresh TLS cert extraction every cycle and repeated SSL alerts.
  if (data.sslCertificate != null) patch.sslCertificate = data.sslCertificate;

  // Propagate the durable SSL alert state so the next probe compares against
  // what we actually notified about. Without this the in-memory check would lag
  // until the 12h fullResync and could re-evaluate the same transition (harmless
  // re-sends are throttled, but this keeps the schedule correct immediately).
  if (data.sslAlertedState != null) patch.sslAlertedState = data.sslAlertedState;

  // Propagate dnsMonitoring sub-fields (baseline, lastResult, changes, etc.)
  // so the in-memory check has the updated baseline for drift comparison.
  // The buffer uses dot-separated keys like 'dnsMonitoring.baseline'.
  const anyData = data as Record<string, unknown>;

  // Propagate lastHistoryAt so the hourly sampling gate works correctly.
  // Without this, the in-memory check never knows a sample was recorded,
  // so shouldSampleHistory fires on every cycle instead of once per hour.
  if (data.lastHistoryAt != null) patch.lastHistoryAt = data.lastHistoryAt;
  const dnsKeys = Object.keys(anyData).filter(k => k.startsWith('dnsMonitoring.'));
  if (dnsKeys.length > 0) {
    const existing = schedule.getCheck(checkId);
    const dnsMon = existing?.dnsMonitoring ? { ...existing.dnsMonitoring } : {};
    for (const key of dnsKeys) {
      const subField = key.slice('dnsMonitoring.'.length);
      dnsMon[subField] = anyData[key];
    }
    patch.dnsMonitoring = dnsMon;
  }

  if (Object.keys(patch).length > 0) schedule.updateCheck(checkId, patch);

  // Pivot runner-driven `disabled` toggles into state-segment ops. We
  // compared against the prior in-memory value above; only act on a real
  // transition. `disabledAt` isn't carried through the hook, so use
  // `now` for the band start — close enough for non-user-driven disables.
  if (
    data.disabled != null &&
    priorDisabled !== null &&
    Boolean(data.disabled) !== priorDisabled
  ) {
    const ownerUid = schedule.getCheckOwner(checkId);
    const at = Date.now();
    if (data.disabled) {
      applyStateOpen(checkId, 'disabled', at, ownerUid);
    } else {
      applyStateClose(checkId, 'disabled', at, ownerUid);
    }
  }

  // Phase 3: fan the same update out to WS subscribers. Build the live
  // delta directly from `data` (the hook's source-of-truth partial) rather
  // than from `patch` so nextCheckAt — which the existing code routes to
  // updateNextCheckAt above instead of into patch — still rides along.
  const liveDelta: LiveFields = {};
  const liveBag = liveDelta as unknown as Record<string, unknown>;
  const dataAny = data as Record<string, unknown>;
  for (const key of LIVE_FIELD_NAMES) {
    const val = dataAny[key];
    if (val !== undefined) liveBag[key] = val;
  }
  if (Object.keys(liveDelta).length > 0) {
    const ownerUid = schedule.getCheckOwner(checkId);
    if (ownerUid) broadcastUpdate(checkId, ownerUid, liveDelta);
  }

  // live-charts.md Phase 1: append a ChartPoint to the per-check 24h
  // buffer on every probe completion. `lastChecked` is the discriminator
  // — it's only set when the status-buffer hook fires from a real probe,
  // not from a config edit.
  //
  // status-buffer only sends fields that CHANGED since its last write,
  // so for a stable check status/responseTime/lastStatusCode are absent
  // from almost every delta. We fall back to schedule.getCheck() to
  // recover the last-known values — without this, the buffer would only
  // grow on state transitions and stay empty for steady-state checks.
  if (data.lastChecked != null) {
    const full = schedule.getCheck(checkId) as
      | { status?: string; responseTime?: number; lastStatusCode?: number }
      | undefined;
    const status = data.status ?? full?.status;
    if (status === 'online' || status === 'offline') {
      const responseTime =
        typeof dataAny.responseTime === 'number'
          ? dataAny.responseTime
          : typeof full?.responseTime === 'number'
            ? full.responseTime
            : null;
      const statusCode =
        typeof dataAny.lastStatusCode === 'number'
          ? dataAny.lastStatusCode
          : typeof full?.lastStatusCode === 'number'
            ? full.lastStatusCode
            : undefined;
      // Phase timings are point-in-time measurements of *this* probe.
      // Unlike responseTime we deliberately do NOT fall back to the
      // schedule's cached value: on a partial-failure HTTP probe (e.g.
      // TLS handshake failed) check-utils omits the phases that didn't
      // run, and the schedule cache still holds the last successful
      // values — falling back would mislabel the failed probe with a
      // bogus "tlsMs=120" inherited from a different request.
      // Status-buffer doesn't throttle these (they fluctuate every
      // probe), so the fresh delta is authoritative.
      const pickMs = (key: 'dnsMs' | 'connectMs' | 'tlsMs' | 'ttfbMs'): number | undefined => {
        const fresh = dataAny[key];
        return typeof fresh === 'number' ? fresh : undefined;
      };
      const dn = pickMs('dnsMs');
      const cn = pickMs('connectMs');
      const tl = pickMs('tlsMs');
      const ft = pickMs('ttfbMs');
      const point: ChartPoint = {
        t: data.lastChecked,
        rt: responseTime,
        st: status === 'online' ? 'up' : 'down',
      };
      if (typeof statusCode === 'number') point.sc = statusCode;
      if (dn !== undefined) point.dn = dn;
      if (cn !== undefined) point.cn = cn;
      if (tl !== undefined) point.tl = tl;
      if (ft !== undefined) point.ft = ft;
      timeseries.append(checkId, point);
      // live-charts.md Phase 2: persist asynchronously so the chart
      // survives deploys. store.append is a fire-and-forget write to
      // an open NDJSON file — no awaits, no blocking on disk IO from
      // this hot path. If persistence is disabled (mkdir failed at
      // boot, etc.), this is a cheap no-op.
      timeseriesStore.append(checkId, point);
    }
  }
});

// Safety net: full resync every 12 hours in case onSnapshot missed events.
const RESYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const resyncTimer = setInterval(() => {
  schedule.fullResync().catch(err => console.error('[CheckSchedule] Full resync failed:', err));
}, RESYNC_INTERVAL_MS);

// ── Phase 7: Heartbeat-defer live switch ──────────────────────────────
// Subscribe to system_settings/heartbeat_defer so an admin toggle reaches
// both VPSes within seconds. Status-buffer's setter drains the deferred
// buffer immediately when disabling, so flipping OFF never leaves stale
// heartbeats sitting around.
const heartbeatDeferUnsub = firestore
  .doc('system_settings/heartbeat_defer')
  .onSnapshot(
    (snap: { exists: boolean; data: () => { enabled?: boolean } | undefined }) => {
      const enabled = snap.exists ? Boolean(snap.data()?.enabled) : false;
      setHeartbeatDeferEnabled(enabled);
    },
    (err: unknown) => console.warn('[heartbeat-defer] onSnapshot error:', err),
  );

// Periodic flush of the deferred buffer. 60 min per firestore-write-reduction.md
// Tier 2 (was 15 min in Tier 1, 5 min originally) — heartbeat snapshots are
// the dominant Firestore write path, and the frontend reads live fields over
// WS (Phase 5), so Firestore freshness only matters for WS-fallback mode,
// restart hydration, and the public API's lastChecked/responseTime. State
// transitions still write immediately. Since the steady-state skip landed in
// status-buffer.ts (material-hash dedup + CHECKS_DOC_REFRESH_MAX_AGE_MS
// floor, default 24h), this interval only sets how often the buffer is
// *evaluated* — a check whose material state hasn't changed writes at most
// once per floor interval, not once per flush. The WS-fallback UI presents
// timing fields as stale accordingly (Tier 2b, copy says "up to a day").
// Env-overridable so ops can tune without a redeploy.
const HEARTBEAT_DEFER_FLUSH_INTERVAL_MS =
  Number(process.env.HEARTBEAT_DEFER_FLUSH_INTERVAL_MS) || 60 * 60 * 1000;
const heartbeatDeferFlushTimer = setInterval(() => {
  flushDeferredHeartbeats().catch((err: unknown) =>
    console.warn('[heartbeat-defer] flush failed:', err)
  );
}, HEARTBEAT_DEFER_FLUSH_INTERVAL_MS);

// ── Deploy Mode guard (cached, checked every 30s) ─────────────────────
// Mirrors the global kill switch from runCheckScheduler. When active,
// the dispatcher skips all check processing. The `disabledAt` timestamp
// is exposed via checkCtx so processOneCheck can treat the first probe
// of each check after the lift as a silent re-baseline (no alerts).
let deployModeActive = false;
let deployModeDisabledAt = 0;
let deployModeLastChecked = 0;
const DEPLOY_MODE_CACHE_MS = 30_000;
// The dispatcher awaits this read inline. Untimed, a wedged gRPC channel
// (the 2026-05-24 failure mode) would park dispatch() forever — and with
// deployModeActive latched true the watchdog would stay suppressed too.
// Bound the read so a wedge degrades to fail-open instead of a permanent
// stall.
const DEPLOY_MODE_READ_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function checkDeployMode(): Promise<boolean> {
  const now = Date.now();
  if (now - deployModeLastChecked < DEPLOY_MODE_CACHE_MS) return deployModeActive;
  deployModeLastChecked = now;
  const wasPreviouslyActive = deployModeActive;
  try {
    type DeployModeDoc = { enabled?: boolean; expiresAt?: number; reason?: string; disabledAt?: number };
    const doc = await withTimeout(
      firestore.doc('system_settings/deploy_mode').get() as Promise<{
        exists: boolean;
        data: () => DeployModeDoc | undefined;
      }>,
      DEPLOY_MODE_READ_TIMEOUT_MS,
      'deploy_mode read',
    );
    const dm = doc.exists ? doc.data() : undefined;
    const expiresAt = typeof dm?.expiresAt === 'number' ? dm.expiresAt : undefined;

    if (dm?.enabled && expiresAt !== undefined && expiresAt > now) {
      deployModeActive = true;
      if (!wasPreviouslyActive) {
        const expiresIn = Math.round((expiresAt - now) / 1000);
        console.log(`[deploy-mode] Deploy mode ACTIVE — skipping all checks (expires in ${expiresIn}s, reason: ${dm.reason ?? 'none'})`);
      }
      return true;
    }

    // Not active: doc missing, disabled by admin, or enabled-but-expired.
    if (dm?.enabled && expiresAt !== undefined && expiresAt <= now) {
      // Stale enabled doc — clear it in Firestore. Arm the post-deploy
      // baseline only if THIS process actually paused for the deploy: at
      // boot, residue of an old deploy must not suppress the first probe
      // cycle's genuine alerts. Bounded like the read — dispatch() awaits
      // this inline, and a wedged write must not park the loop.
      await withTimeout(
        firestore.doc('system_settings/deploy_mode').update({
          enabled: false, disabledAt: now, disabledBy: 'system_auto_expire',
        }) as Promise<unknown>,
        DEPLOY_MODE_READ_TIMEOUT_MS,
        'deploy_mode auto-expire update',
      );
      if (wasPreviouslyActive) deployModeDisabledAt = now;
    } else if (typeof dm?.disabledAt === 'number') {
      deployModeDisabledAt = dm.disabledAt;
    } else if (!doc.exists && wasPreviouslyActive) {
      // Deploy mode lifted by deleting the doc (incident fast path) — no
      // disabledAt to read, so arm the baseline at the moment we noticed
      // the lift. Without this the ramp arms but the post-deploy baseline
      // and DNS grace stay cold, alerting on every stale transition.
      deployModeDisabledAt = now;
    }

    deployModeActive = false;
    if (wasPreviouslyActive) {
      dispatcherResumeAt = Date.now();
      console.log('[deploy-mode] Deploy mode lifted, resuming checks (post-deploy baseline + DNS grace + concurrency ramp armed)');
    }
    // Keep the shared checkCtx mirror in sync so processOneCheck sees the
    // current value on every call.
    checkCtx.deployModeDisabledAt = deployModeDisabledAt;
  } catch (err) {
    // Fail-open: if we can't read deploy mode (error or timeout), proceed
    // with checks — a stuck-active latch must never become a permanent
    // dispatch stall. If we were paused, arm the ramp AND the baseline so
    // the resume neither bursts the resolver nor alerts on stale
    // transitions from the paused window.
    if (wasPreviouslyActive) {
      dispatcherResumeAt = Date.now();
      deployModeDisabledAt = Date.now();
      checkCtx.deployModeDisabledAt = deployModeDisabledAt;
      console.warn('[deploy-mode] Deploy mode check failed (fail-open), resuming checks with ramp + baseline armed:', err);
    }
    deployModeActive = false;
  }
  return deployModeActive;
}

// ── Webhook retry drain (every 60s) ───────────────────────────────────
// Mirrors the drainQueuedWebhookRetries() call from runCheckScheduler.
const webhookRetryTimer = setInterval(() => {
  drainQueuedWebhookRetries().catch((err: unknown) =>
    console.warn('Failed to drain webhook retries:', err)
  );
}, 60_000);
// Also drain once on startup
drainQueuedWebhookRetries().catch((err: unknown) =>
  console.warn('Failed to drain webhook retries on startup:', err)
);

// ── Dispatcher ─────────────────────────────────────────────────────────
// Runs every 500ms. For each due check, submits it to the semaphore-limited
// worker pool. inFlight set prevents double-runs. No batching, no lock.
let shuttingDown = false;

// When processOneCheck throws, the status hook never fired, so the schedule
// entry is still past-due — without a backoff the dispatcher would re-run
// the full network probe every ~probe-duration (instead of every check
// interval) for as long as the failure persists.
const FAILED_CHECK_BACKOFF_MS = 30_000;

// Hard ceiling on a single processOneCheck invocation. Budget: HTTP_TIMEOUT_MS
// (30s) + PEER_CONFIRM_TIMEOUT_MS (35s) + headroom for the Firestore reads,
// alert dispatch and BigQuery enqueue around them. Down-confirmation does NOT
// belong in this budget — DOWN_CONFIRMATION_ATTEMPTS is spread across separate
// scheduled invocations, not retried inside one.
//
// Deliberately generous. Steady state is ~3.8k EU checks on 2-min intervals
// through 250 slots, i.e. ~8s of headroom per slot, so a timeout should be a
// genuine anomaly rather than routine load-shedding. Its job is to make the
// pool impossible to wedge, not to police slow checks.
const CHECK_INVOCATION_TIMEOUT_MS =
  Number(process.env.CHECK_INVOCATION_TIMEOUT_MS) || 120_000;

async function dispatch() {
  if (shuttingDown) return;
  try {
    // Deploy mode: skip all check processing when active
    if (await checkDeployMode()) return; // finally re-arms the next tick

    const due = schedule.getDueChecks(Date.now());
    const effectiveCap = getEffectiveConcurrency();

    for (const check of due) {
      if (inFlight.has(check.id) || executing.has(check.id)) continue;
      // Concurrency ramp: cap dispatches during the warm-up window so the
      // local DNS resolver isn't saturated by a 250-check burst. Remaining
      // due checks stay queued in the schedule and are picked up next tick.
      if (inFlight.size >= effectiveCap) break;
      inFlight.add(check.id);

      // Fire-and-forget — semaphore controls concurrency
      sem.acquire().then(async () => {
        if (shuttingDown) {
          // SIGTERM landed while this task sat in the semaphore queue —
          // don't start a fresh probe mid-drain.
          sem.release();
          inFlight.delete(check.id);
          return;
        }
        const start = Date.now();
        const task: WorkerTask = {
          id: check.id, start, released: false, controller: new AbortController(),
        };
        executing.set(check.id, task);
        try {
          // Inject heartbeat ping state into check object for processOneCheck to evaluate
          if (check.type === 'heartbeat') {
            const pingData = heartbeatPingState.get(check.id);
            if (pingData) {
              check.lastPingAt = pingData.lastPingAt;
              check.lastPingMetadata = pingData.metadata;
            }
          }
          // Hard bound on the whole invocation. processOneCheck's probe is
          // bounded (AbortSignal.timeout) but the Firestore reads, alert
          // dispatch and BigQuery enqueue around it are not — on 2026-07-28 a
          // wedged Firestore read parked ~250 workers before the status write,
          // and because the await never settled the finally never ran and every
          // permit leaked. A timeout here means the finally always runs, so the
          // worst case is degraded throughput rather than a locked pool.
          await withTimeout(
            processOneCheck(check, buildCheckCtx(task.controller.signal)),
            CHECK_INVOCATION_TIMEOUT_MS,
            `check ${check.id}`,
          );
        } catch (err: unknown) {
          console.error(`[Worker] Check ${check.id} failed:`, err);
          // Back off only if the hook didn't already advance nextCheckAt
          // (a late throw after the hook fired must not pull the next run
          // earlier than the real schedule). A timeout lands here too, so a
          // timed-out check reschedules on the same backoff as any failure.
          const cur = (schedule.getCheck(check.id) as { nextCheckAt?: number } | undefined)?.nextCheckAt;
          if (typeof cur !== 'number' || cur <= Date.now()) {
            schedule.updateNextCheckAt(check.id, Date.now() + FAILED_CHECK_BACKOFF_MS);
          }
        } finally {
          // Stop the abandoned invocation from doing further work or writing a
          // stale status update if it settles after the timeout. Harmless on
          // the normal path — nothing reads the signal once the work is done.
          try { task.controller.abort(); } catch { /* ignore */ }
          // Idempotent against watchdog eviction. If the watchdog already
          // reclaimed this slot, releaseSlot returns false and we skip the
          // metrics below: a zombie's multi-minute "duration" is not throughput,
          // and letting it nudge the liveness timestamp is precisely how the
          // 2026-07-28 wedge stayed invisible.
          if (releaseSlot(task)) {
            const elapsed = Date.now() - start;
            thisMinuteChecks++;
            thisMinuteTotalMs += elapsed;
            if (elapsed > thisMinuteMaxMs) thisMinuteMaxMs = elapsed;
            // Liveness signal — the watchdog uses this to detect "running but
            // not working". Update on any completion (success or error) so a
            // pool that's actually moving doesn't get killed for failed probes.
            lastSuccessfulCheckCompletedAt = Date.now();
          }
        }
      }).catch((err: unknown) => {
        // Semaphore acquire itself failed (shouldn't happen) — clean up
        inFlight.delete(check.id);
        executing.delete(check.id);
        console.error(`[Worker] Semaphore error for ${check.id}:`, err);
      });
    }
  } catch (err) {
    // A throw here (schedule internals, deploy-mode edge) must never kill
    // the dispatch loop — the finally below guarantees the next tick.
    console.error('[Dispatcher] tick failed:', err);
  } finally {
    if (!shuttingDown) setTimeout(dispatch, DISPATCH_INTERVAL_MS);
  }
}

dispatch();

// ── Graceful Shutdown ──────────────────────────────────────────────────
// Wait for in-flight checks to drain before exiting. PM2 kill_timeout is
// 30s; we use 25s as our own deadline so the process exits cleanly before
// PM2 sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received, shutting down...`);
  // Flip the buffers' internal shutdown flags so their final flushes
  // force-retry entries sitting in failure backoff instead of skipping
  // them (the now K_SERVICE-gated signal handlers used to do this).
  try { markStatusBufferShuttingDown(); } catch { /* ignore */ }
  try { markBigQueryShuttingDown(); } catch { /* ignore */ }
  server.close();
  clearInterval(resyncTimer);
  clearInterval(webhookRetryTimer);
  clearInterval(budgetFlushTimer);
  clearInterval(heartbeatFlushTimer);
  clearInterval(heartbeatDeferFlushTimer);
  clearInterval(stateRefreshTimer);
  // The watchdog must not exit(1) mid-drain and discard the final flushes.
  clearInterval(watchdogTimer);
  try { heartbeatDeferUnsub(); } catch { /* ignore */ }
  schedule.stopRealtimeSync();
  setStatusUpdateHook(null);

  // Wait on BOTH sets: the status hook early-releases checks from inFlight
  // while their workers are still finishing (alerts, BigQuery enqueue), and
  // those tails are tracked in `executing`.
  if (inFlight.size > 0 || executing.size > 0) {
    console.info(`Waiting for ${inFlight.size} queued + ${executing.size} running checks to complete...`);
    await new Promise<void>(resolve => {
      const check = () => {
        if (inFlight.size === 0 && executing.size === 0) return resolve();
        setTimeout(check, 500);
      };
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); // deadline
      check();
    });
  }

  // Final flush of all pending writes before exit
  console.info('Flushing pending writes...');
  await Promise.allSettled([
    // Bounded flush-until-empty: stragglers past the drain deadline can
    // still addStatusUpdate mid-flush; loop so their completions reach
    // Firestore too. (The import-time signal handler in status-buffer used
    // to do this — the K_SERVICE gate moved lifecycle ownership here.)
    (async () => {
      for (let i = 0; i < 5; i++) {
        await flushStatusUpdates();
        if (statusUpdateBuffer.size === 0) break;
      }
    })(),
    // Same straggler treatment: a worker past the drain deadline can still
    // enqueue a history row after a single flush snapshot was taken.
    (async () => {
      for (let i = 0; i < 5; i++) {
        await flushBigQueryInserts();
        if (getBigQueryInsertBufferSize() === 0) break;
      }
    })(),
    flushDeferredBudgetWrites(),
    flushHeartbeatWrites(),
    // Phase 7: drain deferred heartbeats into the main flush path so a
    // restart doesn't lose up to one defer-flush interval of cold-status
    // data for unaffected checks. flushDeferredHeartbeats internally calls flushStatusUpdates
    // after draining; the prior entry in this array starts that flush
    // too, but having both is safe (flushStatusUpdates is lock-aware).
    flushDeferredHeartbeats(),
    // live-charts.md Phase 2: flush + close the NDJSON write stream so
    // points sitting in Node's writable buffer reach the kernel before
    // exit. No JSON.stringify of the in-memory Map — append-on-write
    // already paid that cost incrementally during steady state.
    timeseriesStore.close(),
    // State-segment store — same end-cleanly contract as the timeseries
    // store. Cheap (segments are rare, tiny writable buffer).
    checkStateStore.close(),
  ]);
  console.info('Shutdown complete.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
