# Firestore Cost Analysis

> Audit date: February 2026

This document maps every Firestore read and write in the codebase, identifies the highest-cost patterns, and proposes concrete optimizations ranked by impact.

---

## Architecture Overview

The system has two main Firestore consumers:

1. **Cloud Functions (backend)** -- 5 regional check schedulers running every 2 minutes, plus domain intelligence (every 6 hours), security refresh (weekly), and alert processing.
2. **React frontend** -- Up to 8 concurrent `onSnapshot` real-time listeners per active user session.

---

## Cost Driver #1: Check Scheduler (Backend)

**Scale:** 5 regions x every 2 minutes = **3,600 scheduler runs/day**

### Reads per run

| Operation | Collection | Code Location | Docs per run |
|---|---|---|---|
| Query due checks | `checks` | `functions/src/checks.ts:286-303` | up to 2,000 (paginated) |
| Email settings per user | `emailSettings` | `functions/src/checks.ts:488` | 1 per unique user |
| SMS settings per user | `smsSettings` | `functions/src/checks.ts:489` | 1 per unique user |
| Webhooks query per user | `webhooks` | `functions/src/checks.ts:490` | 1 query per unique user |
| Lock acquisition (transaction) | `runtimeLocks` | `functions/src/checks.ts:223` | 1 |

The alert settings reads (`emailSettings` + `smsSettings` + `webhooks`) are cached in an in-memory `Map` for the duration of a single function invocation, but every new invocation starts cold. Over 3,600 daily invocations this adds up significantly.

### Writes per run

| Operation | Collection | Code Location | Docs per run |
|---|---|---|---|
| Status updates (batched) | `checks` | `functions/src/checks.ts:480-530` | up to 2,000 (batch size 400) |
| Deferred budget writes | `email_user_budget`, `sms_user_budget`, etc. | `functions/src/alert.ts:151-158` | O(unique users) |
| Lock lifecycle | `runtimeLocks` | `functions/src/checks.ts:231-269` | 1-3 per run |

Status writes use hash-based deduplication to skip no-op updates when nothing changed.

### Daily estimate (scheduler only)

| Metric | Estimate |
|---|---|
| Check query reads | ~720,000/day (assuming avg 200 checks/run) |
| Alert settings reads | 3 x unique_users x 3,600 |
| Status update writes | ~720,000/day |
| Budget transaction reads+writes | Proportional to alerts sent |

---

## Cost Driver #2: Frontend `onSnapshot` Listeners

Every active user session maintains real-time listeners:

| Listener | Collection | File | Trigger |
|---|---|---|---|
| User's checks | `checks` | `src/hooks/useChecks.ts:139` | Always active when logged in |
| Domain intelligence | `checks` | `src/hooks/useDomainIntelligence.ts:117` | Domain Intelligence page |
| User notifications | `user_notifications` | `src/hooks/useUserNotifications.ts:65` | Always active |
| System notifications | `system_notifications` | `src/hooks/useNotifications.ts:53` | Always active |
| User preferences | `userPreferences` | `src/hooks/useUserPreferences.ts:49` | Always active |
| Status pages | `status_pages` | `src/pages/Status.tsx:186` | Status page |
| Webhooks | `webhooks` | `src/pages/Webhooks.tsx:102` | Webhooks page |
| Public status page | `status_pages` | `src/pages/PublicStatus.tsx:443` | Public visitors |

### The multiplier effect

The `checks` listener is the most expensive by far. When the scheduler writes a status update to any check document, every user whose `onSnapshot` query includes that document receives the **entire query result set** again.

**Example:** If a user has 50 checks and the scheduler updates 1 of them, Firestore charges for **50 document reads** on that client. With N concurrent users averaging M checks each, a single scheduler run generates up to **N x M client-side reads**.

### Potential duplicate listener

`src/pages/Webhooks.tsx` appears to set up two `onSnapshot` calls at lines 102 and 122. This may be creating duplicate subscriptions.

---

## Cost Driver #3: Domain Intelligence Scheduler

