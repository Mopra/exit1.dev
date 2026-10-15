/**
 * Copy for the two reverse-trial emails: the day-5 reminder ("2 days left") and
 * the note that goes out when the trial ends and the account drops to Free.
 * Plain text from Morten, like the trial invites, so a reply reaches a person.
 *
 * Pure and firestore-free so the copy is unit-tested
 * (__tests__/reverse-trial.test.ts).
 */
import { describeMonitors } from "./trial-invite-email";

export const REVERSE_TRIAL_KEEP_URL = "https://app.exit1.dev/billing";

export interface ReverseTrialEmail {
  subject: string;
  text: string;
}

/** What the account did with Nano during the trial. Counts come from its checks. */
export interface TrialUsage {
  /** All monitors on the account. */
  checkCount: number;
  /** Hostnames of a couple of them, for the opening line. */
  hostnames: string[];
  /** Monitors checking faster than Free's 5-minute floor. */
  fastChecks: number;
  /** Monitors with domain intelligence (expiry tracking) switched on. */
  domainIntel: number;
  /** Monitors pinned to a region. */
  pinnedRegions: number;
}

/** What the drop to Free changed. Nothing is deleted; these are the switches that moved. */
export interface DowngradeChanges {
  /** Monitors moved back to the 5-minute floor. */
  slowedChecks: number;
  /** Monitors paused because the account is over Free's monitor cap. */
  pausedChecks: number;
  /** Monitors whose domain intelligence was switched off. */
  domainIntelOff: number;
  /** Monitors whose pinned region was reset to the default. */
  regionsReset: number;
  /** Free's monitor cap, for the paused line. */
  freeMaxChecks: number;
}

const greeting = (firstName: string | null) => {
  const name = firstName?.trim();
  return name ? `Hi ${name},` : "Hi,";
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const SIGN_OFF = ["Morten", "exit1.dev"];

/** Lines describing what they used. Empty when they used nothing Nano-specific. */
export function usageLines(u: TrialUsage): string[] {
  const lines: string[] = [];
  if (u.fastChecks > 0) {
    lines.push(`- ${plural(u.fastChecks, "monitor", "monitors")} checking faster than every 5 minutes`);
  }
  if (u.domainIntel > 0) {
    lines.push(`- domain expiry tracking on ${plural(u.domainIntel, "monitor", "monitors")}`);
  }
  if (u.pinnedRegions > 0) {
    lines.push(`- ${plural(u.pinnedRegions, "monitor", "monitors")} pinned to a region`);
  }
  return lines;
}

/** Day 5 of the 7-day reverse trial. */
export function buildReverseTrialReminder(opts: {
  firstName: string | null;
  daysLeft: number;
  usage: TrialUsage;
}): ReverseTrialEmail {
  const d = Math.max(1, opts.daysLeft);
  const left = `${d} day${d === 1 ? "" : "s"} left`;
  const subject = `${left} of your Nano trial`;
  const used = usageLines(opts.usage);
  const opening = opts.usage.checkCount > 0
    ? `Morten here, I build exit1. Your account has been on Nano for free since you signed up, and you have ${describeMonitors(opts.usage.checkCount, opts.usage.hostnames)} running.`
    : "Morten here, I build exit1. Your account has been on Nano for free since you signed up.";
  const text = [
    greeting(opts.firstName),
    "",
    opening,
    "",
    ...(used.length > 0
      ? ["So far you are using:", ...used, ""]
      : ["Nano gives you 30-second checks, up to 250 monitors, domain expiry tracking and a choice of US, EU or Asia for where your checks run from.", ""]),
    `The trial has ${left}. After that the account moves to Free: monitors check every 5 minutes at most, and domain tracking and region choice switch off. Nothing is deleted.`,
    "",
    "To keep Nano ($7/mo billed yearly, or $9 monthly):",
    REVERSE_TRIAL_KEEP_URL,
    "",
    "If something is missing or in your way, just reply. This comes straight to me.",
    "",
    ...SIGN_OFF,
  ].join("\n");
  return { subject, text };
}

/** Lines describing what changed when the account dropped to Free. */
export function changeLines(c: DowngradeChanges): string[] {
  const lines: string[] = [];
  if (c.slowedChecks > 0) {
    lines.push(`- ${plural(c.slowedChecks, "monitor now checks", "monitors now check")} every 5 minutes instead of faster`);
  }
  if (c.pausedChecks > 0) {
    lines.push(`- ${plural(c.pausedChecks, "monitor was", "monitors were")} paused, because Free covers ${c.freeMaxChecks} monitors`);
  }
  if (c.domainIntelOff > 0) {
    lines.push(`- domain expiry tracking is off on ${plural(c.domainIntelOff, "monitor", "monitors")}`);
  }
  if (c.regionsReset > 0) {
    lines.push(`- ${plural(c.regionsReset, "monitor", "monitors")} went back to the default region`);
  }
  return lines;
}

/** The trial ended and the account is on Free now. */
export function buildReverseTrialEnded(opts: {
  firstName: string | null;
  changes: DowngradeChanges;
}): ReverseTrialEmail {
  const subject = "Your Nano trial has ended";
  const changed = changeLines(opts.changes);
  const text = [
    greeting(opts.firstName),
    "",
    "Your 7-day Nano trial on exit1 has ended, so your account is on the Free plan now.",
    "",
    ...(changed.length > 0
      ? ["What changed:", ...changed, ""]
      : ["Your monitors already fit within Free, so nothing about them changed.", ""]),
    "Your monitors, settings and history are all still there. Nothing was deleted.",
    "",
    "If you want Nano back ($7/mo billed yearly, or $9 monthly):",
    REVERSE_TRIAL_KEEP_URL,
    "",
    "Questions, or something that did not work for you? Reply and tell me.",
    "",
    ...SIGN_OFF,
  ].join("\n");
  return { subject, text };
}
