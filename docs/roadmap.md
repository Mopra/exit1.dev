## Product & Engineering Roadmap

### Guiding principles
- **UI**: shadcn/ui everywhere; convert remaining custom UI to shadcn.
- **Aesthetic**: glassmorphism (frosted blue), subtle borders, backdrop-blur.
- **UX**: all actionable elements must use `cursor-pointer`.
- **DRY**: prefer shared components and utilities.

### Feature ideas¨
- ✅ **Alert SSL errors or warning in email and webhook** - *Implemented*
- **Tags**
- **Incident comments**
- **Public status page**

### Existing features: enhancements
- **Logs (BigQuery)**
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

### Reliability and alerting
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