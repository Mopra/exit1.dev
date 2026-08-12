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
| **Free** | $0 | — | Genuinely usable monitoring for hobby projects and evaluation. |
| **Indie** | $4 | $36 ($3/mo) | Sites you want watched *closely* — 1-minute checks and a branded status page. |
| **Nano** | $9 | $84 ($7/mo) | Production monitoring for small teams: 30s checks, domain intelligence, region pinning. |
| **Pro** | $24 | $240 ($20/mo) | Teams running production workloads — everything, at the highest limits. |

All plans share the same monitoring engine. Higher tiers unlock faster checks, higher caps, longer history, and gated features.

> **The ladder is monotonic on every dimension.** Each tier is a strict superset
> of the one below it: caps only rise, intervals only get faster, and no feature
> flag is ever revoked going up. The primary axis is **check interval** —
> 5min → 1min → 30s → 15s, i.e. *how fast do you want to know* — with the
> team-and-scale features layered on at Nano and Pro. A test suite
> (`functions/src/__tests__/tier-ladder.test.ts`) fails the build if any of this
> stops being true.

---

## Feature matrix

Capabilities marked **🕐 Coming soon** have the entitlement flag enabled in code but the feature itself is still being built. Subscribers see a "Coming Soon" badge in-app.

| Capability | Free | Indie | Nano | Pro |
|---|---|---|---|---|
| **Monitored checks** | 50 | 100 | 250 | 1,000 |
| **Minimum check interval** | 5 min | 1 min | 30 sec | 15 sec |
| **History retention** | 60 days | 90 days | 365 days | 1,095 days (3 yr) |
| **Status pages** | 1 | 1 | 5 | 50 |
| **Webhooks** | 1 | 3 | 10 | 100 |
| **API keys** (also gates MCP access) | 1 | 3 | 10 | 100 |
| **Email alerts / hour** | 50 | 100 | 250 | 1,000 |
| **Email alerts / month** | 300 | 800 | 2,500 | 10,000 |
| **SMS alerts / hour** | 0 | 0 | 0 | 25 |
| **SMS alerts / month** | 0 | 0 | 0 | 50 |
| Live probe stream (real-time page) | ✓ | ✓ | ✓ | ✓ |
| REST API access | ✓ | ✓ | ✓ | ✓ |
| MCP server access | ✓ | ✓ | ✓ | ✓ |
| Status page builder (branding, layout, widgets) | — | ✓ | ✓ | ✓ |
| DNS record monitoring | — | ✓ | ✓ | ✓ |
| Domain Intelligence (WHOIS, expiry, DNS) | — | — | ✓ | ✓ |
| Maintenance mode | — | — | ✓ | ✓ |
| Stats & timeline views | — | — | ✓ | ✓ |
| Region choice (US / EU / Asia) | — | — | ✓ | ✓ |
| SMS alerts | — | — | — | ✓ |
| CSV bulk export | — | — | — | ✓ |
| All alert channels (Slack / Discord / Teams) | — | — | — | ✓ |
| Per-log comments / notes | — | — | — | ✓ |
| Extra email recipients (per-check / per-folder) | — | — | — | ✓ |
| Team seats 🕐 *Coming soon* | 0 | 0 | 0 | 10 |
| SLA reporting 🕐 *Coming soon* | — | — | — | ✓ |
| Custom status-page domain 🕐 *Coming soon* | — | — | — | ✓ |

