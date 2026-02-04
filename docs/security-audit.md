# Security & Vulnerability Audit Report

**Date:** 2026-02-04
**Scope:** Full codebase — Firestore rules, Cloud Functions, public API, client-side code, secrets management, OWASP Top 10 vectors

---

## Executive Summary

The application has strong security foundations including parameterized BigQuery queries, Clerk/Firebase auth bridge, webhook signature verification, and DOMPurify for HTML sanitization. However, **6 significant vulnerabilities** were identified that require immediate attention.

### Findings Overview

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 3 |
| Medium | 3 |
| Low | 4 |

---

## Critical Findings

### 1. Missing Server-Side Admin Authorization on User Management Functions

**Severity:** CRITICAL
**OWASP:** A01 Broken Access Control
**Location:** `functions/src/users.ts` — `getAllUsers`, `deleteUser`, `bulkDeleteUsers`

These functions have **no backend admin check**. The code explicitly comments that admin verification is "handled on the frontend":

```typescript
// Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
// The frontend already ensures only admin users can access this function
```

**Impact:** Any authenticated user can call these callable functions directly (bypassing the UI) to:

- **List all users** — exposes emails, admin status, sign-in times, check counts (PII leak)
- **Delete any user** — wipes their checks, webhooks, email/SMS settings, and API keys
- **Bulk-delete users** — mass destruction of user data

**Note:** The `notifications.ts` module correctly verifies admin via `syncAdminStatus()` which calls Clerk's backend API. The same pattern should be applied here.

**Remediation:** Add server-side admin verification using the `syncAdminStatus()` pattern from `functions/src/notifications.ts:149` to all three functions before any data access.

---

### 2. SSRF — Cloud Metadata Endpoint Not Blocked

**Severity:** CRITICAL
**OWASP:** A10 Server-Side Request Forgery
**Location:** `functions/src/config.ts:279-289`

The URL validation blocks `10.x`, `172.16-31.x`, `192.168.x` but **does not block `169.254.169.254`** (the GCP/AWS/Azure instance metadata endpoint).

An attacker can create a check targeting `http://169.254.169.254/computeMetadata/v1/` and potentially exfiltrate:

- Service account tokens
- Project metadata
- Instance credentials

**Additional SSRF gaps:**

| Gap | Location | Description |
|-----|----------|-------------|
| IPv6 private addresses | `config.ts:279-289` | `fe80::`, `fc00::/fd00::`, `::ffff:127.0.0.1` not blocked |
| DNS rebinding | `check-utils.ts:235` | Validation at submission time, DNS resolves again at request time |
| Redirect following | `check-utils.ts:361` | Follows up to 5 redirects without validating the target URL |

**Remediation:**
1. Add `169.254.x.x` to the IP blocklist
2. Block IPv6 private ranges
3. Resolve DNS before the request and validate the resolved IP
4. Validate redirect targets against the same blocklist

---

## High Findings

### 3. SSRF in Webhook Delivery — No Private IP Filtering

**Severity:** HIGH
**OWASP:** A10 Server-Side Request Forgery
**Location:** `functions/src/webhooks.ts:14-19`, `functions/src/alert.ts:2417`

Webhook URL validation only checks that the URL is syntactically valid (`new URL(url)`). There is **zero private IP filtering**.

The webhook delivery code sends POST requests to user-provided URLs, and the test webhook function returns the response status — enabling partial data exfiltration from internal services.

**Remediation:** Apply the same `validateUrl()` from `config.ts` (with the metadata endpoint fix) to webhook URLs at both creation time and delivery time.

---

### 4. Twilio Secrets in Client-Side Environment Files

**Severity:** HIGH
**OWASP:** A02 Cryptographic Failures
**Location:** `.env.local`, `.env.production` (project root)

