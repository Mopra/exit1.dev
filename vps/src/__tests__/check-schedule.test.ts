/**
 * fullResync must not fire a herd of probes.
 *
 * The Firestore copy of a check lags memory on purpose, so a resync that
 * trusted the doc's nextCheckAt saw most checks as overdue and ran them all
 * at once. These tests pin the merge rules that stop that.
 *
 * Run: npm test (in vps/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from '@google-cloud/firestore';
import {
  CheckSchedule,
  RESYNC_SPREAD_MAX_MS,
  RESYNC_SPREAD_THRESHOLD,
  docWasChangedElsewhere,
  mergeResyncedCheck,
  resyncSpreadDelayMs,
} from '../check-schedule.js';

type Doc = Record<string, unknown>;

const MIN = 60_000;
const T0 = 1_800_000_000_000;

/** Just enough Firestore for init() and fullResync(). */
function fakeFirestore(docs: Map<string, Doc>): Firestore {
  return {
    collection: () => ({
      where: () => ({
        get: async () => ({
          docs: [...docs.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) })),
        }),
      }),
    }),
  } as unknown as Firestore;
}

function checkDoc(over: Doc = {}): Doc {
  return {
    userId: 'user_1',
    name: 'Site',
    url: 'https://example.com',
    type: 'website',
    checkFrequency: 2,
    disabled: false,
    status: 'online',
    lastChecked: T0,
    nextCheckAt: T0 + 2 * MIN,
    checkRegion: 'vps-eu-1',
    ...over,
  };
}

async function scheduleWith(docs: Map<string, Doc>): Promise<CheckSchedule> {
  const schedule = new CheckSchedule();
  await schedule.init('vps-eu-1' as never, fakeFirestore(docs));
  return schedule;
}

const silence = () => {
  const original = console.info;
  console.info = () => {};
  return () => {
    console.info = original;
  };
};

test('resync keeps the in-memory schedule when the doc is only stale', async () => {
  const restore = silence();
  try {
    const docs = new Map<string, Doc>();
    for (let i = 0; i < 500; i++) docs.set(`c${i}`, checkDoc());
    const schedule = await scheduleWith(docs);

    // Six hours of probes land in memory. The docs are never rewritten.
    const now = T0 + 6 * 60 * MIN;
    for (let i = 0; i < 500; i++) {
      schedule.updateCheck(`c${i}`, { lastChecked: now - MIN, responseTime: 123 });
      schedule.updateNextCheckAt(`c${i}`, now + MIN + i);
    }
    assert.equal(schedule.getDueChecks(now).length, 0);

    await schedule.fullResync({ now });

    assert.equal(schedule.getDueChecks(now).length, 0, 'no stale doc may make a check due');
    const check = schedule.getCheck('c7')!;
    assert.equal(check.nextCheckAt, now + MIN + 7);
    assert.equal(check.lastChecked, now - MIN, 'lastChecked must not go back to the stale doc value');
    assert.equal(check.responseTime, 123);
    // All of them come due on their own time.
    assert.equal(schedule.getDueChecks(now + 2 * MIN).length, 500);
  } finally {
    restore();
  }
});

test('resync still takes config from the doc', async () => {
  const restore = silence();
  try {
    const docs = new Map<string, Doc>([['a', checkDoc()]]);
    const schedule = await scheduleWith(docs);
    const now = T0 + 60 * MIN;
    schedule.updateCheck('a', { lastChecked: now - MIN });
    schedule.updateNextCheckAt('a', now + MIN);

    docs.set('a', checkDoc({ name: 'Renamed', userTier: 'pro', responseTimeLimit: 900 }));
    await schedule.fullResync({ now });

    const check = schedule.getCheck('a')!;
    assert.equal(check.name, 'Renamed');
    assert.equal(check.userTier, 'pro');
    assert.equal(check.responseTimeLimit, 900);
    assert.equal(check.nextCheckAt, now + MIN);
  } finally {
    restore();
  }
});

