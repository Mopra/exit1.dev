## Features

### Core Monitoring
- **Real-time checks**: Live list of checks powered by Firestore `onSnapshot`, with status badges and next-run countdown.
- **Website monitoring**: HEAD by default; tracks availability, HTTP status, and latency.
- **API monitoring**: Monitor REST endpoints with custom method, headers, JSON body, and expected status codes.
- **SSL certificate checks**: Validity, issuer/subject, valid from/to, days until expiry; inline tooltip in the UI.
- **Domain expiry monitoring**: Tracks domain registration expiry dates with warnings.
- **Check frequency**: Presets 60s, 5m, 1h, 24h; configurable per check.
- **Manual check (run now)**: Trigger an immediate check on demand.
- **Reordering**: Drag‑and‑drop checks; persisted ordering.
- **Enable/disable**: Pause/resume individual or multiple checks (bulk actions).
- **Bulk delete**: Delete multiple checks at once with confirmation.
- **Search checks**: Filter by name, URL, type, or status.

### Logs & History
- **Logs (BigQuery)**: Server‑side paginated history per site with status, code, latency, and errors.
- **Log filters**: Time presets (24h, 7d, 30d, 90d, 1y, all), custom date range calendar, status, website, and search.
- **Log details sheet**: Rich row details with copy‑all and copy‑JSON.
- **Export logs**: Download current view as CSV or Excel (.xlsx).
- **Column controls**: Toggle visible columns; preferences saved to localStorage.
- **Successful checks view**: Hourly drill‑down page showing only successful checks for a given hour.

### Reports & Analytics
- **Reports dashboard**: Aggregated metrics across one or many sites.
- **Uptime %**: Computed from online vs total checks for selected range.
- **Incidents**: Count of offline transitions; incident intervals tracked.
- **Total downtime**: Sum of offline durations in the window.
- **MTBI**: Mean Time Between Incidents (single or multi‑site).
- **ORS (reliability score)**: 0–10 score blending uptime, incidents, recovery, adjusted by check rate.
- **Trends chart**: Incidents, downtime (min), and uptime% over time.
- **Response time analytics**: Average, min, max response times with charts.

### Notifications
- **Webhook alerts**: Create/update/delete webhooks with events (website_down/up/error, ssl_error/warning), enable/disable, custom headers.
- **HMAC signatures**: Optional `X-Exit1-Signature: sha256=<sig>` for payload verification.
- **Test webhook**: Send test payload and show response.
- **Email alerts**: Recipient, event selection, per‑check overrides.
- **Flap suppression**: Require N consecutive events before first email.
- **Delivery policy**: Max 1 email per check per event per hour; send test email.

### API & Integration
- **API keys**: Create/list/revoke keys; show prefix/last4; last‑used tracking.
- **Public REST API**: `X-Api-Key` protected GET endpoints for checks, details, history (filters), and stats; CORS enabled.
- **BigQuery integration**: Full historical data storage and analytics.
- **Firebase Functions**: Serverless backend with real-time updates.

### System & Status
- **System status**: Service health card (Firebase), recent issues (24h), manual refresh and 60s auto‑refresh.
- **Real-time updates**: Live status changes with optimistic UI updates.
- **Error tracking**: Comprehensive error logging and display.

### Authentication & User Management
- **Authentication**: Clerk‑based sign‑in/sign‑up, forgot password, SSO (Google/GitHub/Discord), SSO callback.
- **Profile management**: Update username/password; manage and disconnect linked accounts.
- **Delete account**: Purge app data (checks, webhooks, email settings) via function; finalize deletion in Clerk.

### Security & Performance
- **Spam protection & limits**: URL validation, blocked domains, duplicate/pattern detection, max checks/user, per‑minute/hour/day rate limits on adds.
- **Auto‑disable dead sites**: Disable after extended downtime or too many consecutive failures.
- **Cost/perf optimizations**: Batched Firestore writes, dynamic concurrency, scheduler‑driven checker, circuit breaker.
- **Data storage**: Real‑time state + recent history in Firestore; full history in BigQuery.

### UI/UX Features
- **Modern UI**: shadcn/ui components with glassmorphism aesthetic.
- **Responsive design**: Mobile-first responsive layouts with adaptive navigation.
- **Loading states**: Skeletons, spinners, and progressive loading indicators.
- **Interactive elements**: Slide‑out forms, tooltips, cursor‑pointer on clickable elements.
- **Data visualization**: Charts and graphs for analytics using Recharts.
- **Accessibility**: ARIA labels, keyboard navigation, screen reader support.
- **Dark theme**: Consistent dark theme with frosted blue accents.
- **Real-time indicators**: Live status updates with visual feedback.

### Advanced Features
- **Response validation**: JSONPath validation, text content checking for API endpoints.
- **Custom headers**: Support for authentication and custom request headers.
- **Status code validation**: Configurable expected status codes for different check types.
- **Error handling**: Comprehensive error messages and recovery suggestions.
- **Data export**: CSV and Excel export capabilities for logs and reports.
- **Caching**: Intelligent caching for performance optimization.
- **Rate limiting**: Built-in rate limiting to prevent abuse.