| Detail | Value |
|---|---|
| Frequency | Every 6 hours (4 runs/day) |
| Reads per run | Up to 500 checks (`domainExpiry.enabled == true`) |
| Writes per run | Up to 500 (batch size 400) |
| Daily total | ~4,000 operations |
| Code | `functions/src/domain-intelligence.ts:40-155` |

Modest compared to the check scheduler. Already uses batched writes.

---

## Cost Driver #4: Budget Tracking Transactions

Every alert triggers a `runTransaction` to check and increment budget counters:

- `email_user_budget` -- `functions/src/alert.ts:1893`
- `email_user_monthly_budget` -- `functions/src/alert.ts:2006`
- `sms_user_budget` -- `functions/src/alert.ts:2192`
- `sms_user_monthly_budget` -- `functions/src/alert.ts:2294`

Each transaction = minimum 1 read + 1 write, with potential retries on contention. Deferred budget writes batch these at the end of scheduler runs, which helps.

---

## Cost Driver #5: Other Backend Reads

| Operation | Collection | Code Location | Frequency |
|---|---|---|---|
| Admin stats (cached) | `admin_metadata` | `functions/src/admin.ts:276` | On admin page load |
| Webhook retry queue | `webhook_retry_queue` | `functions/src/alert.ts:820-824` | Once per scheduler run |
| User tier lookup (cached 2h) | `users` | `functions/src/init.ts:222-247` | Tier-gated features |
| Check existence verification | `checks` | `functions/src/checks.ts:1951,2102,2168` | Per user action |
| Security refresh | `checks` | `functions/src/security-refresh.ts:195` | Weekly |

---

## Existing Optimizations Already in Place

The codebase already implements several cost-reduction patterns:

- **Hash-based write dedup** in status buffer skips no-op writes
- **In-memory alert settings cache** per scheduler invocation (`checks.ts:470`)
- **Deferred budget writes** batched at end of run instead of per-alert
- **Batch writes** capped at 400-500 docs across the board
- **BigQuery daily pre-aggregation** reduces query costs by 80-90% (`history.ts:764`)
- **Frontend TTL caches** for BigQuery results (stats: 10min, history: 15min)
- **Rate limiting** on analytics queries to prevent cost runaway
- **Tab visibility check** on Webhooks page unsubscribes when tab hidden

---

## Optimization Recommendations

### 1. Replace `checks` onSnapshot with polling or change-notification pattern

**Impact: Very High**

The `checks` `onSnapshot` is the single most expensive frontend operation due to the multiplier effect described above.

**Option A -- Polling:** Replace the real-time listener with periodic `getDocs` calls every 30-60 seconds. The `fetchChecks` function already exists at `src/hooks/useChecks.ts:105`.

**Option B -- Change-notification document:** The scheduler writes a single `lastUpdatedAt` timestamp to a lightweight per-user document (e.g., `userCheckMeta/{userId}`). The frontend subscribes to only that 1-doc snapshot. When it changes, fetch the full checks list with `getDocs`. This collapses N x M reads down to N x 1 snapshot reads, plus N x M reads only when data actually changed.

**Option C -- Separate status from config:** Move frequently-changing status fields (`status`, `lastCheckedAt`, `responseTime`) into a separate subcollection or summary document. The main `checks` onSnapshot stops firing on every scheduler write. Status is fetched separately on a polling interval.

**Estimated savings:** 70-90% reduction in frontend `checks` reads.

### 2. Denormalize or combine alert settings

**Impact: High**

Currently 3 parallel reads per unique user per scheduler run (`emailSettings` + `smsSettings` + `webhooks` query). These are cached within a single invocation but start cold on each of the 3,600 daily runs.

**Option A -- Single combined document:** Merge email, SMS, and webhook settings into one `alertSettings/{userId}` document. Reduces 3 reads to 1.

**Option B -- Embed on check document:** Store a summary of alert preferences directly on each check document. Since the scheduler already reads the check, this eliminates the separate settings reads entirely.

**Option C -- Persistent cache (Memorystore/Redis):** Cache alert settings outside of function memory so they survive across invocations. TTL of 5-10 minutes would cover most scheduler cycles.

**Estimated savings:** Up to 2/3 reduction in alert settings reads.