test('resync takes the doc for an edit the listener missed', async () => {
  const restore = silence();
  try {
    const docs = new Map<string, Doc>([
      ['edited', checkDoc()],
      ['checkNow', checkDoc()],
      ['disabled', checkDoc()],
      ['untouched', checkDoc()],
    ]);
    const schedule = await scheduleWith(docs);
    const now = T0 + 60 * MIN;
    for (const id of docs.keys()) {
      schedule.updateCheck(id, { lastChecked: now - MIN });
      schedule.updateNextCheckAt(id, now + MIN);
    }

    docs.set('edited', checkDoc({ checkFrequency: 5, lastChecked: 0, nextCheckAt: now - 10 }));
    docs.set('checkNow', checkDoc({ lastChecked: 0, nextCheckAt: now - 10 }));
    docs.set('disabled', checkDoc({ disabled: true }));
    await schedule.fullResync({ now });

    const due = schedule.getDueChecks(now).map((c) => c.id).sort();
    assert.deepEqual(due, ['checkNow', 'edited'], 'a few real edits run at once, unspread');
    assert.equal(schedule.getCheck('edited')!.checkFrequency, 5);
    assert.equal(schedule.getCheck('edited')!.lastChecked, 0);
    assert.equal(schedule.getCheck('disabled')!.disabled, true);
    assert.equal(schedule.getDueChecks(now + 60 * MIN).some((c) => c.id === 'disabled'), false);
    assert.equal(schedule.getCheck('untouched')!.nextCheckAt, now + MIN);
  } finally {
    restore();
  }
});

test('resync adds new checks from the doc and drops deleted ones', async () => {
  const restore = silence();
  try {
    const docs = new Map<string, Doc>([
      ['old', checkDoc()],
      ['gone', checkDoc()],
    ]);
    const schedule = await scheduleWith(docs);
    const now = T0 + 60 * MIN;
    schedule.updateNextCheckAt('old', now + MIN);

    docs.delete('gone');
    docs.set('fresh', checkDoc({ lastChecked: 0, nextCheckAt: now - 5 }));
    await schedule.fullResync({ now });

    assert.equal(schedule.getCheck('gone'), undefined);
    assert.deepEqual(schedule.getDueChecks(now).map((c) => c.id), ['fresh']);
  } finally {
    restore();
  }
});

test('the resync callback still gets the raw doc', async () => {
  const restore = silence();
  try {
    const docs = new Map<string, Doc>([['a', checkDoc()]]);
    const schedule = await scheduleWith(docs);
    const now = T0 + 60 * MIN;
    schedule.updateCheck('a', { lastChecked: now - MIN });
    schedule.updateNextCheckAt('a', now + MIN);

    const seen: Doc[] = [];
    schedule.setCheckResyncedCallback((_id, doc) => seen.push({ ...doc }));
    await schedule.fullResync({ now });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].lastChecked, T0, 'reconcile needs what Firestore holds, not memory');
    assert.equal(seen[0].nextCheckAt, T0 + 2 * MIN);
  } finally {
    restore();
  }
});

test('a herd of overdue checks from Firestore is spread with jitter', async () => {
  const restore = silence();
  try {
    const schedule = await scheduleWith(new Map());
    const now = T0 + 60 * MIN;
    const count = 400;
    const docs = new Map<string, Doc>();
    for (let i = 0; i < count; i++) {
      docs.set(`n${i}`, checkDoc({ checkFrequency: i % 2 === 0 ? 2 : 60, nextCheckAt: now - 30 * MIN }));
    }
    // Swap the store under the schedule: every check is new to memory.
    (schedule as unknown as { firestoreRef: Firestore }).firestoreRef = fakeFirestore(docs);

    let n = 0;
    const random = () => (n++ % 100) / 100;
    await schedule.fullResync({ now, random });

    const dueNow = schedule.getDueChecks(now).length;
    assert.ok(dueNow <= count / 50, `only a sliver may be due at once, got ${dueNow}`);
    assert.equal(schedule.getDueChecks(now + RESYNC_SPREAD_MAX_MS).length, count, 'all run within the cap');
    for (let i = 0; i < count; i++) {
      const check = schedule.getCheck(`n${i}`)!;
      const windowMs = Math.min(check.checkFrequency * MIN, RESYNC_SPREAD_MAX_MS);
      assert.ok(check.nextCheckAt >= now && check.nextCheckAt < now + windowMs);
    }
    // No minute in the window carries more than a fair share of the herd.
    const perMinute = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const minute = Math.floor((schedule.getCheck(`n${i}`)!.nextCheckAt - now) / MIN);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    assert.ok(Math.max(...perMinute.values()) <= count * 0.4, "no minute takes more than 40% of the herd");
  } finally {
    restore();
  }
});

