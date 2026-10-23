/**
 * Outage windows for the public status pages (exit1.dev/status/<slug>/outages/<day>).
 * Pure, so the rules are testable without BigQuery or Firestore.
 *
 * History is sparse: a row is written on a confirmed status change, an hourly
 * sample while up, and when the second region is asked to confirm. So BigQuery
 * hands us islands of confirmed-offline rows, each ending at the next row of
 * any kind (in practice the confirmed recovery). Firewall blocks, 4xx answers,
 * maintenance and unconfirmed failures never count as offline. Rules here:
 *
 *   - Islands separated by a short recovery are one outage. A service that
 *     flaps for an hour had one bad hour, not twelve outages.
 *   - The hourly run only re-reads a few days of history (further back for an
 *     outage still open). Incidents older than that window are kept as stored.
 *   - `probes` counts history rows, not probes. Never show it as a probe count.
 */

export interface IncidentIsland {
  startedAt: number;
  lastFailedAt: number;
  /** The first probe after the island (a success), or null if none yet. */
  nextProbeAt: number | null;
  probes: number;
  statusCode: number | null;
  error: string | null;
  peerOfflineProbes: number;
}

export interface PublicIncident {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  ongoing: boolean;
  probes: number;
  statusCode: number | null;
  error: string | null;
  confirmedFromTwoRegions: boolean;
}

/** A confirmed offline row already passed the runner's confirmation gate, so one is enough. */
export const MIN_FAILED_PROBES = 1;
/** Islands closer than this merge into one outage. */
export const MERGE_GAP_MS = 10 * 60 * 1000;
/** Longer than the heartbeat: an indexed outage page should not 404 after 90 days. */
export const INCIDENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_INCIDENTS_PER_PAGE = 200;
const MAX_ERROR_LENGTH = 200;

function cleanError(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_ERROR_LENGTH ? `${s.slice(0, MAX_ERROR_LENGTH - 3)}...` : s;
}

/**
 * Islands (any order) for one check into incidents, newest first.
 * `currentlyDown` comes from the check doc: an island with no probe after it is
 * ongoing only if the check still says offline. Otherwise the recovery probe
 * just hasn't reached BigQuery yet, and the outage ends at its last failure.
 */
export function deriveIncidents(islands: IncidentIsland[], currentlyDown: boolean): PublicIncident[] {
  const sorted = islands.filter((i) => i.probes > 0).sort((a, b) => a.startedAt - b.startedAt);

  const merged: IncidentIsland[] = [];
  for (const island of sorted) {
    const prev = merged[merged.length - 1];
    const prevEnd = prev ? prev.nextProbeAt ?? prev.lastFailedAt : 0;
    if (prev && island.startedAt - prevEnd < MERGE_GAP_MS) {
      merged[merged.length - 1] = {
        startedAt: prev.startedAt,
        lastFailedAt: Math.max(prev.lastFailedAt, island.lastFailedAt),
        nextProbeAt: island.nextProbeAt,
        probes: prev.probes + island.probes,
        statusCode: prev.statusCode ?? island.statusCode,
        error: prev.error ?? island.error,
        peerOfflineProbes: prev.peerOfflineProbes + island.peerOfflineProbes,
      };
    } else {
      merged.push({ ...island });
    }
  }

  const out: PublicIncident[] = [];
  merged.forEach((m, i) => {
    if (m.probes < MIN_FAILED_PROBES) return;
    const isLast = i === merged.length - 1;
    const ongoing = isLast && m.nextProbeAt == null && currentlyDown;
    const endedAt = ongoing ? null : m.nextProbeAt ?? m.lastFailedAt;
    out.push({
      id: String(m.startedAt),
      startedAt: m.startedAt,
      endedAt,
      durationMs: (endedAt ?? m.lastFailedAt) - m.startedAt,
      ongoing,
      probes: m.probes,
      statusCode: m.statusCode && m.statusCode > 0 ? m.statusCode : null,
      error: cleanError(m.error),
      confirmedFromTwoRegions: m.peerOfflineProbes > 0,
    });
  });
  return out.reverse();
}

/** Tolerant read of incidents stored on a page doc. */
export function normalizeStoredIncidents(raw: unknown): PublicIncident[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicIncident[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const d = r as Record<string, unknown>;
    if (typeof d.startedAt !== "number" || typeof d.durationMs !== "number") continue;
    out.push({
      id: typeof d.id === "string" ? d.id : String(d.startedAt),
      startedAt: d.startedAt,
      endedAt: typeof d.endedAt === "number" ? d.endedAt : d.ongoing === true ? null : d.startedAt + d.durationMs,
      durationMs: d.durationMs,
      ongoing: d.ongoing === true,
      probes: typeof d.probes === "number" ? d.probes : 0,
      statusCode: typeof d.statusCode === "number" ? d.statusCode : null,
      error: typeof d.error === "string" ? d.error : null,
      confirmedFromTwoRegions: d.confirmedFromTwoRegions === true,
    });
  }
  return out;
}

/**
 * Fold a fresh read of [windowStart, now] into the stored history. Stored
 * incidents that began inside the window are replaced by the fresh ones. An
 * outage that began before the window shows up fresh with its start clipped to
 * the window edge; it takes over the stored start and id so its page URL and
 * duration stay true.
 */
export function mergeIncidentHistory(
  stored: PublicIncident[],
  fresh: PublicIncident[],
  windowStart: number,
  now: number,
): PublicIncident[] {
  const before = stored.filter((s) => s.startedAt < windowStart);
  const result: PublicIncident[] = [];
  const consumed = new Set<string>();

  for (const f of fresh) {
    const continued = before.find(
      (s) =>
        !consumed.has(s.id) &&
        f.startedAt - windowStart < MERGE_GAP_MS &&
        (s.endedAt == null || f.startedAt - s.endedAt < MERGE_GAP_MS),
    );
    if (continued) {
      consumed.add(continued.id);
      const end = f.endedAt;
      result.push({
        ...f,
        id: continued.id,
        startedAt: continued.startedAt,
        durationMs: (end ?? f.startedAt + f.durationMs) - continued.startedAt,
        // Both reads can cover the same rows, so a sum would double count.
        probes: Math.max(continued.probes, f.probes),
        statusCode: continued.statusCode ?? f.statusCode,
        error: continued.error ?? f.error,
        confirmedFromTwoRegions: continued.confirmedFromTwoRegions || f.confirmedFromTwoRegions,
      });
    } else {
      result.push(f);
    }
  }
  for (const s of before) {
    if (consumed.has(s.id)) continue;
    // A stored "ongoing" outage the fresh read no longer sees ended before the window.
    result.push(s.ongoing ? { ...s, ongoing: false, endedAt: s.startedAt + s.durationMs } : s);
  }

  return result
    .filter((i) => i.startedAt >= now - INCIDENT_RETENTION_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_INCIDENTS_PER_PAGE);
}
