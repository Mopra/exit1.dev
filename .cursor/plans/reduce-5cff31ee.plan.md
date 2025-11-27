<!-- 5cff31ee-f8a8-4f7a-912c-07aafd30d343 26bd8362-54a0-4e2f-8295-1e5874b90782 -->
# Cost-Control Implementation Plan

## 1. Decouple SSL/domain work from every minute check

- **files**: `functions/src/check-utils.ts`, `functions/src/security-utils.ts`, new `functions/src/security-refresh.ts`
- Introduce a `securityMetadata` collection that stores SSL & domain results per hostname with `cachedAt`/`expiresAt`.
- Update `checkRestEndpoint` to read cached metadata and only fall back to live `checkSecurityAndExpiry` when the cache is missing or stale; this keeps per-minute checks lightweight.
- Add a scheduled `refreshSecurityMetadata` function (e.g., hourly) that iterates the distinct hostnames seen recently and refreshes their cache in the background.

## 2. Cache alert configuration per user during a run

- **files**: `functions/src/alert.ts`, `functions/src/checks.ts`
- When `checkAllChecks` groups checks by `userId`, load each user’s webhook + email settings once, store in an in-memory map, and pass cached settings into `triggerAlert` so repeated Firestore reads disappear.
- Remove the debug branch that loads *all* `emailSettings` when a user is missing a doc; replace with a concise log message to avoid full-collection reads.

## 3. Reduce throttle/budget document churn

- **files**: `functions/src/alert.ts`, `functions/src/config.ts`
- Relax throttle windows (e.g., merge down/up events into a shared 5‑minute window) so we create fewer Firestore docs per flap.
- Store short-lived throttle state in memory for the duration of `checkAllChecks` (e.g., a `Map` keyed by `userId+checkId+eventType`) to skip duplicate writes when multiple status changes happen in the same invocation.

---
**Todos**

- `security-cache`: Add metadata cache + refresh job.
- `alert-cache`: Memoize webhook/email settings per run.
- `throttle-optim`: Adjust throttle windows and add in-memory guard.
- `bleed-stop`: Implement the immediate read guardrails (RDAP toggle + memoization + email debug removal).
- `docs-update`: Record the new flow for future operators.