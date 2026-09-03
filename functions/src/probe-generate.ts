// ============================================================================
// PROBE GENERATOR  (probe PLAN.md §6, exit1 side)
//
// probe sweeps launch directories, resolves a contact, and then asks a product
// for a finding about the launched site. This is exit1's answer to that ask.
//
// THE CONTRACT IN ONE LINE: return a finding a founder would thank you for, or
// return 204. There is no third option. probe never falls back to a template,
// so a weak finding here does not become a weaker email -- it becomes a
// pretext, and a pretext is worse than no email for the recipient, for any
// regulator reading intent, and for the reply rate.
//
// A CLEAN SITE IS A FINDING. Severity 0, the "all clear" report. The first
// version of this returned 204 whenever nothing was broken, which threw away
// the better half of the list: seventeen consecutive real checks found nothing,
// because a launched product on modern hosting usually has a valid certificate,
// a canonical redirect and working links. The founder who ships that is not a
// worse prospect for an uptime monitor. They are the one who already cares.
//
// What keeps it from being a pretext is not bad news, it is specifics: the
// clean report quotes the status, the TTFB, the certificate expiry date and the
// number of links checked, all measured against that domain minutes earlier and
// all verifiable in thirty seconds. 204 now means only that nothing could be
// measured.
//
// WHAT COUNTS AS SEVERITY 1. Something the founder can verify in thirty seconds
// and would want to know on launch morning:
//   - the landing page does not answer, or answers 4xx/5xx
//   - the TLS certificate is expired, invalid for the hostname, or expires
//     inside 30 days
//   - the apex and www forms disagree: one works, the other does not
//   - a link on their own launch page points at a page on their own domain
//     that 404s
//
// WHAT IS SEVERITY 2, recorded and then dropped by probe: TTFB, missing HSTS,
// long redirect chains. Real, pedantic, and not worth a stranger's email. Note
// that these same numbers appear in the severity 0 report as evidence of a
// healthy site, which is the difference between a measurement and a complaint.
//
// TIMING. This runs synchronously and finishes in seconds, so it answers 200 or
// 204 and never 202. probe's contract allows 202 + polling with a two hour
// budget, and if the check set ever grows into a real probe run, that is the
// shape to move to -- nothing here needs to change on probe's side.
// ============================================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import { URL } from "url";
import { checkSSLCertificate } from "./security-utils";
import { PROBE_HMAC_SECRET } from "./env";

const FINDINGS_COLLECTION = "probeFindings";

/**
 * Lazy, not module level. The pure halves of this file (the signature check, the
 * link extraction, the body renderer) are unit tested, and a top-level
 * getFirestore() would make importing the module require an initialised Firebase
 * app -- so the tests would need a live app to assert on a regex.
 */
const db = () => getFirestore();

/** §6: generators reject a timestamp more than 300s old. */
const TIMESTAMP_TOLERANCE_S = 300;

/** A certificate this close to expiry is a severity 1 finding: it is about to
 *  take the site down and almost nobody is watching it on launch week. */
const CERT_EXPIRY_WARNING_DAYS = 30;

const FETCH_TIMEOUT_MS = 10_000;

/** Enough links to find a broken one, few enough to stay polite on a launch
 *  morning when the site is already under load from the directory itself. */
const MAX_LINKS_TO_CHECK = 12;

/**
 * Where the public report is served from.
 *
 * NOT exit1.dev/probe/<id>, which is what this originally emitted. exit1.dev is
 * served by Vercel with no vercel.json, so the Firebase Hosting rewrites in
 * firebase.json are inert and that URL 404s -- as do exit1's other rewrites,
 * which is a pre-existing condition of the Vercel migration and not something
 * probe should fix on its way past.
 *
 * probe's own app proxies /e/<id> to probeEvidence instead. It is a subdomain of
 * exit1.dev, so the link still reads as ours to a recipient, and it keeps the
 * whole evidence path inside probe where it can be changed without touching the
 * marketing site. Override with PROBE_EVIDENCE_BASE if exit1.dev ever gets a
 * rewrite and the nicer URL becomes available.
 */
const EVIDENCE_BASE = (process.env.PROBE_EVIDENCE_BASE ?? "https://probe.exit1.dev/e").replace(
  /\/+$/,
  "",
);

/**
 * We identify ourselves honestly. probe's §9.2 is built on radical provenance
 * and that does not start at the email: a founder who greps their access log
 * after getting one should find something that explains itself.
 *
 * Which means the URL in here has to resolve. It pointed at exit1.dev/probe,
 * which 404s for the reason described on EVIDENCE_BASE above, so it now points
 * at the site root.
 */
