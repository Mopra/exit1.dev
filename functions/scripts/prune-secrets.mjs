#!/usr/bin/env node
/**
 * prune-secrets.mjs — audit and prune orphaned Secret Manager versions.
 *
 * Why this exists: Secret Manager bills $0.06 per ENABLED version per month,
 * and `firebase functions:secrets:set` adds a version without ever disabling
 * the one it replaced. Because Gen2 pins an *exact* version at deploy time,
 * superseded versions are never read again — they just sit there costing money
 * and staying readable. Left alone this accumulates silently: the TWILIO_*
 * secrets each kept 3 enabled versions from a single 2026-01-07 rotation, and
 * PROBE_HMAC_SECRET repeated the pattern on 2026-09-01.
 *
 * An orphan is an ENABLED version that no deployed consumer references. Those
 * are safe to destroy; anything a consumer pins is not.
 *
 * CAUTION — the Cloud Run `locations/-` wildcard is NOT safe for this job. It
 * ignores pageSize, returns no nextPageToken, and silently truncates (it
 * returned 102 of 124 services on this project). An audit built on it
 * under-reports consumers and will happily tell you to destroy a version that
 * is still in use. This script always enumerates per-region and cross-checks
 * the two APIs against each other; see assertCoverage().
 *
 * Usage (run from functions/):
 *   npm run secrets:audit                      # report only, changes nothing
 *   npm run secrets:audit -- --check           # exit 1 if orphans exist (CI)
 *   npm run secrets:audit -- --json            # machine-readable report
 *   npm run secrets:prune                      # destroy orphaned versions
 *   npm run secrets:prune -- --delete-unused   # also delete secrets nothing binds
 *
 * Needs Application Default Credentials: `gcloud auth application-default login`.
 */

import { applicationDefault } from 'firebase-admin/app';

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);

const OPT = {
  apply: hasFlag('--apply'),
  deleteUnused: hasFlag('--delete-unused'),
  check: hasFlag('--check'),
  json: hasFlag('--json'),
  allowLatest: hasFlag('--allow-latest'),
};

const PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'exit1-dev';
const PRICE_PER_VERSION_MONTH = 0.06;

// ---- auth / transport ----------------------------------------------------
let cachedToken;
async function token() {
  if (!cachedToken) cachedToken = (await applicationDefault().getAccessToken()).access_token;
  return cachedToken;
}

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

