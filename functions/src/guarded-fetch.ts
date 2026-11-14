import http from "http";
import https from "https";
import zlib from "zlib";
import dns from "dns";
import {
  assertPublicHost,
  BlockedAddressError,
  blockedPeerError,
  guardedSystemLookupOption,
  reservedAddressReason,
} from "./ssrf-guard";

/**
 * fetch for URLs a customer chose (webhook endpoints, a site to probe).
 *
 * Global fetch resolves the name itself and follows redirects itself, so a
 * webhook URL, a DNS record or a 302 could aim a delivery at 127.0.0.1, the
 * Docker bridge or the cloud metadata address. This one goes through
 * http/https with the guarded lookup from ssrf-guard.ts: the socket connects
 * to exactly the address that was validated, and every redirect hop is
 * validated the same way.
 *
 * Deliberately not built on an undici dispatcher: Node's bundled undici and an
 * installed one disagree across versions, and the VPS runner loads this file
 * from functions/lib. Plain http has no such seam.
 */

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** "follow" (default) walks redirects, each hop guarded. "manual" returns the 3xx. */
  redirect?: "follow" | "manual";
  /** Response bodies are cut off here, before and after decompression. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Called each time a hop's status line and headers arrive, before its body. */
  onHeaders?: () => void;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
// A ceiling for callers that pass no signal, and for an endpoint that trickles a body.
const HARD_DEADLINE_MS = 60_000;
const DEFAULT_USER_AGENT = "Exit1-Website-Monitor/1.0";
const NULL_BODY_STATUS = new Set([204, 205, 304]);
// Dropped when a redirect leaves the origin, as fetch does.
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
// Dropped when a redirect turns a POST into a GET.
const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding", "content-language"]);
// Set by this module from the real body. A customer value would corrupt the request.
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

/**
 * Our own services that customers (and we) deliver webhooks to, and that live
 * on a runner box. The guard refuses a box's own public address, because from
 * the box itself that address also reaches ports the firewall hides from the
 * internet. For these names, on HTTPS port 443 only, that one rule is waived:
 * 443 is the public front door either way. Private and local ranges stay
 * refused. Comma separated in WEBHOOK_TRUSTED_HOSTS.
 */
const TRUSTED_OWN_HOSTS = new Set(
  (process.env.WEBHOOK_TRUSTED_HOSTS ?? "automation.exit1.dev")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

function isTrustedOwnTarget(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.port === "" || url.port === "443") &&
    TRUSTED_OWN_HOSTS.has(url.hostname.toLowerCase())
  );
}

/** dns.lookup that refuses reserved ranges but lets the box's own public address through. */
const reservedOnlyLookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const allowed = list.filter((entry) => !reservedAddressReason(entry.address));
    if (allowed.length === 0) {
      const first = list[0]?.address ?? "";
      return callback(new BlockedAddressError(hostname, first, reservedAddressReason(first) ?? "private"));
    }
    if (Array.isArray(address)) return callback(null, allowed);
    return callback(null, allowed[0].address, allowed[0].family);
  });
}) as unknown as typeof dns.lookup;

// Fresh sockets only. A pooled socket could have been opened by unguarded
// code, and a stale keep-alive socket fails a POST that cannot be replayed.
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function filterHeaders(
  headers: Record<string, string>,
  drop: (lowerName: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!drop(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * Undo a compressed body. No Accept-Encoding is sent, so this is for servers
 * that compress anyway. maxOutputLength is what stops a small gzip from
 * unpacking into gigabytes: past the cap, or on a corrupt stream, the body
 * comes back empty instead.
 */
function decodeBody(buffer: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  try {
    switch ((encoding ?? "").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: maxBytes });
      case "deflate":
        return zlib.inflateSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: maxBytes });
      case "br":
        return zlib.brotliDecompressSync(buffer, {
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
          maxOutputLength: maxBytes,
        });
      default:
        return buffer;
    }
  } catch {
    return Buffer.alloc(0);
  }
}

