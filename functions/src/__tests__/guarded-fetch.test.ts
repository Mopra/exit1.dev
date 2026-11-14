import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import zlib from "zlib";

import { guardedFetch } from "../guarded-fetch";
import { isBlockedAddressError, setSsrfGuardExemptionForTests } from "../ssrf-guard";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

const startServer = (
  handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void,
): Promise<{ port: number; seen: Seen[]; close: () => void }> =>
  new Promise((resolve) => {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const entry: Seen = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        seen.push(entry);
        handler(req, res, entry);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, seen, close: () => server.close() });
    });
  });

// Only 127.0.0.1 is let through, so 127.0.0.2 and friends still count as blocked.
const allowLoopback = () => setSsrfGuardExemptionForTests((ip) => ip === "127.0.0.1");
const reset = () => setSsrfGuardExemptionForTests(undefined);

test("refuses private, local and metadata targets without connecting", async () => {
  reset();
  const server = await startServer((_req, res) => res.end("secret"));
  try {
    const targets = [
      `http://127.0.0.1:${server.port}/`,
      `http://localhost:${server.port}/`,
      `http://2130706433:${server.port}/`,
      `http://0x7f.1:${server.port}/`,
      `http://[::1]:${server.port}/`,
      `http://[::ffff:127.0.0.1]:${server.port}/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/hook",
    ];
    for (const target of targets) {
      await assert.rejects(
        guardedFetch(target, { method: "POST", body: "{}", signal: AbortSignal.timeout(5000) }),
        (err) => isBlockedAddressError(err),
        target,
      );
    }
    assert.equal(server.seen.length, 0);
  } finally {
    server.close();
  }
});

test("refuses schemes other than http and https", async () => {
  await assert.rejects(guardedFetch("file:///etc/passwd"), TypeError);
});

test("delivers a POST with the customer's headers and returns the response", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => {
    res.writeHead(201, "Created", { "content-type": "text/plain", "x-reply": "yes" });
    res.end("stored");
  });
  try {
    const body = JSON.stringify({ event: "website_down", note: "æøå" });
    const response = await guardedFetch(`http://127.0.0.1:${server.port}/hook?x=1`, {
      method: "POST",
      // A customer Content-Length must not be able to corrupt the request.
      headers: { "Content-Type": "application/json", "X-Custom": "abc", "content-length": "3" },
      body,
    });
    assert.equal(response.status, 201);
    assert.equal(response.ok, true);
    assert.equal(response.statusText, "Created");
    assert.equal(response.headers.get("x-reply"), "yes");
    assert.equal(await response.text(), "stored");

    const [seen] = server.seen;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/hook?x=1");
    assert.equal(seen.body, body);
    assert.equal(seen.headers["x-custom"], "abc");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(seen.headers["content-length"], String(Buffer.byteLength(body)));
  } finally {
    server.close();
    reset();
  }
});

test("reports a failing status without throwing", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const response = await guardedFetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body: "{}" });
    assert.equal(response.ok, false);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "boom");
  } finally {
    server.close();
    reset();
  }
});

test("handles a 204 with no body", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const response = await guardedFetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body: "{}" });
    assert.equal(response.status, 204);
    assert.equal(response.ok, true);
    assert.equal(await response.text(), "");
  } finally {
    server.close();
    reset();
  }
});

