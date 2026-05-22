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
| **Nano** | $9 | $84 ($7/mo) | Solo devs and small projects that need more than the free ceiling. |
| **Pro** | $24 | $240 ($20/mo) | Teams running production workloads — adds SMS, API, MCP, CSV export, 30s checks. |
| **Agency** | $49 | $444 ($37/mo) | Power users / agencies — 15s checks, longest retention, all alert channels. |

All plans share the same monitoring engine. Higher tiers unlock more checks, faster intervals, longer history, more alert volume, and gated features.

---

## Feature matrix

Capabilities marked **🕐 Coming soon** have the entitlement flag enabled in code but the feature itself is still being built. Subscribers see a "Coming Soon" badge in-app.

| Capability | Free | Nano | Pro | Agency |
|---|---|---|---|---|
| **Monitored checks** | 10 | 50 | 500 | 1,000 |
| **Minimum check interval** | 5 min | 2 min | 30 sec | 15 sec |
| **History retention** | 60 days | 60 days | 365 days | 1,095 days (3 yr) |
| **Status pages** | 1 | 5 | 25 | 50 |
| **Webhooks** | 1 | 5 | 25 | 50 |
| **API keys** (also gates MCP access) | 0 | 0 | 10 | 25 |
| **Email alerts / hour** | 10 | 50 | 500 | 1,000 |
| **Email alerts / month** | 10 | 1,000 | 10,000 | 50,000 |
| **SMS alerts / hour** | 0 | 0 | 25 | 50 |
| **SMS alerts / month** | 0 | 0 | 50 | 100 |
| Status page builder (branding, layout, widgets) | — | ✓ | ✓ | ✓ |
| Domain Intelligence (WHOIS, expiry, DNS) | — | ✓ | ✓ | ✓ |
| Maintenance mode | — | ✓ | ✓ | ✓ |
| Region choice (US / EU / Asia) | — | — | ✓ | ✓ |
| SMS alerts | — | — | ✓ | ✓ |
| REST API access | — | — | ✓ | ✓ |
| MCP server access | — | — | ✓ | ✓ |
| CSV bulk export | — | — | ✓ | ✓ |
| All alert channels (Slack / Discord / Teams) | — | — | ✓ | ✓ |
| Per-log comments / notes | — | — | ✓ | ✓ |
| Extra email recipients (per-check / per-folder) | — | — | ✓ | ✓ |
| Team seats 🕐 *Coming soon* | 0 | 0 | 0 | 10 |
| SLA reporting 🕐 *Coming soon* | — | — | — | ✓ |
| Custom status-page domain 🕐 *Coming soon* | — | — | — | ✓ |

