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
const { checkRestEndpoint, checkTcpEndpoint, checkUdpEndpoint, checkPingEndpoint, checkWebSocketEndpoint } = await import('../../functions/lib/check-utils.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { firestore, getUserTier } = await import('../../functions/lib/init.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { setStatusUpdateHook, initializeStatusFlush, flushStatusUpdates } = await import('../../functions/lib/status-buffer.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { insertCheckHistory, flushBigQueryInserts } = await import('../../functions/lib/bigquery.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { drainQueuedWebhookRetries, enableDeferredBudgetWrites, flushDeferredBudgetWrites, fetchAlertSettingsFromFirestore } = await import('../../functions/lib/alert.js');
import { CheckSchedule } from './check-schedule.js';

const REGION = 'vps-eu-1' as const;
const DISPATCH_INTERVAL_MS = 500; // Dispatcher tick: 500ms
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CHECKS_OVERRIDE) || 200;

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

type CheckType = 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — a check payload is < 10 KB
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30;           // max requests per window
const rateLimitHits: number[] = [];

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
      checkType === 'tcp' ? await checkTcpEndpoint(website)
      : checkType === 'udp' ? await checkUdpEndpoint(website)
      : checkType === 'ping' ? await checkPingEndpoint(website)
      : checkType === 'websocket' ? await checkWebSocketEndpoint(website)
      : await checkRestEndpoint(website);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[ManualCheck] Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
  }
}

// ── Worker Pool State ──────────────────────────────────────────────────
const sem = new Semaphore(MAX_CONCURRENT);
const inFlight = new Set<string>(); // prevents double-runs of same check
const schedule = new CheckSchedule();

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

// ── Shared ProcessOneCheck context ─────────────────────────────────────
// Caches live for the process lifetime. TTL-based eviction prevents
// unbounded growth. getUserTier is memoized per-user with 5-min TTL.

const TIER_CACHE_TTL_MS = 5 * 60 * 1000;
const tierCache = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

function getEffectiveTierForUser(uid: string): Promise<unknown> {
  const cached = tierCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const p = getUserTier(uid);
  tierCache.set(uid, { value: p, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return p;
}

const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;
const settingsCache = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

function getUserSettings(uid: string): Promise<unknown> {
  const cached = settingsCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const p = fetchAlertSettingsFromFirestore(uid);
  settingsCache.set(uid, { value: p, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return p;
}

// Throttle and budget caches — cleared periodically to prevent unbounded growth
const throttleCache = new Set<string>();
const budgetCache = new Map<string, number>();
const emailMonthlyBudgetCache = new Map<string, number>();
const smsThrottleCache = new Set<string>();
const smsBudgetCache = new Map<string, number>();
const smsMonthlyBudgetCache = new Map<string, number>();

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
};

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
        active: MAX_CONCURRENT - sem.available,
        queued: sem.queued,
        inFlight: inFlight.size,
      },
      schedule: stats,
      throughput: {
        checksLastMinute: lastMinuteChecks,
        avgResponseTimeMs: lastMinuteAvgMs || null,
        maxResponseTimeMs: lastMinuteMaxMs || null,
      },
      caches: {
        tierCacheSize: tierCache.size,
        settingsCacheSize: settingsCache.size,
        throttleCacheSize: throttleCache.size,
      },
    }));
  } else if (req.method === 'POST' && req.url === '/api/manual-check') {
    handleManualCheck(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
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
  lastError?: string | null;
  pendingDownEmail?: boolean;
  pendingUpEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpSince?: number | null;
}) => {
  if (data.nextCheckAt != null) {
    schedule.updateNextCheckAt(checkId, data.nextCheckAt);
    // Release from inFlight immediately — the schedule is updated, so the
    // dispatcher can reschedule this check without waiting for the buffer
    // flush that may block processOneCheck's addStatusUpdate for seconds.
    inFlight.delete(checkId);
  }
  const patch: Record<string, unknown> = {};
  if (data.disabled != null) patch.disabled = data.disabled;
  if (data.status != null) patch.status = data.status;
  if (data.detailedStatus != null) patch.detailedStatus = data.detailedStatus;
  if (data.consecutiveFailures != null) patch.consecutiveFailures = data.consecutiveFailures;
  if (data.consecutiveSuccesses != null) patch.consecutiveSuccesses = data.consecutiveSuccesses;
  if ('lastError' in data) patch.lastError = data.lastError;
  if ('pendingDownEmail' in data) patch.pendingDownEmail = data.pendingDownEmail;
  if ('pendingUpEmail' in data) patch.pendingUpEmail = data.pendingUpEmail;
  if ('pendingDownSince' in data) patch.pendingDownSince = data.pendingDownSince;
  if ('pendingUpSince' in data) patch.pendingUpSince = data.pendingUpSince;
  if (Object.keys(patch).length > 0) schedule.updateCheck(checkId, patch);
});

