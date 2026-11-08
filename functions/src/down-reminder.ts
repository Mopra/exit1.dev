/**
 * "Still down" reminder emails and the downtime figure in recovery emails.
 *
 * Pure apart from one in-memory map. No firestore, no firebase-admin, so it is
 * unit-tested directly (__tests__/down-reminder.test.ts).
 *
 * Reminders are opt-in per user (`emailSettings.downReminderIntervalMinutes`,
 * default off). They ride the runner's existing probe cycle: every probe of a
 * check that is still confirmed offline asks `isDownReminderDue`, and only a
 * due reminder costs anything (one Firestore read in verifyAlertable plus the
 * usual throttle and budget bookkeeping). There is no polling loop of its own.
 *
 * The "last down email" clock lives in runner memory, keyed by check id. It is
 * set when a check goes down and every time a reminder is attempted. After a
 * runner restart the map is empty and the clock falls back to the check's
 * `lastStatusChange` (when it went down), so the worst case is one reminder
 * that arrives a little early after a deploy. That is cheaper than persisting
 * a timestamp on every reminder through the status buffer.
 */

/** Intervals offered in the app. Anything else normalizes to 0 (off). */
export const DOWN_REMINDER_INTERVALS_MINUTES = [10, 30, 60] as const;
export type DownReminderIntervalMinutes = 0 | (typeof DOWN_REMINDER_INTERVALS_MINUTES)[number];

/**
 * Reminders may only use this share of the hourly and monthly email budgets, so
 * a long outage across many checks can never starve a real DOWN alert.
 */
export const DOWN_REMINDER_BUDGET_SHARE = 0.5;

export function normalizeDownReminderInterval(value: unknown): DownReminderIntervalMinutes {
  const n = typeof value === "string" ? Number(value) : value;
  return (DOWN_REMINDER_INTERVALS_MINUTES as readonly unknown[]).includes(n)
    ? (n as DownReminderIntervalMinutes)
    : 0;
}

/**
 * When the outage began, for "down for X" copy. Prefers the first failed probe
 * of the streak (`lastFailureTime`), which is what the user experienced, and
 * falls back to the confirmed transition time. Returns undefined when neither
 * is a usable past timestamp.
 */
export function resolveDownSince(
  check: { lastFailureTime?: number | null; lastStatusChange?: number | null },
  now: number,
): number | undefined {
  for (const candidate of [check.lastFailureTime, check.lastStatusChange]) {
    if (typeof candidate === "number" && candidate > 0 && candidate <= now) return candidate;
  }
  return undefined;
}

/**
 * Is a reminder due for a check that is still confirmed offline?
 *
 * The clock starts at the later of the last down email we know about (this
 * process) and the check's `lastStatusChange` (the down transition). Using the
 * later of the two means a stale map entry from an earlier outage can never
 * fire a reminder right after a fresh DOWN alert.
 */
export function isDownReminderDue(args: {
  now: number;
  intervalMinutes: number;
  lastStatusChange?: number | null;
  lastReminderAt?: number;
}): boolean {
  const { now, intervalMinutes, lastStatusChange, lastReminderAt } = args;
  if (!intervalMinutes || intervalMinutes <= 0) return false;
  const base = Math.max(
    typeof lastStatusChange === "number" ? lastStatusChange : 0,
    typeof lastReminderAt === "number" ? lastReminderAt : 0,
  );
  // No anchor at all: we cannot tell how long it has been, so stay quiet.
  if (base <= 0) return false;
  return now - base >= intervalMinutes * 60 * 1000;
}

/** "45s", "12m", "1h 5m", "2d 3h". Whole units only, largest two. */
export function formatDowntime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// In-memory clock
// ---------------------------------------------------------------------------

const lastDownEmailAt = new Map<string, number>();

/** Record that a down email (transition or reminder) was attempted for a check. */
export function noteDownEmail(checkId: string, at: number): void {
  lastDownEmailAt.set(checkId, at);
}

export function getLastDownEmail(checkId: string): number | undefined {
  return lastDownEmailAt.get(checkId);
}

/** Forget the clock once a check is back up (keeps the map bounded). */
export function clearDownReminder(checkId: string): void {
  lastDownEmailAt.delete(checkId);
}

// ---------------------------------------------------------------------------
// Settings-read back-off for users with reminders off
// ---------------------------------------------------------------------------

/**
 * How long to skip the settings lookup for a user whose reminders are off.
 * Most down checks belong to users who never turn reminders on; without this,
 * every one of their long-down checks would keep the runner's 30-minute
 * settings cache warm (about 3 Firestore reads per refill). The cost is that
 * turning reminders on reaches checks that were ALREADY down within this
 * window; checks that go down afterwards are covered right away.
 */
export const DOWN_REMINDER_OFF_RECHECK_MS = 3 * 60 * 60 * 1000;

const remindersOffUntil = new Map<string, number>();

export function remindersKnownOff(userId: string, now: number): boolean {
  const until = remindersOffUntil.get(userId);
  if (until === undefined) return false;
  if (until <= now) {
    remindersOffUntil.delete(userId);
    return false;
  }
  return true;
}

export function noteRemindersOff(userId: string, now: number): void {
  remindersOffUntil.set(userId, now + DOWN_REMINDER_OFF_RECHECK_MS);
}
