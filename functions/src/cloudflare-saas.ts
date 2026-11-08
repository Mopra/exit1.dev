// ============================================================================
// CLOUDFLARE FOR SAAS CLIENT (custom status page domains)
//
// Plain fetch against the zone's custom_hostnames API. This is the only
// provider today; it sits behind the small `CustomDomainProvider` seam
// (register, status, remove) so a Caddy on-demand TLS fallback could replace
// it without touching the callables. Docs:
// https://developers.cloudflare.com/api/resources/custom_hostnames/
// ============================================================================

import { CUSTOM_DOMAIN } from "./config";
import { getCloudflareSaasToken } from "./env";
import type { ProviderState } from "./custom-domain-policy";

const API = "https://api.cloudflare.com/client/v4";
/** Cloudflare error code for "Duplicate custom hostname found". */
const DUPLICATE_CODE = 1406;

export interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  status?: string;
  ssl?: {
    status?: string;
    validation_errors?: Array<{ message?: string }>;
  };
  verification_errors?: string[];
  created_at?: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

export class CloudflareApiError extends Error {
  constructor(message: string, readonly status: number, readonly codes: number[]) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareSaasClientOptions {
  token: string;
  zoneId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface CustomDomainProvider {
  register(hostname: string): Promise<CloudflareCustomHostname>;
  status(id: string): Promise<CloudflareCustomHostname | null>;
  remove(id: string): Promise<void>;
}

export class CloudflareSaasClient implements CustomDomainProvider {
  private readonly fetchFn: FetchLike;
  private readonly base: string;

  constructor(private readonly opts: CloudflareSaasClientOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.base = `${API}/zones/${opts.zoneId}/custom_hostnames`;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; env: CloudflareEnvelope<T> | null }> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "authorization": `Bearer ${this.opts.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? CUSTOM_DOMAIN.cloudflareTimeoutMs),
    });
    let env: CloudflareEnvelope<T> | null = null;
    try {
      env = (await res.json()) as CloudflareEnvelope<T>;
    } catch {
      env = null;
    }
    return { status: res.status, env };
  }

  private fail(what: string, status: number, env: CloudflareEnvelope<unknown> | null): never {
    const errors = env?.errors ?? [];
    const msg = errors.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ") || `HTTP ${status}`;
    throw new CloudflareApiError(`Cloudflare ${what} failed: ${msg}`, status, errors.map((e) => Number(e.code) || 0));
  }

  /** Create the hostname. A duplicate (an earlier attempt that did land) is looked up and adopted. */
  async createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
    const { status, env } = await this.call<CloudflareCustomHostname>("POST", "", {
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
    if (env?.success && env.result) return env.result;

    const duplicate = (env?.errors ?? []).some(
      (e) => e.code === DUPLICATE_CODE || /duplicate/i.test(e.message ?? ""),
    );
    if (duplicate) {
      const existing = await this.findByHostname(hostname);
      if (existing) return existing;
    }
    return this.fail("create", status, env);
  }

  async findByHostname(hostname: string): Promise<CloudflareCustomHostname | null> {
    const { status, env } = await this.call<CloudflareCustomHostname[]>(
      "GET", `?hostname=${encodeURIComponent(hostname)}`,
    );
    if (!env?.success) return this.fail("lookup", status, env);
    return (env.result ?? []).find((h) => h.hostname?.toLowerCase() === hostname) ?? null;
  }

  /** null when Cloudflare no longer has it. */
  async getCustomHostname(id: string): Promise<CloudflareCustomHostname | null> {
    const { status, env } = await this.call<CloudflareCustomHostname>("GET", `/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (!env?.success) return this.fail("get", status, env);
    return env.result;
  }

  /** 404 counts as success: the goal is that it is gone. */
  async deleteCustomHostname(id: string): Promise<void> {
    const { status, env } = await this.call<unknown>("DELETE", `/${encodeURIComponent(id)}`);
    if (status === 404 || env?.success) return;
    this.fail("delete", status, env);
  }

  /** One page of 50. */
  async listCustomHostnames(page: number): Promise<{ hostnames: CloudflareCustomHostname[]; totalPages: number; totalCount: number }> {
    const { status, env } = await this.call<CloudflareCustomHostname[]>("GET", `?page=${page}&per_page=50`);
    if (!env?.success) return this.fail("list", status, env);
    return {
      hostnames: env.result ?? [],
      totalPages: env.result_info?.total_pages ?? 1,
      totalCount: env.result_info?.total_count ?? (env.result ?? []).length,
    };
  }

  /** Every hostname in the zone, page by page (capped at 100 pages). */
  async listAllCustomHostnames(): Promise<CloudflareCustomHostname[]> {
    const out: CloudflareCustomHostname[] = [];
    for (let page = 1; page <= 100; page++) {
      const { hostnames, totalPages } = await this.listCustomHostnames(page);
      out.push(...hostnames);
      if (page >= totalPages || hostnames.length === 0) break;
    }
    return out;
  }

  register(hostname: string): Promise<CloudflareCustomHostname> {
    return this.createCustomHostname(hostname);
  }

  status(id: string): Promise<CloudflareCustomHostname | null> {
    return this.getCustomHostname(id);
  }

  remove(id: string): Promise<void> {
    return this.deleteCustomHostname(id);
  }
}

/** The configured client, or null when the token is not available here. */
export function getCloudflareSaasClient(): CloudflareSaasClient | null {
  const token = getCloudflareSaasToken();
  const zoneId = CUSTOM_DOMAIN.cloudflareZoneId;
  if (!token || !zoneId) return null;
  return new CloudflareSaasClient({ token, zoneId });
}

function firstMessage(h: CloudflareCustomHostname): string | null {
  const v = h.verification_errors?.find((m) => typeof m === "string" && m.trim());
  if (v) return v.trim();
  const s = h.ssl?.validation_errors?.find((e) => e?.message && e.message.trim());
  return s?.message?.trim() ?? null;
}

/**
 * Map Cloudflare's hostname and certificate status onto ours. Pure.
 *
 * - blocked: Cloudflare refuses the hostname (abuse or a banned domain).
 * - moved: the hostname's DNS no longer points at our fallback origin.
 * - active: hostname and certificate both active, so it is served.
 * - anything else is still in progress, with the most useful message we have.
 */
export function mapProviderState(h: CloudflareCustomHostname): ProviderState {
  const providerStatus = h.status ?? null;
  const sslStatus = h.ssl?.status ?? null;
  const detail = firstMessage(h);

  if (providerStatus === "blocked") {
    return { kind: "blocked", providerStatus, sslStatus, error: detail ?? "Cloudflare blocked this hostname" };
  }
  if (providerStatus === "moved") {
    return {
      kind: "moved", providerStatus, sslStatus,
      error: `The CNAME no longer points at ${CUSTOM_DOMAIN.cnameTarget}`,
    };
  }
  if (providerStatus === "active" && sslStatus === "active") {
    return { kind: "active", providerStatus, sslStatus, error: null };
  }

  let error: string;
  if (detail) {
    error = detail;
  } else if (providerStatus !== "active") {
    error = `Waiting for the CNAME to point at ${CUSTOM_DOMAIN.cnameTarget}`;
  } else if (sslStatus && /timed_out/.test(sslStatus)) {
    error = "Certificate validation timed out. Check the CNAME and any CAA records, then check again.";
  } else {
    error = "Waiting for the certificate to be issued";
  }
  return { kind: "pending", providerStatus, sslStatus, error };
}
