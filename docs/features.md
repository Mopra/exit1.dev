## Features

- **Real‑time checks**: Live list of checks powered by Firestore `onSnapshot`, with status badges and next‑run countdown.
- **Website monitoring**: HEAD by default; tracks availability, HTTP status, and latency.
- **API monitoring**: Monitor REST endpoints with custom method, headers, JSON body, and expected status codes.
- **SSL certificate checks**: Validity, issuer/subject, valid from/to, days until expiry; inline tooltip in the UI.
- **Check frequency**: Presets 60s, 5m, 1h, 24h; configurable per check.
- **Manual check (run now)**: Trigger an immediate check on demand.
- **Reordering**: Drag‑and‑drop checks; persisted ordering.
- **Enable/disable**: Pause/resume individual or multiple checks (bulk actions).
- **Bulk delete**: Delete multiple checks at once with confirmation.
- **Search checks**: Filter by name, URL, type, or status.

- **Logs (BigQuery)**: Server‑side paginated history per site with status, code, latency, and errors.
- **Log filters**: Time presets (24h, 7d, 30d, 90d, 1y, all), custom date range calendar, status, website, and search.
- **Log details sheet**: Rich row details with copy‑all and copy‑JSON.
- **Export logs**: Download current view as CSV or Excel (.xlsx).
- **Column controls**: Toggle visible columns; preferences saved to localStorage.
- **Successful checks view**: Hourly drill‑down page showing only successful checks for a given hour.

- **Reports dashboard**: Aggregated metrics across one or many sites.
- **Uptime %**: Computed from online vs total checks for selected range.
- **Incidents**: Count of offline transitions; incident intervals tracked.
- **Total downtime**: Sum of offline durations in the window.
- **MTBI**: Mean Time Between Incidents (single or multi‑site).
- **ORS (reliability score)**: 0–10 score blending uptime, incidents, recovery, adjusted by check rate.
- **Trends chart**: Incidents, downtime (min), and uptime% over time.

- **Webhook alerts**: Create/update/delete webhooks with events (website_down/up/error), enable/disable, custom headers.
- **HMAC signatures**: Optional `X-Exit1-Signature: sha256=<sig>` for payload verification.
- **Test webhook**: Send test payload and show response.

- **Email alerts**: Recipient, event selection, per‑check overrides.
- **Flap suppression**: Require N consecutive events before first email.
- **Delivery policy**: Max 1 email per check per event per hour; send test email.

- **API keys**: Create/list/revoke keys; show prefix/last4; last‑used tracking.
- **Public REST API**: `X-Api-Key` protected GET endpoints for checks, details, history (filters), and stats; CORS enabled.

- **System status**: Service health card (Firebase), recent issues (24h), manual refresh and 60s auto‑refresh.

- **Authentication**: Clerk‑based sign‑in/sign‑up, forgot password, SSO (Google/GitHub/Discord), SSO callback.
- **Profile management**: Update username/password; manage and disconnect linked accounts.
- **Delete account**: Purge app data (checks, webhooks, email settings) via function; finalize deletion in Clerk.

- **Spam protection & limits**: URL validation, blocked domains, duplicate/pattern detection, max checks/user, per‑minute/hour/day rate limits on adds.
- **Auto‑disable dead sites**: Disable after extended downtime or too many consecutive failures.
- **Cost/perf optimizations**: Batched Firestore writes, dynamic concurrency, scheduler‑driven checker, circuit breaker.
- **Data storage**: Real‑time state + recent history in Firestore; full history in BigQuery.

- **UI/UX**: shadcn/ui components with glassmorphism aesthetic, responsive layouts, skeletons/loading states, slide‑out forms, tooltips, cursor‑pointer on interactive elements.

