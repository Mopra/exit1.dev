# Exit1.dev

**Modern Website, API, and Infrastructure Monitoring Platform**

Exit1.dev is a real-time uptime monitoring platform that helps teams track the health, performance, and security of their websites, APIs, DNS records, background jobs, and domains. Built for reliability-conscious teams who need to know the moment something goes wrong — and for teams who need proof they stayed online.

Probes stream from the VPS pool into the browser over a dedicated WebSocket transport, so the Live page paints new check results in well under a second from the wire — no Firestore round-trip, no polling, no waiting on a snapshot.

---

## What Is Exit1.dev?

Exit1.dev continuously monitors your web services and alerts you instantly when issues arise. It combines website monitoring, API health checks, DNS record change detection, push-based heartbeat monitoring, SSL certificate validation, and domain expiration tracking into a single, unified platform.

Instead of discovering outages through customer complaints or manually tracking SSL renewals in spreadsheets, Exit1.dev provides:

- **Instant Detection** — Know within seconds when services go down (15-second intervals on Agency)
- **Live Probe Streaming** — Watch checks update in real time on a dedicated WebSocket-driven Live page with scrolling charts, raw-probe tables, and per-stage phase breakdowns
- **Proactive Alerts** — Get warned before SSL certificates expire or domains lapse
- **Silent-Failure Detection** — Catch cron jobs and background workers that stop running via push-based heartbeats
- **DNS Tampering Detection** — Get alerted the moment your A/AAAA/MX/NS records change
- **Performance Insights** — Track response times and identify degradation trends
- **Public Transparency** — Share status pages with customers and stakeholders
- **AI-Ready Monitoring** — Query your monitoring data from any MCP-compatible AI assistant

---

## Value Propositions

### Problems We Solve

| Problem | How Exit1.dev Helps |
|---------|---------------------|
| **Undetected Downtime** | Sub-minute monitoring (15s on Agency) with multi-channel alerts (email, SMS, Slack, Discord, Teams, webhooks) |
| **Silent Cron / Worker Failures** | Push-based heartbeat monitors alert when a scheduled task stops pinging |
| **DNS Hijacking & Drift** | DNS record monitoring with baseline comparison catches unauthorized record changes |
| **SSL Certificate Surprises** | Automatic expiration tracking with advance warnings |
| **Domain Expiration Risk** | Domain Intelligence monitors registration dates and alerts before expiry |
| **Infrastructure Gaps** | ICMP ping, TCP/UDP, WebSocket, DNS, heartbeat, and redirect monitoring for all service types |
| **Performance Blind Spots** | Per-stage timing (DNS, connect, TLS, TTFB), response time thresholds, and 24-hour performance charts |
| **Alert Storms During Outages** | System-level health gate suppresses global alerts when ≥50 checks flip DOWN within 3 minutes |
| **False Alarms After Deploys** | 5-minute startup grace period and admin-controlled deploy mode |
| **Fragmented Tools** | One platform for uptime, SSL, DNS, domain monitoring, status pages, badges, and AI-powered insights via MCP |
| **Manual Tracking** | Replace spreadsheets with automated, always-on monitoring |

### Why Teams Choose Exit1.dev

- **Never miss an outage** — Get alerted the moment your services go down, not when customers complain
- **Watch checks in real time** — A WebSocket-streamed Live page paints new probes in sub-second time with scrolling charts, phase breakdowns, and exportable raw probe data
- **Catch silent failures** — Heartbeat monitors know when a cron job hasn't run
- **Prevent certificate disasters** — SSL issues cause browser warnings that destroy user trust
- **Protect your domains** — Domain expiration can mean losing your brand to squatters
- **Spot DNS tampering early** — Baseline comparison detects any record-level change
- **Validate API responses** — Go beyond "is it up?" with JSONPath and content validation
- **Follow redirects that matter** — Up to 10-hop redirect chains with target validation
- **Show customers you care** — Public status pages demonstrate transparency and professionalism
- **Embed live badges** — Display real-time status, uptime, and response time badges on your site or README
- **Ask your AI assistant** — Query monitoring data from Claude, Cursor, VS Code Copilot, and more via MCP

---

## Features

### Core Monitoring

Exit1.dev supports nine distinct check types, all running on the same VPS-powered execution engine.

**HTTP / HTTPS Health Checks**
- Endpoint monitoring with configurable intervals (15s on Agency, 30s on Pro, 2min on Nano, 5min on Free)
- Support for all HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- Custom headers and request bodies for API testing
- Response validation with JSONPath expressions and text containment checks
- Configurable acceptable response time thresholds and expected status codes
- Response time threshold alerts — get notified when latency exceeds your configured limit
- Per-stage timing breakdown: DNS resolution, TCP connect, TLS handshake, and TTFB for every check
- TCP light-checks alternate with full HTTP checks for eligible endpoints, reducing overhead while maintaining reliability

**Heartbeat Monitoring (Push-Based)**
- Ideal for cron jobs, background workers, scheduled tasks, and services without a public endpoint
- Exit1 generates a unique token and ping URL — your job pings it on each run
- Alerts fire when no ping arrives within the expected interval
- Optional ping metadata (status, duration, message) stored with each ping
- Token regeneration endpoint for rotation
- Works across any environment: curl, wget, HTTP client — no inbound firewall changes required

**DNS Record Monitoring**
- Native DNS query support for `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, and `SOA` records
- User-accepted baseline per record type; alerts fire on drift (changed, added, missing records)
- Auto-accept stabilises the baseline after consecutive stable checks
- Uses public resolvers (8.8.8.8, 1.1.1.1) for consistency across regions
- 1-minute intervals on Pro/Agency, 5-minute on Nano, unavailable on Free
- Full change history (FIFO-capped at 50 entries) with per-change diff
- DNS-specific event types: `dns_record_changed`, `dns_record_missing`, `dns_resolution_failed`
- Timeouts treated as unknown (not drift) to prevent false positives

**ICMP Ping Monitoring**
- Native ICMP echo request monitoring via `ping://` URLs
- Multi-packet ICMP with configurable packet count (1–5, default 3) for reduced false alerts
- Round-trip time (RTT) and TTL (Time-To-Live) tracking per check
- Lightweight alternative for infrastructure and network device monitoring

**WebSocket Monitoring**
- Native `ws://` and `wss://` protocol support
- Full WebSocket endpoint health tracking

**TCP / UDP Socket Monitoring**
- Raw port-level reachability for databases, mail servers, or custom services
- Configurable timeouts and retry behavior

**Redirect Monitoring**
- Monitor HTTP redirects with expected target matching (exact or contains mode)
- Chain-following support for up to 10 redirect hops
- Captures every `Location` header along the chain for diagnostic display
- Wall-clock timeout applies to the full chain, not each hop

**Domain Monitoring (Standalone)**
- A dedicated `domain` check type that tracks domain-registration expiry with **no HTTP or uptime probing** — you enter a domain name, not a URL
- Backed by the same RDAP + WHOIS engine as Domain Intelligence, with the same advance-warning thresholds (30 / 14 / 7 / 1 days) and renewal detection
- Ideal for domains you own but don't host an endpoint for — parked domains, email-only domains, brand-protection portfolios
- Runs on a slow cadence (down to once per day) since registration data changes rarely
- Complements Domain Intelligence, which auto-attaches expiry tracking to your existing HTTP checks; the standalone type is for domains with nothing to ping
- Available on Nano, Pro, and Agency tiers

**VPS-Powered Check Execution**
- All checks run on dedicated VPS workers with static IPs for firewall allowlisting
- Two regions in production:
  - **Frankfurt, Germany (`vps-eu-1`)** — default for everyone
  - **Boston, USA (`vps-us-1`)** — opt-in for Pro / Agency on a per-check basis
- Continuous worker pool with 500ms dispatcher tick — no batch queuing, no head-of-line blocking
- Semaphore-limited concurrency for independent per-check execution, with a post-restart concurrency ramp to avoid overwhelming downstream resolvers
- High-concurrency execution with 128 UV threads for parallel DNS, TLS, and network operations
- Sub-minute check support (15-second intervals on Agency, 30-second on Pro) with adaptive timeouts capped at 70% of check interval (flat 30s budget for sub-minute checks)
- Graceful shutdown handling (SIGTERM/SIGINT) with deploy-mode baseline grace
- Legacy `us-central1` / `asia-southeast1` Cloud Functions schedulers have been retired — all execution now runs on the VPS pool

**CDN & Edge Detection**
- Automatic CDN provider identification (Cloudflare, Fastly, etc.) on every check
- Edge POP (Point of Presence) location tracking
- Edge ray ID capture for request tracing
- Displayed in log details alongside response metadata