const USER_AGENT =
  "exit1-probe/1.0 (+https://exit1.dev; launch-day synthetic check; morten@mail.exit1.dev)";

// ---------------------------------------------------------------------------
// Request signature (§6)
// ---------------------------------------------------------------------------

interface ProbeRequest {
  lead_id: string;
  product: {
    name: string;
    url: string;
    description: string | null;
    source: string;
    launched_at: string | null;
    tags: string[];
  };
  recipient: { first_name: string | null };
}

const getSecret = (): string | undefined => {
  try {
    const value = PROBE_HMAC_SECRET.value();
    return value && value.trim() ? value.trim() : undefined;
  } catch {
    const raw = process.env.PROBE_HMAC_SECRET;
    return raw && raw.trim() ? raw.trim() : undefined;
  }
};

/**
 * Verifies `X-Probe-Signature: sha256=<hex>` over `${timestamp}.${rawBody}`.
 *
 * Fails closed on a missing secret. This endpoint tells probe what to say to a
 * stranger; an unauthenticated caller could feed it a URL of their choosing and
 * get exit1 to probe it, which is both an SSRF and a way to put words in our
 * mouth. The timestamp window is what stops a captured request being replayed
 * forever.
 */
export function verifyProbeSignature(args: {
  secret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { secret, timestamp, signature, rawBody } = args;
  if (!secret) return { ok: false, reason: "PROBE_HMAC_SECRET is not configured" };
  if (!timestamp) return { ok: false, reason: "missing X-Probe-Timestamp" };
  if (!signature) return { ok: false, reason: "missing X-Probe-Signature" };

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "X-Probe-Timestamp is not a number" };

  const nowS = (args.nowMs ?? Date.now()) / 1000;
  // Both directions: a future timestamp is either a broken clock or an attempt
  // to mint a signature that stays valid for a long time.
  if (Math.abs(nowS - ts) > TIMESTAMP_TOLERANCE_S) {
    return { ok: false, reason: "X-Probe-Timestamp is outside the 300s window" };
  }

  const expected = `sha256=${createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "signature mismatch" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export interface Finding {
  /**
   * 1: a defect worth a stranger's email. 2: real but pedantic, recorded and
   * dropped. 0: nothing wrong, and that is the finding.
   *
   * Severity 0 is not a weaker 1. It is a different kind of statement: every
   * check passed, here is what was measured, and a founder who keeps a site in
   * that condition is exactly the person who cares whether it stays that way.
   * probe mails severity 0 and 1 and drops 2 (generator_min_severity).
   */
  severity: 0 | 1 | 2;
  /** Stable id, so the copy for a kind of finding lives in one place. */
  kind: string;
  subject: string;
  /** One sentence, the finding itself. Becomes the email's first line. */
  headline: string;
  /** What we saw, in enough detail to be verified in thirty seconds. */
  detail: string;
  /** What to do about it. §6 requires this: diagnosis without remediation is
   *  just bad news from a stranger. */
  fix: string;
  /** Machine readable, put on the proof and shown in probe's /queue. */
  meta: Record<string, unknown>;
}

interface Probe {
  url: string;
  status: number | null;
  ok: boolean;
  redirects: string[];
  ttfbMs: number | null;
  error: string | null;
  hsts: boolean;
  body: string | null;
}

async function probeUrl(target: string, opts: { body?: boolean } = {}): Promise<Probe> {
  const started = Date.now();
  const redirects: string[] = [];
  try {
    // manual redirect handling, so the chain length is observable rather than
    // collapsed by fetch. A three hop chain is a real (severity 2) finding and
    // an invisible one if you let fetch follow it for you.
    let current = target;
    let response: Response | null = null;
    for (let hop = 0; hop < 6; hop += 1) {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).toString();
        redirects.push(next);
        current = next;
        continue;
      }
      break;
    }
    if (!response) throw new Error("no response");

    return {
      url: current,
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      redirects,
      ttfbMs: Date.now() - started,
      error: null,
      hsts: response.headers.has("strict-transport-security"),
      body: opts.body ? (await response.text()).slice(0, 400_000) : null,
    };
  } catch (err) {
    return {
      url: target,
      status: null,
      ok: false,
      redirects,
      ttfbMs: null,
      error: err instanceof Error ? err.message : String(err),
      hsts: false,
      body: null,
    };
  }
}

/** Same-origin hrefs from a landing page, deduped, absolute, capped. */
export function internalLinks(html: string, baseUrl: string, limit = MAX_LINKS_TO_CHECK): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: string[] = [];
  const pattern = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null && out.length < limit) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    match = pattern.exec(html);
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
    // Their own host only. A broken link to somebody else's site is their
    // problem to notice, not ours to write to a stranger about.
    if (resolved.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
    resolved.hash = "";
    const key = resolved.toString();
    if (key === base.toString() || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The apex/www counterpart of a hostname. */
function counterpartUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      parsed.hostname = host.slice(4);
    } else {
      // Only for a bare two-label domain. Adding www. to 'app.example.com' is
      // guessing at a host that was never meant to exist.
      if (host.split(".").length !== 2) return null;
      parsed.hostname = `www.${host}`;
    }
    parsed.pathname = "/";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/** What the checks actually measured, kept whether or not anything failed.
 *  A clean report is only worth sending because it can quote these. */
export interface Observed {
  host: string;
  finalUrl: string;
  status: number | null;
  ttfbMs: number | null;
  redirects: number;
  hsts: boolean;
  certIssuer: string | null;
  certValidTo: string | null;
  certDaysLeft: number | null;
  counterpartHost: string | null;
  counterpartOk: boolean | null;
  linksChecked: number;
}

/**
 * Runs the suite and returns every finding, strongest first, plus what was
 * measured along the way. Pure enough to reason about: all the IO is in
 * probeUrl and checkSSLCertificate.
 */
export async function findFindings(
  productUrl: string,
): Promise<{ findings: Finding[]; observed: Observed }> {
  const findings: Finding[] = [];
  const landing = await probeUrl(productUrl, { body: true });
  const host = safeHost(productUrl);

  // --- 1. The site itself ---------------------------------------------------
  if (landing.error !== null) {
    findings.push({
      severity: 1,
      kind: "landing_unreachable",
      subject: `${host} did not answer when I checked it this morning`,
      headline: `${productUrl} did not answer at all when I requested it: ${landing.error}.`,
      detail:
        `A plain GET from a Google Cloud address timed out or failed at the transport level. ` +
        `Everything below the application is worth checking first: DNS, the load balancer, ` +
        `and whether the host is refusing connections from outside your own network.`,
      fix:
        "Check the site from a network you do not control, not just your laptop. A launch-day " +
        "outage is usually DNS propagation or a firewall rule that never allowed public traffic.",
      meta: { url: productUrl, error: landing.error },
    });
  } else if (!landing.ok) {
    findings.push({
      severity: 1,
      kind: "landing_error_status",
      subject: `${host} is returning ${landing.status} on the page your launch links to`,
      headline: `${landing.url} returned HTTP ${landing.status} when I requested it.`,
      detail:
        `One plain GET, no headers beyond a user agent, from a Google Cloud address. ` +
        `The response was ${landing.status}, so a visitor arriving from your launch post ` +
        `sees an error rather than your product.`,
      fix:
        landing.status !== null && landing.status >= 500
          ? "A 5xx on the landing page is almost always the app crashing on cold start or a " +
            "missing environment variable in the production deploy. The application log at the " +
            "timestamp above will say which."
          : "A 4xx here usually means the launch post points at a path that no longer exists, " +
            "or a route that requires a trailing slash. Check the exact URL in your launch post.",
      meta: { url: landing.url, status: landing.status, redirects: landing.redirects },
    });
  }

  // --- 2. TLS ---------------------------------------------------------------
  const ssl = await checkSSLCertificate(productUrl);
  if (!ssl.observationFailed && ssl.valid === false) {
    findings.push({
      severity: 1,
      kind: "cert_invalid",
      subject: `The TLS certificate on ${host} is not valid`,
      headline: `${host} is serving a TLS certificate that is not currently valid: ${ssl.error ?? "it did not validate"}.`,
      detail:
        `Issuer ${ssl.issuer ?? "unknown"}, subject ${ssl.subject ?? "unknown"}` +
        (ssl.validTo ? `, valid until ${new Date(ssl.validTo).toISOString()}` : "") +
        ". Browsers will show an interstitial before anyone sees the page.",
      fix:
        "If this is a Let's Encrypt certificate, the renewal cron has probably stopped. " +
        "Renew now and then check that the renewal actually runs, rather than that it ran once.",
      meta: {
        issuer: ssl.issuer ?? null,
        subject: ssl.subject ?? null,
        valid_to: ssl.validTo ?? null,
        days_until_expiry: ssl.daysUntilExpiry ?? null,
      },
    });
  } else if (
    !ssl.observationFailed &&
    typeof ssl.daysUntilExpiry === "number" &&
    ssl.daysUntilExpiry >= 0 &&
    ssl.daysUntilExpiry <= CERT_EXPIRY_WARNING_DAYS
  ) {
    findings.push({
      severity: 1,
      kind: "cert_expiring",
      subject: `${host}'s TLS certificate expires in ${ssl.daysUntilExpiry} days`,
      headline: `The TLS certificate on ${host} expires in ${ssl.daysUntilExpiry} days, on ${
        ssl.validTo ? new Date(ssl.validTo).toISOString().slice(0, 10) : "an unknown date"
      }.`,
      detail:
        `Issued by ${ssl.issuer ?? "an unknown issuer"} for ${ssl.subject ?? host}. ` +
        `Nothing is wrong right now; it simply runs out soon, and the week after a launch is ` +
        `when nobody is watching the certificate.`,
      fix:
        "Confirm automated renewal is actually scheduled and not just configured. If you are on " +
        "Let's Encrypt, `certbot renew --dry-run` answers this in one command.",
      meta: {
        issuer: ssl.issuer ?? null,
        valid_to: ssl.validTo ?? null,
        days_until_expiry: ssl.daysUntilExpiry,
      },
    });
  }

  // --- 3. apex vs www -------------------------------------------------------
  const counterpart = counterpartUrl(productUrl);
  let counterpartOk: boolean | null = null;
  if (counterpart && landing.error === null && landing.ok) {
    const other = await probeUrl(counterpart);
    counterpartOk = other.error === null ? other.ok : null;
    // Only when OURS works and the counterpart is genuinely broken. A
    // counterpart that simply does not resolve is a deliberate choice for
    // plenty of sites, so a DNS failure is not reported: only a host that
    // answers and answers badly.
    if (other.error === null && !other.ok) {
      findings.push({
        severity: 1,
        kind: "host_variant_broken",
        subject: `${safeHost(counterpart)} returns ${other.status} while ${host} works`,
        headline: `${counterpart} returned HTTP ${other.status}, while ${landing.url} returned ${landing.status}.`,
        detail:
          `Both hostnames resolve and both answer, so anyone who types the other form of your ` +
          `domain, or follows an older link to it, gets an error instead of a redirect. ` +
          `This is the variant people type by habit.`,
        fix:
          `Add a 301 from ${safeHost(counterpart)} to ${host} at the edge, so one canonical host ` +
          `serves the site and the other only ever redirects to it.`,
        meta: {
          working: { url: landing.url, status: landing.status },
          broken: { url: counterpart, status: other.status },
        },
      });
    }
  }

  // --- 4. Broken links on their own launch page -----------------------------
  let linksChecked = 0;
  if (landing.body) {
    const links = internalLinks(landing.body, landing.url);
    linksChecked = links.length;
    const broken: Array<{ url: string; status: number | null }> = [];
    for (const link of links) {
      const result = await probeUrl(link);
      // A transport error is not reported: it is far more likely to be our
      // egress or a rate limit than a broken page, and a wrong finding is worse
      // than no finding.
      if (result.error === null && !result.ok) {
        broken.push({ url: link, status: result.status });
      }
    }
    if (broken.length > 0) {
      const first = broken[0];
      findings.push({
        severity: 1,
        kind: "broken_internal_link",
        subject: `${new URL(first.url).pathname} is linked from your launch page and returns ${first.status}`,
        headline: `Your landing page links to ${first.url}, which returned HTTP ${first.status}.`,
        detail:
          broken.length === 1
            ? `One link on ${landing.url} points at a page on your own domain that does not resolve.`
            : `${broken.length} links on ${landing.url} point at pages on your own domain that do not ` +
              `resolve: ${broken.map((b) => `${new URL(b.url).pathname} (${b.status})`).join(", ")}.`,
        fix:
          "These are usually pages that were renamed or never shipped, with the nav still pointing " +
          "at the old path. The full list with status codes is in the report linked below.",
        meta: { checked: links.length, broken },
      });
    }
  }

  // --- 5. Severity 2, recorded so a drift toward pedantry is visible --------
  if (landing.error === null && landing.ok) {
    if (landing.redirects.length > 2) {
      findings.push({
        severity: 2,
        kind: "long_redirect_chain",
        subject: `${host} takes ${landing.redirects.length} redirects to reach the page`,
        headline: `Requesting ${productUrl} went through ${landing.redirects.length} redirects before answering 200.`,
        detail: `The chain: ${[productUrl, ...landing.redirects].join(" -> ")}.`,
        fix: "Collapse the chain to one hop. Each redirect is a round trip before anything renders.",
        meta: { hops: landing.redirects.length, chain: landing.redirects },
      });
    }
    if (!landing.hsts) {
      findings.push({
        severity: 2,
        kind: "missing_hsts",
        subject: `${host} does not send Strict-Transport-Security`,
        headline: `${landing.url} answered 200 with no Strict-Transport-Security header.`,
        detail: "Without HSTS the first request of a session can be downgraded to http.",
        fix: "Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` at the edge.",
        meta: { url: landing.url },
      });
    }
    if (landing.ttfbMs !== null && landing.ttfbMs > 1_000) {
      findings.push({
        severity: 2,
        kind: "slow_ttfb",
        subject: `${host} took ${landing.ttfbMs}ms to answer`,
        headline: `${landing.url} took ${landing.ttfbMs}ms to first byte from europe-west1.`,
        detail: "One sample from one region, so treat it as a hint rather than a measurement.",
        fix: "If this is a cold start, keeping one instance warm removes it.",
        meta: { ttfb_ms: landing.ttfbMs },
      });
    }
  }

  const observed: Observed = {
    host,
    finalUrl: landing.url,
    status: landing.status,
    ttfbMs: landing.ttfbMs,
    redirects: landing.redirects.length,
    hsts: landing.hsts,
    certIssuer: ssl.observationFailed ? null : ssl.issuer ?? null,
    // Epoch ms on the check result, ISO date here: the clean report quotes it
    // to a reader, and a reader cannot verify 1794412551000 against their own
    // certificate in thirty seconds.
    certValidTo:
      ssl.observationFailed || typeof ssl.validTo !== "number"
        ? null
        : new Date(ssl.validTo).toISOString(),
    certDaysLeft: ssl.observationFailed ? null : ssl.daysUntilExpiry ?? null,
    counterpartHost: counterpart ? safeHost(counterpart) : null,
    counterpartOk,
    linksChecked,
  };

  // Strongest first, and severity 0 is not in here: a clean report is built
  // from `observed` only when nothing else was found (see cleanReport).
  return { findings: findings.sort((a, b) => a.severity - b.severity), observed };
}

