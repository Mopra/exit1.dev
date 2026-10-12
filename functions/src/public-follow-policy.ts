/**
 * Decides whether followers of a public monitor get an email for a status
 * transition. Pure, so the rules are testable without Firestore.
 *
 * Followers are not the check's owner. They follow GitHub or npm from the
 * marketing site's status pages, so the bar is "tell me once, accurately":
 *
 *   - One email per transition. triggerAlert can be re-driven for the same
 *     transition (retries, the system health gate deferring it), so the last
 *     event we announced is the dedupe key.
 *   - Never announce recovery for an outage we never announced. The first
 *     probe of a check, or a down we throttled, ends in an up nobody needs.
 *   - A flapping service sends one down/up pair per window, not one per flap.
 *     A throttled down leaves the state alone, so its recovery is skipped too.
 */

export type FollowerEvent = 'website_down' | 'website_up';

export interface FollowerAlertState {
  lastEvent: FollowerEvent | null;
  /** When the last down email went out, ms. */
  lastDownAt: number | null;
}

export type FollowerDecision =
  | { send: true; next: FollowerAlertState }
  | { send: false; reason: 'duplicate' | 'no_prior_down' | 'flap_throttle' };

/** Minimum gap between two down emails for the same service. */
export const FOLLOWER_DOWN_THROTTLE_MS = 60 * 60 * 1000;

export function normalizeFollowerAlertState(raw: unknown): FollowerAlertState {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lastEvent = d.lastEvent === 'website_down' || d.lastEvent === 'website_up' ? d.lastEvent : null;
  const lastDownAt = typeof d.lastDownAt === 'number' ? d.lastDownAt : null;
  return { lastEvent, lastDownAt };
}

export function decideFollowerNotification(
  state: FollowerAlertState,
  event: FollowerEvent,
  now: number,
): FollowerDecision {
  if (state.lastEvent === event) return { send: false, reason: 'duplicate' };

  if (event === 'website_up') {
    if (state.lastEvent !== 'website_down') return { send: false, reason: 'no_prior_down' };
    return { send: true, next: { lastEvent: 'website_up', lastDownAt: state.lastDownAt } };
  }

  if (state.lastDownAt != null && now - state.lastDownAt < FOLLOWER_DOWN_THROTTLE_MS) {
    return { send: false, reason: 'flap_throttle' };
  }
  return { send: true, next: { lastEvent: 'website_down', lastDownAt: now } };
}