**Smart Verification**
- Immediate re-check (30s) to confirm issues aren't transient
- Configurable consecutive failure threshold (1–99 attempts) before marking offline
- Default 3 consecutive failures across a 5-minute window prevents flapping
- **Multi-region peer confirmation** — before treating a check as down, the executing region can ask a peer region for a second opinion, so a local network blip in one POP doesn't fire a false alert. The originating and confirming regions are recorded on the log row, the feature has its own rate limit and circuit breaker so it degrades gracefully under load, and it can be disabled per-check (`peerConfirmDisabled`) for checks you want alerted on a single region's word. Heartbeat checks are excluded (there's no peer to re-probe).
- Hardened DNS resolution with c-ares resolver, retry with backoff, and local recursive DNS cache

### Live Page — Real-Time Probe Stream

A dedicated `/checks/:checkId` surface that turns every check into a live, scrolling instrument panel. The sidebar's **Live** entry opens `/live`, which redirects to the last check you viewed (or your first check). Probes flow from the Frankfurt and Boston VPS workers into the browser over region-specific WebSocket endpoints (`wss://live-eu.exit1.dev/ws`, `wss://live-us.exit1.dev/ws`) and paint on screen the moment they land — typically in well under a second from the wire, with no Firestore round-trip in the hot path.

The same WebSocket transport is now the **runtime source of truth for live check state** across the app — `status`, `lastChecked`, `nextCheckAt`, `responseTime`, `lastStatusCode`, `consecutiveFailures`/`Successes`, `lastError`, `disabled`, and `maintenanceMode` stream from the VPS as compact field deltas, with Firestore `onSnapshot` kept as a hot-swappable fallback. Firestore stays authoritative for configuration (name, URL, frequency, alert settings, folders).

**Real-Time Chart**
- Canvas-rendered scrolling line chart with smooth tweening as the live tip advances
- Particle/sparkle trail streams backward from the live tip while in real-time mode and quiets when you pan back in history
- 1h / 6h / 24h buffered windows with cadence-aware defaults — sub-60s checks ticker at 1-minute resolution; slower checks auto-scale to hold ~20 points
- **Drag-to-zoom** — Select any region of the chart to zoom in; double-click to progressively zoom out
- Brush navigator below the main chart shows the full buffer; drag to pan back while the buffer keeps filling live
- Y-axis tweens on new spikes so incidents enter the frame instead of jumping
- "Collecting history" diagonal-striped overlay marks portions of the visible window before the buffer warms up
- Maintenance and disabled-state segments render as inline bands on the timeline

**Tier-Classified Probes**
- Per-probe classification against the visible window's median: amber dots for **elevated** (≥2× median), red dots for **spike** (≥3× median)
- Markers and table-row tints always agree because both consume the same windowed-median computation

**Phase Breakdown**
- Toggle between **Total** and **Phases** view modes
- Phase view renders a stacked-area chart of DNS → Connect → TLS → TTFB on every probe (for HTTP/REST/redirect/API check types)
- Stage colors flow from the design-system tokens (`--stage-dns`, `--stage-connect`, `--stage-tls`, `--stage-ttfb`) so the chart, log details, and request-timing labels stay in sync

**Raw Probe Table**
- Newest-first table beside the chart with timestamp, status, response time, per-stage phase columns, status code, and relative time ("5s ago")
- New probes **flash green for 900ms** when they land
- State-segment events (maintenance start/end, disabled start/end) are interleaved into the table as inline rows with duration badges

**Bidirectional Probe Selection**
- Click any row in the table to highlight the corresponding point on the chart, and vice versa
- Click again to deselect — selection state is shared by both surfaces

**Export Raw Probe Data**
- Download visible-window or full-buffer probes as **CSV or JSON**
- Range presets from 5 minutes to 24 hours
- Exported payload includes per-stage phase timings, status codes, response times, and state-segment metadata

**Connection Resilience**
- Firebase ID token auth (Clerk → Firebase bridge — no new trust plane on the VPS); the socket prompts for a token refresh ~30s before expiry and closes cleanly if it can't re-auth
- Snapshot-on-auth — immediately after authenticating, the server pushes a full snapshot of the user's checks so the page is never empty while waiting for the next probe
- 5-minute server-side replay ring buffer — reconnects pass a `since` timestamp and receive any state transitions missed during the gap, filtered to the verified `uid` (per-check ring, capped to recent entries)
- Per-region multi-connect — the browser opens one WebSocket per region the user has checks in, capped at 10 concurrent connections; each region is independent and failure-isolated
- Connection indicator in the page header surfaces region state (`live` / `reconnecting` / `fallback`)
- Hysteresis fallback to Firestore `onSnapshot` on WebSocket outage with an 8s debounce to prevent flicker; a banner names the affected region only if degradation persists
- Staleness watchdog — if no frame arrives for ~75 seconds the client proactively closes and reconnects, catching half-open sockets (NAT timeouts, laptop sleep) that TCP would otherwise hide
- Compact wire format: `{t, rt, sc?, st, dn?, cn?, tl?, ft?}` — ~30 bytes per probe on the wire, ~100 bytes in heap
- ~25-second app-level keepalive (a JS-visible "still alive" tick) plus protocol-level ping/pong
- Backpressure-safe — the server drops a slow consumer's socket if its send buffer backs up, so one stalled client can't leak memory

**Streaming Protocol & History Backfill**
- A small, versioned message protocol kept byte-identical between the VPS and the browser by a build-time contract test — client sends `auth` / `subscribe_history`; server sends `snapshot`, `update`, `replay`, `history`, `state`, `keepalive`, and `error`
- On chart open the client sends `subscribe_history` for the requested window; the server replies with a `history` message containing backfilled probe points and state segments, then live probes append via the ongoing `update` stream
- The VPS keeps a **24-hour in-memory response-time buffer per check** (oldest points trimmed on append) that drives the backfill; it is persisted to disk as NDJSON and replayed on boot, so chart history survives clean deploys
- Maintenance/disabled windows arrive as `state` events (open, then close), deduplicated and merged client-side into the timeline bands

**Live Sidebar Entry**
- A dedicated **"Live"** entry (Radio icon) lives at the top of the app sidebar
- Remembers the last check opened via `exit1_last_check_id` and auto-navigates back to it on re-visit
- New users land on the first check in their list

**Tier Gating**
- Free tier sees a blurred preview with an upgrade overlay; available from Nano upward
- All paid tiers stream live with no rate-limit on the WebSocket transport

### SSL Certificate Management

- Automatic SSL validity checking for all HTTPS URLs
- Certificate expiration countdown (days until expiry)
- Issuer and subject information display
- Three-state classification — **ok** (healthy), **warning** (valid but ≤30 days to expiry), **error** (invalid or expired)
- Alerts for invalid, expired, or expiring certificates, independent of uptime status — a perfectly healthy check still warns when its certificate nears expiry
- No separate setup required — works automatically

**Durable Alert State Machine**
- SSL alerting is driven by a persistent `sslAlertedState` field that records the last state the user was actually notified about — not a transient previous-snapshot comparison
- A certificate is observed at four independent points (each live probe, steady-state no-change checks, the scheduled 6-hour security refresh, and manual refresh); every observation compares the freshly computed state against the durable record
- This guarantees an **ok → warning** crossing fires exactly once and can never be silently swallowed by whichever writer advances the certificate past the threshold first (the failure mode the design was built to close)
- Maintenance mode and the system health gate suppress *delivery* without advancing the state, so a missed warning is retried once normal operation resumes
- `ssl_warning` and `ssl_error` are throttled (warning windowed to once per week per check) so a long-lived expiring cert doesn't re-alert every cycle

### Domain Intelligence

Track domain registration expiration across all your monitored URLs:

- **Automatic Discovery** — Extracts domains from monitored URLs automatically
- **RDAP Protocol** — Modern, reliable domain lookup with WHOIS fallback for broader TLD coverage
- **Smart Frequency** — Checks increase as expiry approaches (monthly → daily → twice daily)
- **Configurable Alerts** — Default warnings at 30, 14, 7, and 1 day before expiration
- **Renewal Detection** — Confirms when domains are renewed
- **Unified Dashboard** — Color-coded status view of all domains
- Available on Nano, Pro, and Agency tiers

### Alerting & Notifications

**Multi-Channel Delivery**
- Email alerts with configurable recipients and per-check or per-folder overrides
- SMS alerts (Pro/Agency) with E.164 formatting and opt-out compliance
- **Webhooks** — generic HTTPS endpoints plus native Slack (Block Kit), Discord (embeds), Microsoft Teams (adaptive cards), and Pumble formatting
- **Integrations** — API-based services you connect with credentials instead of hosting an endpoint: Pushover, PagerDuty, and Opsgenie
- Plain-text email format option alongside rich HTML
- Per-check event filtering (customize which alerts fire for each endpoint)
- Latency breakdown and status codes included in alert notifications
- Notification timezone support for localized alert timestamps

**Reliability Engineering for Alerts**
- **System-Level Health Gate** — If ≥50 unique checks flip DOWN within a 3-minute window, all alerting is suppressed globally for 10 minutes to prevent mass false alerts during infrastructure-wide outages. Checks keep running so uptime data is preserved.
- **Deploy-Mode Baseline Grace** — Replaces the older fixed startup-grace + post-grace window. Each VPS restart establishes a baseline from current Firestore state and suppresses DOWN alerts until each check has been re-observed for stability. UP alerts fire immediately (asymmetric grace) so recoveries are never silenced.
- **Post-Deploy DNS Grace** — DNS-record drift alerts get an additional grace window after a deploy so resolver-cache warm-up doesn't surface false drift.
- **Deploy Mode (Admin Kill Switch)** — Global pause for all check execution and alerts during platform deployments. Configurable duration (default 30 min, max 120 min), auto-expires, full audit trail.
- **Webhook Circuit Breaker** — After 3 deliveries exhaust all 8 retry attempts, the webhook is marked as `permanent_failure` and the user is emailed. Prevents dead endpoints from consuming infinite retry capacity.
- **Per-Check Event Throttle** — Event-specific windows (1 min → 7 days depending on type) prevent alert storms from flapping checks.
- **Tier-Aware Scheduling** — The scheduler refuses to clamp Pro/Agency check intervals down to nano floors when user tier resolution is briefly stale, preventing accidental rate degradation.

**Alert Events**
- Website down / up / error
- SSL certificate error / warning
- Domain expiring / expired / renewed
- DNS record changed / missing / resolution failed
- Heartbeat missed
- Webhook permanent failure

### Maintenance Mode

Schedule planned maintenance windows to suppress alerts (Nano, Pro, Agency):

- **Instant Toggle** — One-click enable/disable maintenance mode for immediate use
- **One-Time Scheduled** — Set a start time and duration for a specific maintenance window
- **Recurring** — Configure weekly recurring windows by day-of-week, start time, and duration
- Cancel scheduled or delete recurring windows at any time
- Automatically activates and deactivates based on schedule
- All alerts (email, SMS, webhooks) are suppressed during maintenance
- Checks continue running to preserve uptime data continuity

### Organization & Management

**Check Folders**
- Organize checks into hierarchical folders
- Six built-in folder accent colors (blue, emerald, amber, rose, violet, slate) backed by theme tokens — picker uses static helpers so the swatch column matches the row indicator exactly
- Bulk operations on folder contents
- Folder-based status page inclusion
- Inherited alert settings (folder-level overrides flow to checks)

**Check Views**
- **List view** — default tabular layout with sort, drag-to-reorder, and bulk actions
- **Folder view** — grouped tile layout (CheckTile component) showing folder color, status counts, and tap-to-expand on mobile
- **Map view** — geo-distributed health visualization placing each check at its target's IP geolocation, color-coded by current status

**Bulk Operations**
- CSV / URL-list import for adding many checks at once — imports run in small client-side batches so the progress bar advances in real time instead of freezing while the backend works, and pasted content is auto-detected as CSV even on the plain-URL tab
- Multi-select with **shift-click range selection**
- **Bulk move to folder** across selections
- Bulk enable/disable/delete actions
- Bulk edit check settings: frequency, recheck behavior, down confirmation attempts, expected status codes, timezone, domain alert thresholds
- Drag-and-drop check reordering within tables
- Streamlined management for large deployments

**Global Search (Cmd/Ctrl + K)**
- Command-palette-style global search across the app
- Search categories: recent views, actions, pages, checks, docs
- Keyboard-first navigation (↑/↓, Enter, Esc)
- Recents history with one-click clear
- Jumps directly to check detail, admin actions, pages, and documentation

**Feedback Widget**
- In-app feedback button anchored to the top bar — sends product feedback directly to the team without leaving the app
- Keyboard-discoverable via the global search Kbd indicator

**Founders Upgrade Flow**
- Dedicated upgrade surface for legacy Founders Nano subscribers (`/founders-upgrade`) explaining their grandfathered Pro entitlements and the path to Agency
- `FoundersOfferBanner` surfaces the offer contextually in the sidebar/usage widget

### Status Pages

Share uptime status with customers and stakeholders:

- Public or private visibility options
- Custom domain support with SSL (Agency tier)
- Branding customization (logo, favicon, colors)
- Optional "Powered by exit1.dev" footer (removable on Nano/Pro/Agency)
- Folder-based dynamic check inclusion
- **Drag-and-drop layout editor** — Customize widget placement and sizing on a 12-column grid
- Multiple widget types: timeline, text, uptime, incidents, downtime, map, status
- 90-day heartbeat calendar (online / offline / unknown per day)
- Real-time updates — no manual maintenance
- Per-tier status-page limits: 1 (Free), 5 (Nano), 25 (Pro), 50 (Agency)

### Public Uptime Monitors

A separate, marketing-facing surface from user Status Pages: a curated directory of public uptime landing pages served at `exit1.dev/status/<slug>` for the open internet — no login, no workspace.

**How it works**
- An admin flags a check with the `public` field (and an optional `publicSlug`); the field is admin-only at the Firestore-rules layer, so it can't be set from the normal app
- An hourly cron (`refreshPublicMonitors`) scans every public-flagged check and rebuilds a lightweight index plus per-check detail documents from BigQuery pre-aggregated daily summaries
- Two unauthenticated, CDN-cached HTTP endpoints serve the data (10-minute client cache, 1-hour edge cache, stale-while-revalidate):
  - `GET /v1/public/monitors` — the directory: every public check with metadata and a **`daysWithData`** maturity signal
  - `GET /v1/public/monitor?slug=<slug>` — one check's detail: 7 / 30 / 90-day uptime, average response time, last-checked timestamp, and a 90-day heartbeat calendar
- The marketing site consumes these via ISR and renders SEO-friendly status pages

**`daysWithData` maturity signal**
- Counts how many of the last 90 days have at least one recorded check
- The marketing site uses it to keep thin, freshly-added pages out of the sitemap and search index until they've accumulated enough history to be worth ranking

**Eligibility & data exposed**
- Only checks with real uptime data are eligible — standalone `domain` checks (expiry-only, no probing) are filtered out
- Exposes status, uptime percentages, response time, and the heartbeat calendar; never private configuration or alert settings
- Admins can bulk-flag an account's checks with the `flag-public-checks.mjs` script, which resolves collision-free slugs automatically (explicit slug → hostname → suffix)

### Status Badges

Embed real-time monitoring badges on your website, README, or documentation:

- **Three badge types**: Status (up/down), Uptime (30-day percentage), Response Time (average ms)
- **Three embed formats**: JavaScript (auto-injecting script tag), HTML (img tag), Markdown
- Exit1 branding footer included by default; removable on paid tiers
- 5-minute CDN caching for fast global delivery
- Rate limited (60 requests/min per IP)
- Uses check display names as badge labels
- **Badge analytics** (admin-visible) — BigQuery-tracked views with referrer, user-agent, and embed-format breakdown

### Analytics & Reporting

**Real-Time Dashboard**
- Live status updates without page refresh
- 24-hour performance charts
- Per-stage timing metrics: DNS resolution, TCP connect, TLS handshake, TTFB
- Response time trends and patterns
- CDN provider, edge POP, and ray ID in log details
- Map view for geo-distributed health visualization

**Historical Analysis**
- Timeline view of uptime/downtime periods
- Incident tracking and notes
- BigQuery-powered log storage for long-term analytics
- Multi-range statistics (1h, 6h, 1d, 7d, 30d, 60d, 90d)
- 90-day heartbeat view with pre-aggregated daily summaries
- Exportable reports for compliance and review
- **CSV Export** of check history (Pro/Agency)

**Reports (SLA Metrics)**
- Uptime % (per check or across all checks)
- Incidents count and window list
- Total downtime minutes
- MTBI (Mean Time Between Incidents)
- Average response time with distribution buckets
- Time ranges: 1h, 24h, 7d, 30d, 60d, custom calendar
- Recharts-based bar and line visualizations
- Dedicated SLA reporting surface on Agency tier

**Log Annotations**
- **Log notes** — Attach comments (max 2000 chars) to any historical check result
- **Manual logs** — Document incidents, deployments, or maintenance events directly on a check's timeline with custom status and timestamp

**Failure Classification & Alert Audit**

The logs make the alerting layer's decisions legible, so you can always see *why* you were — or weren't — notified:

- **Transient vs confirmed failures** — A single offline probe held below your down-confirmation threshold is tagged **transient** (amber) and the check stays online; a failure that reaches the threshold is **confirmed** (red). Flapping is visible at a glance instead of looking like an outage.
- **Alert sent / suppressed** — Each transition row shows whether an alert was actually delivered (bell) or attempted-but-suppressed (muted bell). Suppression reasons include the event throttle window, an exhausted email/SMS budget, active maintenance mode, active deploy mode, or per-check event filtering.
- **Peer-consulted marker** — When a multi-region check consults its peer region before deciding, the row links to the peer's status and reachability for that probe.
- Transient and peer-audit rows are written even when no alert fires, so the timeline is a complete diagnostic record rather than an alerts-only view.

### Developer & Integration Features

**Public API** (Pro/Agency)
- Programmatic access to monitoring data
- API key authentication with read/write scopes
- CRUD operations: create, read, update, and delete checks
- Regenerate heartbeat tokens programmatically
- Build custom integrations and dashboards
- Rate limiting (global and per-key)

**MCP Server (AI Assistant Integration)**
- Query monitoring data from any MCP-compatible AI assistant
- Published as `exit1-mcp` on npm — works with Claude Code, Claude Desktop, Cursor, VS Code Copilot, Windsurf, Codex CLI, Gemini, Goose, ChatGPT, and more
- Five read-only tools: `list_checks`, `get_check`, `get_check_history`, `get_check_stats`, `get_status_page`
- Access follows your API access tier (Pro/Agency with an API key, `checks:read` scope) — MCP is not a separate add-on, it's implied by having API access
- **In-app setup page** (`/mcp`, "MCP" sidebar entry, Bot icon) — copy-paste configuration snippets for each client (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI, ChatGPT), a one-click "Create API key" hand-off that lands on the key form pre-armed to create a read key, the tool reference, and example prompts ("Are any of my monitors down right now?")

**Webhooks & Integrations**

The dashboard splits notification channels into two surfaces that share one delivery engine, retry queue, and circuit breaker:

*Webhooks* — send to any endpoint you own or control:
- Generic HTTPS webhook with custom headers
- Native presets with provider-correct payload formatting:
  - **Slack** (Block Kit)
  - **Discord** (rich embeds)
  - **Microsoft Teams** (adaptive cards)
  - **Pumble** (incoming webhook format)

*Integrations* — connect an API-based service with credentials, no endpoint to host:
- **Pushover** — mobile push with five priority levels (-2 Lowest → 2 Emergency), emergency-mode retry/expiry, time-to-live auto-delete, custom sounds, and per-device targeting (see below)
- **PagerDuty** (Events API v2 — auto trigger / resolve from up/down events)
- **Opsgenie** (alert API — auto create / close)

**Shared delivery features (all channels):**
- Per-check and per-folder event filtering
- Delivery status tracking with automatic retries (exponential backoff, 8 attempts, 48-hour TTL)
- Circuit breaker prevents wasted retries on dead endpoints
- Latency breakdown and status codes included in payloads

**Pushover Priority Levels**
- **-2 (Lowest)** — badge only, no sound or vibration
- **-1 (Low)** — quiet, respects quiet hours
- **0 (Normal)** — default device behavior
- **1 (High)** — always alerts, bypasses quiet hours
- **2 (Emergency)** — repeats until acknowledged; requires a retry interval and an expiry time
- Critical events (outages, errors, SSL/domain/DNS failures) are raised to at least High; non-critical events (recoveries, warnings) are capped at High so successful re-checks can't trigger an Emergency storm

**Public Marketing Stats**
- `/v1/stats/checks` returns lifetime total checks performed, timestamp (UTC midnight), and current rate per second
- Powers the live counter on the marketing site
- Monotonic — clamped to max-ever to stay stable through admin data purges

### Onboarding

A guided five-step onboarding flow helps new users set up their first check and tells us who you are so we can help:

1. **Source** — where you heard about us (Google, Reddit, AI assistant, Twitter, Product Hunt, Hacker News, friend, blog, other)
2. **Use case** — what you'll monitor (infrastructure/APIs, e-commerce, customer sites, SaaS, personal, agency, other)
3. **Team size** — solo, 2–5, 6–20, 21–100, 100+
4. **First check** — URL input with **inline check-run** so you see a green result before finishing onboarding; skippable with dynamic logic
5. **Plan selection** — compare Free, Nano, Pro, and Agency side-by-side

**Persistence**
- Completion state stored server-side (Firestore) so it syncs across devices
- Per-user localStorage cache key prevents cross-account leakage
- URL prefill (`PREFILL_WEBSITE_URL_KEY`) from marketing site
- Answers and plan tier mirrored to Resend as contact custom properties (17 total) for segmented email campaigns

---

## Pricing

Exit1.dev has four tiers. All tiers run on the same VPS-powered execution engine — you're paying for capacity, speed, and advanced features, not a different product.

### Free Plan

Get started with monitoring at no cost:

- Up to **10** monitors
- **5-minute** check intervals
- **60-day** data retention
- **1** status page (with exit1 branding)
- **1** webhook endpoint
- **10** emails/hour · **10**/month
- Email alerts only (no SMS)
- SSL certificate monitoring
- Heartbeat, HTTP, TCP, UDP, ICMP, WebSocket, redirect monitoring (no DNS)
- Status badges (with exit1 branding)
- Public status pages (timeline view + basic widgets)
- Global search, log notes, manual logs

### Nano Plan

For small teams and side projects that need faster detection:

- Up to **50** monitors
- **2-minute** check intervals
- **60-day** data retention
- **5** status pages with layout builder, removable "Powered by" footer
- **5** webhook endpoints
- **50** emails/hour · **1,000**/month
- **Domain Intelligence** (automatic domain expiration tracking)
- **DNS record monitoring** (5-minute minimum interval)
- **Maintenance mode** (instant toggle, one-time scheduled, and recurring windows)
- Status badges with removable branding
- Timeline view, all widget types

### Pro Plan

For growing teams and production infrastructure:

- Up to **500** monitors
- **30-second** check intervals
- **365-day** data retention
- **25** status pages
- **25** webhook endpoints
- **10** API keys + full Public API access
- **MCP server access** for AI assistants
- **500** emails/hour · **10,000**/month
- **SMS alerts** (25/hour · 50/month)
- **DNS record monitoring** at 1-minute intervals
- **CSV export** of check history
- All alert channels, all widget types, all Nano features

### Agency Plan

For agencies, multi-team orgs, and latency-sensitive production:

- Up to **1,000** monitors
- **15-second** check intervals (the fastest tier)
- **3-year (1,095 days)** data retention
- **50** status pages
- **50** webhook endpoints
- **25** API keys + full Public API access + MCP server
- **1,000** emails/hour · **50,000**/month
- **SMS alerts** (50/hour · 100/month)
- **Custom status domains** with SSL
- **SLA reporting** surface
- **Team seats** (10)
- All Pro features

### Legacy & Founders

- **Founders Nano** — original lifetime-deal subscribers on the legacy `nano` plan are grandfathered onto **Pro entitlements**, identified as `isFounders` in the app
- **Scale (legacy)** — former Scale subscribers are mapped to **Agency** with full Agency entitlements
- **Starter (legacy)** — mapped to **Nano**

Downgrade enforcement is automatic: when a user drops to a lower tier, excess checks/webhooks/API keys/status pages are disabled (oldest first), intervals clamped, tier-gated features turned off, and SMS recipients cleared if needed.

---

## Target Audience

**Primary Users**
- **SaaS Companies** — Reliable monitoring for customer-facing services
- **DevOps Teams** — Managing services across multiple regions
- **Startups & SMBs** — Affordable monitoring without complexity
- **Web Agencies** — Monitoring client websites and APIs (Agency tier)
- **eCommerce** — Revenue-critical availability tracking
- **Data & Platform Teams** — Cron jobs, ETL pipelines, and background worker monitoring via heartbeats

**Use Cases**
- Website uptime monitoring
- REST API health validation
- Cron job / background worker heartbeats
- DNS record change detection and tamper alerting
- ICMP ping for network devices and infrastructure
- Microservices endpoint tracking
- SSL certificate management
- Domain portfolio protection
- Customer-facing status pages with custom domains
- Scheduled maintenance window management
- Embedding status badges in READMEs and dashboards
- AI-assisted incident investigation via MCP
- SLA reporting and audit trails (Agency)

---

## What Makes Exit1.dev Different

### Nine Check Types, One Engine

HTTP/HTTPS, heartbeats, DNS records, ICMP ping, TCP/UDP sockets, WebSocket, redirects, and standalone domain-expiry monitors — monitor every layer of your stack in one place, all running on the same low-latency VPS worker.

### Push-Based Heartbeats

Most uptime tools only pull. Heartbeats let you catch silent failures in cron jobs, workers, data pipelines, and any service without a public endpoint — without configuring inbound firewall rules.

### DNS Record Monitoring with Baseline

Not just "does DNS resolve." Exit1 compares every record to a user-accepted baseline, catching drift, tampering, and unintended record changes with per-change diffs.

### Integrated Domain Intelligence

Unlike bolt-on domain monitoring tools, Exit1.dev automatically extracts and monitors domains from your existing checks. No duplicate configuration, no separate tool.

### True API Monitoring

Go beyond simple ping checks with full HTTP method support, custom payloads, multi-hop redirect following, and response validation using JSONPath expressions and text matching.

### Smart Alert Verification

Immediate re-checks, 3-consecutive-failure confirmation, and event-specific throttle windows dramatically reduce false positives while maintaining fast detection.

### Alert Reliability Engineering

A system-level health gate prevents alert storms during infrastructure outages. A 5-minute startup grace period silences false alarms after deploys. A webhook circuit breaker stops wasted retries on dead endpoints. An admin deploy-mode kill switch pauses the whole platform during maintenance.

### Sub-Minute Detection

A continuous VPS worker pool with 15-second check intervals (Agency) means faster detection than any traditional scheduler. Combined with Firebase real-time listeners, the dashboard updates instantly when status changes.

### Real-Time Live Page

Most uptime tools surface live data through 30-second polls or 60-second auto-refreshes. The Exit1 Live page streams probes from the VPS pool over a dedicated WebSocket transport — canvas-rendered scrolling chart, drag-to-zoom, bidirectional probe-to-row selection, per-stage phase breakdown (DNS / Connect / TLS / TTFB), tier-classified spike markers, particle-trail live tip, and CSV/JSON probe export. The transport authenticates with Firebase ID tokens, replays missed transitions on reconnect from a 5-minute ring buffer, and falls back to Firestore `onSnapshot` if the socket drops so the UI never errors.

### Multi-Region Execution

Two production VPS regions — Frankfurt (`vps-eu-1`, default) and Boston (`vps-us-1`, opt-in for Pro / Agency on a per-check basis). Each region has a static IP for firewall allowlisting and a hardened DNS stack (c-ares + local Unbound cache).

### Transparent Status Pages

Built-in status pages with drag-and-drop layout editor, seven widget types, and custom domain support on Agency. No need to pay for a separate status page service — it's included and fully integrated.

### Developer-First Design

Public API with read/write scopes, webhook integrations, MCP server for AI assistants, embeddable status badges, global command palette, CSV export, log annotations, TypeScript throughout. Built by developers, for developers.

### AI-Ready Monitoring

The MCP server (`exit1-mcp`) lets AI assistants query your monitoring data directly. Ask Claude, Copilot, or any MCP client about outages, compare response times, and investigate incidents without switching context. A dedicated in-app `/mcp` page provides copy-paste setup for every major client and a one-click API-key hand-off. The product surfaces also explicitly allow AI crawlers (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, and their search/user agents) in `robots.txt`, so AI tools can discover and cite exit1 freely.

---

## Technology

Exit1.dev is built on a modern, scalable stack:

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS 4, shadcn/ui, Lucide icons
- **Backend**: Firebase Cloud Functions Gen2 (API layer), dedicated VPS pool (check execution)
- **Database**: Cloud Firestore (real-time), BigQuery (analytics, badge analytics, daily summaries)
- **DNS**: Unbound (local recursive cache), c-ares (resolver)
- **Authentication**: Clerk (SSO, organizations, billing)
- **Billing**: Clerk Billing (checkout, subscription, invoice history)
- **Notifications**: Resend (email + contact sync + audience segmentation), Twilio (SMS), Svix (webhooks)
- **Analytics**: Microsoft Clarity (session analytics)
- **AI Integration**: MCP server (`exit1-mcp` on npm)

---

## Design System

The app is **dark-only** and built around a single source of truth in [src/style.css](src/style.css). The full brand and visual rulebook lives in [DESIGN.md](DESIGN.md); this section is a quick reference.

### Theme tokens

Every color in the product flows through CSS custom properties on the `.dark` selector and is exposed to Tailwind via `@theme inline`. To re-skin the entire app, edit token values — components reference utilities like `bg-primary`, `bg-success`, `bg-tier-nano`, `bg-folder-blue`, `bg-stage-tls`, etc.

| Group | Tokens | Purpose |
|---|---|---|
| **Brand** | `--primary` / `--primary-foreground` / `--ring` | Muted teal-green (`oklch(0.585 0.102 167)` ≈ `#3F9081`). CTAs, focus rings, links, scrollbars. Replaces the prior Sky Blue. |
| **Surfaces** | `--background` (`#15151B`), `--popover`, `--card`, `--secondary`, `--muted`, `--accent`, `--border` | Layered elevation around the canvas — recessed wells (popover), canvas, elevated panels (card/secondary/sidebar), subtle wells (muted). |
| **Status** | `--success`, `--warning`, `--destructive`, `--info` | Reserved for status; never decorative. |
| **Tier accents** | `--tier-nano` (violet), `--tier-pro` (amber), `--tier-agency` (teal-green) | Subscription badges, founders glow. |
| **Folder colors** | `--folder-blue`, `-emerald`, `-amber`, `-rose`, `-violet`, `-slate` | User-assigned folder accents. |
| **HTTP timing stages** | `--stage-dns`, `-connect`, `-tls`, `-ttfb` | Logs page request-timing labels. |
| **Pixel-card variants** | `--pixel-{default\|blue\|yellow\|pink}-{1,2,3}` | Three-stop fills for empty-state pixel art. |
| **Aurora** | `--aurora-1..4`, `--aurora-glow`, `--aurora-ring-{outer,inner}` | Premium glow card hues (currently disabled by flat-mode). |
| **Single-consumer** | `--favicon-offline`, `--receipt-accent` | Public status page favicon dot, PDF receipt accent (overridable per-deployment via `config/receipt.json`). |
| **Charts** | `--chart-1..5` | Blue-leaning ramp for series. |

### Typography

- **Albert Sans** — all UI and body copy (weights 400/500/600/700)
- **DM Serif Display** — hero / display headlines only
- **System monospace** — code, IDs, request timing
- Global letter spacing is `-0.01em` (`--tracking-normal`); spacing scale is `0.26rem`; default radius is `0.5rem`. New components inherit these — don't hard-code.

### Surface elevation

Surfaces stack by lightness around the canvas; deltas are deliberate. Use `--shadow-sm/md/lg/xl/2xl` for depth. **Never** invent custom box-shadows or colored glows — the flat-mode override block at the bottom of `style.css` will silently kill them anyway.

### Flat-mode philosophy

The app ships with a hard-coded "flat-mode" override block that strips every gradient, glow, halo, ping ripple, `blur-2xl` decorative spot, and aurora overlay site-wide — even those embedded in third-party components. The product reads as a calm instrument-panel UI, not a glowing dashboard demo. Comment out the override block to enable the aurora/glow effects for marketing screenshots.

### Token-driven consumers

A few non-CSS surfaces also read from the token system so a single `style.css` edit propagates through:

- The **public status page favicon** inlines `--favicon-offline` to draw the offline dot.
- The **PDF receipt** consumes `--receipt-accent` (hex form) — overridable per deployment via `config/receipt.json` for white-label receipts without touching code.
- **Folder color helpers** (`src/lib/folder-color.ts`) return static Tailwind class names so picker swatches and folder rows stay perfectly in sync.

---

## Infrastructure & Cloud Functions

Exit1.dev runs on a hybrid architecture: a dedicated VPS handles check execution for near-real-time detection, while Firebase Cloud Functions power the API layer. Below is a comprehensive overview of the backend infrastructure.

### Health Check Execution

The core monitoring engine runs on a dedicated VPS with a continuous polling loop:

| Component | Location | Cycle | Purpose |
|-----------|----------|-------|---------|
| VPS Runner (EU) | Frankfurt, Germany (`vps-eu-1`) | 500ms dispatch | Default region; executes all health checks with continuous worker pool |
| VPS Runner (US) | Boston, USA (`vps-us-1`) | 500ms dispatch | Opt-in region for Pro / Agency on a per-check basis |

**Key capabilities:**
- Continuous worker pool with semaphore-limited concurrency (replaced batch scheduler)
- 500ms dispatcher tick — each check runs independently, no head-of-line blocking
- Post-restart concurrency ramp prevents downstream overload after a deploy
- Sub-minute check support (15-second on Agency, 30-second on Pro), with a flat 30s timeout budget for sub-minute checks
- 128 UV threads for high-concurrency DNS, TLS, and network operations
- Real-time status buffering for efficient Firestore writes
- HTTP/HTTPS, heartbeat, DNS, ICMP, TCP, UDP, WebSocket, redirect, and standalone domain check types
- Real-time live streaming — broadcasts every probe to subscribed browsers over the regional WebSocket server, and serves the per-check 24-hour chart buffer
- SSL certificate validation on every HTTP check
- TCP light-checks alternate with full HTTP for eligible endpoints
- Security metadata collection (IP geolocation, ASN, ISP)
- System-level health gate, alert throttling, and budget enforcement
- Multi-region peer confirmation endpoint (`/api/peer-confirm`) with its own rate limit and circuit breaker
- Hardened DNS with c-ares resolver, local Unbound cache, retry with backoff
- Graceful shutdown on SIGTERM/SIGINT with deploy-mode baseline grace
- Maintenance mode and deploy mode awareness
- **Liveness watchdog** — detects a wedged dispatcher (process up but executing nothing, e.g. a stuck Firestore connection): if no check completes for ~5 minutes while >50 checks are queued (outside deploy mode and the boot-grace window) it exits non-zero so PM2 restarts it, skipping the graceful drain that would deadlock on the stuck I/O
- **Heartbeat-defer mode** — batches no-change "still up" writes into a buffer that flushes every ~5 minutes to cut Firestore writes, while real transitions (status / disabled / maintenance / error changes) still write immediately; toggleable at runtime

### Check Management Functions

| Function | Type | Description |
|----------|------|-------------|
| `addCheck` | Callable | Create new check (HTTP, heartbeat, DNS, ICMP, TCP, UDP, WebSocket, redirect) with URL validation, rate limiting (10/min, 100/hour, 500/day), and automatic region assignment |
| `bulkAddChecks` | Callable | Import multiple checks at once via CSV or batch input (supports redirect validation import) |
| `getChecks` | Callable | Retrieve all checks with pagination and folder filtering |
| `updateCheck` | Callable | Modify check configuration (URL, frequency, headers, validation rules, DNS record types, heartbeat interval) |
| `deleteWebsite` | Callable | Permanently delete check and all associated data |
| `toggleCheckStatus` | Callable | Enable/disable check execution |
| `manualCheck` | Callable | Trigger immediate on-demand check (routed through VPS for static IP) |
| `updateCheckRegions` | Callable | Reassign checks to different execution regions |

### SSL & Security Functions

| Function | Type | Schedule | Description |
|----------|------|----------|-------------|
| `refreshSecurityMetadata` | Scheduled | Every 6 hours | Batch refresh SSL certificates and security metadata for all active checks |
| `refreshTargetMetadata` | Scheduled | Periodic | Refresh DNS resolution, IP geolocation, ASN, and ISP data for all checks |
| `refreshCheckMetadata` | Callable | — | Manual refresh of a single check's metadata |

**Capabilities:**
- SSL certificate expiration validation
- Certificate trust chain verification
- Issuer/subject extraction
- Parallel processing (20 concurrent checks)
- Batch updates (400 docs per batch)

### Domain Intelligence Functions

| Function | Type | Description |
|----------|------|-------------|
| `checkDomainExpiry` | Scheduled (6h) | Monitor domain registration expiration via RDAP protocol |
| `enableDomainExpiry` | Callable | Enable domain monitoring for a check (Nano/Pro/Agency) |
| `disableDomainExpiry` | Callable | Disable domain monitoring |
| `updateDomainExpiry` | Callable | Update alert thresholds and settings |
| `refreshDomainExpiry` | Callable | Manual domain refresh (rate limited: 50/day) |
| `bulkEnableDomainExpiry` | Callable | Enable for multiple checks at once |
| `getDomainIntelligence` | Callable | Retrieve domain data for all enabled checks |

**RDAP Features:**
- Modern RDAP protocol with WHOIS fallback for broader TLD coverage
- Multi-level caching (in-memory, Firestore, IANA bootstrap)
- Smart frequency scaling as expiry approaches
- Alert thresholds: 30, 14, 7, 1 days before expiration
- Renewal detection and confirmation

### Email Alert Functions

| Function | Type | Description |
|----------|------|-------------|
| `saveEmailSettings` | Callable | Configure global email recipients and events |
| `updateEmailPerCheck` | Callable | Set per-check email overrides |
| `updateEmailPerFolder` | Callable | Set per-folder email overrides |
| `bulkUpdateEmailPerCheck` | Callable | Update email settings for multiple checks |
| `getEmailSettings` | Callable | Retrieve current email configuration |
| `getEmailUsage` | Callable | Check email quota usage (hourly/monthly) |
| `sendTestEmail` | Callable | Send test email to verify delivery |

**Per-Tier Email Quotas:**
- Free: 10/hour · 10/month
- Nano: 50/hour · 1,000/month
- Pro: 500/hour · 10,000/month
- Agency: 1,000/hour · 50,000/month
- Notification limit email sent when quota is reached; monitors keep running

### SMS Alert Functions

| Function | Type | Description |
|----------|------|-------------|
| `saveSmsSettings` | Callable | Configure SMS recipients (E.164 format) |
| `updateSmsPerCheck` | Callable | Set per-check SMS overrides |
| `bulkUpdateSmsPerCheck` | Callable | Update SMS settings for multiple checks |
| `getSmsSettings` | Callable | Retrieve SMS configuration |
| `getSmsUsage` | Callable | Check SMS quota (Twilio-based) |
| `sendTestSms` | Callable | Send test SMS |

**Per-Tier SMS Quotas:**
- Free & Nano: no SMS
- Pro: 25/hour · 50/month
- Agency: 50/hour · 100/month

### Webhook Functions

| Function | Type | Description |
|----------|------|-------------|
| `saveWebhookSettings` | Callable | Create webhook endpoint (per-tier limits: 1/5/25/50) |
| `updateWebhookSettings` | Callable | Modify webhook configuration |
| `deleteWebhook` | Callable | Remove webhook endpoint |
| `testWebhook` | Callable | Send test payload to verify delivery |
| `bulkDeleteWebhooks` | Callable | Delete multiple webhooks |
| `bulkUpdateWebhookStatus` | Callable | Enable/disable multiple webhooks |

**Delivery Features:**
- Exponential backoff retries (up to 8 attempts)
- 48-hour retry TTL
- Batch retry draining (25 retries per drain)
- Health tracking per endpoint
- Circuit breaker after 3 exhausted retry cycles → marks `permanent_failure` and emails the user

### History & Analytics Functions

| Function | Type | Description |
|----------|------|-------------|
| `getCheckHistoryBigQuery` | Callable | Query raw check history (rate limited: 60/user/min) |
| `getCheckStatsBigQuery` | Callable | Calculate uptime statistics |
| `getCheckStatsBatchBigQuery` | Callable | Fetch stats for multiple checks |
| `getCheckHistoryForStats` | Callable | Hourly aggregated history for trends |
| `getCheckHistoryDailySummary` | Callable | Daily summary snapshots |
| `getCheckReportMetrics` | Callable | SLA compliance metrics (uptime, incidents, MTBI, downtime, distribution) |
| `aggregateDailySummariesScheduled` | Scheduled (daily) | Pre-aggregate summaries for cost optimization |
| `purgeBigQueryHistory` | Scheduled (daily) | Delete data older than retention period |
| `exportChecksCsv` | Callable (Pro+) | Export check history to CSV |

### Log Annotation Functions

| Function | Type | Description |
|----------|------|-------------|
| `getLogNotes` | Callable | Retrieve annotations on check logs |
| `addLogNote` | Callable | Add annotation (max 2000 chars) |
| `updateLogNote` | Callable | Edit existing note |
| `deleteLogNote` | Callable | Remove note |
| `getManualLogs` | Callable | Retrieve manual log entries |
| `addManualLog` | Callable | Create manual status record |

### Public API

| Function | Type | Description |
|----------|------|-------------|
| `publicApi` | HTTP | RESTful API for external integrations |

**Endpoints:**
- `GET /v1/checks` — List checks with pagination
- `GET /v1/checks/{id}/status` — Current status
- `GET /v1/checks/{id}/history` — Query history
- `GET /v1/checks/{id}/stats` — Uptime statistics
- `POST /v1/checks` — Create check (write scope)
- `PUT /v1/checks/{id}` — Update check (write scope)
- `DELETE /v1/checks/{id}` — Delete check (write scope)
- `POST /v1/public/checks/{id}/regenerate-token` — Rotate a heartbeat's ping token
- `POST <heartbeat-ping-url>` — Ingest a heartbeat ping (tokenized)

**Features:**
- API key authentication (SHA-256 hashed)
- Scope-based access control (read/write)
- Rate limiting (global and per-key)
- Response caching (10-minute TTL)
- Pro/Agency only

### Public Marketing Stats

| Function | Type | Description |
|----------|------|-------------|
| `getPublicChecksStats` | HTTP | `/v1/stats/checks` — lifetime total checks performed, UTC-midnight anchor, current rate/sec |
| `refreshPublicChecksStats` | Scheduled | Rebuild cached counter from BigQuery daily summaries |

### Public Monitor Functions

| Function | Type | Schedule | Description |
|----------|------|----------|-------------|
| `refreshPublicMonitors` | Scheduled | Hourly | Scan all admin-flagged `public` checks, compute uptime stats from BigQuery daily summaries, and rebuild the Firestore index + per-check detail docs that power `exit1.dev/status` |
| `getPublicMonitors` | HTTP (public) | — | `/v1/public/monitors` — directory of public monitors with metadata and the `daysWithData` maturity signal (10-min client / 1-hr CDN cache) |
| `getPublicMonitor` | HTTP (public) | — | `/v1/public/monitor?slug=…` — one monitor's detail: 7/30/90-day uptime, response time, last-checked, 90-day heartbeat |

### Status Page Functions

| Function | Type | Description |
|----------|------|-------------|
| `getStatusPageUptime` | Callable | Retrieve uptime stats for status page |
| `getStatusPageSnapshot` | Callable | Real-time status snapshot (5-min cache) |
| `getStatusPageHeartbeat` | Callable | 90-day heartbeat history |

### API Key Management

| Function | Type | Description |
|----------|------|-------------|
| `createApiKey` | Callable | Generate new API key (Pro: up to 10, Agency: up to 25) |
| `listApiKeys` | Callable | List all keys (hashed values only) |
| `revokeApiKey` | Callable | Disable key without deleting |
| `deleteApiKey` | Callable | Permanently delete key |

### Badge Functions

| Function | Type | Description |
|----------|------|-------------|
| `badge` | HTTP (public) | Generate real-time SVG badges (status, uptime, response time) with CDN caching and 60 req/min per-IP limit |

### User & Organization Functions

| Function | Type | Description |
|----------|------|-------------|
| `deleteUserAccount` | Callable | Delete account and all associated data |
| `getAllUsers` | Callable | List all users (admin only) |
| `deleteUser` | Callable | Admin delete user |
| `bulkDeleteUsers` | Callable | Admin bulk delete (streaming-buffer-safe) |
| `updateOrganizationBillingProfile` | Callable | Update billing address and tax info |

### Onboarding Functions

| Function | Type | Description |
|----------|------|-------------|
| `submitOnboardingResponse` | Callable | Persist onboarding answers (source, use case, team size) to Firestore + BigQuery |
| `getOnboardingResponses` | Callable | Admin — fetch aggregated onboarding responses |
| `getOnboardingStatus` | Callable | Return whether the current user has completed onboarding (cross-device sync) |
| `deleteOnboardingResponses` | Callable | Admin — bulk delete onboarding rows (streaming-buffer-safe) |

### Authentication & Resend Sync

| Function | Type | Description |
|----------|------|-------------|
| `clerkWebhook` | HTTP | Receive Clerk auth webhooks (user lifecycle, plan changes, subscription events) |
| `syncClerkUsersToResend` | Callable | Sync users to Resend for email campaigns (dry-run supported) |
| `syncSegmentsToResend` | Callable | Sync users into Resend audiences by plan tier (Free / Nano / Pro / Agency) |
| `resyncResendProperties` | Callable | Backfill Resend custom properties (plan_tier, onboarding answers, source/use-case booleans, team_size) |

**Lifecycle automation events** — key user-lifecycle moments fire named events into Resend (`user.created`, `user.onboarding_completed`, `user.deleted`, `user.webhook_created`, `user.alert_connected`) so onboarding sequences and re-engagement automations can trigger off real product activity rather than time alone.

### Plan & Tier Management

| Function | Type | Description |
|----------|------|-------------|
| `syncMyTier` | Callable | Force-refresh Firestore tier cache from Clerk subscription data (called by client on mismatch) |
| `enforcePlanDowngrade` | Callable | Handle downgrade: disable excess checks/webhooks/API keys/status pages, clamp intervals, turn off tier-gated features (SMS, DNS, custom domain, SLA reporting), backfill userTier |
| `recomputeAllTiers` | Callable (admin) | Resumable bulk recompute — scans all Clerk users, recalculates tier from active subscription, backfills denormalized userTier on every check. Supports dry-run and ~200 users per invocation |

### Notification Functions

| Function | Type | Description |
|----------|------|-------------|
| `createSystemNotification` | Callable | Platform-wide notification (admin) |
| `toggleSystemNotification` | Callable | Activate/deactivate (admin) |
| `deleteSystemNotification` | Callable | Remove notification (admin) |
| `createUserNotification` | Callable | User-specific in-app notification |
| `markNotificationAsRead` | Callable | Mark as read |
| `markAllNotificationsAsRead` | Callable | Bulk mark as read |
| `deleteUserNotification` | Callable | Delete notification |

### Admin Functions

| Function | Type | Description |
|----------|------|-------------|
| `getAdminStats` | Callable | Platform-wide statistics (12h cache) |
| `getBigQueryUsage` | Callable | Data warehouse cost estimates |
| `getBadgeAnalytics` | Callable | Badge view analytics (referrers, embed formats, per-check breakdowns) from BigQuery |
| `investigateCheck` | Callable | Deep troubleshooting — computes auto-disable conditions, surfaces 7-day history, failure trends, error patterns |
| `purgeFalseAlerts` | Callable | Bulk-delete false-alert BigQuery rows for VPS maintenance windows (dry-run supported) |
| `enableDeployMode` | Callable | Activate global check/alert kill switch |
| `disableDeployMode` | Callable | Deactivate deploy mode |

### System Status

| Function | Type | Description |
|----------|------|-------------|
| `getSystemStatus` | Callable | Platform health and recent errors |

### Maintenance Mode Functions

| Function | Type | Description |
|----------|------|-------------|
| `toggleMaintenanceMode` | Callable | Instant enable/disable maintenance mode for a check |
| `scheduleMaintenanceWindow` | Callable | Schedule a one-time maintenance window with start time and duration |
| `cancelScheduledMaintenance` | Callable | Cancel a pending scheduled maintenance window |
| `setRecurringMaintenance` | Callable | Configure recurring weekly maintenance by day-of-week, start time, and duration |
| `deleteRecurringMaintenance` | Callable | Remove a recurring maintenance schedule |

---

### Core Infrastructure Modules

**check-utils.ts** — Check execution engine
- HTTP/HTTPS request execution with adaptive timeout handling
- Heartbeat evaluation (compares `lastPingAt` to expected interval)
- DNS record queries with normalization and baseline comparison
- ICMP ping checks with multi-packet support, RTT, and TTL extraction
- TCP and UDP socket checks
- WebSocket (`ws://`, `wss://`) endpoint checks
- Redirect monitoring with expected target validation and multi-hop chain following
- TCP light-checks (fast port-only connectivity test)
- SSL certificate extraction
- Per-stage timing: DNS resolution, TCP connect, TLS handshake, TTFB
- CDN provider detection (Cloudflare, Fastly, etc.), edge POP location, and ray ID capture
- Response parsing and body snippet extraction
- Target metadata collection (IP, geolocation, ASN, ISP)

**target-metadata.ts** — Target metadata collection
- IP geolocation via external API (country, region, city, coordinates)
- ASN, ISP, and organization lookup
- CDN edge hints extraction (provider, POP, ray ID, response headers)
- DNS resolution via cached c-ares resolver

**badge-svg.ts** + **badge-analytics.ts** — Badge rendering & analytics
- SVG badge generation with three variants: status, uptime, response time
- Dynamic color coding based on check state
- Optional exit1 branding footer (removable on paid tiers)
- Unique gradient IDs for safe multi-badge embedding
- BigQuery analytics table (`checks.badge_views`) — day-partitioned, 90-day retention
- Async buffered writes (max 500 rows, 10s flush)

**alert.ts** — Alert delivery system (split into submodules)
- `alert-email.ts` — Email delivery via Resend with per-check/per-folder overrides, HTML and plain-text formats
- `alert-sms.ts` — SMS delivery via Twilio with E.164 formatting
- `alert-webhook.ts` — Webhook delivery with native Slack (Block Kit), Discord (embeds), and Teams (adaptive cards) formatting + circuit breaker
- `alert-domain.ts` — Domain expiry and SSL alerts across all channels
- `alert-dns.ts` — DNS change/missing/resolution-failure alerts
- `alert-throttle.ts` — Event-specific throttle windows (1min → 7days)
- `alert-helpers.ts` — Shared utilities, per-user email/SMS budgets, webhook retry queue, system health gate

**status-buffer.ts** — Efficient status updates
- In-memory buffer (500 doc max)
- Automatic flush on high watermark (200 docs)
- Idle timeout flush (25 seconds)
- Deduplication and failure backoff

**bigquery.ts** — Data warehouse integration
- Insert check history records (including DNS records field)
- Purge old records for cost control
- Batch processing with retry logic
- Daily summary pre-aggregation

**rdap-client.ts** + **whois-client.ts** — Domain lookup
- RDAP protocol client with multi-level caching and IANA bootstrap
- WHOIS fallback via raw TCP port 43 for 30+ gTLDs and ccTLDs
- Per-server throttle and result cache

**dns-cache.ts** — Resilient DNS resolution
- c-ares based resolver with in-memory cache
- Retry with progressive backoff on failure
- Query timeouts treated as unknown (not drift) to prevent false positives
- Designed for high-concurrency VPS workloads

**rate-limit.ts** — Rate limiting
- Fixed window rate limiter
- Per-user and per-endpoint limits
- Configurable windows and thresholds

**config.ts** — `TIER_LIMITS` source of truth
- Per-tier caps for maxChecks, minCheckInterval, maxWebhooks, maxApiKeys, email/SMS budgets, retentionDays, maxStatusPages
- Per-tier feature flags (statusPageBuilder, domainIntel, maintenanceMode, smsAlerts, apiAccess, csvExport, teamSeats, slaReporting, customStatusDomain, allAlertChannels)
- Helper functions return per-tier values (`getMaxChecksForTier`, `getMinCheckIntervalMinutesForTier`, etc.)

**init.ts** — Tier resolution
- `PLAN_KEY_TO_TIER` maps Clerk plan slugs to internal tiers (including legacy `scale` → `agency` and Founders `nano` → `pro`)
- 2-hour Firestore cache with live fallback and Clerk prod/dev dual-instance support
- Admin metadata → `agency` tier; legacy `lifetimeNano` metadata → `pro`
- `getUserTierLive()`, `getUserPlanInfo()`, `syncMyTier()` expose tier state to call sites

---

### Architectural Patterns

1. **Continuous Worker Pool** — Dedicated VPS with semaphore-limited worker pool and 500ms dispatcher tick eliminates cold starts and head-of-line blocking for sub-minute checks
2. **Nine Check Types, One Engine** — HTTP, heartbeat, DNS, ICMP, TCP, UDP, WebSocket, redirect, and standalone domain checks share a single execution path and dispatcher
3. **Push + Pull Monitoring** — Heartbeats complement pulled checks to catch silent failures in cron/worker systems
4. **DNS Baseline Comparison** — User-accepted baseline per record type with FIFO change history and auto-accept stabilization
5. **TCP Light-Checks** — Alternating fast port-only checks with full HTTP checks reduces overhead for eligible endpoints
6. **Status Buffering** — In-memory batching reduces Firestore writes by ~50%
7. **Multi-Layer Alert Reliability** — Per-check event throttle, webhook circuit breaker, system-level health gate, deploy-mode baseline grace (asymmetric: UP fires immediately, DOWN waits for re-observation), post-deploy DNS grace, and admin deploy-mode kill switch
8. **Multi-Layer Rate Limiting** — Per-user, per-endpoint, and per-IP protection
9. **Multi-Level Caching** — In-memory, Firestore, and HTTP response caching
10. **Hardened DNS** — c-ares resolver with local Unbound cache, retry with backoff, timeout-as-unknown semantics
11. **Graceful Degradation** — Non-blocking metadata collection, best-effort geo lookups
12. **Exponential Backoff** — Webhook delivery and failed operation retries
13. **BigQuery Optimization** — Pre-aggregated daily summaries reduce query costs; monotonic public counter survives purges
14. **Tier-Based Features** — Four-tier system (Free/Nano/Pro/Agency) with `TIER_LIMITS` source of truth, legacy plan mapping, and automatic downgrade enforcement
15. **Denormalized Tier on Checks** — `userTier` backfilled onto every check so the VPS runner can enforce interval floors without a user lookup
16. **Maintenance & Deploy Modes** — Instant toggle, scheduled, and recurring alert suppression plus admin kill switch for safe deployments
17. **CDN-Cached Badges** — SVG badges served with 5-minute CDN cache and in-memory Firestore/BigQuery caching; BigQuery-tracked analytics
18. **Per-Stage Timing** — DNS, connect, TLS, and TTFB breakdown captured on every check for latency diagnostics
19. **Cross-Device Onboarding** — Server-side completion state with per-user localStorage cache key; answers mirrored to Resend as contact properties
20. **Admin Data Safety** — Streaming-buffer-safe bulk deletes and resumable tier recompute make ops-scale changes safe against Firestore's write limits
21. **VPS-Primary Live State over WebSocket** — Live check fields stream from the VPS to the browser as compact field deltas over a versioned, contract-tested protocol; Firestore `onSnapshot` is kept as a hot-swappable fallback so the UI never errors on a dropped socket
22. **Durable SSL Alert State Machine** — A persistent `sslAlertedState` (not a transient snapshot) makes ok→warning crossings idempotent and impossible to silently miss across the four concurrent certificate-observation sites
23. **Multi-Region Peer Confirmation** — A failing region asks a peer region for a second opinion before alerting, with its own rate limit and circuit breaker, and a per-check opt-out
24. **Liveness Watchdog** — Detects a dispatcher that's running but not executing (wedged I/O) and force-restarts via PM2, skipping the graceful drain that would deadlock
25. **Heartbeat-Defer Batching** — No-change "still up" writes are buffered and flushed on a slow cadence to cut Firestore writes, while real transitions write immediately
26. **Curated Public Monitors** — Admin-flagged checks are pre-aggregated by an hourly cron into CDN-cached public endpoints with a `daysWithData` maturity signal that gates thin pages out of search until they have history

---

## Live Architecture — Shipped & Roadmap

The live data plane between the VPS and the browser was reworked in two phased, reversible plans. The core of both has **shipped** and is documented above under [Live Page — Real-Time Probe Stream](#live-page--real-time-probe-stream); what remains is incremental surface area.

### Shipped

- **VPS-primary live state** — The frontend reads live check fields (`status`, `lastChecked`, `nextCheckAt`, `responseTime`, `lastStatusCode`, `consecutiveFailures`/`Successes`, `lastError`, `disabled`, `maintenanceMode`) from regional WebSocket endpoints instead of Firestore `onSnapshot`, with Firestore retained as a hot-swappable fallback. Firestore stays authoritative for configuration.
- **Per-region multi-connect**, **Firebase ID token auth**, **snapshot-on-auth + 5-minute replay buffer**, and **hysteresis fallback** with an 8s debounce — all live.
- **Live response-time charts** — Canvas-rendered scrolling detail-view chart, zoomable to the full 24-hour window with status-transition markers and phase breakdown, backed by a **24h in-memory buffer per check** on the VPS that is NDJSON-persisted and replayed on boot. Backfill on chart open uses the `subscribe_history` / `history` message pair; live points append via the `update` stream.
- **Heartbeat-defer mode** — The Firestore write-reduction step is implemented as a runtime-toggleable defer buffer (no-change writes flushed on a slow cadence; transitions immediate).

### Roadmap

- **Per-check sparklines** — A scrolling mini-chart on every CheckCard in the list view (last few minutes of response time), reusing the same live buffer — no new infrastructure.
- **Multi-check folder overlay** — All checks in a folder rendered on one chart, color-coded, for spotting correlated outages.
- **Live countdown UX** — A smooth per-check "next check in" progress bar driven by a single `requestAnimationFrame` loop, with a reduced-motion text fallback.
- **BigQuery beyond 24h** — Windows longer than the in-memory buffer fall back to hourly-sampled history, clearly labeled as lower resolution.
- **Fan-in relay** — A read-only relay becomes the natural next step past five regions (today each user opens one WebSocket per region they have checks in, capped at 10); the current architecture composes with it without a rewrite.

### Risk model

The frontend keeps Firestore `onSnapshot` as a parallel data source. If anything WebSocket-related breaks, users see the connection indicator flip and continue with Firestore-fresh data — never an error. Heartbeat-defer is the only mechanism that materially ages the fallback path (heartbeats age up to ~5 min in fallback mode), which is why it's runtime-toggleable.

---

## Getting Started

1. **Sign up** at exit1.dev
2. **Complete onboarding** — tell us how you heard about us, what you monitor, your team size
3. **Add your first check** — Enter a URL and watch it run inline before you finish onboarding
4. **Set up alerts** — Choose how and when you want to be notified
5. **Create a status page** — Share uptime with customers (optional)
6. **Relax** — Exit1.dev monitors 24/7 so you don't have to

---

## Summary

Exit1.dev combines website monitoring, API health checks, push-based heartbeats, DNS record monitoring, ICMP ping, WebSocket, TCP/UDP, redirect chain monitoring, standalone domain-expiry checks, SSL validation, domain expiration tracking, embeddable status badges, and AI-powered insights into one unified platform. With sub-minute detection (15-second intervals on Agency), multi-region VPS execution (Frankfurt + opt-in Boston) with cross-region peer confirmation, a WebSocket-streamed Live page with scrolling charts, drag-to-zoom, bidirectional probe selection, per-stage phase breakdowns and raw-probe CSV/JSON export, per-stage timing diagnostics, CDN edge detection, intelligent verification, deploy-mode-aware alert reliability engineering (including a durable SSL alert state machine), seven native notification providers (Slack, Discord, Teams, Pumble, Pushover, PagerDuty, Opsgenie), transient-vs-confirmed failure auditing, flexible maintenance windows, drag-and-drop status pages with custom domains, curated public uptime monitors, CSV export, SLA reporting, list / folder / map check views, global command-palette search, an in-app feedback widget, a fully token-driven dark-only design system, and an MCP server for AI assistants, it provides everything teams need to ensure their web services and infrastructure stay online and secure.

**Stop discovering outages from your customers. Start monitoring with Exit1.dev.**
