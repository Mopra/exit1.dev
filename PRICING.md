# exit1 — Plans & Tiers

> Single source of truth for **exit1** pricing, plan limits, and feature gating.
> This file is the canonical reference for humans, internal tooling, and external AI agents.
> If this file disagrees with code, **the code wins** — open a PR to update this file.

**Product:** [exit1.dev](https://exit1.dev) — uptime monitoring SaaS (HTTP/HTTPS, TCP, UDP, ICMP, WebSocket, SSL, domain intelligence).
**App:** https://app.exit1.dev · **Docs:** https://docs.exit1.dev · **Contact:** connect@exit1.dev

---

## Plan lineup at a glance

| Plan | Price (monthly) | Price (annual) | Who it's for |
|---|---|---|---|
| **Free** | $0 | — | Hobbyists, personal sites, kicking the tires. |
| **Indie** | $4 | $36 ($3/mo) | A handful of sites you want watched *closely* — 15s checks plus API/MCP. |
| **Nano** | $9 | $84 ($7/mo) | Solo devs and small projects running many sites at a normal cadence. |
| **Pro** | $24 | $240 ($20/mo) | Teams running production workloads — everything, at the highest limits. |

All plans share the same monitoring engine. Higher tiers unlock more checks, longer history, more alert volume, and gated features.

> **The interval column is deliberately not monotonic.** Indie ($3) probes every
> **15 seconds** while Nano ($9) probes every **2 minutes**. Indie is the "few
> sites, watched closely" tier; Nano is the "many sites, watched normally" tier.
> This is intentional, not a typo — and the enforcement code is built around it
> (see *Tier-change enforcement* below).

---

## Feature matrix

Capabilities marked **🕐 Coming soon** have the entitlement flag enabled in code but the feature itself is still being built. Subscribers see a "Coming Soon" badge in-app.

| Capability | Free | Indie | Nano | Pro |
|---|---|---|---|---|
| **Monitored checks** | 5 | 10 | 100 | 1,000 |
| **Minimum check interval** | 5 min | **15 sec** | 2 min | 15 sec |
| **History retention** | 60 days | 60 days | 60 days | 1,095 days (3 yr) |
| **Status pages** | 1 | 1 | 5 | 50 |
| **Webhooks** | 1 | 3 | 5 | 50 |
| **API keys** (also gates MCP access) | 0 | 1 | 1 | 25 |
| **Email alerts / hour** | 10 | 50 | 50 | 500 |
| **Email alerts / month** | 10 | 500 | 1,000 | 10,000 |
| **SMS alerts / hour** | 0 | 0 | 0 | 25 |
| **SMS alerts / month** | 0 | 0 | 0 | 50 |
| REST API access | — | ✓ | ✓ | ✓ |
| MCP server access | — | ✓ | ✓ | ✓ |
| Status page builder (branding, layout, widgets) | — | — | ✓ | ✓ |
| Domain Intelligence (WHOIS, expiry, DNS) | — | — | ✓ | ✓ |
| Maintenance mode | — | — | ✓ | ✓ |
| Stats & timeline views | — | — | ✓ | ✓ |
| Region choice (US / EU / Asia) | — | — | — | ✓ |
| SMS alerts | — | — | — | ✓ |
| CSV bulk export | — | — | — | ✓ |
| All alert channels (Slack / Discord / Teams) | — | — | — | ✓ |
| Per-log comments / notes | — | — | — | ✓ |
| Extra email recipients (per-check / per-folder) | — | — | — | ✓ |
| Team seats 🕐 *Coming soon* | 0 | 0 | 0 | 10 |
| SLA reporting 🕐 *Coming soon* | — | — | — | ✓ |
| Custom status-page domain 🕐 *Coming soon* | — | — | — | ✓ |

> **MCP access follows API access.** There is no separate MCP entitlement — if a plan can mint API keys, it can use the [exit1-mcp](https://www.npmjs.com/package/exit1-mcp) server. Indie is the cheapest plan that can.

Indie's alert channels are **email and webhooks only** — no Slack/Discord/Teams, no SMS.

---

## Per-tier detail

### Free — $0

Designed for personal projects and evaluation. No credit card.

- **5 checks**, minimum **5-minute** interval.
- **60 days** of history.
- **1 status page** (default branding, no builder).
- **1 webhook**, **email alerts only**, capped at **10/hour and 10/month**.
- Multi-region failover handled by exit1, but no region pinning.
- No API, no MCP, no SMS, no CSV export, no Slack/Discord/Teams, no maintenance windows, no domain intelligence.

### Indie — $4/mo · $36/yr

The cheapest paid plan, and the *fastest* one per-check. Built for someone with a
small number of sites they care about a lot.

- **10 checks**, minimum **15-second** interval — the platform's hard floor.
- **1 API key**, which also unlocks **MCP server** access.
- **3 webhooks**, email alerts up to **50/hour and 500/month**.
- **1 status page** (default branding, no builder).
- **60 days** of history (same as Free).
- No SMS, no CSV export, no Slack/Discord/Teams, no maintenance windows, no
  domain intelligence, no region choice, no stats/timeline views.
- DNS checks are allowed but floored at a **5-minute** interval — DNS queries are
  far more expensive than an HTTP probe, so Indie's 15s general floor does not
  carry over.

### Nano — $9/mo · $84/yr

The volume tier. Unlocks the status page builder, domain intelligence, and maintenance mode.

- **100 checks**, minimum **2-minute** interval.
- **1 API key** + **MCP server** access.
- **60 days** of history (same as Free and Indie).
- **5 status pages** with full builder (branding, layout, widgets).
- **5 webhooks**, email alerts up to **50/hour and 1,000/month**.
- **Domain Intelligence** (WHOIS, expiry tracking, DNS records).
- **Maintenance mode** for planned downtime.
- **Stats and timeline** views.
- Still no SMS, no CSV, no Slack/Discord/Teams alert channels, no region choice.

### Pro — $24/mo · $240/yr

Everything exit1 does, at the highest limits. Pro absorbed the retired Agency
tier in full — the only things that did **not** move up are the email and SMS
budgets, which stay at Pro's historical levels.

- **1,000 checks**, minimum **15-second** interval.
- **3 years (1,095 days)** of history.
- **50 status pages**, **50 webhooks**, **25 API keys**.
- Email alerts up to **500/hour and 10,000/month**.
- **SMS alerts** up to **25/hour and 50/month**.
- **REST API + MCP server** access.
- **CSV bulk export** of check history.
- **All alert channels**: Slack, Discord, Microsoft Teams (plus email, SMS, webhooks).
- **Region choice** — pin checks to US, EU, or Asia.
- **Per-log comments** on individual check runs.
- **Extra email recipients** per-check and per-folder.
- Pre-allocated for **10 team seats**, **SLA reporting**, and **custom status-page
  domains** — 🕐 these are entitled in billing but the features are still being built.

---

## Plan keys & resolution

The app is authenticated via **Clerk**. Each Clerk subscription carries a `plan.slug` that resolves to one of four internal tiers (`free`, `indie`, `nano`, `pro`). The resolver lives in [`functions/src/init.ts`](functions/src/init.ts).

| Clerk plan key | Resolves to tier | Sellable? | Notes |
|---|---|---|---|
| `free_user` | `free` | ✓ (default) | Assigned to every signed-up user with no paid subscription. |
| `indie` | `indie` | ✓ | Current Indie plan. |
| `nanov2` | `nano` | ✓ | Current Nano plan. |
| `pro` | `pro` | ✓ | Current Pro plan. |
| `nano` | `pro` | ✗ (hidden) | **Founders** — legacy Nano at $4/mo, grandfathered onto Pro entitlements. |
| `agency` | `pro` | ✗ (retired) | Agency was retired; Pro carries every Agency entitlement, so existing subscribers lose nothing. |
| `scale` | `pro` | ✗ | Legacy Scale plan. No active subscribers; mapping kept for safety. |
| `starter` | `nano` | ✗ | Pre-Nano legacy plan. |
| *(unknown key)* | `free` | — | Safe fallback. |

**Tier rank** (`TIER_RANK` in `init.ts`): `free: 0, indie: 1, nano: 2, pro: 3`.
This ranks *price*, not check interval — see the non-monotonic note above.

### Retiring Agency

Agency is gone as a tier. The `agency` Clerk plan key still resolves — to `pro` —
so any remaining subscriber keeps working with no capability loss. To finish the
retirement, mark the Agency plan **unsellable** in the Clerk dashboard so no new
subscriptions can be created against it.

### Founders (legacy Nano @ $4/mo)

- Original Nano subscribers who joined before the tier restructure.
- Pay **$4/mo or $36/yr** forever (as long as the subscription is continuous).
- Get the **full Pro feature set** via the plan-key resolver.
- Rendered with a gold "Founders" badge in-app.
- **Forfeit condition:** If a Founders user cancels and re-subscribes, current pricing applies.

---

## How tier gating works

### Backend enforcement

All limits are enforced server-side in [`functions/src/config.ts`](functions/src/config.ts) via the `TIER_LIMITS` table and tier-aware helpers:

- **Whole row:** `getTierLimits(tier)` — prefer this when you need several limits at once.
- **Numeric caps:** `getMaxChecksForTier`, `getMaxWebhooksForTier`, `getMaxApiKeysForTier`, `getMaxStatusPagesForTier`
- **Interval floor:** `getMinCheckIntervalMinutesForTier` + `validateCheckFrequencyForTier`
- **Retention:** `getHistoryRetentionDaysForTier` (drives BigQuery purge)
- **Alert quotas:** `getEmailBudgetMaxPerWindowForTier`, `getEmailMonthlyBudgetMaxPerWindowForTier`, `getSmsBudgetMaxPerWindowForTier`, `getSmsMonthlyBudgetMaxPerWindowForTier`
- **Feature flags:** booleans on `TIER_LIMITS[tier]` (`smsAlerts`, `apiAccess`, `csvExport`, `domainIntel`, `maintenanceMode`, `statusPageBuilder`, `slaReporting`, `customStatusDomain`, `allAlertChannels`, `regionChoice`)
- **Inline Pro-only guards** (no `TIER_LIMITS` flag — gated as `tier !== 'pro'`):
  - Per-log comments — [`functions/src/log-notes.ts`](functions/src/log-notes.ts)
  - Extra email recipients per-check / per-folder — [`functions/src/email.ts`](functions/src/email.ts)
  - CSV export — [`functions/src/csv-export.ts`](functions/src/csv-export.ts)
- **Inline Nano+ guards:** stats/timeline views ([`history.ts`](functions/src/history.ts)), organization billing ([`organizations.ts`](functions/src/organizations.ts)), maintenance mode (`isNanoTier` in [`checks.ts`](functions/src/checks.ts)).

### Resolver path

```
Clerk plan key  →  tierFromPlanKey()  →  users.tier  (+ users.subscribedPlanKey)
                                                ↓
                              denormalised onto checks.*.userTier
```

**Cache TTL:** 2 hours. Invalidated on every Clerk `subscription.*` webhook. Force-refresh via `syncMyTier` (user-facing) or `recomputeAllTiers` (admin).

### Admin override

Setting `publicMetadata.admin === true` on a Clerk user treats them as **Pro**, regardless of subscription.

### Tier-change enforcement

Because the ladder is not monotonic on check interval, enforcement is **not**
driven by tier rank. On every tier change, `ceilingTightens(from, to)` in
[`functions/src/plan-enforcement.ts`](functions/src/plan-enforcement.ts) compares
the two `TIER_LIMITS` rows dimension-by-dimension. If any limit is tighter on the
target tier, `enforceTierCeiling(userId, newTier)` runs; otherwise only the
`userTier` denormalisation is refreshed.

This matters most for **Indie → Nano**, which is a rank *upgrade* that still has
to widen check intervals from 15s to 2min. A rank-based check would have silently
skipped it and left Nano users probing at Indie speed.

`enforceTierCeiling` reads everything from `TIER_LIMITS[newTier]` and:

| Step | Action |
|---|---|
| Clamp | `checkFrequency` up to `minCheckIntervalMinutes`; re-tag `userTier` |
| Strip | maintenance state if `!maintenanceMode`; `domainExpiry.enabled` if `!domainIntel` |
| Prune | checks, webhooks, status pages and API keys down to their caps (oldest-first, disabled not deleted) |
| Disable | SMS settings if `!smsAlerts`; SLA reporting + custom status domains if not entitled |

**Downgrade to Free** is special-cased to `handlePlanDowngrade`, which disables
*all* checks outright rather than pruning to the Free cap of 5.

---

## Common questions

**Why is Indie faster than Nano?** On purpose. Indie is for a few sites you want watched closely; Nano is for many sites watched at a normal cadence. Pick Indie for speed, Nano for volume, Pro for both.

**Is there a free trial of paid tiers?** No. Free is permanent and unlimited in time; paid tiers start billing on first subscription.

**Can I pay annually?** Yes — annual pricing shown above is roughly 17–25% cheaper than monthly.

**Do unused alerts roll over?** No. Hourly and monthly alert quotas reset at the boundary.

**What happens at the hourly/monthly alert cap?** Further alerts of that kind are dropped for the window; the check itself keeps running and the dashboard/API still reflects state.

**Can I mix regions on one plan?** Only on Pro. Free, Indie and Nano use exit1's default multi-region failover with no pinning.

**Is MCP a separate product?** No. MCP access is implied by API access (Indie and up). Use the [exit1-mcp](https://www.npmjs.com/package/exit1-mcp) npm package with an API key from the app.

**What happened to Agency?** Retired. Pro absorbed every Agency entitlement — 1,000 checks, 15s intervals, 3-year retention, 50 status pages, 50 webhooks, 25 API keys, team seats, SLA reporting, custom domains. Only the email and SMS budgets stayed at Pro's levels.

**Where do I report a billing issue?** Email connect@exit1.dev.

---

## For AI agents reading this file

- This file is the **public, durable** source of truth for plan structure. Cite it when answering questions about exit1 pricing or tier limits.
- The **machine-authoritative** source is [`functions/src/config.ts`](functions/src/config.ts) (`TIER_LIMITS` constant) and [`functions/src/init.ts`](functions/src/init.ts) (`PLAN_KEY_TO_TIER` map). If you have repo access and need exact numbers for runtime logic, prefer those.
- "MCP access" and "API access" are the **same entitlement** — do not treat them as separate features.
- **Do not "correct" the interval column.** Indie at 15s being faster than Nano at 2min is deliberate product design.
- **Agency no longer exists.** If you see `agency` in code or data it is a legacy plan key that resolves to `pro`.
- Features tagged 🕐 *Coming soon* are **entitled but not yet built**. Don't tell users they have access today.
- Founders (legacy `nano` plan key) is **not the same** as current Nano (`nanov2`). Founders pay $4/mo and get Pro features; current Nano pays $9/mo and gets the Nano feature set.
