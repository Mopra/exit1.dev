import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

export interface BadgeUsageEventPayload {
  checkId: string;
  referer: string;
  domain: string | null;
  clientIp: string;
  timestamp: number;
}

interface BadgeUsageEvent extends BadgeUsageEventPayload {
  id: string;
}

interface FailureMeta {
  failures: number;
  nextRetryAt: number;
  firstFailureAt: number;
  lastErrorCode?: number | string;
  lastErrorMessage?: string;
}

interface FlushStats {
  successes: number;
  failures: number;
  dropped: number;
}

interface DomainSummary {
  firstSeen: number;
  lastSeen: number;
  viewCount: number;
}

interface SummaryDocument {
  totalViews?: number;
  lastViewed?: number;
  domains?: Record<string, DomainSummary>;
  recentEventIds?: string[];
  dailyViews?: Record<string, number>;
}

interface AggregatedCheckStats {
  events: BadgeUsageEvent[];
}

const badgeUsageBuffer = new Map<string, BadgeUsageEvent>();
const failureTracker = new Map<string, FailureMeta>();

const MAX_BUFFER_SIZE = 2000;
const MAX_PARALLEL_WRITES = 20;
const FIRESTORE_BATCH_SIZE = 400;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_DROP = 10;
const FAILURE_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_FLUSH_HIGH_WATERMARK = 250;
const MAX_DOMAINS_TRACKED = 200;
const MAX_RECENT_EVENT_IDS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY_VIEW_DAYS = 30;

let queuedFlushTimer: NodeJS.Timeout | null = null;
let queuedFlushTime = Infinity;
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;
let isShuttingDown = false;
let eventCounter = 0;