/** Give every failure a message a customer can read in their webhook's last error. */
function describeFailure(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if (err.name === "AbortError" || err.name === "TimeoutError") {
    const timedOut = new Error("Request timed out before the endpoint answered");
    timedOut.name = err.name;
    return timedOut;
  }
  if (err.message) return err;
  // Node reports "every address failed" as an AggregateError with an empty message.
  const inner = ((err as { errors?: unknown[] }).errors ?? []).find(
    (e): e is Error => e instanceof Error && Boolean(e.message),
  );
  const code = (err as NodeJS.ErrnoException).code ?? (inner as NodeJS.ErrnoException | undefined)?.code;
  const described: NodeJS.ErrnoException = new Error(
    inner?.message || (code ? `Connection failed (${code})` : "Connection failed"),
  );
  described.code = code;
  return described;
}

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal | undefined,
  maxBodyBytes: number,
  onHeaders: (() => void) | undefined,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    // An IP literal never reaches the lookup, so it is judged here.
    try {
      assertPublicHost(url.hostname);
    } catch (err) {
      reject(err);
      return;
    }

    const isHttps = url.protocol === "https:";
    const trustedOwn = isTrustedOwnTarget(url);
    const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
    const sendHeaders = filterHeaders(headers, (name) => FRAMING_HEADERS.has(name));
    if (payload) sendHeaders["Content-Length"] = String(payload.length);
    // fetch sent these by default, and some WAFs turn away a request without them.
    const sent = new Set(Object.keys(sendHeaders).map((name) => name.toLowerCase()));
    if (!sent.has("user-agent")) sendHeaders["User-Agent"] = DEFAULT_USER_AGENT;
    if (!sent.has("accept")) sendHeaders["Accept"] = "*/*";

    let settled = false;
    let req: http.ClientRequest | undefined;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(describeFailure(err));
    };
    const deadline = setTimeout(() => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      fail(err);
      req?.destroy();
    }, HARD_DEADLINE_MS);

    try {
      const request = (isHttps ? https : http).request(
        url,
        {
          method,
          headers: sendHeaders,
          agent: isHttps ? httpsAgent : httpAgent,
          lookup: trustedOwn ? reservedOnlyLookup : guardedSystemLookupOption,
          signal,
        },
        (res) => {
          const blocked = trustedOwn ? undefined : blockedPeerError(url.hostname, res.socket?.remoteAddress);
          if (blocked) {
            request.destroy();
            fail(blocked);
            return;
          }
          const status = res.statusCode ?? 0;
          // The Response constructor only takes 200 to 599.
          if (status < 200 || status > 599) {
            request.destroy();
            fail(new Error(`HTTP ${status}: not a status this client can handle`));
            return;
          }
          try {
            onHeaders?.();
          } catch {
            // A caller's timing hook must not fail the request.
          }

          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () => {
            if (settled) return;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const item of Array.isArray(value) ? value : [value]) {
                try {
                  responseHeaders.append(name, item);
                } catch {
                  // A header fetch would refuse is not worth failing a delivery over.
                }
              }
            }
            const raw = Buffer.concat(chunks);
            const decoded = decodeBody(raw, res.headers["content-encoding"], maxBodyBytes);
            if (decoded !== raw) {
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
            }
            const responseBody = NULL_BODY_STATUS.has(status) || method === "HEAD" ? null : new Uint8Array(decoded);
            let response: Response;
            try {
              try {
                response = new Response(responseBody, {
                  status,
                  statusText: res.statusMessage ?? "",
                  headers: responseHeaders,
                });
              } catch {
                // A reason phrase the constructor refuses. The status is what matters.
                response = new Response(responseBody, { status, headers: responseHeaders });
              }
            } catch (err) {
              fail(err);
              return;
            }
            settled = true;
            clearTimeout(deadline);
            resolve(response);
          };

          res.on("data", (chunk: Buffer) => {
            if (size >= maxBodyBytes) return;
            const room = maxBodyBytes - size;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            size += chunk.length;
            if (size >= maxBodyBytes) {
              // Enough. Stop reading and hand back what there is.
              finish();
              request.destroy();
            }
          });
          res.on("end", finish);
          res.on("error", fail);
          res.on("close", () => fail(new Error("Response ended before it completed")));
        },
      );
      req = request;

      request.on("error", fail);
      // A 101 reply gives neither a response nor an error, so without these
      // two the promise would never settle.
      request.on("upgrade", (_res, socket) => {
        socket.destroy();
        fail(new Error("Endpoint tried to switch protocols instead of answering"));
      });
      request.on("close", () => fail(new Error("Connection closed before a response arrived")));
      request.end(payload);
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Like fetch(url, init), for a URL that came from a customer. Rejects with a
 * BlockedAddressError (see isBlockedAddressError) when the URL, or a redirect
 * from it, leads to a private, local or own address.
 */
export async function guardedFetch(input: string | URL, init: GuardedFetchInit = {}): Promise<Response> {
  let url = new URL(String(input));
  let method = (init.method ?? "GET").toUpperCase();
  let headers = { ...(init.headers ?? {}) };
  let body = init.body;
  const maxBodyBytes = init.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`Unsupported URL scheme: ${url.protocol}`);
    }
    const response = await requestOnce(url, method, headers, body, init.signal, maxBodyBytes, init.onHeaders);

    const location = response.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && Boolean(location);
    if (init.redirect === "manual" || !isRedirect) return response;
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);

    const next = new URL(location as string, url);
    // Same rewrite fetch does: 303 always, 301 and 302 for a POST, become a GET.
    const toGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (toGet) {
      method = "GET";
      body = undefined;
      headers = filterHeaders(headers, (name) => BODY_HEADERS.has(name));
    }
    if (next.origin !== url.origin) {
      headers = filterHeaders(headers, (name) => CREDENTIAL_HEADERS.has(name) || name === "host");
    }
    url = next;
  }
}