/**
 * The finding for a site with nothing wrong with it.
 *
 * This exists because "no defect, no email" was throwing away the better half
 * of the list. Seventeen consecutive checks found nothing, which is not a
 * failure of the checks: it is what a launched product on modern hosting
 * usually looks like. A founder who ships a site with a valid certificate, a
 * canonical redirect and no broken links is not a worse prospect for an uptime
 * monitor than one who ships a 500. They are the person who already cares.
 *
 * The rule it must not break: this is still a report on THEIR site, quoting
 * numbers measured against THEIR domain minutes earlier, verifiable in thirty
 * seconds. What makes an email a pretext is not the absence of bad news, it is
 * the absence of specifics. So every sentence here carries one.
 *
 * Returns null when there is not enough to say. A site we could not measure
 * gets no email, which is where "no proof, no send" still bites.
 */
export function cleanReport(o: Observed): Finding | null {
  // Nothing measured, nothing to report. A landing page that did not answer is
  // a severity 1 finding elsewhere and never reaches here.
  if (o.status === null) return null;

  const checks: string[] = [];
  checks.push(
    o.redirects > 0
      ? `${o.finalUrl} answered ${o.status} after ${o.redirects} redirect${o.redirects === 1 ? "" : "s"}`
      : `${o.finalUrl} answered ${o.status} directly, with no redirect`,
  );
  if (o.ttfbMs !== null) {
    checks.push(`first byte in ${o.ttfbMs}ms from europe-west1`);
  }
  if (o.certValidTo && o.certDaysLeft !== null) {
    checks.push(
      `the TLS certificate${o.certIssuer ? ` from ${o.certIssuer}` : ""} is valid for another ` +
        `${o.certDaysLeft} days, until ${o.certValidTo.slice(0, 10)}`,
    );
  }
  if (o.counterpartHost && o.counterpartOk === true) {
    checks.push(`${o.counterpartHost} resolves and answers rather than erroring`);
  }
  if (o.linksChecked > 0) {
    checks.push(
      `all ${o.linksChecked} internal link${o.linksChecked === 1 ? "" : "s"} on the page resolve`,
    );
  }

  // Two measurements is the floor. One is a fact, not a report, and it would
  // read as filler around a pitch, which is exactly what this must not be.
  if (checks.length < 2) return null;

  return {
    severity: 0,
    kind: "all_clear",
    subject: `I checked ${o.host} this morning and everything passed`,
    headline:
      `I ran a check against ${o.host} this morning and found nothing wrong with it, ` +
      `which is rarer on launch day than it should be.`,
    detail: `What I measured: ${joinList(checks)}.`,
    // §6 requires a fix even here. The honest one is not a repair: it is the
    // single thing this check cannot tell them, which is whether any of it is
    // still true tomorrow.
    fix:
      `Nothing to fix. The one thing a check like this cannot tell you is whether it is still ` +
      `true next Tuesday at 03:00, which is when certificates expire and DNS changes land.`,
    meta: {
      status: o.status,
      ttfb_ms: o.ttfbMs,
      redirects: o.redirects,
      hsts: o.hsts,
      cert_valid_to: o.certValidTo,
      cert_days_left: o.certDaysLeft,
      links_checked: o.linksChecked,
      counterpart_ok: o.counterpartOk,
    },
  };
}

