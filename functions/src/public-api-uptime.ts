// Opt-in uptime figures on GET /v1/public/checks?include=uptime.
//
// Each listed check gains uptime24h, uptime30d and avgResponseTime24h. The two
// windows come from different sources so a 100-check page stays cheap:
// - 24h: one raw history scan over the page's ids (duration-weighted, like the
//   dashboard's 24h figure).
// - 30d: check_daily_summaries, chunked, so every id is answered.
// Results are cached per check, so a poller re-reading the same page hits
// BigQuery at most once per TTL.

export const LIST_INCLUDE_OPTIONS = new Set(['uptime']);

/** Parses ?include=a,b. Throws on an unknown option. */
export function parseIncludeParam(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== 'string' || !raw.trim()) return out;
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (!LIST_INCLUDE_OPTIONS.has(name)) {
      throw new Error(`Invalid include: ${name}. Allowed: ${[...LIST_INCLUDE_OPTIONS].join(', ')}`);
    }
    out.add(name);
  }
  return out;
}

export interface Window24h {
  uptime: number | null;
  avgResponseTime: number | null;
}

export interface UptimeFetchers {
  /** Raw 24h stats for the given ids. Missing ids mean no data. */
  fetch24h: (ids: string[]) => Promise<Map<string, Window24h>>;
  /** 30d uptime % for the given ids. Missing ids mean no data. */
  fetch30d: (ids: string[]) => Promise<Map<string, number>>;
}

export interface UptimeFields {
  uptime24h: number | null;
  uptime30d: number | null;
  avgResponseTime24h: number | null;
}

export const UPTIME_24H_TTL_MS = 5 * 60 * 1000;
export const UPTIME_30D_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 20000;

type Entry<T> = { value: T; expiresAt: number };

export class UptimeCache {
  private h24 = new Map<string, Entry<Window24h>>();
  private d30 = new Map<string, Entry<number | null>>();

  constructor(private now: () => number = Date.now) {}

  /** Attaches the uptime fields for each id, fetching only cache misses. */
  async lookup(userId: string, ids: string[], fetchers: UptimeFetchers): Promise<Map<string, UptimeFields>> {
    const now = this.now();
    const key = (id: string) => `${userId}::${id}`;
    const fresh = <T>(map: Map<string, Entry<T>>, id: string) => {
      const e = map.get(key(id));
      return e && e.expiresAt > now ? e : undefined;
    };

    const miss24 = ids.filter(id => !fresh(this.h24, id));
    const miss30 = ids.filter(id => !fresh(this.d30, id));

    const [got24, got30] = await Promise.all([
      miss24.length ? fetchers.fetch24h(miss24) : Promise.resolve(new Map<string, Window24h>()),
      miss30.length ? fetchers.fetch30d(miss30) : Promise.resolve(new Map<string, number>()),
    ]);

    for (const id of miss24) {
      this.h24.set(key(id), { value: got24.get(id) ?? { uptime: null, avgResponseTime: null }, expiresAt: now + UPTIME_24H_TTL_MS });
    }
    for (const id of miss30) {
      this.d30.set(key(id), { value: got30.get(id) ?? null, expiresAt: now + UPTIME_30D_TTL_MS });
    }
    if (this.h24.size > CACHE_MAX) this.h24.clear();
    if (this.d30.size > CACHE_MAX) this.d30.clear();

    const out = new Map<string, UptimeFields>();
    for (const id of ids) {
      const w24 = got24.get(id) ?? fresh(this.h24, id)?.value ?? { uptime: null, avgResponseTime: null };
      const u30 = got30.has(id) ? got30.get(id)! : fresh(this.d30, id)?.value ?? null;
      out.set(id, {
        uptime24h: roundPct(w24.uptime),
        uptime30d: roundPct(u30),
        avgResponseTime24h: w24.avgResponseTime === null ? null : Math.round(w24.avgResponseTime),
      });
    }
    return out;
  }
}

function roundPct(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
}
