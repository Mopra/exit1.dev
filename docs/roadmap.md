## Product & Engineering Roadmap

### Guiding principles
- **UI**: shadcn/ui everywhere; convert remaining custom UI to shadcn.
- **Aesthetic**: glassmorphism (frosted blue), subtle borders, backdrop-blur.
- **UX**: all actionable elements must use `cursor-pointer`.
- **DRY**: prefer shared components and utilities.

### Quick wins (prioritized)
1) **Live checks**: switch `useChecks` to Firestore `onSnapshot` for real-time updates; show per-row countdown from `nextCheckAt`.
2) **Virtualization**: use `@tanstack/react-virtual` for `CheckTable` and `LogsBigQuery` to keep 60fps on large lists.
3) **Pre‑add “Test configuration”**: from `CheckForm`, call a new function to run `checkRestEndpoint` against unsaved data; show status, response time, headers, SSL, and validation results
4) Remove bar chart from Reports, let's only have line charts
5) Store response time in BigQuery and add it to the report and log pages
6) Fix drag and drop to rearrange on the checks table

### Existing features: enhancements
- **CheckForm**
  - Add JSONPath validation support; preview match result.
  - Show validated expected status codes vs actual; badge for mismatches.
- **Checks list**
  - Add “Next run” column with live countdown; display `disabledReason`/`disabledAt` with “Re‑enable” action.
  - Bulk actions bar: enable/disable, change interval, delete, tag (future).
- **Logs (BigQuery)**
  - Add infinite scroll for page 1; auto-refresh with last-updated pill.
  - Quick filters: status chips, time presets; fuzzy match on name/url/error.
  - Row detail: include raw headers if present; copy JSON/fields with toasts.
- **Reports**
  - Add p50/p95/p99 latency, error rate; reliability score already present—add sparkline and trend.

### Performance and cost
- **Functions**
  - Use HTTP keep-alive agents for outbound `fetch` to reduce TLS handshakes at high concurrency.
  - Adaptive concurrency: reduce `getDynamicConcurrency` when error rate spikes; persist rolling failure window.
- **BigQuery**
  - Replace “fetch 10k then count” with `COUNT(*)` for totals.
  - Add `APPROX_QUANTILES(response_time, [0.5,0.95,0.99])` to return percentiles in one query.
- **Firestore**
  - TTL policy: keep recent history in subcollections (e.g., last 7 days); full history lives in BigQuery only.
  - Ensure composite indexes for `userId + orderIndex` and `userId + status` queries.

### Reliability and alerting
- **Flap suppression**: already supported; add UI for per-event N.
- **Maintenance windows**: per-check/global quiet hours; suppress emails/webhooks.
- **Webhook delivery log**: store attempts/outcomes; add re-delivery action.
- **SSL**: show issuer/subject/validity in tooltip; warn at ≤7 days; allow “snooze SSL alerts”.

### Security and public API
- **API keys**
  - Add `scopes` enforcement and optional IP allowlist.
  - Track usage metrics (count per key) and simple rate limits.
- **Public endpoints**
  - Add dedicated count endpoints; standardize error payloads; document examples in Settings page.

### New features
- **Public status pages**: per-user/per-check shareable pages using shadcn + glass; themeable.
- **Weekly email summaries**: uptime, incidents, p95 latency via Resend; subscribe toggle on Reports.
- **Integrations**: Slack/Discord/Telegram as alert channels (templates + signing docs).
- **Bulk import/export**: CSV/JSON importer with validation and preview.

### DevEx, CI/CD, and docs
- **CI**: lint, typecheck, Playwright E2E, functions deploy on tagged releases.
- **Config**: move BigQuery dataset/table IDs to env; document required env vars.
- **Docs**: add brief “How checks run” and “Alert policy” pages for users.

### MCP integrations
- **Slack MCP**: send test messages; configure channels from UI.
- **BigQuery MCP**: run ad-hoc queries for debugging.
- **GitHub MCP**: surface CI status and link PRs in-app.

### Audit for shadcn/UI consistency
- Convert any legacy UI instances to shadcn (buttons, dialogs, headers).
- Ensure consistent tooltips, badges, toasts, and `cursor-pointer` usage.

### Suggested next steps
1) Implement Firestore `onSnapshot` in `useChecks` + countdown column.
2) Virtualize `CheckTable` and `LogsBigQuery`.
3) Add “Test configuration” path in `CheckForm` + JSONPath validation via `jsonpath-plus`.