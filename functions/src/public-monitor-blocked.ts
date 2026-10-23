/**
 * Public status pages must not report a site as down just because a bot
 * firewall refused our probe. Since the WAF detection shipped (2026-10-10), a
 * Cloudflare block or challenge page is recorded as an offline observation
 * with a describeWafBlock() error. For customer checks that is right (the
 * monitor is blind, so tell the owner). For the curated public pages it is
 * wrong: openai.com, medium.com and friends challenge every datacenter IP, so
 * "down" there only means "we could not see", never "the site is down".
 *
 * The same goes for a 4xx answer. homebrew.sh rate-limits us (429), codepen.io
 * and grok.com refuse datacenter IPs (403), a wrong probe path 404s. The
 * service answered and refused the probe, which is not an outage.
 *
 * These helpers turn those observations into "no data" for the public pages:
 * blocked rows leave the uptime math and a day made only of blocked rows is
 * "unknown" (grey), not "offline" (red). Pure so it can be unit-tested.
 */

/** Error prefixes written by describeWafBlock() in waf-block.ts. Keep in sync. */
export const WAF_BLOCK_ERROR_PREFIXES = [
  "Cloudflare challenge page (HTTP",
  "Blocked by Cloudflare firewall (HTTP",
] as const;

export const isWafBlockError = (error: unknown): boolean =>
  typeof error === "string" && WAF_BLOCK_ERROR_PREFIXES.some((p) => error.startsWith(p));

export const isRefusedStatusCode = (code: unknown): boolean =>
  typeof code === "number" && code >= 400 && code <= 499;

/** The probe was refused (firewall block or 4xx), so it says nothing about the service. */
export const isProbeRefusal = (error: unknown, statusCode: unknown): boolean =>
  isWafBlockError(error) || isRefusedStatusCode(statusCode);

export type PublicDay = {
  day: number;
  status: "online" | "offline" | "unknown";
  uptimePercentage: number | null;
  totalChecks: number;
  responseMs: number | null;
};

export type DayCounts = {
  totalChecks: number;
  onlineChecks: number;
  offlineChecks: number;
  hasIssues: boolean;
};

/**
 * Build a heartbeat day from the daily summary counts minus the blocked
 * observations (firewall blocks and 4xx). `blocked` rows are always offline rows, so they come off both
 * total and offline. Whatever offline rows remain are real downtime.
 */
export function buildPublicDay(
  day: number,
  counts: DayCounts,
  responseMs: number | null,
  blocked: number,
): PublicDay {
  // The summary's offline bucket can hold fewer rows than the raw offline
  // count (it skips a few classifications), so subtract from each side
  // independently rather than capping total at the offline bucket.
  const removed = Math.min(Math.max(blocked, 0), counts.totalChecks);
  const totalChecks = counts.totalChecks - removed;
  const offlineChecks = Math.max(counts.offlineChecks - removed, 0);
  const onlineChecks = Math.min(counts.onlineChecks, totalChecks);

  const uptimePercentage =
    totalChecks > 0 ? Math.round((onlineChecks / totalChecks) * 10000) / 100 : null;

  let status: PublicDay["status"];
  if (totalChecks <= 0) status = "unknown";
  else if (removed > 0) status = offlineChecks > 0 ? "offline" : "online";
  else status = counts.hasIssues ? "offline" : "online";

  // A day of only block pages timed Cloudflare's edge, not the site.
  return { day, status, uptimePercentage, totalChecks, responseMs: totalChecks > 0 ? responseMs : null };
}

/**
 * Current status for the public page. A check whose latest observation is a
 * refused probe is "unknown": we genuinely do not know if the site is up.
 */
export function publicCurrentStatus(status: string, lastError: unknown, lastStatusCode?: unknown): string {
  if (status === "offline" && isProbeRefusal(lastError, lastStatusCode)) return "unknown";
  return status;
}
