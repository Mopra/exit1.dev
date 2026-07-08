// ============================================================================
// EMAIL SUPPRESSION POLICY (pure logic — no Firestore, no I/O)
//
// Decides when a recipient address should stop receiving alert emails based
// on bounce/complaint events from Resend. Mirrors the ssl-alert-state.ts
// pattern: the durable state lives in Firestore (emailSuppressions), this
// module only computes transitions so the policy is unit-testable.
//
// Policy:
// - Permanent bounce or spam complaint → suppress indefinitely until the
//   user explicitly resumes the address from the Emails settings page.
// - Transient bounces → suppress on the FIRST bounce (a bounce usually means
//   a mistyped address, so we block and notify the owner right away) with
//   escalating backoff: each episode pauses for BASE_SUPPRESSION_MS doubling
//   per episode, capped at MAX_SUPPRESSION_MS. Transient mailboxes sometimes
//   recover (greylisting, full inbox), so the pause expires on its own; if
//   the address keeps bouncing the next pause is longer.
// ============================================================================

export type BounceKind = 'permanent' | 'transient' | 'complaint';

export interface EmailSuppressionState {
  email: string;
  /** Hard bounce or complaint — suppressed until manually cleared. */
  permanent: boolean;
  /** Epoch ms until which transient suppression is active (null = none). */
  suppressedUntil: number | null;
  /** Transient bounces observed in the current rolling window. */
  transientCount: number;
  /** Start of the current transient-bounce window (epoch ms). */
  windowStart: number;
  /** How many transient suppression episodes have occurred (backoff exponent). */
  escalations: number;
  lastBounceKind: BounceKind;
  lastBounceAt: number;
  lastReason: string | null;
  totalBounces: number;
  createdAt: number;
  updatedAt: number;
}

export interface BounceTransition {
  state: EmailSuppressionState;
  /** True when this event moved the address from deliverable to suppressed. */
  becameSuppressed: boolean;
}

export const TRANSIENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
export const TRANSIENT_THRESHOLD = 1; // first bounce blocks + notifies
export const BASE_SUPPRESSION_MS = 6 * 60 * 60 * 1000; // 6h first episode
export const MAX_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7d cap

/**
 * Canonical form used as the suppression key: the bare addr-spec, trimmed and
 * lowercased. Accepts RFC 5322 "Display Name <addr>" strings — recipients can
 * be stored that way in settings, and Resend echoes the same form back in
 * webhook payloads — so both sides of the pipeline key on the same doc.
 */
export const normalizeEmail = (email: string): string => {
  const trimmed = email.trim();
  const angled = trimmed.match(/<([^<>]*)>\s*$/);
  return (angled ? angled[1] : trimmed).trim().toLowerCase();
};

export const isSuppressed = (
  state: Pick<EmailSuppressionState, 'permanent' | 'suppressedUntil'> | null | undefined,
  now: number
): boolean => {
  if (!state) return false;
  if (state.permanent) return true;
  return state.suppressedUntil !== null && state.suppressedUntil > now;
};

export const suppressionDurationForEscalation = (escalations: number): number => {
  // escalations counts completed episodes; the next episode doubles each time.
  const duration = BASE_SUPPRESSION_MS * Math.pow(2, Math.max(0, escalations));
  return Math.min(duration, MAX_SUPPRESSION_MS);
};

export const applyBounceEvent = (
  prev: EmailSuppressionState | null,
  email: string,
  kind: BounceKind,
  now: number,
  reason?: string | null
): BounceTransition => {
  const wasSuppressed = isSuppressed(prev, now);

  const base: EmailSuppressionState = prev
    ? { ...prev }
    : {
        email: normalizeEmail(email),
        permanent: false,
        suppressedUntil: null,
        transientCount: 0,
        windowStart: now,
        escalations: 0,
        lastBounceKind: kind,
        lastBounceAt: now,
        lastReason: reason ?? null,
        totalBounces: 0,
        createdAt: now,
        updatedAt: now,
      };

  base.lastBounceKind = kind;
  base.lastBounceAt = now;
  base.lastReason = reason ?? null;
  base.totalBounces += 1;
  base.updatedAt = now;

  if (kind === 'permanent' || kind === 'complaint') {
    base.permanent = true;
  } else {
    // Transient: roll the window if it expired, then count.
    if (now - base.windowStart > TRANSIENT_WINDOW_MS) {
      base.windowStart = now;
      base.transientCount = 0;
    }
    base.transientCount += 1;

    const alreadyPaused = base.suppressedUntil !== null && base.suppressedUntil > now;
    if (!alreadyPaused && base.transientCount >= TRANSIENT_THRESHOLD) {
      base.suppressedUntil = now + suppressionDurationForEscalation(base.escalations);
      base.escalations += 1;
      // Reset the window so bounces during the pause don't immediately
      // re-trigger the moment the pause expires.
      base.transientCount = 0;
      base.windowStart = now;
    }
  }

  return {
    state: base,
    becameSuppressed: !wasSuppressed && isSuppressed(base, now),
  };
};