test("a redirect to a private address is refused", async () => {
  allowLoopback();
  for (const location of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.2:9/", "http://[::1]:9/"]) {
    const server = await startServer((_req, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    try {
      await assert.rejects(
        guardedFetch(`http://127.0.0.1:${server.port}/`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(5000),
        }),
        (err) => isBlockedAddressError(err),
        location,
      );
    } finally {
      server.close();
    }
  }
  reset();
});

test("302 turns a POST into a GET, 307 keeps the POST and its body", async () => {
  allowLoopback();
  const server = await startServer((req, res) => {
    if (req.url === "/a") {
      res.writeHead(302, { location: "/landed" });
      res.end();
    } else if (req.url === "/b") {
      res.writeHead(307, { location: "/landed" });
      res.end();
    } else {
      res.end("ok");
    }
  });
  try {
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' };
    assert.equal((await guardedFetch(`http://127.0.0.1:${server.port}/a`, init)).status, 200);
    assert.equal((await guardedFetch(`http://127.0.0.1:${server.port}/b`, init)).status, 200);

    const landed = server.seen.filter((s) => s.url === "/landed");
    assert.equal(landed[0].method, "GET");
    assert.equal(landed[0].body, "");
    assert.equal(landed[0].headers["content-type"], undefined);
    assert.equal(landed[1].method, "POST");
    assert.equal(landed[1].body, '{"a":1}');
  } finally {
    server.close();
    reset();
  }
});

test("credentials are dropped when a redirect leaves the origin", async () => {
  allowLoopback();
  const other = await startServer((_req, res) => res.end("other"));
  const server = await startServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${other.port}/x` });
    res.end();
  });
  try {
    const response = await guardedFetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      headers: { Authorization: "Bearer secret", "X-Keep": "1" },
      body: "{}",
    });
    assert.equal(await response.text(), "other");
    assert.equal(server.seen[0].headers.authorization, "Bearer secret");
    assert.equal(other.seen[0].headers.authorization, undefined);
    assert.equal(other.seen[0].headers["x-keep"], "1");
  } finally {
    server.close();
    other.close();
    reset();
  }
});

test("gives up on a redirect loop", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => {
    res.writeHead(307, { location: "/again" });
    res.end();
  });
  try {
    await assert.rejects(
      guardedFetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body: "{}" }),
      /Too many redirects/,
    );
    assert.equal(server.seen.length, 6);
  } finally {
    server.close();
    reset();
  }
});

test("redirect: manual hands back the 3xx untouched", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => {
    res.writeHead(301, { location: "https://example.com/next" });
    res.end();
  });
  try {
    const response = await guardedFetch(`http://127.0.0.1:${server.port}/`, { redirect: "manual" });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "https://example.com/next");
    assert.equal(server.seen.length, 1);
  } finally {
    server.close();
    reset();
  }
});

test("decodes a gzip body and caps an oversized one", async () => {
  allowLoopback();
  const server = await startServer((req, res) => {
    if (req.url === "/gzip") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(zlib.gzipSync("hello compressed"));
    } else {
      res.end("x".repeat(50_000));
    }
  });
  try {
    const gz = await guardedFetch(`http://127.0.0.1:${server.port}/gzip`);
    assert.equal(await gz.text(), "hello compressed");
    const big = await guardedFetch(`http://127.0.0.1:${server.port}/big`, { maxBodyBytes: 1000 });
    assert.equal((await big.text()).length, 1000);
  } finally {
    server.close();
    reset();
  }
});

test("an abort signal ends a hanging request", async () => {
  allowLoopback();
  const server = await startServer(() => {
    // Never answers.
  });
  try {
    await assert.rejects(
      guardedFetch(`http://127.0.0.1:${server.port}/`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(200),
      }),
    );
  } finally {
    server.close();
    reset();
  }
});

test("a 101 reply or an odd status fails instead of hanging", async () => {
  allowLoopback();
  const net = await import("net");
  for (const [statusLine, pattern] of [
    ["HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", /switch protocols|closed before/],
    ["HTTP/1.1 999 Nope\r\nContent-Length: 0\r\n\r\n", /HTTP 999/],
  ] as const) {
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.write(statusLine));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await assert.rejects(
        guardedFetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(3000),
        }),
        pattern,
      );
    } finally {
      server.close();
    }
  }
  reset();
});

test("a gzip bomb does not unpack past the cap", async () => {
  allowLoopback();
  const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(bomb);
  });
  try {
    const response = await guardedFetch(`http://127.0.0.1:${server.port}/`, { maxBodyBytes: 100_000 });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength <= 100_000);
  } finally {
    server.close();
    reset();
  }
});

test("sends a default User-Agent and Accept, and keeps the caller's", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => res.end("ok"));
  try {
    await guardedFetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body: "{}" });
    await guardedFetch(`http://127.0.0.1:${server.port}/`, { headers: { "user-agent": "Custom/2" } });
    assert.equal(server.seen[0].headers["user-agent"], "Exit1-Website-Monitor/1.0");
    assert.equal(server.seen[0].headers.accept, "*/*");
    assert.equal(server.seen[1].headers["user-agent"], "Custom/2");
  } finally {
    server.close();
    reset();
  }
});

test("a refused connection gives a readable error", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => res.end("ok"));
  const port = server.port;
  server.close();
  await assert.rejects(
    guardedFetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" }),
    (err) => err instanceof Error && err.message.length > 0,
  );
  reset();
});

test("onHeaders fires before the body is read", async () => {
  allowLoopback();
  const server = await startServer((_req, res) => res.end("ok"));
  try {
    let calls = 0;
    await guardedFetch(`http://127.0.0.1:${server.port}/`, { onHeaders: () => { calls += 1; } });
    assert.equal(calls, 1);
  } finally {
    server.close();
    reset();
  }
});
