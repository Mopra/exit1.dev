/**
 * Fetches and caches OAuth Client ID Metadata Documents for the MCP OAuth server.
 *
 * With CIMD an MCP client's client_id is an https URL, and the document at that
 * URL lists its name and redirect URIs. That replaces dynamic registration (now
 * deprecated in the MCP spec): no `mcp_oauth_clients` row, and the consent page
 * can show the domain that published the client instead of a name anyone could
 * have typed into a registration request.
 *
 * The URL is chosen by whoever crafts the authorize link, so the fetch is the
 * dangerous part. The address check runs inside the socket's DNS lookup, which
 * means the IP we vetted is the IP we connect to and a rebinding DNS server
 * can't swap in an internal one between the check and the request.
 */

import https from "https";
import dns from "dns";
import net, { type LookupFunction } from "net";
import {
  cimdCacheTtlMs,
  isSpecialUseAddress,
  validateCimdDocument,
  type CimdClient,
} from "./mcp-oauth-policy";

const FETCH_TIMEOUT_MS = 5000;
// The draft recommends 5 KB. Claude Code's document is about 300 bytes.
const MAX_DOCUMENT_BYTES = 5 * 1024;
const CACHE_MAX_ENTRIES = 1000;

const cache = new Map<string, { client: CimdClient; expiresAt: number }>();

export class CimdError extends Error {}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isSpecialUseAddress(a.address))) {
      callback(new CimdError("Client metadata URL resolves to a non-public address"), "", 0);
      return;
    }
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
};

function fetchDocument(url: string): Promise<{ body: string; cacheControl: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: safeLookup,
        timeout: FETCH_TIMEOUT_MS,
        headers: { Accept: "application/json", "User-Agent": "exit1-oauth/1.0 (+https://exit1.dev)" },
      },
      (res) => {
        // The draft forbids following redirects: the document must live at the
        // exact URL that is the client's identity.
        if (res.statusCode !== 200) {
          res.resume();
          reject(new CimdError(`Client metadata URL returned HTTP ${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            req.destroy(new CimdError("Client metadata document is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const cacheControl = res.headers["cache-control"];
          resolve({ body: Buffer.concat(chunks).toString("utf8"), cacheControl });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new CimdError("Timed out fetching client metadata document")));
    req.on("error", reject);
  });
}

/**
 * Resolve a CIMD client_id to its client. Throws CimdError with a message safe
 * to show the user when the document can't be fetched or doesn't validate.
 * Failures are never cached, as the draft requires.
 */
export async function resolveCimdClient(clientIdUrl: string): Promise<CimdClient> {
  const cached = cache.get(clientIdUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  cache.delete(clientIdUrl);

  // Node connects to an IP-literal host without calling `lookup`, which would
  // skip the address check entirely. No real client publishes from a bare IP.
  if (net.isIP(new URL(clientIdUrl).hostname.replace(/^\[|\]$/g, ""))) {
    throw new CimdError("Client metadata URL must use a domain name, not an IP address");
  }

  let fetched: { body: string; cacheControl: string | undefined };
  try {
    fetched = await fetchDocument(clientIdUrl);
  } catch (error) {
    if (error instanceof CimdError) throw error;
    throw new CimdError("Could not fetch the client metadata document");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    throw new CimdError("Client metadata document is not valid JSON");
  }

  const result = validateCimdDocument(parsed, clientIdUrl);
  if (typeof result === "string") throw new CimdError(result);

  const ttl = cimdCacheTtlMs(fetched.cacheControl);
  if (ttl > 0) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(clientIdUrl, { client: result, expiresAt: Date.now() + ttl });
  }
  return result;
}
