#!/usr/bin/env node
// Deploy-mode toggle for VPS deploys.
//
// Writes system_settings/deploy_mode directly with the runner's service
// account (GOOGLE_APPLICATION_CREDENTIALS from ../.env) — the same doc the
// enableDeployMode/disableDeployMode callables write and the same credential
// the runner already uses to auto-expire it. No Cloud Function call, so it
// works even while the runner is stopped mid-deploy.
//
// Usage:
//   node scripts/deploy-mode.mjs enable [minutes] [reason ...]
//   node scripts/deploy-mode.mjs disable
//   node scripts/deploy-mode.mjs status
//
// Deploy sequence:
//   npm run deploy:mode:on     # pauses checks/alerts, waits for propagation
//   <build + pm2 restart>
//   npm run deploy:mode:off    # resumes; runner arms post-deploy baseline
//
// `enable` defaults to 5 minutes (auto-expires as a safety net if the deploy
// script dies before disabling) and, after writing, waits out one runner poll
// cycle (30s cache in runner.ts checkDeployMode) plus a buffer so BOTH
// regions' runners have observed the pause before anything restarts. Pass
// --no-wait to skip the wait.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const vpsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(vpsDir, '.env') });

const { Firestore } = await import('@google-cloud/firestore');
const firestore = new Firestore();

const DOC = 'system_settings/deploy_mode';
// Mirror the callable's bounds (functions/src/deploy-mode.ts).
const DEFAULT_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 120;
// runner.ts DEPLOY_MODE_CACHE_MS (30s) + buffer for the Firestore read itself.
const PROPAGATION_WAIT_MS = 35_000;

const argv = process.argv.slice(2);
const noWait = argv.includes('--no-wait');
const args = argv.filter((a) => a !== '--no-wait');
const command = args[0];
const enabledBy = `vps-deploy:${process.env.VPS_REGION_ID || 'unknown'}`;

async function enable() {
  let minutes = DEFAULT_DURATION_MINUTES;
  let reasonArgs = args.slice(1);
  if (reasonArgs.length && /^\d+$/.test(reasonArgs[0])) {
    minutes = Math.min(Math.max(1, parseInt(reasonArgs[0], 10)), MAX_DURATION_MINUTES);
    reasonArgs = reasonArgs.slice(1);
  }
  const reason = reasonArgs.join(' ') || 'VPS deployment';

  const now = Date.now();
  const expiresAt = now + minutes * 60 * 1000;
  await firestore.doc(DOC).set({
    enabled: true,
    enabledAt: now,
    expiresAt,
    enabledBy,
    reason,
  });
  console.log(`[deploy-mode] ENABLED for ${minutes}m (expires ${new Date(expiresAt).toISOString()}) — ${reason}`);

  if (noWait) {
    console.log('[deploy-mode] --no-wait: runners may keep checking for up to 30s.');
    return;
  }
  console.log(`[deploy-mode] Waiting ${PROPAGATION_WAIT_MS / 1000}s for both regions' runners to observe the pause...`);
  await new Promise((r) => setTimeout(r, PROPAGATION_WAIT_MS));
  console.log('[deploy-mode] Propagated. Safe to deploy.');
}

async function disable() {
  await firestore.doc(DOC).set({
    enabled: false,
    disabledAt: Date.now(),
    disabledBy: enabledBy,
  }, { merge: true });
  console.log('[deploy-mode] DISABLED. Runners resume within 30s (post-deploy baseline armed).');
}

async function status() {
  const doc = await firestore.doc(DOC).get();
  if (!doc.exists) {
    console.log('[deploy-mode] No deploy_mode doc — inactive.');
    return;
  }
  const dm = doc.data();
  const active = dm.enabled && typeof dm.expiresAt === 'number' && dm.expiresAt > Date.now();
  if (active) {
    const remaining = Math.ceil((dm.expiresAt - Date.now()) / 60000);
    console.log(`[deploy-mode] ACTIVE — ${remaining}m remaining, enabled by ${dm.enabledBy}${dm.reason ? `, reason: ${dm.reason}` : ''}`);
  } else {
    console.log('[deploy-mode] Inactive.');
  }
  process.exitCode = active ? 0 : 1;
}

try {
  if (command === 'enable') await enable();
  else if (command === 'disable') await disable();
  else if (command === 'status') await status();
  else {
    console.error('Usage: deploy-mode.mjs enable [minutes] [reason ...] [--no-wait] | disable | status');
    process.exit(2);
  }
} catch (err) {
  console.error('[deploy-mode] FAILED:', err.message || err);
  process.exit(1);
}