// Safety net: full resync every 12 hours in case onSnapshot missed events.
const RESYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const resyncTimer = setInterval(() => {
  schedule.fullResync().catch(err => console.error('[CheckSchedule] Full resync failed:', err));
}, RESYNC_INTERVAL_MS);

// ── Deploy Mode guard (cached, checked every 30s) ─────────────────────
// Mirrors the global kill switch from runCheckScheduler. When active,
// the dispatcher skips all check processing.
let deployModeActive = false;
let deployModeLastChecked = 0;
const DEPLOY_MODE_CACHE_MS = 30_000;

async function checkDeployMode(): Promise<boolean> {
  const now = Date.now();
  if (now - deployModeLastChecked < DEPLOY_MODE_CACHE_MS) return deployModeActive;
  deployModeLastChecked = now;
  try {
    const doc = await firestore.doc('system_settings/deploy_mode').get();
    if (doc.exists) {
      const dm = doc.data();
      if (dm?.enabled && dm?.expiresAt > now) {
        deployModeActive = true;
        return true;
      }
      // Auto-expire
      if (dm?.enabled && dm?.expiresAt <= now) {
        await firestore.doc('system_settings/deploy_mode').update({
          enabled: false, disabledAt: now, disabledBy: 'system_auto_expire',
        });
      }
    }
    deployModeActive = false;
  } catch {
    // Fail-open: if we can't read deploy mode, proceed with checks
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

async function dispatch() {
  if (shuttingDown) return;

  // Deploy mode: skip all check processing when active
  if (await checkDeployMode()) {
    if (!shuttingDown) setTimeout(dispatch, DISPATCH_INTERVAL_MS);
    return;
  }

  const due = schedule.getDueChecks(Date.now());

  for (const check of due) {
    if (inFlight.has(check.id)) continue;
    inFlight.add(check.id);

    // Fire-and-forget — semaphore controls concurrency
    sem.acquire().then(async () => {
      const start = Date.now();
      try {
        await processOneCheck(check, checkCtx);
      } catch (err: unknown) {
        console.error(`[Worker] Check ${check.id} failed:`, err);
      } finally {
        sem.release();
        inFlight.delete(check.id);
        // Track throughput
        const elapsed = Date.now() - start;
        thisMinuteChecks++;
        thisMinuteTotalMs += elapsed;
        if (elapsed > thisMinuteMaxMs) thisMinuteMaxMs = elapsed;
      }
    }).catch((err: unknown) => {
      // Semaphore acquire itself failed (shouldn't happen) — clean up
      inFlight.delete(check.id);
      console.error(`[Worker] Semaphore error for ${check.id}:`, err);
    });
  }

  if (!shuttingDown) setTimeout(dispatch, DISPATCH_INTERVAL_MS);
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
  server.close();
  clearInterval(resyncTimer);
  clearInterval(webhookRetryTimer);
  clearInterval(budgetFlushTimer);
  schedule.stopRealtimeSync();
  setStatusUpdateHook(null);

  if (inFlight.size > 0) {
    console.info(`Waiting for ${inFlight.size} in-flight checks to complete...`);
    await new Promise<void>(resolve => {
      const check = () => {
        if (inFlight.size === 0) return resolve();
        setTimeout(check, 500);
      };
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); // deadline
      check();
    });
  }

  // Final flush of all pending writes before exit
  console.info('Flushing pending writes...');
  await Promise.allSettled([
    flushStatusUpdates(),
    flushBigQueryInserts(),
    flushDeferredBudgetWrites(),
  ]);
  console.info('Shutdown complete.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