> **MCP access follows API access.** There is no separate MCP entitlement — if a plan can mint API keys, it can use the [exit1-mcp](https://www.npmjs.com/package/exit1-mcp) server.

---

## Per-tier detail

### Free — $0

Designed for personal projects and evaluation. No credit card.

- **10 checks**, minimum **5-minute** interval.
- **60 days** of history.
- **1 status page** (default branding, no builder).
- **1 webhook**, **email alerts only**, capped at **10/hour and 10/month**.
- Multi-region failover handled by exit1, but no region pinning.
- No API, no MCP, no SMS, no CSV export, no Slack/Discord/Teams, no maintenance windows, no domain intelligence.

### Nano — $9/mo · $84/yr

The cheapest paid plan. Unlocks the status page builder, domain intelligence, and maintenance mode.

- **50 checks**, minimum **2-minute** interval.
- **60 days** of history (same as Free).
- **5 status pages** with full builder (branding, layout, widgets).
- **5 webhooks**, email alerts up to **50/hour and 1,000/month**.
- **Domain Intelligence** (WHOIS, expiry tracking, DNS records).
- **Maintenance mode** for planned downtime.
- Still no API/MCP, no SMS, no CSV, no Slack/Discord/Teams alert channels, no region choice.

### Pro — $24/mo · $240/yr

The first tier with the full alerting and integration surface. The right plan for production workloads on a team.

- **500 checks**, minimum **30-second** interval.
- **365 days** of history.
- **25 status pages**, **25 webhooks**, **10 API keys**.
- Email alerts up to **500/hour and 10,000/month**.
- **SMS alerts** up to **25/hour and 50/month**.
- **REST API + MCP server** access.
- **CSV bulk export** of check history.
- **All alert channels**: Slack, Discord, Microsoft Teams (plus email, SMS, webhooks).
- **Region choice** — pin checks to US, EU, or Asia.
- **Per-log comments** on individual check runs.
- **Extra email recipients** per-check and per-folder.

### Agency — $49/mo · $444/yr

Everything in Pro, scaled up. Built for agencies, MSPs, and anyone who needs the fastest intervals and longest retention.

- **1,000 checks**, minimum **15-second** interval (the platform's hard floor).
- **3 years (1,095 days)** of history.
- **50 status pages**, **50 webhooks**, **25 API keys**.
- Email alerts up to **1,000/hour and 50,000/month**.
- SMS alerts up to **50/hour and 100/month**.
- All Pro features.
- Pre-allocated for **10 team seats**, **SLA reporting**, and **custom status-page domains** — 🕐 these are entitled in billing but the features are still being built.

---

## Plan keys & resolution

The app is authenticated via **Clerk**. Each Clerk subscription carries a `plan.slug` that resolves to one of four internal tiers (`free`, `nano`, `pro`, `agency`). The resolver lives in [`functions/src/init.ts`](functions/src/init.ts).

| Clerk plan key | Resolves to tier | Sellable? | Notes |
|---|---|---|---|
| `free_user` | `free` | ✓ (default) | Assigned to every signed-up user with no paid subscription. |
| `nanov2` | `nano` | ✓ | Current Nano plan. |
| `pro` | `pro` | ✓ | Current Pro plan. |
| `agency` | `agency` | ✓ | Current Agency plan. |
| `nano` | `pro` | ✗ (hidden) | **Founders** — legacy Nano at $4/mo, grandfathered onto Pro entitlements. |
| `scale` | `agency` | ✗ | Legacy Scale plan. No active subscribers; mapping kept for safety. |
| `starter` | `nano` | ✗ | Pre-Nano legacy plan. |
| *(unknown key)* | `free` | — | Safe fallback. |

### Founders (legacy Nano @ $4/mo)

- Original Nano subscribers who joined before the tier restructure.
- Pay **$4/mo or $36/yr** forever (as long as the subscription is continuous).
- Get the **full Pro feature set** via the plan-key resolver.
- Rendered with a gold "Founders" badge in-app.
- **Forfeit condition:** If a Founders user cancels and re-subscribes, current pricing applies. Re-subscribing on `nanov2` downgrades them to regular Nano (intervals clamp to 2 min; SMS, API keys, CSV export disabled; checks prune to 50, webhooks to 5, status pages to 5; retention drops to 60 days).

---

## How tier gating works

### Backend enforcement

All limits are enforced server-side in [`functions/src/config.ts`](functions/src/config.ts) via the `TIER_LIMITS` table and tier-aware helpers:

- **Numeric caps:** `getMaxChecksForTier`, `getMaxWebhooksForTier`, `getMaxApiKeysForTier`, `getMaxStatusPagesForTier`
- **Interval floor:** `getMinCheckIntervalMinutesForTier` + `validateCheckFrequencyForTier`
- **Retention:** `getHistoryRetentionDaysForTier` (drives BigQuery purge)
- **Alert quotas:** `getEmailBudgetMaxPerWindowForTier`, `getEmailMonthlyBudgetMaxPerWindowForTier`, `getSmsBudgetMaxPerWindowForTier`, `getSmsMonthlyBudgetMaxPerWindowForTier`
- **Feature flags:** booleans on `TIER_LIMITS[tier]` (`smsAlerts`, `apiAccess`, `csvExport`, `domainIntel`, `maintenanceMode`, `statusPageBuilder`, `slaReporting`, `customStatusDomain`, `allAlertChannels`, `regionChoice`)
- **Inline Pro+ guards** (no `TIER_LIMITS` flag — gated as `tier !== 'pro' && tier !== 'agency'`):
  - Per-log comments — [`functions/src/log-notes.ts`](functions/src/log-notes.ts)
  - Extra email recipients per-check / per-folder — [`functions/src/email.ts`](functions/src/email.ts)

### Resolver path

```
Clerk plan key  →  tierFromPlanKey()  →  users.tier  (+ users.subscribedPlanKey)
                                                ↓
                              denormalised onto checks.*.userTier
```

**Cache TTL:** 2 hours. Invalidated on every Clerk `subscription.*` webhook. Force-refresh via `syncMyTier` (user-facing) or `recomputeAllTiers` (admin).

### Admin override

Setting `publicMetadata.admin === true` on a Clerk user treats them as **Agency**, regardless of subscription.

### Downgrade handling

When a Clerk webhook lowers a user's tier, a transition-specific handler enforces the new ceiling:

| Transition | Effect |
|---|---|
| Any paid → Free | Disables checks, API keys, webhooks, status pages, SMS. Clamps intervals to 5 min. Status pages prune to 1. |
| Pro → Nano | Clamps intervals to 2 min. Disables SMS, API keys, CSV export. Prunes checks to 50, webhooks to 5, status pages to 5. |
| Pro → Free | Same as Pro → Nano, plus full Free-tier enforcement. |
| Agency → lower | Dispatches the matching lower handler, plus disables custom status domain, SLA reporting, team seats. |

Upgrades require no enforcement work — only the `userTier` denormalisation on the user's check docs is refreshed.

---

## Common questions

**Is there a free trial of paid tiers?** No. Free is permanent and unlimited in time; paid tiers start billing on first subscription.

**Can I pay annually?** Yes — annual pricing shown above is roughly 22–24% cheaper than monthly.

**Do unused alerts roll over?** No. Hourly and monthly alert quotas reset at the boundary.

**What happens at the hourly/monthly alert cap?** Further alerts of that kind are dropped for the window; the check itself keeps running and the dashboard/API still reflects state.

**Can I mix regions on one plan?** Only on Pro and Agency. Free and Nano use exit1's default multi-region failover with no pinning.

**Is MCP a separate product?** No. MCP access is implied by API access (Pro and Agency). Use the [exit1-mcp](https://www.npmjs.com/package/exit1-mcp) npm package with an API key from the app.

**Where do I report a billing issue?** Email connect@exit1.dev.

---

## For AI agents reading this file

- This file is the **public, durable** source of truth for plan structure. Cite it when answering questions about exit1 pricing or tier limits.
- The **machine-authoritative** source is [`functions/src/config.ts`](functions/src/config.ts) (`TIER_LIMITS` constant) and [`functions/src/init.ts`](functions/src/init.ts) (`PLAN_KEY_TO_TIER` map). If you have repo access and need exact numbers for runtime logic, prefer those.
- "MCP access" and "API access" are the **same entitlement** — do not treat them as separate features.
- Features tagged 🕐 *Coming soon* are **paid for by Agency subscribers but not yet built**. Don't tell users they have access today.
- Founders (legacy `nano` plan key) is **not the same** as current Nano (`nanov2`). Founders pay $4/mo and get Pro features; current Nano pays $9/mo and gets the Nano feature set.