const nextEventId = () => {
  eventCounter = (eventCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${eventCounter.toString(36)}`;
};

const shutdownHandler = async (signal: string) => {
  isShuttingDown = true;
  if (queuedFlushTimer) {
    clearTimeout(queuedFlushTimer);
    queuedFlushTimer = null;
  }
  logger.info(`[badge-buffer] Received ${signal}, flushing badge usage buffer (${badgeUsageBuffer.size} pending)...`);

  while (badgeUsageBuffer.size > 0) {
    try {
      await flushBadgeUsageEvents();
    } catch (error) {
      logger.error("[badge-buffer] Error flushing during shutdown", error);
      break;
    }
  }
};

process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
process.on("SIGINT", () => shutdownHandler("SIGINT"));

export const queueBadgeUsageEvent = async (payload: BadgeUsageEventPayload): Promise<void> => {
  if (badgeUsageBuffer.size >= MAX_BUFFER_SIZE) {
    logger.warn(`[badge-buffer] Buffer at capacity (${badgeUsageBuffer.size}), forcing flush before enqueue`);
    try {
      await flushBadgeUsageEvents();
    } catch (error) {
      logger.error("[badge-buffer] Forced flush failed", error);
    }
  }

  const id = nextEventId();
  badgeUsageBuffer.set(id, { id, ...payload });
  failureTracker.delete(id);

  if (!isShuttingDown) {
    queueFlushAfter(200);
  }
};

export const flushBadgeUsageEvents = async (): Promise<void> => {
  if (badgeUsageBuffer.size === 0) {
    return;
  }

  if (isFlushing) {
    return currentFlushPromise || Promise.resolve();
  }

  isFlushing = true;
  currentFlushPromise = (async () => {
    const snapshot = Array.from(badgeUsageBuffer.entries());
    const readyEntries: Array<[string, BadgeUsageEvent]> = [];
    let skipped = 0;
    let dropped = 0;

    for (const entry of snapshot) {
      const state = evaluateEntryState(entry[0], entry[1]);
      if (state === "ready") {
        readyEntries.push(entry);
      } else if (state === "skipped") {
        skipped += 1;
      } else {
        dropped += 1;
      }
    }

    if (readyEntries.length === 0) {
      if (skipped || dropped) {
        logger.info(`[badge-buffer] No ready usage events (skipped=${skipped}, dropped=${dropped})`);
      }
      return;
    }

    const stats: FlushStats = {
      successes: 0,
      failures: 0,
      dropped,
    };

    for (let i = 0; i < readyEntries.length; i += FIRESTORE_BATCH_SIZE) {
      const chunk = readyEntries.slice(i, i + FIRESTORE_BATCH_SIZE);
      await processChunk(chunk, stats);
    }

    logger.info(
      `[badge-buffer] Flush complete: ${stats.successes} processed, ${stats.failures} deferred, dropped=${stats.dropped}, waiting=${skipped}`
    );
  })()
    .catch(error => {
      logger.error("[badge-buffer] Flush error", error);
    })
    .finally(() => {
      isFlushing = false;
      currentFlushPromise = null;

      if (badgeUsageBuffer.size > QUICK_FLUSH_HIGH_WATERMARK) {
        queueFlushAfter(200);
      }

      scheduleNextBackoffFlush();
    });

  return currentFlushPromise;
};

const processChunk = async (
  chunk: Array<[string, BadgeUsageEvent]>,
  stats: FlushStats
): Promise<void> => {
  if (chunk.length === 0) return;
  const processedIds = await applySummaryUpdates(chunk, stats);

  for (const [eventId, event] of chunk) {
    if (processedIds.has(eventId)) {
      markEntrySuccess(eventId, event);
      stats.successes += 1;
    }
  }
};

const applySummaryUpdates = async (
  entries: Array<[string, BadgeUsageEvent]>,
  stats: FlushStats
): Promise<Set<string>> => {
  const grouped = new Map<string, AggregatedCheckStats>();

  for (const [, event] of entries) {
    if (!grouped.has(event.checkId)) {
      grouped.set(event.checkId, { events: [] });
    }
    grouped.get(event.checkId)!.events.push(event);
  }

  const processedIds = new Set<string>();
  const groupEntries = Array.from(grouped.entries());

  for (let i = 0; i < groupEntries.length; i += MAX_PARALLEL_WRITES) {
    const batch = groupEntries.slice(i, i + MAX_PARALLEL_WRITES);
    await Promise.all(
      batch.map(async ([checkId, aggregated]) => {
        try {
          await updateSummaryForCheck(checkId, aggregated);
          aggregated.events.forEach(event => processedIds.add(event.id));
        } catch (error) {
          aggregated.events.forEach(event => {
            recordFailure(event.id, error);
            stats.failures += 1;
          });
          logger.error(`[badge-buffer] Failed to update badge summary for ${checkId}`, error);
        }
      })
    );
  }

  return processedIds;
};

const updateSummaryForCheck = async (checkId: string, aggregated: AggregatedCheckStats) => {
  const summaryRef = firestore.collection("badge_stats").doc(checkId);

  await firestore.runTransaction(async tx => {
    const snapshot = await tx.get(summaryRef);
    const existing = snapshot.data() as SummaryDocument | undefined;
    const now = Date.now();
    const domains: Record<string, DomainSummary> = existing?.domains
      ? { ...existing.domains }
      : {};
    const recentEventIds = existing?.recentEventIds ? [...existing.recentEventIds] : [];
    const dailyViews: Record<string, number> = existing?.dailyViews
      ? { ...existing.dailyViews }
      : {};

    let totalViews = existing?.totalViews ?? 0;
    let lastViewed = existing?.lastViewed ?? 0;

    const knownEvents = new Set(recentEventIds);
    const newEventIds: string[] = [];

    for (const event of aggregated.events) {
      if (knownEvents.has(event.id)) {
        continue;
      }

      totalViews += 1;
      lastViewed = Math.max(lastViewed, event.timestamp);

      const dayBucket = Math.floor(event.timestamp / DAY_MS) * DAY_MS;
      const dayKey = String(dayBucket);
      dailyViews[dayKey] = (dailyViews[dayKey] ?? 0) + 1;

      if (event.domain) {
        const normalizedDomain = event.domain;
        const current = domains[normalizedDomain] ?? {
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
          viewCount: 0,
        };
        current.firstSeen = Math.min(current.firstSeen ?? event.timestamp, event.timestamp);
        current.lastSeen = Math.max(current.lastSeen ?? event.timestamp, event.timestamp);
        current.viewCount = (current.viewCount ?? 0) + 1;
        domains[normalizedDomain] = current;
      }

      newEventIds.push(event.id);
      knownEvents.add(event.id);
    }

    const trimmedDailyViews = trimDailyViews(dailyViews, now);
    const dailyViewsChanged = Object.keys(trimmedDailyViews).length !== Object.keys(dailyViews).length;

    if (newEventIds.length === 0 && recentEventIds.length <= MAX_RECENT_EVENT_IDS && !dailyViewsChanged) {
      // Nothing new to apply.
      return;
    }

    const trimmedDomains = trimDomains(domains);
    const trimmedRecentIds = trimRecentEvents([...recentEventIds, ...newEventIds]);

    tx.set(
      summaryRef,
      {
        checkId,
        totalViews,
        lastViewed,
        updatedAt: now,
        domains: trimmedDomains,
        domainCount: Object.keys(trimmedDomains).length,
        recentEventIds: trimmedRecentIds,
        dailyViews: trimmedDailyViews,
      },
      { merge: true }
    );
  });
};

const trimDomains = (domains: Record<string, DomainSummary>): Record<string, DomainSummary> => {
  const entries = Object.entries(domains);
  if (entries.length <= MAX_DOMAINS_TRACKED) {
    return domains;
  }

  const trimmed = entries
    .sort(([, a], [, b]) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    .slice(0, MAX_DOMAINS_TRACKED);

  return trimmed.reduce<Record<string, DomainSummary>>((acc, [domain, summary]) => {
    acc[domain] = summary;
    return acc;
  }, {});
};

const trimRecentEvents = (eventIds: string[]): string[] => {
  if (eventIds.length <= MAX_RECENT_EVENT_IDS) {
    return eventIds;
  }
  return eventIds.slice(eventIds.length - MAX_RECENT_EVENT_IDS);
};

const trimDailyViews = (views: Record<string, number>, now: number): Record<string, number> => {
  const cutoff = now - MAX_DAILY_VIEW_DAYS * DAY_MS;
  const trimmedEntries = Object.entries(views).filter(([bucket]) => {
    const bucketValue = Number(bucket);
    if (!Number.isFinite(bucketValue)) {
      return false;
    }
    return bucketValue >= cutoff;
  });

  return trimmedEntries.reduce<Record<string, number>>((acc, [bucket, count]) => {
    acc[bucket] = count;
    return acc;
  }, {});
};

const calculateBackoffDelay = (failures: number): number => {
  if (failures <= 0) return BACKOFF_INITIAL_MS;
  const delay = BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return Math.min(delay, BACKOFF_MAX_MS);
};

const queueFlushAfter = (delayMs: number) => {
  queueFlushAt(Date.now() + Math.max(delayMs, 0));
};

const queueFlushAt = (targetTime: number) => {
  if (isShuttingDown) {
    return;
  }

  const now = Date.now();
  const delay = Math.max(targetTime - now, 0);

  if (queuedFlushTimer) {
    if (targetTime >= queuedFlushTime - 10) {
      return;
    }
    clearTimeout(queuedFlushTimer);
  }

  queuedFlushTime = targetTime;
  queuedFlushTimer = setTimeout(() => {
    queuedFlushTimer = null;
    queuedFlushTime = Infinity;
    flushBadgeUsageEvents().catch(error => logger.error("[badge-buffer] Error in scheduled flush", error));
  }, delay);
};

const scheduleNextBackoffFlush = () => {
  if (isShuttingDown) return;
  const now = Date.now();
  let earliest: number | null = null;

  for (const meta of failureTracker.values()) {
    if (meta.nextRetryAt <= now) {
      queueFlushAfter(0);
      return;
    }
    if (earliest === null || meta.nextRetryAt < earliest) {
      earliest = meta.nextRetryAt;
    }
  }

  if (earliest !== null) {
    queueFlushAt(earliest);
  }
};

const markEntrySuccess = (eventId: string, snapshot: BadgeUsageEvent) => {
  const current = badgeUsageBuffer.get(eventId);
  if (current && current === snapshot) {
    badgeUsageBuffer.delete(eventId);
  }
  failureTracker.delete(eventId);
};

const dropBufferedEntry = (eventId: string, snapshot: BadgeUsageEvent, reason: string) => {
  const current = badgeUsageBuffer.get(eventId);
  if (current && current === snapshot) {
    badgeUsageBuffer.delete(eventId);
  }
  failureTracker.delete(eventId);
  logger.warn(`[badge-buffer] Dropping badge usage event ${eventId}: ${reason}`);
};

const evaluateEntryState = (
  eventId: string,
  snapshot: BadgeUsageEvent
): "ready" | "skipped" | "dropped" => {
  const meta = failureTracker.get(eventId);
  if (!meta) return "ready";

  const now = Date.now();
  const exceededFailures = meta.failures >= MAX_FAILURES_BEFORE_DROP;
  const exceededTimeout = now - meta.firstFailureAt >= FAILURE_TIMEOUT_MS;

  if (exceededFailures || exceededTimeout) {
    dropBufferedEntry(eventId, snapshot, `max failures reached (${meta.failures})`);
    return "dropped";
  }

  if (now < meta.nextRetryAt) {
    return "skipped";
  }

  return "ready";
};

const recordFailure = (eventId: string, error: unknown) => {
  const now = Date.now();
  const previous = failureTracker.get(eventId);
  const failures = (previous?.failures ?? 0) + 1;
  const meta: FailureMeta = {
    failures,
    nextRetryAt: now + calculateBackoffDelay(failures),
    firstFailureAt: previous?.firstFailureAt ?? now,
    lastErrorCode: (error as { code?: number | string })?.code,
    lastErrorMessage: (error as Error)?.message,
  };

  failureTracker.set(eventId, meta);
  scheduleNextBackoffFlush();

  if (failures === 1 || failures === 3 || failures === 5 || failures >= MAX_FAILURES_BEFORE_DROP) {
    logger.warn(
      `[badge-buffer] Event ${eventId} failed ${failures} times; retrying in ${meta.nextRetryAt - now}ms`,
      { code: meta.lastErrorCode }
    );
  }
};


