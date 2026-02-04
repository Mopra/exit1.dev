# X Posts - exit1.dev Development Journey

Posts from building exit1.dev over the past 3 months. Each captures a decision, lesson, or shipping moment.

---

## Cost & Infrastructure

**BigQuery will bankrupt you if you let it**

Reduced our BigQuery costs 40% by pre-aggregating daily summaries instead of querying raw data. The expensive query is the one that runs every time a user loads a dashboard.

---

**Firestore reads add up faster than you think**

Replaced 50k individual doc reads with aggregation queries. Switched from getDoc loops to getAll() batching. 60-80% fewer read operations. The SDK makes the wrong thing easy.

---

**Caching isn't optional at scale**

Added a 5-minute API key validation cache. Before: every request hit Firestore. After: one read per key per 5 minutes. Sometimes the boring fix is the right fix.

---

**Buffer sizes are a product decision**

Cut our status buffer from 1000 to 500 entries. Users never scrolled that far anyway. Memory isn't free, and most "just in case" capacity is waste.

---

## Pricing & Limits

**Free tiers need guardrails, not honor systems**

Added tier-based check interval limits. Free users get 5-minute minimum, paid get 1-minute. Enforced in backend, not just UI. Trust but verify is just verify with extra steps.

---

**Migrations are the tax on product changes**

Wrote 5 different migration scripts just to enforce new check intervals. Had to handle missing tier fields, distribution analysis, dry-run modes. The feature took a day; the migration took two.

---

## Features Shipped

**Domain expiry monitoring via RDAP**

Built domain intelligence from scratch. RDAP lookups every 6 hours, expiry alerts via email/SMS/webhooks. Domains expire silently. Now they don't.

---

**Bulk import changes how people onboard**

Added CSV import for checks. One file, dozens of monitors configured. Lowered the activation energy for teams with existing monitoring they want to migrate.

---

**Public status pages with folder-based inclusion**

Status pages now pull checks from folders dynamically. Add a check to a folder, it appears on the status page. No manual syncing. Folders are an organizational primitive that keeps paying off.

---

**Multiple alert recipients per check**

Alerts go to arrays now, not single values. On-call rotations need this. Backwards compatible with old single-recipient data. The migration was one line; the UI took a week.

---

## Bugs & Fixes

**Manual checks weren't alerting. The throttle was stale.**

Flap suppression used the old consecutive count instead of the new one. Manual checks passed the wrong counter to triggerAlert. One argument, hours of debugging.

---

**First recipient got the email. Others got nothing.**

Throttle check happened per-recipient instead of per-alert. Fixed by checking budget once, then iterating. Concurrency bugs hide in loops.

---

**Webhooks failing silently on Slack**

Slack expects a specific JSON format. Our generic webhook worked everywhere except Slack. Added format detection and Slack-specific payloads. Integration code is just edge cases all the way down.

---

**Webhook retries hammering rate-limited endpoints**

Added exponential backoff with jitter. 30-min max for rate-limited, 5-min for others. Skip non-retryable status codes entirely. Retry logic is more nuanced than tutorials suggest.

---

**Dialogs blocking clicks after closing**

Body pointer-events weren't being cleaned up. Modal closes, overlay gone, but clicks still blocked. The invisible bug is the worst bug.

---

**Resend rate limits hit differently in loops**

Resend allows 2 req/sec. Our alert loop was faster. Added 600ms delays between sends. Rate limits aren't about burst capacity; they're about sustained throughput.

---

## Product Decisions

**Killed the badge feature**

Removed public embed badges entirely. Low usage, high maintenance, security surface area. Features that aren't earning their keep get cut. Shipping is also unshipping.

---

**Changed default check frequency from 2 minutes to 1 hour**

New users don't need 2-minute checks. They need to see it work. Aggressive defaults cost money and teach the wrong habits. Sane defaults are a feature.

---

**History retention: 90 days to 60 days**

Nobody was looking at 3-month-old uptime data. Reduced retention, reduced storage costs, reduced query times. Data you don't need is data you shouldn't keep.

---

## Architecture

**setDoc with merge beats updateDoc**

updateDoc fails on missing documents. setDoc with merge handles create and update. Firestore's API has opinions, and updateDoc's opinion is "document must exist." Learn that once.

---

**URL hash index for O(1) duplicate detection**

Was iterating through checks to find duplicates. Now we hash URLs and index them. O(n) to O(1). The data structure is the optimization.

---

**Apex domain deduplication**

Users adding both "api.example.com" and "example.com" for domain monitoring. Both resolve to the same apex. Now we dedupe automatically. Edge cases are where features get polished.

---

## Shipping Lessons

**Security check timeouts were killing HTTP checks**

TLS verification runs alongside HTTP checks. Timeout on security was aborting the whole request. Separated the concerns. Parallel operations need independent failure modes.

---

**Clerk webhook sync was overwriting preferences**

Syncing contacts to Resend with unsubscribed:false. Overwrote users who had opted out. Removed the explicit field. Defaults should be absent, not false.

---

**The overnight check is the real test**

Features work in development. They break at 3am when the cron job runs and the edge case hits. Monitoring your monitoring is not paranoia.

---
