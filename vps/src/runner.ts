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
const { runCheckScheduler } = await import('../../functions/lib/checks.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { checkRestEndpoint, checkTcpEndpoint, checkUdpEndpoint, checkPingEndpoint, checkWebSocketEndpoint } = await import('../../functions/lib/check-utils.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { firestore } = await import('../../functions/lib/init.js');
// @ts-expect-error — functions/lib/ has no .d.ts files; types are verified at the source level
const { setStatusUpdateHook } = await import('../../functions/lib/status-buffer.js');

import { CheckSchedule } from './check-schedule.js';

const REGION = 'vps-eu-1' as const;
const INTERVAL_MS = 2 * 1000; // 2 seconds between cycles (sub-minute checks need fast polling)

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

let lastSchedulerCompleted = 0;
let schedulerRunning = false;

// ── In-Memory Check Schedule ──
const schedule = new CheckSchedule();

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const uptime = process.uptime();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      region: REGION,
      uptimeSeconds: Math.round(uptime),
      schedulerRunning,
      lastSchedulerCompletedAgo: lastSchedulerCompleted ? `${Math.round((Date.now() - lastSchedulerCompleted) / 1000)}s` : null,
      schedule: schedule.getStats(),
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

async function runOnce() {
  const dueChecks = schedule.getDueChecks(Date.now());
  if (dueChecks.length === 0) return;

  const start = Date.now();
  console.info(`[${new Date().toISOString()}] ${dueChecks.length} due checks (${schedule.getStats().totalChecks} total)`);
  schedulerRunning = true;

  try {
    await runCheckScheduler(REGION, { preloadedChecks: dueChecks });
    console.info(`[${new Date().toISOString()}] Scheduler completed in ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Scheduler failed:`, err);
  } finally {
    schedulerRunning = false;
    lastSchedulerCompleted = Date.now();
  }
}

console.info(`VPS Check Runner starting for region: ${REGION}`);
console.info(`Interval: ${INTERVAL_MS / 1000}s between cycles`);

// Clear any stale lock left by a previous process that was killed mid-run
// (e.g., during a deploy). Safe because PM2 instances:1 guarantees no other
// process is alive when this code runs.
const LOCK_DOC = `checkAllChecks-${REGION}`;
try {
  await firestore.collection('runtimeLocks').doc(LOCK_DOC).delete();
  console.info(`Cleared stale lock: runtimeLocks/${LOCK_DOC}`);
} catch (err) {
  // Not fatal — lock may not exist (clean shutdown), or Firestore may be slow.
  // The scheduler's own TTL-based expiry is the fallback.
  console.warn(`Could not clear stale lock (will expire via TTL):`, err);
}

// ── Initialize in-memory schedule ──
// One-time Firestore read of all checks for this region, then start
// real-time sync via onSnapshot for user edits.
await schedule.init(REGION, firestore);
schedule.startRealtimeSync();

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
  if (data.nextCheckAt != null) schedule.updateNextCheckAt(checkId, data.nextCheckAt);
  // Sync alert-relevant fields back to the in-memory check object so that
  // status change detection sees the current state, not the stale init load.
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

// setTimeout chain prevents overlapping runs. The short interval lets checks
// run closer to their configured frequency — nextCheckAt naturally throttles
// each check so there's no risk of double-runs.
let shuttingDown = false;
let currentRun: Promise<void> | null = null;

async function loop() {
  if (shuttingDown) return;
  currentRun = runOnce();
  await currentRun;
  currentRun = null;
  if (!shuttingDown) setTimeout(loop, INTERVAL_MS);
}
loop();

// Graceful shutdown — wait for in-flight scheduler run to finish before exiting.
// PM2 kill_timeout is 30s; we use 25s as our own deadline so the process exits
// cleanly before PM2 sends SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function shutdown(signal: string) {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;
  console.info(`${signal} received, shutting down...`);
  server.close();
  clearInterval(resyncTimer);
  schedule.stopRealtimeSync();
  setStatusUpdateHook(null);

  if (currentRun) {
    console.info('Waiting for in-flight scheduler run to finish...');
    await Promise.race([
      currentRun,
      new Promise(r => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
    ]);
  }

  console.info('Shutdown complete.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
