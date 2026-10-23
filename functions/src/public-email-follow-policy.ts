/**
 * Rules for email-only follows of public monitors. Pure, so they are testable
 * without Firestore.
 *
 * Anyone can type an address into a status page, so the address has to prove
 * it wants the mail (double opt-in) before it gets a single alert, and nobody
 * can use the form to bomb a stranger's inbox with confirmation emails.
 */

/** Confirmation emails one address can receive per window, across all services. */
export const MAX_CONFIRM_SENDS_PER_EMAIL = 5;
export const CONFIRM_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Pending follows nobody confirmed stop being confirmable after this. */
export const CONFIRM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_EMAIL_LENGTH = 254;

/** Deliberately loose: the confirmation email is the real validation. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z0-9-]{2,}$/i.test(email)) return null;
  return email;
}

export interface EmailSendWindow {
  windowStart: number;
  count: number;
}

export type ConfirmSendDecision =
  | { allowed: true; next: EmailSendWindow }
  | { allowed: false };

export function normalizeEmailSendWindow(raw: unknown): EmailSendWindow | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof d.windowStart !== "number" || typeof d.count !== "number") return null;
  return { windowStart: d.windowStart, count: d.count };
}

export function decideConfirmSend(window: EmailSendWindow | null, now: number): ConfirmSendDecision {
  if (!window || now - window.windowStart >= CONFIRM_SEND_WINDOW_MS) {
    return { allowed: true, next: { windowStart: now, count: 1 } };
  }
  if (window.count >= MAX_CONFIRM_SENDS_PER_EMAIL) return { allowed: false };
  return { allowed: true, next: { windowStart: window.windowStart, count: window.count + 1 } };
}

export function isConfirmTokenExpired(createdAt: number, now: number): boolean {
  return now - createdAt > CONFIRM_TOKEN_TTL_MS;
}