### 3. Adaptive scheduler frequency

**Impact: Medium**

All 5 regional schedulers run every 2 minutes regardless of load. If a region has no due checks, the run still queries Firestore and returns empty.

**Option A -- Skip on empty:** After an empty result, use Cloud Tasks to schedule the next run at a longer interval (e.g., 5 minutes). Reset to 2 minutes when checks are found.

**Option B -- Tier-based scheduling:** Group checks by frequency tier. Run a 1-minute scheduler only for checks that need it. Run 5-minute and 15-minute schedulers separately.

**Estimated savings:** 30-50% reduction in empty scheduler reads.

### 4. Lazy-load non-critical frontend listeners

**Impact: Low-Medium**

Several listeners are active on every page even though their data is rarely needed:

- `system_notifications` -- Subscribe only when the notification panel is open
- `user_notifications` -- Same as above
- `userPreferences` -- Fetch once with `getDoc` on login; preferences rarely change

**Estimated savings:** 3-5 fewer active listeners per user session.

### 5. Audit potential duplicate Webhooks listener

**Impact: Low**

`src/pages/Webhooks.tsx` lines 102 and 122 both call `onSnapshot`. Verify this isn't creating two concurrent subscriptions to the same collection.

### 6. Write status to BigQuery only (long-term)

**Impact: Medium (requires architecture change)**

If the frontend moves away from `onSnapshot` on `checks` (recommendation #1), the scheduler no longer needs to write status back to Firestore for real-time delivery. Status could flow exclusively through BigQuery, with the frontend polling a Cloud Function or API endpoint that reads from BigQuery or an in-memory cache.

This would eliminate the ~720,000 daily Firestore writes from status updates entirely.

---

## Summary Table

| Source | Type | Relative Cost | Optimization |
|---|---|---|---|
| `onSnapshot` on `checks` (frontend) | Reads | **Very High** | Polling or change-notification pattern |
| Scheduler querying due checks | Reads | **High** | Adaptive frequency |
| Alert settings reads (3/user/run) | Reads | **High** | Denormalize or combine |
| Scheduler writing status updates | Writes | **High** | Already has dedup; long-term move to BigQuery-only |
| Budget transactions | Read+Write | **Medium** | Already has deferred writes |
| Domain intelligence scheduler | Read+Write | **Low** | Already reasonable |
| Other frontend listeners | Reads | **Low** | Lazy-load non-critical ones |

---

## Collections Referenced

For reference, all Firestore collections touched by the application:

| Collection | Primary Use | Read Frequency | Write Frequency |
|---|---|---|---|
| `checks` | Core check config + status | Very High | Very High |
| `emailSettings` | Per-user email alert config | High (scheduler) | Low (user action) |
| `smsSettings` | Per-user SMS alert config | High (scheduler) | Low (user action) |
| `webhooks` | Per-user webhook config | High (scheduler) | Low (user action) |
| `email_user_budget` | Email rate limiting | Medium (per alert) | Medium (per alert) |
| `sms_user_budget` | SMS rate limiting | Medium (per alert) | Medium (per alert) |
| `email_user_monthly_budget` | Monthly email budget | Medium | Medium |
| `sms_user_monthly_budget` | Monthly SMS budget | Medium | Medium |
| `webhook_retry_queue` | Failed webhook retries | Low (once/run) | Low |
| `status_pages` | Public status pages | Low-Medium | Low |
| `user_notifications` | Per-user notifications | Low-Medium | Low |
| `system_notifications` | System-wide notifications | Low | Very Low |
| `userPreferences` | UI preferences | Low | Very Low |
| `users` | User records + tier cache | Low | Low |
| `apiKeys` | API key management | Low | Very Low |
| `runtimeLocks` | Scheduler distributed locks | Low (3/run) | Low (3/run) |
| `domainRefreshRateLimits` | Domain refresh throttling | Very Low | Very Low |
| `userMigrations` | Legacy migration records | Very Low | None |
| `admin_metadata` | Cached admin dashboard stats | Very Low | Very Low |
| `user_check_stats` | Cached check counts | Low | Low |