/** Page through a list endpoint, accumulating `key`. */
async function pageAll(baseUrl, key, pageSize = 100) {
  let out = [];
  let pageToken;
  do {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}pageSize=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = await api(url);
    out = out.concat(data[key] || []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// ---- consumers -----------------------------------------------------------
/**
 * Every deployed thing that pins a secret version, as a map of
 * "SECRET@version" -> [consumer labels]. Built from two independent sources so
 * neither one silently under-reporting can cause a bad destroy.
 */
async function getConsumers() {
  const refs = new Map();
  const latestPins = new Set();
  const add = (secret, version, consumer) => {
    const name = String(secret).split('/').pop();
    const v = version || 'latest';
    if (v === 'latest') latestPins.add(name);
    const key = `${name}@${v}`;
    if (!refs.has(key)) refs.set(key, []);
    refs.get(key).push(consumer);
  };

  // Source 1: Cloud Functions v2. `locations/-` DOES paginate correctly here.
  const fns = await pageAll(
    `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/-/functions`,
    'functions',
  );
  const regions = new Set();
  for (const f of fns) {
    const label = f.name.split('/').pop();
    regions.add(f.name.split('/')[3]);
    for (const s of f.serviceConfig?.secretEnvironmentVariables || []) add(s.secret, s.version, label);
    for (const vol of f.serviceConfig?.secretVolumes || []) {
      const versions = vol.versions || [];
      if (!versions.length) add(vol.secret, 'latest', label);
      for (const it of versions) add(vol.secret, it.version, label);
    }
  }

  // Source 2: Cloud Run, per region. Never `locations/-` (see header).
  const runServices = [];
  for (const region of regions) {
    const services = await pageAll(
      `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${region}/services`,
      'services',
    );
    runServices.push(...services);
    for (const s of services) {
      const label = s.name.split('/').pop();
      for (const c of s.template?.containers || []) {
        for (const e of c.env || []) {
          const r = e.valueSource?.secretKeyRef;
          if (r) add(r.secret, r.version, label);
        }
      }
      for (const vol of s.template?.volumes || []) {
        if (!vol.secret) continue;
        const items = vol.secret.items || [];
        if (!items.length) add(vol.secret.secret, 'latest', label);
        for (const it of items) add(vol.secret.secret, it.version, label);
      }
    }
  }

  return { refs, latestPins, fnCount: fns.length, runCount: runServices.length, regions: [...regions] };
}

/**
 * Every Gen2 function is backed by a Cloud Run service, so Run must cover at
 * least as many services as there are functions. Fewer means an enumeration
 * came back short and the orphan set cannot be trusted.
 */
function assertCoverage({ fnCount, runCount, regions }) {
  if (!fnCount) throw new Error('enumerated 0 functions — refusing to treat every version as an orphan');
  if (runCount < fnCount) {
    throw new Error(
      `consumer enumeration looks incomplete: ${runCount} Cloud Run services < ${fnCount} Gen2 functions ` +
        `across ${regions.join(', ')}. Refusing to compute orphans from a short list.`,
    );
  }
}

// ---- secrets -------------------------------------------------------------
async function getSecrets() {
  const secrets = await pageAll(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets`,
    'secrets',
  );
  const out = [];
  for (const s of secrets) {
    const name = s.name.split('/').pop();
    const versions = await pageAll(`https://secretmanager.googleapis.com/v1/${s.name}/versions`, 'versions');
    out.push({
      name,
      versions: versions.map((v) => ({
        id: Number(v.name.split('/').pop()),
        state: v.state,
        created: v.createTime,
      })),
    });
  }
  return out;
}

// ---- main ----------------------------------------------------------------
const consumers = await getConsumers();
assertCoverage(consumers);
const { refs, latestPins } = consumers;
const secrets = await getSecrets();

const orphans = [];
const unusedSecrets = [];
let enabledCount = 0;

for (const s of secrets) {
  const enabled = s.versions.filter((v) => v.state === 'ENABLED');
  enabledCount += enabled.length;
  const boundAnywhere = enabled.some((v) => refs.has(`${s.name}@${v.id}`)) || latestPins.has(s.name);
  if (!boundAnywhere) unusedSecrets.push(s.name);
  for (const v of enabled) {
    if (refs.has(`${s.name}@${v.id}`)) continue;
    // A `latest` pin can resolve to any version, so nothing under that secret is safe.
    if (latestPins.has(s.name)) continue;
    orphans.push({ secret: s.name, version: v.id, created: v.created });
  }
}

if (OPT.json) {
  console.log(JSON.stringify({ enabledCount, orphans, unusedSecrets, latestPins: [...latestPins] }, null, 2));
} else {
  console.log(`project ${PROJECT}: ${secrets.length} secrets, ${enabledCount} enabled versions`);
  console.log(
    `consumers: ${consumers.fnCount} functions / ${consumers.runCount} run services in ${consumers.regions.join(', ')}`,
  );
  console.log(`bound versions: ${refs.size}\n`);

  if (latestPins.size) {
    console.log(`WARNING: pinned to "latest", so their versions are never prunable: ${[...latestPins].join(', ')}\n`);
  }

  if (!orphans.length) {
    console.log('no orphaned versions');
  } else {
    console.log(
      `orphaned enabled versions (${orphans.length}), ~$${(orphans.length * PRICE_PER_VERSION_MONTH).toFixed(2)}/month:`,
    );
    for (const o of orphans) console.log(`   ${o.secret}@${o.version}   created ${o.created.slice(0, 10)}`);
  }
  if (unusedSecrets.length) {
    console.log(`\nsecrets with no consumer at all (${unusedSecrets.length}): ${unusedSecrets.join(', ')}`);
    if (!OPT.deleteUnused) console.log('   pass --delete-unused to remove these entirely');
  }
}

if (!OPT.apply) {
  if (!OPT.json && orphans.length) console.log('\nreport only. re-run via `npm run secrets:prune` to destroy these.');
  if (OPT.check && orphans.length) process.exit(1);
  process.exit(0);
}

if (latestPins.size && !OPT.allowLatest) {
  console.error('\nrefusing to prune: some secrets are pinned to "latest" (pass --allow-latest to override)');
  process.exit(1);
}

console.log('\ndestroying orphaned versions...');
let done = 0;
for (const o of orphans) {
  const name = `projects/${PROJECT}/secrets/${o.secret}/versions/${o.version}`;
  await api(`https://secretmanager.googleapis.com/v1/${name}:destroy`, { method: 'POST', body: '{}' });
  console.log(`   destroyed ${o.secret}@${o.version}`);
  done++;
}

if (OPT.deleteUnused) {
  for (const name of unusedSecrets) {
    await api(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}`, { method: 'DELETE' });
    console.log(`   deleted secret ${name}`);
    done++;
  }
}

console.log(`\n${done} change(s) applied, saving ~$${(done * PRICE_PER_VERSION_MONTH).toFixed(2)}/month`);