test('a handful of overdue checks is not delayed', async () => {
  const restore = silence();
  try {
    const schedule = await scheduleWith(new Map());
    const now = T0 + 60 * MIN;
    const docs = new Map<string, Doc>();
    for (let i = 0; i < RESYNC_SPREAD_THRESHOLD; i++) docs.set(`n${i}`, checkDoc({ nextCheckAt: now - MIN }));
    (schedule as unknown as { firestoreRef: Firestore }).firestoreRef = fakeFirestore(docs);

    await schedule.fullResync({ now, random: () => 0.99 });

    assert.equal(schedule.getDueChecks(now).length, RESYNC_SPREAD_THRESHOLD);
  } finally {
    restore();
  }
});

test('docWasChangedElsewhere tells a stale doc from a foreign write', () => {
  const prev = checkDoc({ lastChecked: T0 + 10 * MIN, nextCheckAt: T0 + 12 * MIN });
  assert.equal(docWasChangedElsewhere(prev, checkDoc()), false, 'older doc is just stale');
  assert.equal(docWasChangedElsewhere(prev, { ...prev }), false);
  assert.equal(docWasChangedElsewhere(prev, checkDoc({ lastChecked: 0 })), true, 'edit reset');
  assert.equal(docWasChangedElsewhere(prev, checkDoc({ lastChecked: T0 + 11 * MIN })), true, 'doc ahead');
  assert.equal(docWasChangedElsewhere(prev, checkDoc({ nextCheckAt: T0 + 20 * MIN })), true, 'doc scheduled later');
  assert.equal(docWasChangedElsewhere(prev, checkDoc({ url: 'https://other.example' })), true);
  assert.equal(docWasChangedElsewhere(prev, checkDoc({ maintenanceMode: true })), true);
  // Missing and false or null mean the same thing only when both are absent.
  assert.equal(docWasChangedElsewhere({ ...prev, maintenanceMode: undefined }, checkDoc({ maintenanceMode: null })), false);
});

test('mergeResyncedCheck keeps probe state and pairs the certificate with its alert state', () => {
  const prev = checkDoc({
    lastChecked: T0 + 10 * MIN,
    nextCheckAt: T0 + 12 * MIN,
    status: 'offline',
    consecutiveFailures: 3,
    pendingDownEmail: true,
    sslCertificate: { valid: true, lastChecked: T0 + 5 * MIN },
    sslAlertedState: 'warning',
  });

  const stale = checkDoc({
    name: 'Renamed',
    sslCertificate: { valid: false, lastChecked: T0 },
    sslAlertedState: 'ok',
  });
  const merged = mergeResyncedCheck(prev, stale);
  assert.equal(merged.kept, true);
  assert.equal(merged.check.name, 'Renamed');
  assert.equal(merged.check.status, 'offline');
  assert.equal(merged.check.consecutiveFailures, 3);
  assert.equal(merged.check.pendingDownEmail, true);
  assert.equal(merged.check.sslCertificate.valid, true);
  assert.equal(merged.check.sslAlertedState, 'warning');
  assert.notEqual(merged.check, stale, 'the raw doc is not mutated');
  assert.equal(stale.status, 'online');

  // A cron refreshed the certificate after the runner last saw it.
  const cronDoc = checkDoc({
    sslCertificate: { valid: false, lastChecked: T0 + 8 * MIN },
    sslAlertedState: 'expired',
  });
  const fromCron = mergeResyncedCheck(prev, cronDoc);
  assert.equal(fromCron.kept, true);
  assert.equal(fromCron.check.sslCertificate.valid, false);
  assert.equal(fromCron.check.sslAlertedState, 'expired');

  assert.deepEqual(mergeResyncedCheck(undefined, stale), { check: stale, kept: false });
  assert.equal(mergeResyncedCheck(prev, checkDoc({ lastChecked: 0 })).kept, false);
});

test('resyncSpreadDelayMs stays inside one interval and the cap', () => {
  assert.equal(resyncSpreadDelayMs({ checkFrequency: 2 }, () => 0), 0);
  assert.equal(resyncSpreadDelayMs({ checkFrequency: 2 }, () => 0.5), MIN);
  assert.ok(resyncSpreadDelayMs({ checkFrequency: 2 }, () => 0.999999) < 2 * MIN);
  assert.ok(resyncSpreadDelayMs({ checkFrequency: 60 }, () => 0.999999) < RESYNC_SPREAD_MAX_MS);
  assert.ok(resyncSpreadDelayMs({}, () => 0.999999) < RESYNC_SPREAD_MAX_MS);
});
