import test from "node:test";
import assert from "node:assert/strict";
import http from "http";

import { checkRestEndpoint } from "../check-utils";
import type { Website } from "../types";

const startServer = (handler: http.RequestListener): Promise<{ port: number; close: () => void }> =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });

const makeWebsite = (port: number, responseValidation: Website["responseValidation"]): Website => ({
  id: "test-check",
  userId: "test-user",
  name: "Test Site",
  url: `http://127.0.0.1:${port}`,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  // Fresh SSL cache so the test never opens outbound security lookups.
  sslCertificate: { valid: true, lastChecked: Date.now() },
  responseValidation,
});

test("jsonPath assertion failure marks the check offline and captures the body", async () => {
  const body = JSON.stringify({ status: "degraded", model: "gpt-x" });
  const { port, close } = await startServer((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(body);
  });

  try {
    const result = await checkRestEndpoint(
      makeWebsite(port, { jsonPath: "$.status", jsonPathOperator: "equals", expectedValue: "ok" })
    );
    assert.equal(result.status, "offline");
    assert.match(result.error ?? "", /JSONPath \$\.status expected/);
    assert.equal(result.responseBodySample, body);
  } finally {
    close();
  }
});

test("jsonPath assertion success keeps the check online with no body sample", async () => {
  const { port, close } = await startServer((req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok" }));
  });

  try {
    const result = await checkRestEndpoint(
      makeWebsite(port, { jsonPath: "$.status", jsonPathOperator: "equals", expectedValue: "ok" })
    );
    assert.equal(result.status, "online");
    assert.equal(result.error, undefined);
    assert.equal(result.responseBodySample, undefined);
  } finally {
    close();
  }
});

test("non-JSON body fails a configured jsonPath assertion with a clear reason", async () => {
  const { port, close } = await startServer((req, res) => {
    res.statusCode = 200;
    res.end("<html>not json</html>");
  });

  try {
    const result = await checkRestEndpoint(
      makeWebsite(port, { jsonPath: "$.status", jsonPathOperator: "exists" })
    );
    assert.equal(result.status, "offline");
    assert.match(result.error ?? "", /not valid JSON/);
    assert.equal(result.responseBodySample, "<html>not json</html>");
  } finally {
    close();
  }
});

test("containsText failure captures the body sample; body spanning chunks still matches", async () => {
  // Send the body in two chunks with a flush in between — the old
  // first-chunk-only reader would have missed text in the second chunk.
  const { port, close } = await startServer((req, res) => {
    res.statusCode = 200;
    res.write("<html><head><title>shop</title></head>");
    setTimeout(() => {
      res.end("<body>checkout button</body></html>");
    }, 20);
  });

  try {
    const miss = await checkRestEndpoint(makeWebsite(port, { containsText: ["basket"] }));
    assert.equal(miss.status, "offline");
    assert.match(miss.error ?? "", /did not contain expected text/);
    assert.ok(miss.responseBodySample?.includes("<title>shop</title>"));

    const hit = await checkRestEndpoint(makeWebsite(port, { containsText: ["checkout button"] }));
    assert.equal(hit.status, "online");
    assert.equal(hit.responseBodySample, undefined);
  } finally {
    close();
  }
});
