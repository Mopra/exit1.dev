/**
 * Cloudflare for SaaS custom hostname responses, shaped like the API's
 * `result` objects (trimmed to the fields we read).
 */
import type { CloudflareCustomHostname } from "../../cloudflare-saas";

export const CH_PENDING_VALIDATION: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "pending",
  ssl: { status: "pending_validation" },
  verification_errors: ["custom hostname does not CNAME to this zone."],
  created_at: "2026-11-08T10:00:00Z",
};

export const CH_ACTIVE_HOSTNAME_PENDING_SSL: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "active",
  ssl: { status: "pending_validation" },
};

export const CH_ACTIVE: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "active",
  ssl: { status: "active" },
};

export const CH_MOVED: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "moved",
  ssl: { status: "active" },
};

export const CH_BLOCKED: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "blocked",
  ssl: { status: "pending_validation" },
  verification_errors: ["This hostname is blocked."],
};

export const CH_SSL_ERRORS: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "active",
  ssl: {
    status: "pending_validation",
    validation_errors: [{ message: "caa_error: blocked by CAA record" }],
  },
};

export const CH_SSL_TIMED_OUT: CloudflareCustomHostname = {
  id: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
  hostname: "status.acme.com",
  status: "active",
  ssl: { status: "validation_timed_out" },
};

export const DUPLICATE_ERROR_BODY = {
  success: false,
  errors: [{ code: 1406, message: "Duplicate custom hostname found." }],
  result: null,
};
