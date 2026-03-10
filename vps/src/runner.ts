// Expand UV threadpool BEFORE any dns.lookup() or I/O calls.
// Default is 4 threads — far too few when running 250+ concurrent checks.
// c-ares (dns-cache.ts) bypasses the threadpool for DNS, but other I/O
// (TLS handshakes, file ops) still uses it.
process.env.UV_THREADPOOL_SIZE = '64';

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer, IncomingMessage, ServerResponse } from 'http';

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

const REGION = 'vps-eu-1' as const;
const INTERVAL_MS = 10 * 1000; // 10 seconds between cycles

// ── Manual Check HTTP API ──
// Firebase Cloud Functions proxy manual check requests here so the network
// request originates from the VPS static IP (allowlistable by users).
const VPS_CHECK_SECRET = process.env.VPS_MANUAL_CHECK_SECRET;
const HTTP_PORT = Number(process.env.VPS_HTTP_PORT) || 3100;

type CheckType = 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleManualCheck(req: IncomingMessage, res: ServerResponse) {
  // Bearer token auth
  const auth = req.headers.authorization;
  if (!VPS_CHECK_SECRET || auth !== `Bearer ${VPS_CHECK_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
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

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/manual-check') {
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
  const start = Date.now();
  console.info(`[${new Date().toISOString()}] Starting check scheduler for region: ${REGION}`);

  try {
    await runCheckScheduler(REGION);
    console.info(`[${new Date().toISOString()}] Scheduler completed in ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Scheduler failed:`, err);
  }
}

console.info(`VPS Check Runner starting for region: ${REGION}`);
console.info(`Interval: ${INTERVAL_MS / 1000}s between cycles`);

// setTimeout chain prevents overlapping runs. The short interval lets checks
// run closer to their configured frequency — nextCheckAt naturally throttles
// each check so there's no risk of double-runs.
async function loop() {
  await runOnce();
  setTimeout(loop, INTERVAL_MS);
}
loop();

// Graceful shutdown
function shutdown(signal: string) {
  console.info(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  // Force exit if server doesn't close within 5s
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
