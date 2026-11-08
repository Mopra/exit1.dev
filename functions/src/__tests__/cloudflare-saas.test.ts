import test from "node:test";
import assert from "node:assert/strict";

import { CloudflareApiError, CloudflareSaasClient, mapProviderState, type FetchLike } from "../cloudflare-saas";
import {
  CH_ACTIVE,
  CH_ACTIVE_HOSTNAME_PENDING_SSL,
  CH_BLOCKED,
  CH_MOVED,
  CH_PENDING_VALIDATION,
  CH_SSL_ERRORS,
  CH_SSL_TIMED_OUT,
  DUPLICATE_ERROR_BODY,
} from "./fixtures/cloudflare-custom-hostnames";

// ── mapProviderState ──

test("pending validation with a verification error stays pending with that message", () => {
  const s = mapProviderState(CH_PENDING_VALIDATION);
  assert.equal(s.kind, "pending");
  assert.equal(s.providerStatus, "pending");
  assert.equal(s.sslStatus, "pending_validation");
  assert.match(s.error ?? "", /does not CNAME/);
});

test("hostname active but certificate pending is still pending", () => {
  const s = mapProviderState(CH_ACTIVE_HOSTNAME_PENDING_SSL);
  assert.equal(s.kind, "pending");
  assert.match(s.error ?? "", /certificate/);
});

test("both active is active", () => {
  assert.deepEqual(mapProviderState(CH_ACTIVE), { kind: "active", providerStatus: "active", sslStatus: "active", error: null });
});

test("moved and blocked", () => {
  assert.equal(mapProviderState(CH_MOVED).kind, "moved");
  assert.match(mapProviderState(CH_MOVED).error ?? "", /domains\.exit1\.dev/);
  const b = mapProviderState(CH_BLOCKED);
  assert.equal(b.kind, "blocked");
  assert.match(b.error ?? "", /blocked/);
});

test("ssl validation errors and timeouts surface", () => {
  assert.match(mapProviderState(CH_SSL_ERRORS).error ?? "", /CAA/);
  assert.match(mapProviderState(CH_SSL_TIMED_OUT).error ?? "", /timed out/);
});

// ── client ──

type Call = { url: string; method: string; body: unknown };

function fakeFetch(responses: Array<{ status: number; body: unknown }>, calls: Call[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
}

const client = (responses: Array<{ status: number; body: unknown }>, calls: Call[]) =>
  new CloudflareSaasClient({ token: "t", zoneId: "zone1", fetch: fakeFetch(responses, calls) });

test("create posts http DV with TLS 1.2", async () => {
  const calls: Call[] = [];
  const h = await client([{ status: 200, body: { success: true, result: CH_PENDING_VALIDATION } }], calls)
    .createCustomHostname("status.acme.com");
  assert.equal(h.id, CH_PENDING_VALIDATION.id);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/zones\/zone1\/custom_hostnames$/);
  assert.deepEqual(calls[0].body, {
    hostname: "status.acme.com",
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
});

test("a duplicate create adopts the existing hostname", async () => {
  const calls: Call[] = [];
  const h = await client([
    { status: 409, body: DUPLICATE_ERROR_BODY },
    { status: 200, body: { success: true, result: [CH_ACTIVE] } },
  ], calls).createCustomHostname("status.acme.com");
  assert.equal(h.id, CH_ACTIVE.id);
  assert.match(calls[1].url, /\?hostname=status\.acme\.com$/);
});

test("other create errors throw", async () => {
  await assert.rejects(
    client([{ status: 400, body: { success: false, errors: [{ code: 1411, message: "bad" }], result: null } }], [])
      .createCustomHostname("status.acme.com"),
    CloudflareApiError,
  );
});

test("delete treats 404 as success", async () => {
  await client([{ status: 404, body: { success: false, errors: [{ code: 1436, message: "not found" }], result: null } }], [])
    .deleteCustomHostname("gone");
});

test("get returns null on 404", async () => {
  const h = await client([{ status: 404, body: { success: false, errors: [], result: null } }], []).getCustomHostname("gone");
  assert.equal(h, null);
});

test("listAll walks pages", async () => {
  const calls: Call[] = [];
  const all = await client([
    { status: 200, body: { success: true, result: [CH_ACTIVE], result_info: { page: 1, total_pages: 2, total_count: 2 } } },
    { status: 200, body: { success: true, result: [CH_MOVED], result_info: { page: 2, total_pages: 2, total_count: 2 } } },
  ], calls).listAllCustomHostnames();
  assert.equal(all.length, 2);
  assert.match(calls[1].url, /page=2&per_page=50/);
});
