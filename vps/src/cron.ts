/**
 * Scheduled jobs, run on the VPSes instead of as Cloud Functions.
 *
 * These used to be eight onSchedule Cloud Functions. Each run paid a ~3.5s
 * cold start (the whole functions bundle loads per instance), most of their
 * Cloud Run CPU bill, and five Cloud Scheduler jobs beyond the free three.
 * The VPSes are always on and mostly idle, so here the same code costs
 * nothing extra.
 *
 * Both regions run this host. A run is claimed per job per slot through a
 * transaction on `cron_runs/{job}`, so exactly one VPS runs each slot and the
 * other takes over when one is down. The claim carries a lease: a run that
 * dies with its VPS (crash, deploy restart) is picked up by either VPS once
 * the lease expires. A failed run is not retried before its next slot, same
 * as the Cloud Scheduler jobs it replaces.
 *
 * Firestore cost: one transaction per job per slot per VPS (~120/day), plus
 * one read a minute on the VPS that is waiting out a live lease held by the
 * other.
 *
 * Set VPS_CRON_DISABLED=1 to keep a VPS out of the rotation.
 */
import type { Firestore } from '@google-cloud/firestore';

type JobSpec = {
  name: string;
  /** UTC hours the job runs at; omitted means every hour. */
  hours?: number[];
  /** Minute past the hour. Staggered so jobs don't all start together. */
  minute: number;
  /** How long a claim holds before another VPS may take the slot over. */
  leaseMs: number;
  run: () => Promise<unknown>;
};

const every6h = [0, 6, 12, 18];
const MIN = 60_000;

// functions/lib has no .d.ts files; types are verified at the source level.
const JOBS: JobSpec[] = [
  {
    name: 'publicMonitorsRefresh', minute: 5, leaseMs: 30 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/public-monitors.js')).runPublicMonitorsRefresh(),
  },
  {
    name: 'publicChecksStatsRefresh', minute: 15, leaseMs: 15 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/public-stats.js')).runPublicChecksStatsRefresh(),
  },
  {
    name: 'securityMetadataRefresh', hours: every6h, minute: 20, leaseMs: 60 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/security-refresh.js')).runSecurityMetadataRefresh(),
  },
  {
    name: 'domainExpiryCheck', hours: every6h, minute: 40, leaseMs: 30 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/domain-intelligence.js')).runDomainExpiryCheck(),
  },
  {
    name: 'dailySummaryAggregation', hours: [2, 14], minute: 0, leaseMs: 30 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/history.js')).runDailySummaryAggregation(),
  },
  {
    name: 'targetMetadataRefresh', hours: [3], minute: 30, leaseMs: 60 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/target-metadata-refresh.js')).runTargetMetadataRefresh(),
  },
  {
    name: 'bigQueryHistoryPurge', hours: [4], minute: 10, leaseMs: 30 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/history.js')).runBigQueryHistoryPurge(),
  },
  {
    name: 'lifecycleSweep', hours: [7], minute: 0, leaseMs: 60 * MIN,
    // @ts-expect-error: functions/lib has no .d.ts
    run: async () => (await import('../../functions/lib/lifecycle.js')).runScheduledLifecycleSweep(),
  },
];

/** Start of the most recent slot at or before `now`, in ms. */
export function latestSlot(spec: Pick<JobSpec, 'hours' | 'minute'>, now: number): number {
  const d = new Date(now);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), spec.minute);
  for (let back = 0; back <= 48; back++) {
    const t = base - back * 60 * MIN;
    if (t > now) continue;
    if (!spec.hours || spec.hours.includes(new Date(t).getUTCHours())) return t;
  }
  throw new Error(`no slot within 48h for minute ${spec.minute}`);
}

type ClaimDoc = {
  lastSlot?: number;
  status?: 'running' | 'done';
  leaseUntil?: number;
};

type ClaimResult = 'claimed' | 'done' | 'busy' | 'seeded';

/** Pure claim decision, separated out for tests. */
export function decideClaim(doc: ClaimDoc | null, slot: number, now: number): ClaimResult {
  // First sight of a job: mark the current slot done instead of running it,
  // so a fresh deploy doesn't replay every job (the Cloud Function it
  // replaces has most likely already run this slot).
  if (!doc) return 'seeded';
  if (doc.status === 'running' && (doc.leaseUntil ?? 0) > now) return 'busy';
  if ((doc.lastSlot ?? 0) >= slot && doc.status === 'done') return 'done';
  return 'claimed';
}

export function startCronHost(firestore: Firestore, owner: string): () => void {
  if (process.env.VPS_CRON_DISABLED === '1') {
    console.info('[cron] disabled on this VPS (VPS_CRON_DISABLED=1)');
    return () => {};
  }

  const col = firestore.collection('cron_runs');
  // Slots this VPS knows are finished, so it doesn't ask Firestore again.
  const knownDone = new Map<string, number>();
  const running = new Set<string>();
  let stopped = false;

  const claim = (job: JobSpec, slot: number): Promise<ClaimResult> =>
    firestore.runTransaction(async (tx) => {
      const ref = col.doc(job.name);
      const snap = await tx.get(ref);
      const now = Date.now();
      const decision = decideClaim(snap.exists ? (snap.data() as ClaimDoc) : null, slot, now);
      if (decision === 'seeded') {
        tx.set(ref, { lastSlot: slot, status: 'done', seededAt: now, owner });
      } else if (decision === 'claimed') {
        tx.set(ref, {
          lastSlot: slot, status: 'running', leaseUntil: now + job.leaseMs, owner, startedAt: now,
        }, { merge: true });
      }
      return decision;
    });

  const runJob = async (job: JobSpec, slot: number) => {
    running.add(job.name);
    const startedAt = Date.now();
    let error: string | null = null;
    console.info(`[cron] ${job.name} starting (slot ${new Date(slot).toISOString()})`);
    try {
      await job.run();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[cron] ${job.name} failed:`, err);
    } finally {
      running.delete(job.name);
    }
    const durationMs = Date.now() - startedAt;
    console.info(`[cron] ${job.name} finished in ${Math.round(durationMs / 1000)}s${error ? ' (failed)' : ''}`);
    knownDone.set(job.name, slot);
    try {
      await col.doc(job.name).set({
        status: 'done', leaseUntil: 0, finishedAt: Date.now(), durationMs, lastError: error, owner,
      }, { merge: true });
    } catch (err) {
      // The lease runs out on its own; the worst case is one rerun.
      console.warn(`[cron] ${job.name} could not record completion:`, err);
    }
  };

  const tick = async () => {
    const now = Date.now();
    for (const job of JOBS) {
      if (stopped) return;
      if (running.has(job.name)) continue;
      const slot = latestSlot(job, now);
      if ((knownDone.get(job.name) ?? 0) >= slot) continue;
      let decision: ClaimResult;
      try {
        decision = await claim(job, slot);
      } catch (err) {
        console.warn(`[cron] ${job.name} claim failed, retrying next tick:`, err);
        continue;
      }
      if (decision === 'claimed') {
        void runJob(job, slot);
      } else if (decision === 'done' || decision === 'seeded') {
        knownDone.set(job.name, slot);
        if (decision === 'seeded') console.info(`[cron] ${job.name} seeded at slot ${new Date(slot).toISOString()}`);
      }
      // 'busy': the other VPS holds a live lease; ask again next tick.
    }
  };

  const timer = setInterval(() => {
    tick().catch((err) => console.warn('[cron] tick failed:', err));
  }, MIN);
  console.info(`[cron] host started for ${JOBS.length} jobs as ${owner}`);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
