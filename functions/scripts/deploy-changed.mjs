#!/usr/bin/env node
/**
 * deploy-changed.mjs — selective, quota-safe Firebase Functions deploy.
 *
 * Why this exists: this codebase deploys ~120 Gen2 functions. A plain
 * `firebase deploy --only functions` issues one WRITE call per function and
 * blows past Gen2's hard quota of 60 deploy/delete calls per 60s per region
 * (not increasable) — that's the rate-limiting + slow-deploy pain. This script
 * deploys only the functions your changes actually affect, in batches of <=10.
 *
 * It reads src/index.ts to learn which functions exist and which source file
 * each comes from, builds the intra-src import graph, and walks it in reverse
 * so a change to a shared module (e.g. config.ts) correctly redeploys every
 * function that transitively imports it — nothing is silently skipped.
 *
 * Usage (run from functions/):
 *   npm run deploy:changed                 # deploy fns affected by uncommitted changes
 *   npm run deploy:changed -- --base master   # ...by all commits on this branch since master
 *   npm run deploy:changed -- --all        # batched full deploy (quota-safe replacement for `deploy`)
 *   npm run deploy:changed -- --dry-run    # print the plan, deploy nothing
 *   npm run deploy:changed -- --yes        # allow an unexpected full deploy (otherwise it aborts)
 *   npm run deploy:changed -- --chunk 8 --delay 20   # tune batch size / inter-batch delay (s)
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(name);

const OPT = {
  base: getFlagValue('--base'),
  all: hasFlag('--all'),
  yes: hasFlag('--yes'),
  dryRun: hasFlag('--dry-run'),
  chunk: Math.max(1, parseInt(getFlagValue('--chunk') ?? '10', 10) || 10),
  delaySec: Math.max(0, parseInt(getFlagValue('--delay') ?? '15', 10) || 15),
};

// ---- helpers -------------------------------------------------------------
const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const FUNCTIONS_DIR = path.join(REPO_ROOT, 'functions');
const SRC_DIR = path.join(FUNCTIONS_DIR, 'src');
const INDEX_TS = path.join(SRC_DIR, 'index.ts');

const norm = (p) => p.split(path.sep).join('/');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Resolve a relative import spec (from `fromFile`) to an existing src .ts file, or null. */
function resolveImport(fromFile, spec) {
  let base = path.resolve(path.dirname(fromFile), spec);
  base = base.replace(/\.(js|mjs|cjs|ts|tsx)$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

// ---- 1. parse index.ts: function name -> source file ---------------------
const indexSrc = readFileSync(INDEX_TS, 'utf8');
const fnToFile = new Map(); // exported function name -> absolute source file
const deployedFiles = new Set(); // source files that export deployed functions

const reExport = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs;
for (const m of indexSrc.matchAll(reExport)) {
  const namesBlob = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
  const file = resolveImport(INDEX_TS, m[2]);
  if (!file) continue;
  for (const raw of namesBlob.split(',')) {
    const name = raw.trim();
    if (!name) continue;
    // handle `orig as alias` — the deployed name is the alias
    const deployed = name.includes(' as ') ? name.split(/\s+as\s+/)[1].trim() : name;
    if (!deployed) continue;
    fnToFile.set(deployed, file);
    deployedFiles.add(file);
  }
}

if (fnToFile.size === 0) {
  console.error('✖ Could not parse any functions from src/index.ts — aborting.');
  process.exit(1);
}
const ALL_FNS = [...fnToFile.keys()].sort();

// ---- 2. build intra-src import graph (reverse) ---------------------------
// reverseDeps: file -> set of files that import it (one hop)
const allSrcFiles = git(['ls-files', 'functions/src'])
  .split('\n')
  .filter((p) => /\.tsx?$/.test(p) && !p.includes('/__tests__/'))
  .map((p) => path.join(REPO_ROOT, p));

const reverseDeps = new Map();
const importRe = /\bfrom\s*['"](\.[^'"]+)['"]/g;
for (const file of allSrcFiles) {
  let txt;
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const m of txt.matchAll(importRe)) {
    const target = resolveImport(file, m[1]);
    if (!target) continue;
    if (!reverseDeps.has(target)) reverseDeps.set(target, new Set());
    reverseDeps.get(target).add(file);
  }
}

/** All files that transitively import `start` (including `start`). */
function affectedBy(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const importer of reverseDeps.get(cur) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return seen;
}

// ---- 3. detect changed files --------------------------------------------
function changedFiles() {
  const set = new Set();
  const add = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((p) => set.add(p));
  add(git(['diff', '--name-only', 'HEAD'])); // staged + unstaged vs HEAD
  add(git(['ls-files', '--others', '--exclude-standard'])); // untracked
  if (OPT.base) add(git(['diff', '--name-only', `${OPT.base}...HEAD`])); // branch commits since base
  return [...set].map((p) => path.join(REPO_ROOT, norm(p)));
}

// Files whose change forces a full (still-batched) deploy.
const FULL_DEPLOY_TRIGGERS = [
  'functions/package.json',
  'functions/package-lock.json',
  'functions/tsconfig.json',
  'firebase.json',
].map((p) => path.join(REPO_ROOT, p));

// ---- 4. compute the deploy plan -----------------------------------------
let targets; // array of function names
let reason;

if (OPT.all) {
  targets = ALL_FNS;
  reason = '--all flag';
} else {
  const changed = changedFiles();
  const inFunctions = changed.filter((f) => f.startsWith(FUNCTIONS_DIR) || FULL_DEPLOY_TRIGGERS.includes(f));

  if (inFunctions.length === 0) {
    console.log('✓ No changes under functions/ — nothing to deploy.');
    process.exit(0);
  }

  const forcedFull = inFunctions.find((f) => FULL_DEPLOY_TRIGGERS.includes(f));
  const indexEdited = inFunctions.includes(INDEX_TS);

  if (forcedFull) {
    targets = ALL_FNS;
    reason = `${norm(path.relative(REPO_ROOT, forcedFull))} changed (affects all functions)`;
  } else if (indexEdited) {
    targets = ALL_FNS;
    reason = 'src/index.ts changed (export surface may have changed)';
  } else {
    // Map each changed src file to the deployed functions it transitively affects.
    const affectedFiles = new Set();
    for (const f of inFunctions) {
      if (!f.startsWith(SRC_DIR)) continue;
      for (const a of affectedBy(f)) affectedFiles.add(a);
    }
    const hit = new Set();
    for (const [fn, file] of fnToFile) {
      if (affectedFiles.has(file)) hit.add(fn);
    }
    targets = [...hit].sort();
    reason = 'changed files + their importers';
  }

  if (targets.length === 0) {
    console.log('✓ Changed files affect no deployed functions — nothing to deploy.');
    console.log('  (changed under functions/: ' + inFunctions.map((f) => norm(path.relative(REPO_ROOT, f))).join(', ') + ')');
    process.exit(0);
  }
}

// ---- 5. report + deploy in batches --------------------------------------
const batches = [];
for (let i = 0; i < targets.length; i += OPT.chunk) batches.push(targets.slice(i, i + OPT.chunk));

console.log('');
console.log(`Deploy plan  (${targets.length}/${ALL_FNS.length} functions, ${batches.length} batch(es) of <=${OPT.chunk})`);
console.log(`Reason:      ${reason}`);
console.log(`Functions:   ${targets.join(', ')}`);
console.log('');

if (OPT.dryRun) {
  batches.forEach((b, i) => console.log(`  batch ${i + 1}: ${b.join(', ')}`));
  console.log('\n(dry run — nothing deployed)');
  process.exit(0);
}

// Safety: never *silently* fall into a full deploy. The point of this tool is to
// avoid the slow, rate-limited all-functions deploy — so if the plan resolved to
// every function without an explicit --all, stop and make the human opt in.
if (targets.length === ALL_FNS.length && !OPT.all && !OPT.yes) {
  console.error(`✖ This resolved to a FULL deploy of all ${ALL_FNS.length} functions (${reason}).`);
  console.error('  That is the slow / rate-limited path you are trying to avoid.');
  console.error('  If you really mean it, re-run with --all (batched) or add --yes. Or commit/stash that change and deploy only what you touched.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < batches.length; i++) {
  const only = batches[i].map((fn) => `functions:${fn}`).join(',');
  console.log(`\n▶ Batch ${i + 1}/${batches.length}: ${batches[i].join(', ')}`);
  try {
    execSync(`firebase deploy --only ${only}`, { cwd: FUNCTIONS_DIR, stdio: 'inherit', shell: true });
  } catch (err) {
    console.error(`\n✖ Batch ${i + 1} failed (exit ${err.status ?? '?'}). Re-run to retry remaining batches.`);
    process.exit(err.status ?? 1);
  }
  if (i < batches.length - 1 && OPT.delaySec > 0) {
    console.log(`  …waiting ${OPT.delaySec}s before next batch (Gen2 quota: 60 writes / 60s)…`);
    await sleep(OPT.delaySec * 1000);
  }
}

console.log('\n✓ Done. Verify nothing was silently skipped:  firebase functions:list');
