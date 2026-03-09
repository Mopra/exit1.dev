// Expand UV threadpool BEFORE any dns.lookup() or I/O calls.
// Default is 4 threads — far too few when running 250+ concurrent checks.
// c-ares (dns-cache.ts) bypasses the threadpool for DNS, but other I/O
// (TLS handshakes, file ops) still uses it.
process.env.UV_THREADPOOL_SIZE = '64';

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

const REGION = 'vps-eu-1' as const;
const INTERVAL_MS = 10 * 1000; // 10 seconds between cycles

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
process.on('SIGTERM', () => {
  console.info('SIGTERM received, shutting down...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.info('SIGINT received, shutting down...');
  process.exit(0);
});