The frontend project root `.env` files contain:

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
```

While Vite only exposes `VITE_`-prefixed vars to the browser bundle, these secrets:

- Exist on disk in the frontend directory
- Were previously committed to git history (commit `b006ee3`)
- Could be accidentally prefixed with `VITE_` by a developer

Additionally, `functions/.env` contains `CLERK_SECRET_KEY` and the `functions/.gitignore` explicitly does **not** ignore `.env`, meaning it could be committed.

**Remediation:**
1. **Rotate the Twilio credentials immediately** — they were in git history
2. Remove Twilio vars from the frontend `.env` files entirely
3. Add `functions/.env` to `functions/.gitignore`
4. Consider using `git filter-repo` to scrub secrets from git history

---

### 5. Firestore `rdap_cache` Collection — Open Read/Write

**Severity:** HIGH
**OWASP:** A01 Broken Access Control
**Location:** `firestore.rules:199-202`

```
match /rdap_cache/{domain} {
  allow read, write: if true;
}
```

**Any unauthenticated user** can read and write to the `rdap_cache` collection. An attacker could:

- **Poison the cache** — write fake domain expiry data to manipulate RDAP results
- **Read all cached RDAP data** — enumerate which domains users are monitoring

**Remediation:** Change to `allow read, write: if false;` and let Cloud Functions access it via the Admin SDK (which bypasses rules).

---

## Medium Findings

### 6. SMS Tier Bypass via Client-Provided `clientTier`

**Severity:** MEDIUM
**OWASP:** A01 Broken Access Control
**Location:** `functions/src/sms.ts:120-121`

```typescript
if (clientTier === 'nano') {
  return;  // Trusts client-provided tier claim
}
```

A free-tier user can call SMS functions with `{ clientTier: 'nano' }` in the request data and bypass the paid tier check entirely.

**Remediation:** Remove the `clientTier` shortcut. Always verify tier server-side via `getUserTierLive()`.

---

### 7. `userMigrations` Collection — Public Read Access

**Severity:** MEDIUM
**OWASP:** A01 Broken Access Control
**Location:** `firestore.rules:206-213`

```
match /userMigrations/{email} {
  allow read: if true;
}
```

Document IDs are user emails, meaning anyone can enumerate email addresses by checking if documents exist.

**Remediation:** Restrict reads to authenticated users: `allow read: if request.auth != null;`

---

### 8. Admin Routes Not Role-Protected at Route Level

**Severity:** MEDIUM
**OWASP:** A01 Broken Access Control
**Location:** `src/App.tsx:267-296`, `src/components/auth/AuthGuard.tsx`

The admin routes (`/admin`, `/user-admin`, `/admin/notifications`) use `AuthGuard` which only checks `isSignedIn` — not admin role. Non-admin users can navigate to these routes, causing the admin page bundles to be downloaded.

**Remediation:** Create an `AdminGuard` component that checks admin status before rendering, preventing non-admin users from downloading admin component bundles.

---

## Low Findings

### 9. Hardcoded Firebase Config Fallbacks

**Location:** `src/firebase.ts:12-18`

Firebase config values have hardcoded fallbacks (`|| "AIzaSy..."`). While Firebase API keys are designed to be public, this prevents environment separation and means production config is baked into source code.

### 10. Missing `API_KEY_PEPPER` Environment Variable

**Location:** `functions/src/api-keys.ts:27`

```typescript
const pepper = process.env.API_KEY_PEPPER || '';
```

If `API_KEY_PEPPER` is not set, API key hashing uses no pepper, reducing the security benefit. Verify this is set in production.

### 11. XSS via `dangerouslySetInnerHTML` (Mitigated)

**Location:** `src/components/layout/NotificationBell.tsx`, `src/components/layout/SystemAlert.tsx`

Used with `DOMPurify.sanitize()` — properly mitigated. Keep DOMPurify updated.

### 12. Unconditional `console.log` in Admin Page

**Location:** `src/pages/UserAdmin.tsx:20`

Logs to console unconditionally in production builds.

---

## What's Done Well

| Area | Assessment |
|------|-----------|
| BigQuery queries | Fully parameterized — no SQL injection risk |
| Clerk webhook verification | Properly verifies Svix signatures before processing |
| Firebase callable functions | Auth tokens automatically attached, no manual token handling |
| Firestore rules (most collections) | Strong ownership checks (`userId == request.auth.uid`) |
| API key management | Keys hashed with SHA-256 + pepper, plaintext shown only once |
| Public API rate limiting | Multi-layered: IP guard, per-key, per-endpoint, daily quotas |
| Auth flow (Clerk-Firebase bridge) | Correctly implemented via custom token integration |
| Status pages access control | Private/public visibility properly enforced |
| Storage rules | Owner-only writes, file type and size validation |
| Check history subcollection | Locked to `if false` — admin SDK only |

---

## Priority Action Items

| Priority | Issue | Action |
|----------|-------|--------|
| P0 | Admin functions lack server-side auth | Add `syncAdminStatus()` check to `getAllUsers`, `deleteUser`, `bulkDeleteUsers` |
| P0 | SSRF — metadata endpoint | Add `169.254.x.x` to IP blocklist, validate redirect targets, add webhook URL validation |
| P0 | Rotate Twilio credentials | They were in git history — rotate immediately |
| P1 | `rdap_cache` open read/write | Change Firestore rule to `if false` |
| P1 | SMS tier bypass | Remove `clientTier` client-side trust |
| P1 | Remove Twilio secrets from frontend `.env` | Move to `functions/` environment only |
| P2 | `userMigrations` public read | Require authentication for reads |
| P2 | Add `AdminGuard` for admin routes | Route-level admin role check |
| P2 | Add `functions/.env` to `.gitignore` | Prevent accidental commit of Clerk secret key |