/** "a, b and c". Oxford comma deliberately absent: this is read aloud in the
 *  reader's head as a list of measurements, not as prose. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// The email body
// ---------------------------------------------------------------------------

/**
 * Renders the finding as the two body variants probe sends byte for byte.
 *
 * Every constraint here comes from probe's copy lint (§9.2), which runs on the
 * composed message at generation, at approval and again at dispatch. Getting
 * one wrong means the lead is dropped as generator_failed, so they are worth
 * stating:
 *
 *   - the finding is the first sentence, no greeting
 *   - exactly ONE mention of exit1.dev in the body, in the provenance sentence
 *   - exactly one link in the body: the evidence url (probe appends the
 *     unsubscribe and data-notice links itself)
 *   - the contact-once sentence, verbatim
 *   - no closing question, no ask of any kind
 *   - both variants must tell the same story (a Jaccard similarity floor)
 */
export function renderBody(args: {
  finding: Finding;
  evidenceUrl: string;
  firstName: string | null;
  addressSource: string;
}): { text: string; html: string } {
  const { finding, evidenceUrl } = args;

  const paragraphs: Array<string | { label: string; url: string }> = [
    finding.headline,
    finding.detail,
    finding.fix,
    { label: "The full check, with timings and response headers", url: evidenceUrl },
    // §9.2.4. First person, names the product exactly once, and says where the
    // address came from. This doubles as the GDPR Article 14 notice.
    `I run exit1.dev, an uptime monitor. You launched publicly this morning, so I pointed it at ` +
      `your public surface. ${args.addressSource} Where your data lives and how to have it deleted ` +
      `is linked at the bottom of this email.`,
    // §9.2.6, verbatim: the lint matches this sentence.
    "This is the only email you will ever get from me. No follow-ups, no sequence.",
  ];

  const text = paragraphs
    .map((p) => (typeof p === "string" ? p : `${p.label}: ${p.url}`))
    .join("\n\n");

  const style = "margin:0 0 16px;line-height:1.6;";
  const html = [
    "<html>",
    '  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;">',
    ...paragraphs.map((p) =>
      typeof p === "string"
        ? `    <p style="${style}">${escapeHtml(p)}</p>`
        : `    <p style="${style}"><a href="${escapeHtml(p.url)}">${escapeHtml(p.label)}</a></p>`,
    ),
    "  </body>",
    "</html>",
  ].join("\n");

  return { text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * How the email says where the address came from. probe tells us the source
 * indirectly (it is the only thing that knows), so until the contract carries
 * it, this is the honest general form: it claims only what is true for every
 * path in probe's cascade (§8.3), which is that the address was published on a
 * page or profile the founder controls.
 */
const ADDRESS_SOURCE_SENTENCE = "I found your address published on your own site.";

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export const probeGenerate = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
    // Not public: every request is HMAC signed. Invoker stays public because
    // Hosting rewrites cannot pass IAM credentials; the signature is the gate.
    secrets: [PROBE_HMAC_SECRET],
    cors: false,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    // The signature is over the exact bytes, so the raw body is what matters.
    // Firebase parses JSON for us; rawBody is the original.
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});

    const verified = verifyProbeSignature({
      secret: getSecret(),
      timestamp: header(req.headers["x-probe-timestamp"]),
      signature: header(req.headers["x-probe-signature"]),
      rawBody,
    });
    if (!verified.ok) {
      logger.warn("probeGenerate rejected a request", { reason: verified.reason });
      res.status(401).json({ error: "unauthorized", detail: verified.reason });
      return;
    }

    let request: ProbeRequest;
    try {
      request = JSON.parse(rawBody) as ProbeRequest;
    } catch {
      res.status(400).json({ error: "invalid_json" });
      return;
    }

    const productUrl = request.product?.url;
    if (!productUrl || typeof productUrl !== "string") {
      res.status(400).json({ error: "invalid_request", detail: "product.url is required" });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(productUrl);
    } catch {
      res.status(400).json({ error: "invalid_request", detail: "product.url is not a url" });
      return;
    }
    // https only, and a real public hostname. probe already normalises this, but
    // this endpoint fetches whatever it is given, so it does not delegate the
    // check to its caller.
    if (parsed.protocol !== "https:") {
      res.status(400).json({ error: "invalid_request", detail: "product.url must be https" });
      return;
    }
    if (!isPublicHostname(parsed.hostname)) {
      logger.warn("probeGenerate refused a non-public hostname", { hostname: parsed.hostname });
      res.status(400).json({ error: "invalid_request", detail: "product.url is not a public host" });
      return;
    }

    const started = Date.now();
    let findings: Finding[];
    let observed: Observed;
    try {
      ({ findings, observed } = await findFindings(productUrl));
    } catch (err) {
      logger.error("probeGenerate failed while checking", {
        leadId: request.lead_id,
        url: productUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "check_failed" });
      return;
    }

    const elapsedMs = Date.now() - started;

    // A severity 1 defect if there is one; otherwise the clean report, which is
    // a finding in its own right and not a consolation prize (see cleanReport).
    // Severity 2 never becomes an email on its own: a pedantic finding presented
    // as the reason for writing reads as a pretext, and "everything passed" is
    // both truer and more useful than "your redirect chain is three hops".
    const defect = findings.find((f) => f.severity === 1) ?? null;
    const best = defect ?? cleanReport(observed);

    // 204 now means only one thing: the site could not be measured well enough
    // to say anything specific about it. Rule 1 still holds, it just no longer
    // requires bad news.
    if (!best) {
      logger.info("probeGenerate had nothing specific to say", {
        leadId: request.lead_id,
        url: productUrl,
        elapsedMs,
        observed,
      });
      res.status(204).send("");
      return;
    }

    const findingId = randomUUID();
    const evidenceUrl = `${EVIDENCE_BASE}/${findingId}`;
    const body = renderBody({
      finding: best,
      evidenceUrl,
      firstName: request.recipient?.first_name ?? null,
      addressSource: ADDRESS_SOURCE_SENTENCE,
    });

    // The evidence page is a gift, not a funnel (§9.2.3): public, no signup, no
    // email capture. Written before the response so the link in the email can
    // never 404.
    await db().collection(FINDINGS_COLLECTION).doc(findingId).set({
      id: findingId,
      leadId: request.lead_id ?? null,
      productName: request.product?.name ?? null,
      productUrl,
      finding: best,
      allFindings: findings,
      elapsedMs,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("probeGenerate produced a finding", {
      leadId: request.lead_id,
      url: productUrl,
      kind: best.kind,
      findingId,
      elapsedMs,
    });

    res.status(200).json({
      status: "ready",
      severity: best.severity,
      subject: best.subject,
      html: body.html,
      text: body.text,
      fix: best.fix,
      evidence_url: evidenceUrl,
      meta: { kind: best.kind, elapsed_ms: elapsedMs, ...best.meta },
    });
  },
);

