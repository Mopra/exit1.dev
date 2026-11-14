import http from "http";
import https from "https";
import zlib from "zlib";
import { assertPublicHost, blockedPeerError, guardedSystemLookupOption } from "./ssrf-guard";

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
  /** Response bodies are cut off here. Default 1 MiB. */
  maxBodyBytes?: number;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const NULL_BODY_STATUS = new Set([204, 205, 304]);
// Dropped when a redirect leaves the origin, as fetch does.
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
// Dropped when a redirect turns a POST into a GET.
const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding", "content-language"]);
// Set by this module from the real body. A customer value would corrupt the request.
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

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

function decodeBody(buffer: Buffer, encoding: string | undefined): Buffer {
  try {
    switch ((encoding ?? "").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      case "deflate":
        return zlib.inflateSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      case "br":
        return zlib.brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
      default:
        return buffer;
    }
  } catch {
    return buffer;
  }
}

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal | undefined,
  maxBodyBytes: number,
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
    const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
    const sendHeaders = filterHeaders(headers, (name) => FRAMING_HEADERS.has(name));
    if (payload) sendHeaders["Content-Length"] = String(payload.length);

    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let req: http.ClientRequest;
    try {
      req = (isHttps ? https : http).request(
        url,
        {
          method,
          headers: sendHeaders,
          agent: isHttps ? httpsAgent : httpAgent,
          lookup: guardedSystemLookupOption,
          signal,
        },
        (res) => {
          const blocked = blockedPeerError(url.hostname, res.socket?.remoteAddress);
          if (blocked) {
            req.destroy();
            fail(blocked);
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () => {
            if (settled) return;
            settled = true;
            const status = res.statusCode ?? 0;
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
            const decoded = decodeBody(raw, res.headers["content-encoding"]);
            if (decoded !== raw) {
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
            }
            try {
              resolve(
                new Response(NULL_BODY_STATUS.has(status) || method === "HEAD" ? null : new Uint8Array(decoded), {
                  status,
                  statusText: res.statusMessage ?? "",
                  headers: responseHeaders,
                }),
              );
            } catch (err) {
              reject(err);
            }
          };

          res.on("data", (chunk: Buffer) => {
            if (size >= maxBodyBytes) return;
            const room = maxBodyBytes - size;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            size += chunk.length;
            if (size >= maxBodyBytes) {
              // Enough. Stop reading and hand back what there is.
              finish();
              req.destroy();
            }
          });
          res.on("end", finish);
          res.on("error", fail);
          res.on("aborted", () => fail(new Error("Response aborted before it completed")));
        },
      );
    } catch (err) {
      fail(err);
      return;
    }

    req.on("error", fail);
    req.end(payload);
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
    const response = await requestOnce(url, method, headers, body, init.signal, maxBodyBytes);

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
