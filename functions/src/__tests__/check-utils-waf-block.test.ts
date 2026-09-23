import test from "node:test";
import assert from "node:assert/strict";
import http from "http";

import { checkRestEndpoint } from "../check-utils";
import type { Website } from "../types";
import { CF_BLOCK_BODY, CF_ORIGIN_503_BODY } from "./fixtures/cloudflare-pages";

type Seen = { method: string; range?: string; bodyBytes: number; userAgent?: string };

const startServer = (
  handler: (req: http.IncomingMessage, res: http.ServerResponse, index: number) => void
): Promise<{ port: number; seen: Seen[]; close: () => void }> =>
  new Promise((resolve) => {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const entry: Seen = {
        method: req.method ?? "",
        range: req.headers.range,
        bodyBytes: 0,
        userAgent: req.headers["user-agent"],
      };
      seen.push(entry);
      // Bodies go out chunked (no Content-Length), so count the bytes we receive.
      req.on("data", (chunk: Buffer) => { entry.bodyBytes += chunk.length; });
      req.on("end", () => handler(req, res, seen.length - 1));
      req.resume();
    });
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, seen, close: () => server.close() });
    });
  });

// Plain website check: default expected codes (which include 401/403), no
// response validation, so the probe uses a Range GET and never reads a body.
const makeWebsite = (port: number, extra: Partial<Website> = {}): Website => ({
  id: "test-check",
  userId: "test-user",
  name: "Test Site",
  url: `http://127.0.0.1:${port}`,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  sslCertificate: { valid: true, lastChecked: Date.now() },
  ...extra,
});

const serveCloudflareBlock = (res: http.ServerResponse) => {
  res.statusCode = 403;
  res.statusMessage = "Forbidden";
  res.setHeader("server", "cloudflare");
  res.setHeader("cf-ray", "a3b9c0798addd054-CPH");
  res.setHeader("content-type", "text/html; charset=UTF-8");
  res.end(CF_BLOCK_BODY);
};

test("Cloudflare WAF block page is DOWN even though 403 is an accepted status code", async () => {
  const { port, seen, close } = await startServer((req, res) => serveCloudflareBlock(res));

  try {
    const result = await checkRestEndpoint(makeWebsite(port));
    assert.equal(result.status, "offline");
    assert.equal(result.detailedStatus, "DOWN");
    assert.equal(result.statusCode, 403);
    assert.match(result.error ?? "", /^Blocked by Cloudflare firewall \(HTTP 403\)/);
    assert.match(result.error ?? "", /Exit1-Website-Monitor\/1\.0/);

    // Range GET, then the retry without Range that a 403 already triggers now
    // reads the body too. No third connection.
    assert.equal(seen.length, 2, JSON.stringify(seen));
    assert.equal(seen[0].range, "bytes=0-0");
    assert.equal(seen[1].range, undefined);
  } finally {
    close();
  }
});

test("cf-mitigated challenge header is DOWN without spending a body probe", async () => {
  const { port, seen, close } = await startServer((req, res) => {
    res.statusCode = 403;
    res.setHeader("server", "cloudflare");
    res.setHeader("cf-mitigated", "challenge");
    res.end();
  });

  try {
    const result = await checkRestEndpoint(makeWebsite(port));
    assert.equal(result.status, "offline");
    assert.equal(result.detailedStatus, "DOWN");
    assert.match(result.error ?? "", /^Cloudflare challenge page \(HTTP 403\)/);
    assert.equal(seen.length, 2, JSON.stringify(seen));
  } finally {
    close();
  }
});

test("an origin 403 behind Cloudflare stays UP and costs no extra connection", async () => {
  const { port, seen, close } = await startServer((req, res) => {
    res.statusCode = 403;
    res.setHeader("server", "cloudflare");
    res.setHeader("cf-ray", "abc-FRA");
    res.end("<html><head><title>Forbidden</title></head><body>Members only.</body></html>");
  });

  try {
    const result = await checkRestEndpoint(makeWebsite(port));
    assert.equal(result.status, "online");
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, undefined);
    assert.equal(seen.length, 2, JSON.stringify(seen));
  } finally {
    close();
  }
});

