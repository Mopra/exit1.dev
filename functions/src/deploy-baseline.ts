/**
 * Post-deploy baseline predicate, pure so it can be unit-tested
 * (__tests__/deploy-baseline.test.ts).
 *
 * After a deploy-mode window closes, the first probe of a check that has not
 * run since then re-establishes its status silently: no alert on any channel.
 *
 * `lastChecked === 0` is NOT "has not run since the deploy". Editing a check
 * (updateCheck, the public API PATCH, re-enable) writes `lastChecked: 0` to
 * force an immediate probe. Treating that 0 as "older than the deploy" made the
 * first transition after ANY edit silent. In production (2026-11-06, Lucas
 * Mariano) a user got the DOWN email, edited the check while it was down, and
 * the recovery a few seconds later was swallowed as a "post-deploy baseline"
 * even though the last deploy was eight days earlier. A brand-new or re-enabled
 * check also has `lastChecked: 0`, but its status is "unknown", and the alert
 * path never alerts on unknown→X anyway, so nothing relies on the 0 case.
 *
 * Still open (see the KNOWN BUG note in checks.ts): heartbeat-defer can leave a
 * real but stale `lastChecked` in Firestore, which this predicate cannot tell
 * apart from "not probed since the deploy".
 */
export function isPostDeployBaseline(lastChecked: unknown, deployModeDisabledAt: number): boolean {
  const last = Number(lastChecked ?? 0);
  if (!(deployModeDisabledAt > 0)) return false;
  if (!Number.isFinite(last) || last <= 0) return false;
  return last < deployModeDisabledAt;
}
