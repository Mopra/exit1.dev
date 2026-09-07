import test from "node:test";
import assert from "node:assert/strict";

import { MCP_ALLOWED_METHODS, isMcpTransportMethod } from "../mcp-http-policy";

// The hosted MCP server bills by wall-clock. A GET that reaches the SDK
// transport opens a standalone SSE stream and holds a Cloud Run instance for
// the full function timeout (the 2026-08-30 cost spike). These tests pin the
// decision that only POST is ever handed to the transport.

test("POST reaches the transport, case-insensitively", () => {
  assert.equal(isMcpTransportMethod("POST"), true);
  assert.equal(isMcpTransportMethod("post"), true);
});

test("GET is refused so no standalone SSE stream can be opened", () => {
  assert.equal(isMcpTransportMethod("GET"), false);
  assert.equal(isMcpTransportMethod("get"), false);
});

test("DELETE and every other method are refused; the stateless server has no sessions to end", () => {
  for (const method of ["DELETE", "PUT", "PATCH", "HEAD", "OPTIONS", ""]) {
    assert.equal(isMcpTransportMethod(method), false, method || "(empty)");
  }
});

test("Allow header advertises exactly what the handler accepts", () => {
  assert.equal(MCP_ALLOWED_METHODS, "POST, OPTIONS");
});