test("a 403 with no edge fingerprint stays UP and costs no extra request", async () => {
  const { port, seen, close } = await startServer((req, res) => {
    res.statusCode = 403;
    res.setHeader("server", "nginx");
    res.end("<html><body>Forbidden</body></html>");
  });

  try {
    const result = await checkRestEndpoint(makeWebsite(port));
    assert.equal(result.status, "online");
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, undefined);
    assert.equal(seen.length, 2, JSON.stringify(seen));
  } finally {
    close();
  }
});

test("a Cloudflare-branded origin 503 keeps its plain HTTP 503 error and costs one request", async () => {
  const { port, seen, close } = await startServer((req, res) => {
    res.statusCode = 503;
    res.statusMessage = "Service Unavailable";
    res.setHeader("server", "cloudflare");
    res.setHeader("cf-ray", "abc-FRA");
    res.end(CF_ORIGIN_503_BODY);
  });

  try {
    const result = await checkRestEndpoint(makeWebsite(port));
    assert.equal(result.status, "offline");
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, "HTTP 503: Service Unavailable");
    // 503 is already DOWN, so no body read is spent on it.
    assert.equal(seen.length, 1, JSON.stringify(seen));
  } finally {
    close();
  }
});

test("a POST check blocked at the edge is probed with its own method and body", async () => {
  const { port, seen, close } = await startServer((req, res) => serveCloudflareBlock(res));

  try {
    const result = await checkRestEndpoint(
      makeWebsite(port, { type: "rest", httpMethod: "POST", requestBody: JSON.stringify({ user: "probe" }) })
    );
    assert.equal(result.status, "offline");
    assert.equal(result.detailedStatus, "DOWN");
    assert.match(result.error ?? "", /^Blocked by Cloudflare firewall \(HTTP 403\)/);

    // Non-GET: no Range dance, so the body comes from the isolated fallback probe,
    // which replays the POST with its payload rather than a bare GET.
    assert.equal(seen.length, 2, JSON.stringify(seen));
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[1].method, "POST");
    assert.ok(seen[1].bodyBytes > 0, "probe carried the request body");
  } finally {
    close();
  }
});

test("a failing fallback probe leaves the original 403 result untouched", async () => {
  const { port, seen, close } = await startServer((req, res, index) => {
    if (index === 0) {
      res.statusCode = 403;
      res.setHeader("server", "cloudflare");
      res.setHeader("cf-ray", "abc-FRA");
      res.end();
      return;
    }
    // Second connection is torn down mid-flight.
    req.socket.destroy();
  });

  try {
    const result = await checkRestEndpoint(makeWebsite(port, { type: "rest", httpMethod: "POST" }));
    assert.equal(result.status, "online");
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, undefined);
    assert.equal(seen.length, 2, JSON.stringify(seen));
  } finally {
    close();
  }
});

test("a bodiless 403 whose body was already read is not probed again", async () => {
  const { port, seen, close } = await startServer((req, res) => {
    res.statusCode = 403;
    res.setHeader("server", "cloudflare");
    res.setHeader("cf-ray", "abc-FRA");
    res.setHeader("content-length", "0");
    res.end();
  });

  try {
    // responseValidation makes the first request read the body (empty here).
    const result = await checkRestEndpoint(makeWebsite(port, { responseValidation: { containsText: ["ok"] } }));
    assert.equal(result.statusCode, 403);
    assert.doesNotMatch(result.error ?? "", /Cloudflare/);
    assert.equal(seen.length, 1, JSON.stringify(seen));
  } finally {
    close();
  }
});

test("the block error names the user agent that was actually sent", async () => {
  const { port, seen, close } = await startServer((req, res) => serveCloudflareBlock(res));

  try {
    const result = await checkRestEndpoint(
      makeWebsite(port, { requestHeaders: { "user-agent": "AcmeMonitor/2.0" } })
    );
    assert.equal(result.status, "offline");
    assert.equal(seen[0].userAgent, "AcmeMonitor/2.0");
    assert.match(result.error ?? "", /"AcmeMonitor\/2\.0"/);
    assert.doesNotMatch(result.error ?? "", /Exit1-Website-Monitor/);
  } finally {
    close();
  }
});
