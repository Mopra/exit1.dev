/**
 * Copy for the two trial-invite emails the lifecycle sweep sends to new free
 * users (day 3 and day 10). Plain text on purpose: they are written as personal
 * notes from Morten, and a reply goes straight to him.
 *
 * Pure and firestore-free so the copy is unit-tested
 * (__tests__/trial-invite-email.test.ts).
 */

export const TRIAL_INVITE_FROM = "Morten from exit1 <morten@updates.exit1.dev>";
export const TRIAL_INVITE_REPLY_TO = "morten@exit1.dev";
export const TRIAL_INVITE_URL = "https://app.exit1.dev/billing";

export interface TrialInviteEmail {
  subject: string;
  text: string;
}

/**
 * A readable host for a check target. Handles full URLs, bare hosts and
 * host:port targets (TCP, ping). Returns null when nothing usable is there.
 */
export function hostnameOf(target: string | null | undefined): string | null {
  const raw = typeof target === "string" ? target.trim() : "";
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
    if (host) return host.replace(/^www\./, "");
  } catch {
    // Fall through to the plain-string cut below.
  }
  const cut = raw.replace(/^[a-z]+:\/\//i, "").split(/[/:?#\s]/)[0];
  return cut ? cut.replace(/^www\./, "") : null;
}

const greeting = (firstName: string | null) => {
  const name = firstName?.trim();
  return name ? `Hi ${name},` : "Hi,";
};

/** "your monitor on a.com" / "3 monitors, including a.com and b.com". */
export function describeMonitors(checkCount: number, hostnames: string[]): string {
  const hosts = [...new Set(hostnames.filter(Boolean))].slice(0, 2);
  if (checkCount === 1) {
    return hosts.length ? `a monitor on ${hosts[0]}` : "a monitor";
  }
  const count = `${checkCount} monitors`;
  if (hosts.length === 0) return count;
  if (hosts.length === 1) return `${count}, including ${hosts[0]}`;
  return `${count}, including ${hosts[0]} and ${hosts[1]}`;
}

const SIGN_OFF = ["Morten", "exit1.dev"];
const OPT_OUT = "PS: If you would rather not get emails like this, reply \"stop\" and I will not send more.";

/** Day 3: what they have, what Indie and Nano add, the trial, and an invitation to reply. */
export function buildTrialInvite1(opts: {
  firstName: string | null;
  checkCount: number;
  hostnames: string[];
}): TrialInviteEmail {
  const subject = "Your monitors on exit1, and a 7-day trial";
  const text = [
    greeting(opts.firstName),
    "",
    `Morten here, I build exit1. You have ${describeMonitors(opts.checkCount, opts.hostnames)} running with us. Thanks for giving it a go.`,
    "",
    "On Free, each monitor is checked every 5 minutes. If you need more than that, here is what the paid plans add:",
    "",
    "Indie, $4/mo: 1-minute checks, up to 100 monitors and a branded status page.",
    "Nano, $9/mo: 30-second checks, domain expiry tracking, and a choice of US, EU or Asia for where your checks run from.",
    "",
    "Every paid plan starts with a 7-day free trial, so you can try it on your own sites first:",
    TRIAL_INVITE_URL,
    "",
    "If something is missing, confusing or broken, just reply. This comes straight to me and I read every answer.",
    "",
    ...SIGN_OFF,
    "",
    OPT_OUT,
  ].join("\n");
  return { subject, text };
}

/**
 * Day 10: shorter, one concrete reason. With a recent outage on one of their
 * monitors the reason is how much sooner a 1-minute check would have told them;
 * without one it is the same arithmetic, framed for next time.
 */
export function buildTrialInvite2(opts: {
  firstName: string | null;
  /** Host of the monitor that went down since signup, if any did. */
  incidentHost: string | null;
  hadIncident: boolean;
  minutesSooner: number;
}): TrialInviteEmail {
  const m = opts.minutesSooner;
  const minutes = `${m} minute${m === 1 ? "" : "s"}`;
  const reason = opts.hadIncident
    ? [
      `${opts.incidentHost ?? "One of your monitors"} went down since you signed up. On Free we check every 5 minutes, so the alert can arrive a few minutes after the outage starts. With 1-minute checks on Indie you would have heard about it up to ${minutes} sooner.`,
    ]
    : [
      `None of your monitors have gone down since you signed up, which is good. When one does, Free checks every 5 minutes. With 1-minute checks on Indie you would hear about it up to ${minutes} sooner.`,
    ];
  const subject = opts.hadIncident ? "Hearing about outages sooner" : "One reason to try 1-minute checks";
  const text = [
    greeting(opts.firstName),
    "",
    ...reason,
    "",
    "The trial is 7 days and free:",
    TRIAL_INVITE_URL,
    "",
    "If something is in your way, reply and tell me.",
    "",
    ...SIGN_OFF,
    "",
    OPT_OUT,
  ].join("\n");
  return { subject, text };
}