function header(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * Refuses hostnames that are not a public site: localhost, IP literals, and the
 * cloud metadata host. probe's own normalisation already rejects most of these,
 * but this endpoint fetches what it is told to fetch, so it does its own check.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return false;
  if (host === "metadata.google.internal") return false;
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    return false;
  }
  // IPv4 literal, and IPv6 arrives bracketed or with colons.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(":") || host.startsWith("[")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The evidence page (§9.2.3)
// ---------------------------------------------------------------------------

/**
 * Splits an evidence request into the report id and the format asked for.
 *
 * The .json suffix is stripped BEFORE the id is validated, not after. The
 * report page's own footer links to `<id>.json`, and with the suffix still
 * attached the id failed the shape check, so every one of those advertised
 * links 404'd and always had.
 *
 * Exported for tests: it is pure, and it is the only place a path from the
 * open internet becomes a Firestore document id.
 */
export function parseEvidenceRequest(
  path: string,
  query: Record<string, unknown>,
): { id: string; wantsJson: boolean; valid: boolean } {
  const last = (path.split("/").filter(Boolean).pop() ?? "").trim();
  const wantsJson = last.toLowerCase().endsWith(".json") || query.format === "json";
  const id = last.replace(/\.json$/i, "");
  return { id, wantsJson, valid: /^[0-9a-f-]{36}$/i.test(id) };
}