> **MCP access follows API access.** There is no separate MCP entitlement — if a
> plan can mint API keys, it can use the [exit1-mcp](https://www.npmjs.com/package/exit1-mcp)
> server. **Every plan can, including Free.** Free mints one key on purpose: the
> hosted MCP server is the onboarding wedge, and putting it behind a credit card
> means a developer can't reach the thing the product is pitched on. The public
> API's own rate limits (5 req/min per key, 500/day) bound the cost.

> **The Live page is on every plan.** Real-time WebSocket probe streaming with
> scrolling charts and raw-probe tables is not a paid feature and is not planned
> to become one.

Indie's alert channels are **email and webhooks only** — no Slack/Discord/Teams, no SMS.

### How the email budgets are derived

The email caps are not hand-picked numbers. Two rules generate them, and
`tier-ladder.test.ts` enforces both:

1. **`emailHourly` === `maxChecks`.** The blast radius of one provider outage is
   every monitor at once. An hourly cap below the check cap silently truncates
   alerts during the exact incident the product exists for — which is a worse
   failure than any monitor cap, because it fails invisibly and at the worst
   possible moment.
2. **`emailMonthly` is 6–10× `maxChecks`**, rising with tier. One incident costs
   two emails (down + up), so this leaves room for 3–5 incidents per monitor per
   month. Below 6× the email budget, not the monitor count, becomes the real
   product limit.

**Known gap:** exit1 does not yet batch simultaneous incidents into a single
"12 monitors are down" email. Until it does, these caps are the floor rather
than comfortable headroom. Incident grouping is the intended follow-up; it would
make a total outage cost 1 email instead of N and put a large margin back into
every tier.

---

## Per-tier detail

### Free — $0

Designed to be genuinely usable, not a crippled demo. No credit card.

- **50 checks**, minimum **5-minute** interval.
- **1 API key**, which also unlocks **MCP server** access.
- **60 days** of history.
- **1 status page** (default branding, no builder).
- **1 webhook**, **email alerts only**, capped at **50/hour and 300/month**.
- **Live probe stream** — the real-time page, same as every other tier.
- Multi-region failover handled by exit1, but no region pinning.
- No DNS checks, no SMS, no CSV export, no Slack/Discord/Teams, no maintenance
  windows, no domain intelligence, no stats/timeline views.

### Indie — $4/mo · $36/yr

The cheapest paid plan. Built for someone with a set of sites they care about
enough to want minute-resolution and a status page with their own name on it.

- **100 checks**, minimum **1-minute** interval.
- **3 API keys** + **MCP server** access.
- **3 webhooks**, email alerts up to **100/hour and 800/month**.
- **1 status page with the full builder** — branding, layout, widgets. The most
  visible thing a $3 customer gets, and it costs nothing to serve.
- **90 days** of history.
- **DNS record monitoring** (floored at a 5-minute interval — DNS queries are far
  more expensive than an HTTP probe, so the general interval does not carry over).
- No SMS, no CSV export, no Slack/Discord/Teams, no maintenance windows, no
  domain intelligence, no region choice, no stats/timeline views.

### Nano — $9/mo · $84/yr

Production monitoring for small teams. The volume-and-depth tier.

- **250 checks**, minimum **30-second** interval.
- **10 API keys** + **MCP server** access.
- **365 days** of history.
- **5 status pages** with full builder.
- **10 webhooks**, email alerts up to **250/hour and 2,500/month**.
- **Domain Intelligence** (WHOIS, expiry tracking, DNS records).
- **Maintenance mode** for planned downtime.
- **Region choice** — pin checks to US, EU, or Asia. Moved down from Pro so Nano
  is a destination rather than "Indie with more"; Pro is the *team* tier.
- **Stats and timeline** views.
- Still no SMS, no CSV, no Slack/Discord/Teams alert channels.

### Pro — $24/mo · $240/yr

Everything exit1 does, at the highest limits. Pro absorbed the retired Agency
tier in full.

- **1,000 checks**, minimum **15-second** interval.
- **3 years (1,095 days)** of history.
- **50 status pages**, **100 webhooks**, **100 API keys**.
- Email alerts up to **1,000/hour and 10,000/month**.
- **SMS alerts** up to **25/hour and 50/month**.
- **CSV bulk export** of check history.
- **All alert channels**: Slack, Discord, Microsoft Teams (plus email, SMS, webhooks).
- **Per-log comments** on individual check runs.
- **Extra email recipients** per-check and per-folder.
- Pre-allocated for **10 team seats**, **SLA reporting**, and **custom status-page
  domains** — 🕐 these are entitled in billing but the features are still being built.

> **Why 100 webhooks and not "unlimited"?** One down event fans out to every
> configured webhook, so an unbounded count is an amplifier pointed at our own
> egress and at Svix. 100 is past what anyone reaches, and it is a number the
> system can actually promise.

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
Rank now agrees with every other dimension — see the monotonicity note above.

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

### Retired: the Free-tier check grandfathering

Free briefly dropped from 10 checks to 5, and ~91 early users were grandfathered
back to 10 via a sticky `users/{uid}.legacyFreeChecks` flag keyed on their Clerk
signup date. **This mechanism was removed on 2026-08-12** when Free moved to 50
checks, which dominates the grandfathered cap for every user in the set — there
is no longer any input for which the flag changes an answer. Leftover
`legacyFreeChecks` booleans on user documents are inert and need no cleanup.

---

## How tier gating works

### Backend enforcement

All limits are enforced server-side in [`functions/src/config.ts`](functions/src/config.ts) via the `TIER_LIMITS` table and tier-aware helpers:

- **Whole row:** `getTierLimits(tier)` — prefer this when you need several limits at once.
- **Numeric caps:** `getMaxChecksForTier`, `getMaxWebhooksForTier`, `getMaxApiKeysForTier`, `getMaxStatusPagesForTier`
- **Interval floor:** `getMinCheckIntervalMinutesForTier` + `validateCheckFrequencyForTier`
- **Retention:** `getHistoryRetentionDaysForTier` (drives BigQuery purge)
- **Alert quotas:** `getEmailBudgetMaxPerWindowForTier`, `getEmailMonthlyBudgetMaxPerWindowForTier`, `getSmsBudgetMaxPerWindowForTier`, `getSmsMonthlyBudgetMaxPerWindowForTier`
- **Upsell copy:** `nextTierWithMore(tier, dimension)` — resolves the cheapest tier that actually offers more. Never hardcode a tier name in a user-facing limit message; that is how the app ended up advertising caps the backend never honoured.
- **Feature flags:** booleans on `TIER_LIMITS[tier]` (`smsAlerts`, `apiAccess`, `csvExport`, `domainIntel`, `maintenanceMode`, `statusPageBuilder`, `slaReporting`, `customStatusDomain`, `allAlertChannels`, `regionChoice`)
- **Inline Pro-only guards** (no `TIER_LIMITS` flag — gated as `tier !== 'pro'`):
  - Per-log comments — [`functions/src/log-notes.ts`](functions/src/log-notes.ts)
  - Extra email recipients per-check / per-folder — [`functions/src/email.ts`](functions/src/email.ts)
  - CSV export — [`functions/src/csv-export.ts`](functions/src/csv-export.ts)
- **Inline Nano+ guards:** stats/timeline views ([`history.ts`](functions/src/history.ts)), organization billing ([`organizations.ts`](functions/src/organizations.ts)), maintenance mode (`isNanoTier` in [`checks.ts`](functions/src/checks.ts)).

### Frontend enforcement

The browser mirror lives in [`src/lib/subscription.ts`](src/lib/subscription.ts)
(`TIER_LIMITS_MIRROR`) and is surfaced through [`usePlan()`](src/hooks/usePlan.ts).

**Read the named entitlement flags, never a tier comparison.** `usePlan()`
returns `apiAccess`, `statusPageBuilder`, `domainIntel`, `maintenanceMode`,
`smsAlerts`, `csvExport`, `allAlertChannels`, `regionChoice`, plus the numeric
caps. The `nano` / `paid` / `pro` booleans are back-compat only:

- `paid` is **not** `apiAccess` — Free has an API key.
- `nano` is **not** `statusPageBuilder` — Indie has the builder.
- `nano` is **not** `smsAlerts` — SMS is Pro-only.

Each of those three was a live mis-gate in the codebase before the restructure.

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

On every tier change, `ceilingTightens(from, to)` in
[`functions/src/plan-enforcement.ts`](functions/src/plan-enforcement.ts) compares
the two `TIER_LIMITS` rows dimension-by-dimension. If any limit is tighter on the
target tier, `enforceTierCeiling(userId, newTier)` runs; otherwise only the
`userTier` denormalisation is refreshed.

The ladder is monotonic today, so tier rank *would* be sufficient — but it was
not before this restructure, and a dimension-wise comparison stays correct
through any future repricing without anyone having to remember why.

> **Invariant:** every flag listed in `ceilingTightens` must have a corresponding
> strip/reset step in `enforceTierCeiling`. A flag that leaves persisted state
> behind but isn't listed means that state survives the downgrade silently.

`enforceTierCeiling` reads everything from `TIER_LIMITS[newTier]` and:

| Step | Action |
|---|---|
| Clamp | `checkFrequency` up to `minCheckIntervalMinutes`; re-tag `userTier` |
| Strip | maintenance state if `!maintenanceMode`; `domainExpiry.enabled` if `!domainIntel`; status-page `branding` + `customLayout` if `!statusPageBuilder` |
| Reset | pinned `checkRegion` back to `vps-eu-1` if `!regionChoice` |
| Prune | checks, webhooks, status pages and API keys down to their caps (oldest-first, disabled not deleted) |
| Disable | SMS settings if `!smsAlerts`; SLA reporting + custom status domains if not entitled |

**Downgrade to Free** routes to `handlePlanDowngrade`, which does the same work
plus the Free-only bookkeeping (`downgradedAt`).

> **It prunes, it does not blank.** `handlePlanDowngrade` used to disable *every*
> check the user owned. That was defensible when Free allowed 5 monitors; it is
> not now that Free allows 50, because a lapsed card would take a user's entire
> monitoring offline even though the Free plan covers most of it. It now prunes
> oldest-first to the Free cap, exactly like every other tier.

---

## Common questions

**Do I need to pay to use the API or MCP?** No. Every plan including Free mints at least one API key, and MCP access follows API access.

**Is the Live page a paid feature?** No, and it isn't planned to become one. Real-time probe streaming is on every plan.

**Is there a free trial of paid tiers?** No. Free is permanent, unlimited in time, and generous enough to run real projects on; paid tiers start billing on first subscription.

**Can I pay annually?** Yes — annual pricing shown above is roughly 17–25% cheaper than monthly.

**Do unused alerts roll over?** No. Hourly and monthly alert quotas reset at the boundary.

**What happens at the hourly/monthly alert cap?** Further alerts of that kind are dropped for the window; the check itself keeps running and the dashboard/API still reflect state.

**Can I mix regions on one plan?** Nano and Pro. Free and Indie use exit1's default multi-region failover with no pinning.

**What happens to my checks if my card lapses?** Your newest 50 keep running on the Free plan; anything beyond that is disabled (not deleted) and comes back on re-subscription.

**What happened to Agency?** Retired. Pro absorbed every Agency entitlement.

**Where do I report a billing issue?** Email connect@exit1.dev.

---

## For AI agents reading this file

- This file is the **public, durable** source of truth for plan structure. Cite it when answering questions about exit1 pricing or tier limits.
- The **machine-authoritative** source is [`functions/src/config.ts`](functions/src/config.ts) (`TIER_LIMITS` constant) and [`functions/src/init.ts`](functions/src/init.ts) (`PLAN_KEY_TO_TIER` map). If you have repo access and need exact numbers for runtime logic, prefer those.
- "MCP access" and "API access" are the **same entitlement** — do not treat them as separate features, and do not describe either as paid-only.
- The ladder is **monotonic**. If you see code or copy implying a cheaper tier beats a dearer one on any dimension, that is a bug — report it rather than preserving it.
- **Agency no longer exists.** If you see `agency` in code or data it is a legacy plan key that resolves to `pro`.
- Features tagged 🕐 *Coming soon* are **entitled but not yet built**. Don't tell users they have access today.
- Founders (legacy `nano` plan key) is **not the same** as current Nano (`nanov2`). Founders pay $4/mo and get Pro features; current Nano pays $9/mo and gets the Nano feature set.
- The `legacyFreeChecks` grandfathering is **retired**. Ignore any residual field of that name on user documents.
