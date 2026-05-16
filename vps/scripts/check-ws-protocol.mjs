#!/usr/bin/env node
/**
 * WS protocol contract test.
 *
 * Reads the SHARED sentinel blocks from vps/src/ws-protocol.ts and
 * src/lib/ws-protocol.ts and fails the build if they differ by even one
 * byte. The duplicated source is by design (separate package boundaries
 * for browser vs node); this check is what keeps drift from causing
 * silent message-loss bugs.
 *
 * Wired into vps/package.json as a `prebuild` script so `npm run build`
 * on the VPS aborts before the runner picks up a protocol change that
 * the frontend hasn't received.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script lives at vps/scripts/, repo root is two levels up.
const repoRoot = resolve(__dirname, '..', '..');

const VPS_PATH = resolve(repoRoot, 'vps/src/ws-protocol.ts');
const FRONTEND_PATH = resolve(repoRoot, 'src/lib/ws-protocol.ts');

const START = '// ── SHARED START ─';
const END = '// ── SHARED END ─';

function extractShared(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const startIdx = text.indexOf(START);
  const endIdx = text.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`SHARED sentinels missing or out of order in ${filePath}`);
  }
  // Slice from end-of-START-line to start-of-END-line. Normalize line endings
  // so CRLF/LF differences between contributors' machines don't fail the test.
  const startLineEnd = text.indexOf('\n', startIdx) + 1;
  return text.slice(startLineEnd, endIdx).replace(/\r\n/g, '\n');
}

try {
  const vps = extractShared(VPS_PATH);
  const frontend = extractShared(FRONTEND_PATH);

  if (vps === frontend) {
    console.log('[ws-protocol] contract OK');
    process.exit(0);
  }

  console.error('[ws-protocol] DRIFT — vps/src/ws-protocol.ts and src/lib/ws-protocol.ts SHARED blocks differ.');
  console.error('[ws-protocol] vps bytes:', vps.length, '| frontend bytes:', frontend.length);

  // Surface the first divergent line so the operator can fix it without
  // diffing the whole file manually.
  const vpsLines = vps.split('\n');
  const frontendLines = frontend.split('\n');
  const max = Math.max(vpsLines.length, frontendLines.length);
  for (let i = 0; i < max; i++) {
    if (vpsLines[i] !== frontendLines[i]) {
      console.error(`[ws-protocol] first divergence at SHARED line ${i + 1}:`);
      console.error(`  vps:      ${JSON.stringify(vpsLines[i] ?? '<eof>')}`);
      console.error(`  frontend: ${JSON.stringify(frontendLines[i] ?? '<eof>')}`);
      break;
    }
  }
  process.exit(1);
} catch (err) {
  console.error('[ws-protocol] contract check failed:', err.message);
  process.exit(1);
}
