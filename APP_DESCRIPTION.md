# Exit1.dev

**Modern Website, API, and Infrastructure Monitoring Platform**

Exit1.dev is a real-time uptime monitoring platform that helps teams track the health, performance, and security of their websites, APIs, DNS records, background jobs, and domains. Built for reliability-conscious teams who need to know the moment something goes wrong — and for teams who need proof they stayed online.

---

## What Is Exit1.dev?

Exit1.dev continuously monitors your web services and alerts you instantly when issues arise. It combines website monitoring, API health checks, DNS record change detection, push-based heartbeat monitoring, SSL certificate validation, and domain expiration tracking into a single, unified platform.

Instead of discovering outages through customer complaints or manually tracking SSL renewals in spreadsheets, Exit1.dev provides:

- **Instant Detection** — Know within seconds when services go down (15-second intervals on Agency)
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

Exit1.dev supports eight distinct check types, all running on the same VPS-powered execution engine.

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
- Hardened DNS resolution with c-ares resolver, retry with backoff, and local recursive DNS cache

### SSL Certificate Management

- Automatic SSL validity checking for all HTTPS URLs
- Certificate expiration countdown (days until expiry)
- Issuer and subject information display
- Alerts for invalid, expired, or expiring certificates
- No separate setup required — works automatically

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
- Webhooks with native Slack (Block Kit), Discord (embeds), and Microsoft Teams (adaptive cards) support
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
- CSV import for adding multiple checks at once
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
- Five tools: `list_checks`, `get_check`, `get_history`, `get_stats`, `get_status_page`
- Access follows your API access tier (Pro/Agency with an API key, `checks:read` scope)

**Webhook Integrations**
- Generic webhook support
- Native presets with provider-correct payload formatting:
  - **Slack** (Block Kit)
  - **Discord** (rich embeds)
  - **Microsoft Teams** (adaptive cards)
  - **Pumble** (incoming webhook format)
  - **PagerDuty** (Events API v2 — auto trigger / resolve from up/down events)
  - **Opsgenie** (alert API — auto create / close)
- Delivery status tracking with automatic retries (exponential backoff, 8 attempts, 48-hour TTL)
- Circuit breaker prevents wasted retries on dead endpoints

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

### Eight Check Types, One Engine

HTTP/HTTPS, heartbeats, DNS records, ICMP ping, TCP/UDP sockets, WebSocket, and redirects — monitor every layer of your stack in one place, all running on the same low-latency VPS worker.

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

### Multi-Region Execution

Two production VPS regions — Frankfurt (`vps-eu-1`, default) and Boston (`vps-us-1`, opt-in for Pro / Agency on a per-check basis). Each region has a static IP for firewall allowlisting and a hardened DNS stack (c-ares + local Unbound cache).

### Transparent Status Pages

Built-in status pages with drag-and-drop layout editor, seven widget types, and custom domain support on Agency. No need to pay for a separate status page service — it's included and fully integrated.

### Developer-First Design

Public API with read/write scopes, webhook integrations, MCP server for AI assistants, embeddable status badges, global command palette, CSV export, log annotations, TypeScript throughout. Built by developers, for developers.

### AI-Ready Monitoring

The MCP server (`exit1-mcp`) lets AI assistants query your monitoring data directly. Ask Claude, Copilot, or any MCP client about outages, compare response times, and investigate incidents without switching context.

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

The app is **dark-only** and built around a single source of truth in [src/style.css](src/style.css). The full brand and visual rulebook lives in [design.md](design.md); this section is a quick reference.

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
- HTTP/HTTPS, heartbeat, DNS, ICMP, TCP, UDP, WebSocket, and redirect check types
- SSL certificate validation on every HTTP check
- TCP light-checks alternate with full HTTP for eligible endpoints
- Security metadata collection (IP geolocation, ASN, ISP)
- System-level health gate, alert throttling, and budget enforcement
- Hardened DNS with c-ares resolver, local Unbound cache, retry with backoff
- Graceful shutdown on SIGTERM/SIGINT with deploy-mode baseline grace
- Maintenance mode and deploy mode awareness

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
2. **Eight Check Types, One Engine** — HTTP, heartbeat, DNS, ICMP, TCP, UDP, WebSocket, and redirect checks share a single execution path and dispatcher
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

Exit1.dev combines website monitoring, API health checks, push-based heartbeats, DNS record monitoring, ICMP ping, WebSocket, TCP/UDP, redirect chain monitoring, SSL validation, domain expiration tracking, embeddable status badges, and AI-powered insights into one unified platform. With sub-minute detection (15-second intervals on Agency), multi-region VPS execution (Frankfurt + opt-in Boston), per-stage timing diagnostics, CDN edge detection, intelligent verification, deploy-mode-aware alert reliability engineering, six native webhook presets (Slack, Discord, Teams, Pumble, PagerDuty, Opsgenie), flexible maintenance windows, drag-and-drop status pages with custom domains, CSV export, SLA reporting, list / folder / map check views, global command-palette search, an in-app feedback widget, a fully token-driven dark-only design system, and an MCP server for AI assistants, it provides everything teams need to ensure their web services and infrastructure stay online and secure.

**Stop discovering outages from your customers. Start monitoring with Exit1.dev.**