/**
 * The public report the email links to. No signup wall, no email capture, no
 * "claim this report" gate, no tracking. §9.2.3 is explicit that the conversion
 * mechanism is the quality of the artifact and the product being visibly the
 * instrument that made it, so this page's job is to be worth the click and
 * nothing else.
 */
export const probeEvidence = onRequest(
  { region: "europe-west1", timeoutSeconds: 30, memory: "256MiB", cors: true },
  async (req, res) => {
    const { id, wantsJson, valid } = parseEvidenceRequest(req.path, req.query);
    if (!valid) {
      res.status(404).type("text/plain").send("No such report.\n");
      return;
    }

    const doc = await db().collection(FINDINGS_COLLECTION).doc(id).get();
    if (!doc.exists) {
      res.status(404).type("text/plain").send("No such report.\n");
      return;
    }
    const data = doc.data() as {
      productName?: string | null;
      productUrl?: string;
      finding?: Finding;
      allFindings?: Finding[];
      elapsedMs?: number;
      createdAt?: { toDate(): Date };
    };

    if (wantsJson) {
      res.status(200).json({
        product: { name: data.productName ?? null, url: data.productUrl ?? null },
        finding: data.finding ?? null,
        all_findings: data.allFindings ?? [],
        checked_at: data.createdAt?.toDate().toISOString() ?? null,
      });
      return;
    }

    res
      .status(200)
      .set("cache-control", "public, max-age=300")
      // The page holds a stranger's launch-day problem. It should not be indexed.
      .set("x-robots-tag", "noindex, nofollow")
      .type("text/html")
      .send(evidenceHtml(id, data));
  },
);

