import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";

import {
  cleanReport,
  provenanceSentence,
  internalLinks,
  isPublicHostname,
  parseEvidenceRequest,
  renderBody,
  verifyProbeSignature,
  type Finding,
  type Observed,
} from "../probe-generate";

const SECRET = "probe-shared-secret";
const NOW_MS = 1_788_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function sign(body: string, ts = NOW_S, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// The signature is the only gate on this endpoint. probe calls the function's
// own URL, which is publicly reachable, and an unauthenticated caller could
// otherwise feed it any URL and get exit1 to probe it on their behalf.
// ---------------------------------------------------------------------------

test("verifyProbeSignature accepts a correctly signed request", () => {
  const body = '{"lead_id":"01J","product":{"url":"https://example.com"}}';
  const result = verifyProbeSignature({
    secret: SECRET,
    timestamp: String(NOW_S),
    signature: sign(body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(result.ok, true);
});

test("verifyProbeSignature rejects a body that changed by one byte", () => {
  const body = '{"product":{"url":"https://example.com"}}';
  const result = verifyProbeSignature({
    secret: SECRET,
    timestamp: String(NOW_S),
    signature: sign(body),
    rawBody: `${body} `,
    nowMs: NOW_MS,
  });
  assert.equal(result.ok, false);
});

test("verifyProbeSignature rejects the wrong secret", () => {
  const body = "{}";
  const result = verifyProbeSignature({
    secret: SECRET,
    timestamp: String(NOW_S),
    signature: sign(body, NOW_S, "someone-elses-secret"),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(result.ok, false);
});

test("verifyProbeSignature fails closed when no secret is configured", () => {
  const body = "{}";
  const result = verifyProbeSignature({
    secret: undefined,
    timestamp: String(NOW_S),
    signature: sign(body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not configured/);
});

test("verifyProbeSignature enforces the 300s window in both directions", () => {
  const body = "{}";
  // Old enough to be a replay.
  const stale = verifyProbeSignature({
    secret: SECRET,
    timestamp: String(NOW_S - 400),
    signature: sign(body, NOW_S - 400),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(stale.ok, false);

  // Far enough in the future to be an attempt at a long-lived signature.
  const future = verifyProbeSignature({
    secret: SECRET,
    timestamp: String(NOW_S + 400),
    signature: sign(body, NOW_S + 400),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(future.ok, false);

  // Just inside is fine, so the window is the only thing rejecting the above.
  const fresh = verifyProbeSignature({
    secret: SECRET,
    timestamp: String(NOW_S - 200),
    signature: sign(body, NOW_S - 200),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(fresh.ok, true);
});

test("verifyProbeSignature rejects missing headers rather than throwing", () => {
  for (const [ts, sig] of [
    [null, sign("{}")],
    [String(NOW_S), null],
    ["not-a-number", sign("{}")],
  ] as Array<[string | null, string | null]>) {
    const result = verifyProbeSignature({
      secret: SECRET,
      timestamp: ts,
      signature: sig,
      rawBody: "{}",
      nowMs: NOW_MS,
    });
    assert.equal(result.ok, false);
  }
});

// ---------------------------------------------------------------------------
// SSRF guard. probe normalises the url before it gets here, but this endpoint
// fetches whatever it is given, so it does not delegate the check to its caller.
// ---------------------------------------------------------------------------

test("isPublicHostname refuses anything that is not a public site", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "metadata.google.internal",
    "consul.service.internal",
    "printer.local",
    "app.localhost",
    "[::1]",
    "::1",
    "nodot",
  ]) {
    assert.equal(isPublicHostname(host), false, host);
  }
});

test("isPublicHostname accepts ordinary product hostnames", () => {
  for (const host of ["meterbase.dev", "www.meterbase.dev", "app.acme.co.uk", "exit1.dev"]) {
    assert.equal(isPublicHostname(host), true, host);
  }
});

// ---------------------------------------------------------------------------
// Link extraction. The broken-internal-link finding rests on this being
// same-origin only: reporting somebody else's broken link would be both wrong
// and rude.
// ---------------------------------------------------------------------------

test("internalLinks keeps same-host links and drops everything else", () => {
  const html = `
    <a href="/pricing">Pricing</a>
    <a href="/docs/">Docs</a>
    <a href="https://meterbase.dev/changelog">Changelog</a>
    <a href="https://twitter.com/meterbase">Twitter</a>
    <a href="https://other.example.com/x">Other</a>
    <a href="mailto:hi@meterbase.dev">Email</a>
    <a href="#features">Features</a>
    <a href="javascript:void(0)">JS</a>
  `;
  const links = internalLinks(html, "https://meterbase.dev/");
  assert.deepEqual(links, [
    "https://meterbase.dev/pricing",
    "https://meterbase.dev/docs/",
    "https://meterbase.dev/changelog",
  ]);
});

test("internalLinks dedupes, drops the page itself, and honours the cap", () => {
  const html = [
    '<a href="/a">a</a>',
    '<a href="/a">a again</a>',
    '<a href="/a#section">a with a fragment</a>',
    '<a href="https://meterbase.dev/">the page itself</a>',
    ...Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">p${i}</a>`),
  ].join("\n");
  const links = internalLinks(html, "https://meterbase.dev/", 5);
  assert.equal(links.length, 5);
  assert.equal(links[0], "https://meterbase.dev/a");
  assert.equal(new Set(links).size, links.length);
  assert.ok(!links.includes("https://meterbase.dev/"));
});

// ---------------------------------------------------------------------------
// The body has to pass probe's copy lint (§9.2). Every assertion below is one
// of its rules; getting one wrong drops the lead as generator_failed, so the
// rules are worth pinning here rather than discovering at 07:30.
// ---------------------------------------------------------------------------

const FINDING: Finding = {
  severity: 1,
  kind: "cert_expiring",
  subject: "meterbase.dev's TLS certificate expires in 9 days",
  headline: "The TLS certificate on meterbase.dev expires in 9 days, on 2026-09-10.",
  detail: "Issued by Let's Encrypt for meterbase.dev. Nothing is wrong right now.",
  fix: "Confirm automated renewal is actually scheduled and not just configured.",
  meta: { days_until_expiry: 9 },
};

function body() {
  return renderBody({
    finding: FINDING,
    evidenceUrl: "https://exit1.dev/probe/01234567-89ab-cdef-0123-456789abcdef",
    firstName: "Priya",
    addressSource: "I found your address published on your own site.",
    productName: "Meterbase",
    source: "show_hn",
  });
}

test("the body opens on the finding, with no greeting", () => {
  const { text } = body();
  assert.ok(text.startsWith(FINDING.headline), text.slice(0, 80));
  assert.doesNotMatch(text, /^(hi|hey|hello|dear|congrats)/i);
});

test("the body names exit1.dev exactly once", () => {
  // §9.2.4: one mention is provenance, two is a pitch wearing provenance as a
  // hat. probe's lint counts mentions outside urls and outside the footer.
  const { text } = body();
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  const mentions = withoutUrls.match(/exit1\.dev/gi) ?? [];
  assert.equal(mentions.length, 1, withoutUrls);
});

test("the body carries exactly one link, the evidence url", () => {
  // probe appends the unsubscribe and data-notice links itself; a third link
  // from the generator would be a fourth link in the sent email.
  const { text, html } = body();
  const textLinks = text.match(/https?:\/\/\S+/g) ?? [];
  assert.equal(textLinks.length, 1);
  assert.match(textLinks[0], /^https:\/\/exit1\.dev\/probe\//);

  const hrefs = html.match(/href="([^"]+)"/g) ?? [];
  assert.equal(hrefs.length, 1);
});

test("the body states the contact-once policy verbatim", () => {
  // probe's lint matches this sentence. Rewording it fails the send.
  const { text } = body();
  assert.ok(text.includes("This is the only email you will ever get from me. No follow-ups, no sequence."));
});

test("the body carries the provenance sentence the Article 14 notice needs", () => {
  const { text } = body();
  assert.match(text, /\bI run exit1\.dev\b/);
  assert.match(text, /found your address/i);
});

test("the body does not close on a question and asks for nothing", () => {
  const { text } = body();
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  assert.ok(!lines[lines.length - 1].trim().endsWith("?"));
  for (const forbidden of [
    /free trial/i,
    /book a call/i,
    /happy to/i,
    /let me know if/i,
    /sign up for/i,
    /our pricing/i,
  ]) {
    assert.doesNotMatch(text, forbidden, String(forbidden));
  }
});

test("the html and text variants tell the same story", () => {
  // probe's lint enforces a Jaccard similarity floor of 0.5 on content words,
  // so the two variants cannot drift apart.
  const { text, html } = body();
  const words = (input: string) =>
    new Set(
      input
        .replace(/<[^>]*>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
  const a = words(text);
  const b = words(html);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const jaccard = shared / (a.size + b.size - shared);
  assert.ok(jaccard >= 0.9, `similarity ${jaccard.toFixed(2)}`);
});

test("the html escapes the finding text", () => {
  const { html } = renderBody({
    finding: { ...FINDING, headline: 'A <script>alert("x")</script> & co' },
    evidenceUrl: "https://exit1.dev/probe/01234567-89ab-cdef-0123-456789abcdef",
    firstName: null,
    addressSource: "I found your address published on your own site.",
    productName: "Meterbase",
    source: "show_hn",
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp; co"));
});

// ---------------------------------------------------------------------------
// The evidence report's own id parsing. Regression: the page footer links to
// `<id>.json`, and the id was validated with the suffix still attached, so the
// shape check rejected it and every one of those advertised links 404'd.
// ---------------------------------------------------------------------------

const UUID = "3b7e51c1-4452-4d67-81b6-4eac854bfc7d";

test("parseEvidenceRequest accepts a bare id and asks for html", () => {
  const r = parseEvidenceRequest(`/${UUID}`, {});
  assert.equal(r.id, UUID);
  assert.equal(r.wantsJson, false);
  assert.equal(r.valid, true);
});

test("parseEvidenceRequest accepts the .json form the footer links to", () => {
  for (const path of [`/${UUID}.json`, `/probe/${UUID}.JSON`]) {
    const r = parseEvidenceRequest(path, {});
    assert.equal(r.id, UUID, path);
    assert.equal(r.wantsJson, true, path);
    assert.equal(r.valid, true, path);
  }
});

test("parseEvidenceRequest honours ?format=json without a suffix", () => {
  const r = parseEvidenceRequest(`/${UUID}`, { format: "json" });
  assert.equal(r.id, UUID);
  assert.equal(r.wantsJson, true);
  assert.equal(r.valid, true);
});

test("parseEvidenceRequest rejects anything that is not a report id", () => {
  for (const path of ["/", "/nope", "/../../etc/passwd", `/${UUID}.html`, "/12345"]) {
    assert.equal(parseEvidenceRequest(path, {}).valid, false, path);
  }
});

// ---------------------------------------------------------------------------
// The clean report (severity 0)
// ---------------------------------------------------------------------------

const OBSERVED: Observed = {
  host: "taonere.com",
  finalUrl: "https://taonere.com/",
  status: 200,
  ttfbMs: 412,
  redirects: 0,
  hsts: true,
  certIssuer: "Let's Encrypt",
  certValidTo: "2026-11-12T08:15:50.000Z",
  certDaysLeft: 70,
  counterpartHost: "www.taonere.com",
  counterpartOk: true,
  linksChecked: 9,
};

test("a clean site produces a severity 0 finding", () => {
  const finding = cleanReport(OBSERVED);
  assert.ok(finding);
  assert.equal(finding.severity, 0);
  assert.equal(finding.kind, "all_clear");
});

test("the clean report quotes what was measured, not adjectives", () => {
  const finding = cleanReport(OBSERVED);
  assert.ok(finding);
  // One measurement per line, because six of them in one sentence is a wall of
  // text nobody scans.
  const bullets = (finding.bullets ?? []).join(" | ");
  // Every one of these is verifiable by the recipient in thirty seconds, which
  // is the whole reason this is not a pretext.
  assert.match(bullets, /200/);
  assert.match(bullets, /412ms/);
  assert.doesNotMatch(bullets, /europe-west1/);
  assert.match(bullets, /70 days/);
  assert.match(bullets, /2026-11-12/);
  assert.match(bullets, /9 internal links/);
  assert.match(finding.subject, /taonere\.com/);
  // Each one reads as a line, not as a clause lifted out of a sentence. A
  // hostname or url keeps its own casing: "Https://" and "Www." are typos in an
  // email whose whole claim is that it looked carefully at that domain.
  for (const line of finding.bullets ?? []) {
    assert.doesNotMatch(line, /^Https?:/, line);
    assert.doesNotMatch(line, /^Www\./, line);
    assert.match(line, /^[A-Z]|^https?:\/\/|^[a-z0-9-]+\./, line);
  }
});

test("a site that could not be measured gets no clean report", () => {
  // Rule 1 still bites here: no measurement, no email. It just no longer
  // requires the measurement to be bad news.
  assert.equal(cleanReport({ ...OBSERVED, status: null }), null);
});

test("one measurement is not a report", () => {
  const thin: Observed = {
    ...OBSERVED,
    ttfbMs: null,
    certValidTo: null,
    certDaysLeft: null,
    counterpartHost: null,
    counterpartOk: null,
    linksChecked: 0,
  };
  assert.equal(cleanReport(thin), null);
});

test("the clean report renders a body that passes the same copy rules", () => {
  const finding = cleanReport(OBSERVED);
  assert.ok(finding);
  const { text } = renderBody({
    finding,
    evidenceUrl: "https://probe.exit1.dev/e/01234567-89ab-cdef-0123-456789abcdef",
    firstName: "Morten",
    addressSource: "I found your address published on your own site.",
    productName: "Taonere",
    source: "show_hn",
  });
  assert.ok(text.startsWith(finding.headline));
  assert.doesNotMatch(text, /^(hi|hey|hello|dear|congrats)/i);
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  assert.equal((withoutUrls.match(/exit1\.dev/gi) ?? []).length, 1);
  assert.match(text, /This is the only email you will ever get from me\./);
  // No question mark anywhere: 9.2 forbids a closing ask, and "nothing to fix"
  // copy is exactly where one would sneak in.
  assert.doesNotMatch(text, /\?/);
});

test("a slow first byte is read as seconds, not milliseconds", () => {
  const finding = cleanReport({ ...OBSERVED, ttfbMs: 1324 });
  assert.ok(finding);
  const bullets = (finding.bullets ?? []).join(" | ");
  assert.match(bullets, /1\.3 seconds/);
  assert.doesNotMatch(bullets, /1324/);
});

test("the clean report mentions a severity 2 note rather than hiding it", () => {
  // "everything came back clean" next to a 1.3 second first byte would be
  // wrong. It is not a defect and it is not nothing.
  const slow: Finding = {
    severity: 2,
    kind: "slow_ttfb",
    subject: "x",
    headline: "x",
    detail: "x",
    fix: "x",
    meta: { ttfb_ms: 1324 },
  };
  const finding = cleanReport({ ...OBSERVED, ttfbMs: 1324 }, [slow]);
  assert.ok(finding);
  assert.match(finding.detail, /keep half an eye on/);
  assert.match(finding.detail, /slow side/);
});

test("no severity 2 notes means no hedging sentence", () => {
  const finding = cleanReport(OBSERVED, []);
  assert.ok(finding);
  assert.doesNotMatch(finding.detail, /keep half an eye on/);
});

test("provenance names the real source rather than assuming a launch", () => {
  assert.match(provenanceSentence("Taonere", "show_hn"), /I saw Taonere on Show HN/);
  assert.match(provenanceSentence("Taonere", "product_hunt"), /on Product Hunt/);
  // Unknown source: vague rather than wrong.
  assert.match(provenanceSentence("Taonere", "manual"), /I came across Taonere/);
  assert.match(provenanceSentence("Taonere", null), /I came across Taonere/);
  for (const src of ["show_hn", "manual", null]) {
    assert.doesNotMatch(provenanceSentence("Taonere", src), /launched/);
    assert.doesNotMatch(provenanceSentence("Taonere", src), /this morning/);
  }
});

test("the bullets survive into both body variants", () => {
  const finding = cleanReport(OBSERVED);
  assert.ok(finding);
  const { text, html } = renderBody({
    finding,
    evidenceUrl: "https://probe.exit1.dev/e/abc",
    firstName: null,
    addressSource: "I found your address published on your own site.",
    productName: "Taonere",
    source: "show_hn",
  });
  // Plain text gets a real list, not a paragraph: the two variants have to
  // tell the same story or probe's similarity floor rejects the pair.
  assert.match(text, /\n {2}- /);
  assert.match(html, /<ul style=/);
  assert.match(html, /<li style=/);
  for (const bullet of finding.bullets ?? []) {
    assert.ok(text.includes(bullet), bullet);
  }
});
