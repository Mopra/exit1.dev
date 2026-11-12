/**
 * Write planning for the hourly public monitors refresh (public-monitors.ts).
 * Pure, so the rules are testable without Firestore.
 *
 * The refresh used to rewrite every page doc every hour. Almost nothing on a
 * page changes hour to hour except the two clock fields, so:
 *
 *   - a page doc is written only when a field other than `updatedAt` and
 *     `lastChecked` differs from the stored doc, and then only those fields
 *     (plus the clock fields) are sent;
 *   - the freshness of an unwritten page lives on the single index doc, which
 *     is written every run. getPublicMonitor lays it over the page it serves;
 *   - stale page docs are found by diffing the previous index against the new
 *     one, not by listing the collection.
 */

/** Clock fields: they move every run and say nothing about the page content. */
const VOLATILE_FIELDS = new Set(["updatedAt", "lastChecked"]);

/**
 * A page doc left untouched this long is rewritten anyway. Bounds how stale
 * the stored clock fields can get for anything that reads the doc directly.
 */
export const PAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Milliseconds for a Date or a Firestore Timestamp, else null. */
function timeValue(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (isPlainObject(v) && typeof v.toMillis === "function") {
    // Timestamps carry nanoseconds; two that differ below a millisecond differ.
    const nanos = typeof v.nanoseconds === "number" ? (v.nanoseconds % 1e6) / 1e6 : 0;
    return (v.toMillis as () => number).call(v) + nanos;
  }
  return null;
}

/**
 * Deep equality for Firestore data. Object key order does not matter, array
 * order does. Dates and Timestamps compare by value. A key holding undefined
 * counts as absent, since Firestore never stores it.
 */
export function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;

  const ta = timeValue(a);
  const tb = timeValue(b);
  if (ta != null || tb != null) return ta === tb;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => stableEqual(item, b[i]));
  }

  const oa = a as Plain;
  const ob = b as Plain;
  const keysA = Object.keys(oa).filter((k) => oa[k] !== undefined);
  const keysB = Object.keys(ob).filter((k) => ob[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => ob[k] !== undefined && stableEqual(oa[k], ob[k]));
}

/**
 * What to merge into a page doc, or null when the stored doc is already right.
 *
 * `stored` is the doc as read at the start of the build (undefined when it
 * does not exist). Fields equal to the stored ones are left out of the write,
 * which also keeps the transition push safe: it may change `status` after our
 * read, and a field we do not send cannot overwrite it. A push that landed
 * after the build began (statusChangedAt > buildStartedAt) is newer than our
 * snapshot of the check, so its status and lastChecked always win.
 */
export function planPageWrite<T extends { updatedAt: number; lastChecked: number }>(
  stored: Plain | undefined,
  page: T,
  buildStartedAt: number,
  now: number,
): Plain | null {
  if (!stored) return { ...page };

  const pushedAt = stored.statusChangedAt;
  const pushed = typeof pushedAt === "number" && pushedAt > buildStartedAt;

  const patch: Plain = {};
  for (const [key, value] of Object.entries(page)) {
    if (value === undefined || VOLATILE_FIELDS.has(key)) continue;
    if (pushed && key === "status") continue;
    if (!stableEqual(stored[key], value)) patch[key] = value;
  }

  const storedUpdatedAt = typeof stored.updatedAt === "number" ? stored.updatedAt : 0;
  if (!Object.keys(patch).length && now - storedUpdatedAt < PAGE_MAX_AGE_MS) return null;

  patch.updatedAt = page.updatedAt;
  const storedLastChecked = typeof stored.lastChecked === "number" ? stored.lastChecked : 0;
  if (!pushed && page.lastChecked > storedLastChecked) patch.lastChecked = page.lastChecked;
  return patch;
}

/**
 * Slugs that were in the previous index and are gone from the new one: their
 * page docs are stale. Returns null when the previous index is missing or not
 * readable, and the caller must fall back to listing the collection.
 */
export function stalePageSlugs(previousMonitors: unknown, liveSlugs: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(previousMonitors)) return null;
  const stale = new Set<string>();
  for (const entry of previousMonitors) {
    const slug = isPlainObject(entry) ? entry.slug : undefined;
    if (typeof slug !== "string" || !slug) return null;
    if (!liveSlugs.has(slug)) stale.add(slug);
  }
  return [...stale];
}

/**
 * Lay the index doc's clock over a stored page. The refresh confirms every
 * page each run but only writes the changed ones, so the index holds the
 * current `updatedAt` and last probe time. Never moves a value backwards: a
 * transition push writes the page later than the index.
 */
export function applyIndexFreshness<T extends { updatedAt?: number; lastChecked?: number }>(
  page: T,
  indexEntry: { lastChecked?: unknown } | undefined,
  indexUpdatedAt: unknown,
): T {
  if (!indexEntry) return page;
  const out = { ...page };
  if (typeof indexUpdatedAt === "number" && indexUpdatedAt > (page.updatedAt ?? 0)) {
    out.updatedAt = indexUpdatedAt;
  }
  if (typeof indexEntry.lastChecked === "number" && indexEntry.lastChecked > (page.lastChecked ?? 0)) {
    out.lastChecked = indexEntry.lastChecked;
  }
  return out;
}
