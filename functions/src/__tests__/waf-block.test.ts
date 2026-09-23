import test from "node:test";
import assert from "node:assert/strict";

import { detectWafBlock, describeWafBlock, mayBeWafResponse } from "../waf-block";
import {
  CF_BLOCK_BODY,
  CF_CHALLENGE_BODY,
  CF_ORIGIN_503_BODY,
  ORIGIN_403_WITH_JSD_BODY,
} from "./fixtures/cloudflare-pages";

const headers = (init: Record<string, string>) => new Headers(init);

test("Cloudflare WAF block page on a 403 is detected as a block", () => {
  const block = detectWafBlock(403, headers({ server: "cloudflare", "cf-ray": "a3b9c0798addd054-CPH" }), CF_BLOCK_BODY);
  assert.deepEqual(block, { vendor: "Cloudflare", kind: "block" });
});

test("Cloudflare block page is recognised from the body alone when edge headers are missing", () => {
  const block = detectWafBlock(403, headers({}), CF_BLOCK_BODY);
  assert.deepEqual(block, { vendor: "Cloudflare", kind: "block" });
});

test("cf-mitigated: challenge settles a challenge without any body", () => {
  const block = detectWafBlock(403, headers({ server: "cloudflare", "cf-mitigated": "challenge" }));
  assert.deepEqual(block, { vendor: "Cloudflare", kind: "challenge" });
  const underAttack = detectWafBlock(503, headers({ "cf-mitigated": "challenge" }));
  assert.deepEqual(underAttack, { vendor: "Cloudflare", kind: "challenge" });
});

test("legacy challenge page body is detected as a challenge", () => {
  const block = detectWafBlock(403, headers({ server: "cloudflare" }), CF_CHALLENGE_BODY);
  assert.deepEqual(block, { vendor: "Cloudflare", kind: "challenge" });
});

test("an ordinary origin 403 behind Cloudflare is not a block", () => {
  const block = detectWafBlock(
    403,
    headers({ server: "cloudflare", "cf-ray": "abc-FRA" }),
    "<html><head><title>Forbidden</title></head><body>You need to log in.</body></html>"
  );
  assert.equal(block, undefined);
});

test("an origin 403 carrying the injected JavaScript Detections script is not a challenge", () => {
  const block = detectWafBlock(403, headers({ server: "cloudflare", "cf-ray": "abc-FRA" }), ORIGIN_403_WITH_JSD_BODY);
  assert.equal(block, undefined);
});

test("a Cloudflare-branded origin 503 error page is not a block", () => {
  // Same template markup as the block page (cf-error-details, cf.errors.css),
  // but the origin was reached; the plain "HTTP 503" error must survive.
  const block = detectWafBlock(503, headers({ server: "cloudflare", "cf-ray": "abc-FRA" }), CF_ORIGIN_503_BODY);
  assert.equal(block, undefined);
});

test("block signatures are ignored on non-candidate status codes", () => {
  assert.equal(detectWafBlock(200, headers({ server: "cloudflare" }), CF_BLOCK_BODY), undefined);
  assert.equal(detectWafBlock(401, headers({ server: "cloudflare", "cf-mitigated": "challenge" })), undefined);
  assert.equal(detectWafBlock(500, headers({ server: "cloudflare" }), CF_BLOCK_BODY), undefined);
  // The 1020 block markup only means "blocked" on a 403.
  assert.equal(detectWafBlock(503, headers({ server: "cloudflare" }), CF_BLOCK_BODY), undefined);
});

test("a 403 with no edge fingerprint and no body is not a block", () => {
  assert.equal(detectWafBlock(403, headers({ server: "nginx" })), undefined);
  assert.equal(detectWafBlock(403, headers({ server: "nginx" }), "<title>Forbidden</title>"), undefined);
});

test("mayBeWafResponse gates the extra body fetch on status and edge headers", () => {
  assert.equal(mayBeWafResponse(403, headers({ server: "cloudflare" })), true);
  assert.equal(mayBeWafResponse(403, headers({ "cf-ray": "abc" })), true);
  assert.equal(mayBeWafResponse(503, headers({ "cf-mitigated": "challenge" })), true);
  assert.equal(mayBeWafResponse(403, headers({ server: "nginx" })), false);
  assert.equal(mayBeWafResponse(200, headers({ server: "cloudflare" })), false);
  assert.equal(mayBeWafResponse(404, headers({ server: "cloudflare" })), false);
});

test("describeWafBlock names the vendor, the status, the fix and the docs", () => {
  const msg = describeWafBlock({ vendor: "Cloudflare", kind: "block" }, 403, "Exit1-Website-Monitor/1.0");
  assert.match(msg, /^Blocked by Cloudflare firewall \(HTTP 403\)/);
  assert.match(msg, /never reached your origin server/);
  assert.match(msg, /"Exit1-Website-Monitor\/1\.0"/);
  assert.match(msg, /docs\.exit1\.dev\/monitoring\/request-headers/);

  const challenge = describeWafBlock({ vendor: "Cloudflare", kind: "challenge" }, 503, "Exit1-Website-Monitor/1.0");
  assert.match(challenge, /^Cloudflare challenge page \(HTTP 503\)/);
});