function evidenceHtml(
  id: string,
  data: {
    productName?: string | null;
    productUrl?: string;
    finding?: Finding;
    allFindings?: Finding[];
    elapsedMs?: number;
    createdAt?: { toDate(): Date };
  },
): string {
  const finding = data.finding;
  const checkedAt = data.createdAt?.toDate().toISOString() ?? "";
  const others = (data.allFindings ?? []).filter((f) => f.kind !== finding?.kind);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(finding?.subject ?? "Check report")}</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --fg:#16181c; --dim:#5c6672; --line:#dcdcd6; --warn:#b3541e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#08090b; --fg:#e4e7eb; --dim:#98a1ae; --line:#1e232b; --warn:#e8925a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 44rem; margin: 0 auto; padding: 3.5rem 1.5rem 5rem; }
  .tag { font:11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; letter-spacing:.18em; text-transform:uppercase; color:var(--warn); }
  h1 { margin:.75rem 0 1.5rem; font-size:1.6rem; font-weight:400; letter-spacing:-.01em; line-height:1.3; }
  h2 { margin:2.5rem 0 .75rem; font-size:.75rem; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--dim); }
  p { margin:0 0 1rem; }
  .dim { color:var(--dim); }
  pre { overflow-x:auto; padding:1rem; background:rgba(127,127,127,.08); border:1px solid var(--line); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  hr { border:0; border-top:1px solid var(--line); margin:2.5rem 0; }
  dl { display:grid; grid-template-columns:minmax(0,10rem) minmax(0,1fr); gap:.35rem 1rem; margin:0; font-size:.875rem; }
  dt { color:var(--dim); }
  dd { margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
  a { color:inherit; }
  footer { margin-top:3rem; padding-top:1.5rem; border-top:1px solid var(--line); font-size:.8125rem; color:var(--dim); }
</style>
</head>
<body>
<main>
  <span class="tag">Check report</span>
  <h1>${escapeHtml(finding?.subject ?? "Check report")}</h1>

  <p>${escapeHtml(finding?.headline ?? "")}</p>
  <p class="dim">${escapeHtml(finding?.detail ?? "")}</p>

  <h2>What to do</h2>
  <p>${escapeHtml(finding?.fix ?? "")}</p>

  <h2>What was checked</h2>
  <dl>
    <dt>Target</dt><dd>${escapeHtml(data.productUrl ?? "")}</dd>
    <dt>Checked at</dt><dd>${escapeHtml(checkedAt)}</dd>
    <dt>From</dt><dd>europe-west1</dd>
    <dt>Duration</dt><dd>${data.elapsedMs ?? 0}ms</dd>
    <dt>Report id</dt><dd>${escapeHtml(id)}</dd>
  </dl>

  <h2>Raw observation</h2>
  <pre>${escapeHtml(JSON.stringify(finding?.meta ?? {}, null, 2))}</pre>
${
  others.length > 0
    ? `  <h2>Also noticed, not worth an email</h2>
  <ul class="dim">
${others.map((f) => `    <li>${escapeHtml(f.headline)}</li>`).join("\n")}
  </ul>
`
    : ""
}
  <hr>
  <p class="dim">This report was produced by <a href="https://exit1.dev">exit1.dev</a>, an uptime
  monitor, pointed at a publicly launched site. There is nothing to claim and nothing to sign up
  for on this page. It sets no cookies and runs no analytics.</p>

  <footer>
    The full JSON is at <a href="${escapeHtml(EVIDENCE_BASE)}/${escapeHtml(id)}.json">${escapeHtml(
    EVIDENCE_BASE,
  )}/${escapeHtml(id)}.json</a>.
    To have this report deleted, reply to the email it came with.
  </footer>
</main>
</body>
</html>
`;
}
