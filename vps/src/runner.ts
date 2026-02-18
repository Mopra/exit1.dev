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
const INTERVAL_MS = 1 * 60 * 1000; // 1 minute

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
console.info(`Interval: ${INTERVAL_MS}ms (${INTERVAL_MS / 60000} minutes)`);

// Use setTimeout chain instead of setInterval to prevent overlapping runs.
// If runCheckScheduler takes >1 minute (possible with many checks), setInterval
// would fire again while the previous run is still going. The distributed lock
// would make the second run skip, but it wastes a Firestore transaction.
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
