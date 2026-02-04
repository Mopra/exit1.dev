# Exit1.dev

**Modern Website & API Monitoring Platform**

Exit1.dev is a real-time uptime monitoring platform that helps teams track the health, performance, and security of their websites, APIs, and domains. Built for reliability-conscious teams who need to know the moment something goes wrong.

---

## What Is Exit1.dev?

Exit1.dev continuously monitors your web services and alerts you instantly when issues arise. It combines website monitoring, API health checks, SSL certificate validation, and domain expiration tracking into a single, unified platform.

Instead of discovering outages through customer complaints or manually tracking SSL renewals in spreadsheets, Exit1.dev provides:

- **Instant Detection**: Know within minutes when services go down
- **Proactive Alerts**: Get warned before SSL certificates expire or domains lapse
- **Performance Insights**: Track response times and identify degradation trends
- **Public Transparency**: Share status pages with customers and stakeholders

---

## Value Propositions

### Problems We Solve

| Problem | How Exit1.dev Helps |
|---------|---------------------|
| **Undetected Downtime** | Real-time monitoring with multi-channel alerts (email, SMS, webhooks) |
| **SSL Certificate Surprises** | Automatic expiration tracking with advance warnings |
| **Domain Expiration Risk** | Domain Intelligence monitors registration dates and alerts before expiry |
| **Performance Blind Spots** | Response time tracking with 24-hour performance charts |
| **Fragmented Tools** | One platform for uptime, SSL, and domain monitoring |
| **Manual Tracking** | Replace spreadsheets with automated, always-on monitoring |

### Why Teams Choose Exit1.dev

- **Never miss an outage** — Get alerted the moment your services go down, not when customers complain
- **Prevent certificate disasters** — SSL issues cause browser warnings that destroy user trust
- **Protect your domains** — Domain expiration can mean losing your brand to squatters
- **Validate API responses** — Go beyond "is it up?" with JSONPath and content validation
- **Show customers you care** — Public status pages demonstrate transparency and professionalism

---

## Features

### Core Monitoring

**Website & API Health Checks**
- HTTP/HTTPS endpoint monitoring with configurable intervals (2-5 minutes)
- Support for all HTTP methods: GET, POST, PUT, PATCH, DELETE
- Custom headers and request bodies for API testing
- Response validation with JSONPath expressions and text containment checks
- Configurable acceptable response time thresholds

**Multi-Region Checking**
- Distributed checks from US Central, Europe West, and Asia Southeast
- Identify region-specific issues and latency variations
- Automatic region selection for optimal coverage

**Smart Verification**
- 30-second re-check to confirm issues aren't transient
- Configurable consecutive failure threshold (1-99 attempts) before marking offline
- Reduces false positives from temporary network blips

### SSL Certificate Management

- Automatic SSL validity checking for all HTTPS URLs
- Certificate expiration countdown (days until expiry)
- Issuer and subject information display
- Alerts for invalid, expired, or expiring certificates
- No separate setup required — works automatically

### Domain Intelligence

Track domain registration expiration across all your monitored URLs:

- **Automatic Discovery** — Extracts domains from monitored URLs automatically
- **RDAP Protocol** — Modern, reliable domain lookup (not legacy WHOIS)
- **Smart Frequency** — Checks increase as expiry approaches (monthly → daily → twice daily)
- **Configurable Alerts** — Default warnings at 30, 14, 7, and 1 day before expiration
- **Renewal Detection** — Confirms when domains are renewed
- **Unified Dashboard** — Color-coded status view of all domains

### Alerting & Notifications

**Multi-Channel Delivery**
- Email alerts with configurable recipients
- SMS alerts for urgent notifications (Nano plan)
- Webhooks with native Slack and Discord support
- Per-check event filtering (customize which alerts fire for each endpoint)

**Intelligent Throttling**
- Event-specific throttle windows prevent alert fatigue
- Different intervals for down/up events vs. SSL warnings
- Webhook health tracking with automatic retry on failure

**Alert Events**
- Website down / up / error
- SSL certificate error / warning
- Domain expiring / expired / renewed

### Organization & Management

**Check Folders**
- Organize checks into hierarchical folders
- Bulk operations on folder contents
- Folder-based status page inclusion

**Bulk Operations**
- Import multiple checks at once
- Multi-select for enable/disable/delete actions
- Streamlined management for large deployments

### Status Pages

Share uptime status with customers and stakeholders:

- Public or private visibility options
- Custom domain support with SSL
- Branding customization (logo, favicon, colors)
- Folder-based dynamic check inclusion
- Real-time updates — no manual maintenance

### Analytics & Reporting

**Real-Time Dashboard**
- Live status updates without page refresh
- 24-hour performance charts
- Response time trends and patterns
- Map view for geo-distributed health visualization

**Historical Analysis**
- Timeline view of uptime/downtime periods
- Incident tracking and notes
- BigQuery-powered log storage for long-term analytics
- Exportable reports for compliance and review

### Developer & Integration Features

**Public API**
- Programmatic access to monitoring data
- API key authentication
- Build custom integrations and dashboards

**Webhook Integrations**
- Generic webhook support
- Native Slack integration
- Native Discord integration
- Delivery status tracking with automatic retries

---

## Pricing

### Free Plan

Get started with comprehensive monitoring at no cost:

- Up to 200 checks
- 5-minute check intervals
- Email alerts (10/hour, 10/month)
- Public status pages
- SSL certificate monitoring
- Multi-region checking

### Nano Plan

For teams that need faster detection and advanced features:

- 2-minute check intervals (2.5x faster detection)
- SMS alerts (30/hour)
- Domain Intelligence (automatic domain expiration tracking)
- Enhanced email limits (100/hour, 1000/month)
- Full region access
- Timeline view
- All premium features

---

## Target Audience

**Primary Users**
- **SaaS Companies** — Reliable monitoring for customer-facing services
- **DevOps Teams** — Managing services across multiple regions
- **Startups & SMBs** — Affordable monitoring without complexity
- **Web Agencies** — Monitoring client websites and APIs
- **eCommerce** — Revenue-critical availability tracking

**Use Cases**
- Website uptime monitoring
- REST API health validation
- Microservices endpoint tracking
- SSL certificate management
- Domain portfolio protection
- Customer-facing status pages

---

## What Makes Exit1.dev Different

### Integrated Domain Intelligence

Unlike bolt-on domain monitoring tools, Exit1.dev automatically extracts and monitors domains from your existing checks. No duplicate configuration, no separate tool.

### True API Monitoring

Go beyond simple ping checks with full HTTP method support, custom payloads, and response validation using JSONPath expressions and text matching.

### Smart Alert Verification

The 30-second re-check system confirms issues before alerting, dramatically reducing false positives from transient network issues while maintaining fast detection.

### Real-Time Architecture

Built on Firebase with real-time listeners, the dashboard updates instantly when status changes. No waiting, no manual refresh.

### Transparent Status Pages

Built-in status pages with custom domain support. No need to pay for a separate status page service — it's included and fully integrated.

### Developer-First Design

Public API, webhook integrations, TypeScript throughout. Built by developers, for developers.

---

## Technology

Exit1.dev is built on a modern, scalable stack:

- **Frontend**: React, TypeScript, Vite, TailwindCSS
- **Backend**: Firebase Cloud Functions, Node.js
- **Database**: Cloud Firestore (real-time), BigQuery (analytics)
- **Authentication**: Clerk (SSO support)
- **Notifications**: Resend (email), Twilio (SMS), Svix (webhooks)

---

## Infrastructure & Cloud Functions

Exit1.dev runs on Firebase Cloud Functions with a distributed, multi-region architecture. Below is a comprehensive overview of the backend infrastructure.

### Health Check Execution

The core monitoring engine runs as scheduled Cloud Functions across three regions:

| Function | Region | Schedule | Purpose |
|----------|--------|----------|---------|
| `checkAllChecks` | US Central | Every 2 min | Execute health checks for US-assigned endpoints |
| `checkAllChecksEU` | Europe West | Every 2 min | Execute health checks for EU-assigned endpoints |
| `checkAllChecksAPAC` | Asia Southeast | Every 2 min | Execute health checks for APAC-assigned endpoints |

**Key capabilities:**
- Distributed lock mechanism prevents concurrent runs
- Processes up to 6,000 checks per execution cycle
- Real-time status buffering for efficient Firestore writes
- SSL certificate validation on every check
- Security metadata collection (IP geolocation, ASN, ISP)
- Alert throttling and budget enforcement
- 9-minute timeout with graceful shutdown

### Check Management Functions

| Function | Type | Description |
|----------|------|-------------|
| `addCheck` | Callable | Create new health check with URL validation, rate limiting (10/min, 100/hour, 500/day), and automatic region assignment |
| `getChecks` | Callable | Retrieve all checks with pagination and folder filtering |
| `updateCheck` | Callable | Modify check configuration (URL, frequency, headers, validation rules) |
| `deleteWebsite` | Callable | Permanently delete check and all associated data |
| `toggleCheckStatus` | Callable | Enable/disable check execution |
| `manualCheck` | Callable | Trigger immediate on-demand check |
| `updateCheckRegions` | Callable | Reassign checks to different execution regions |

### SSL & Security Functions

| Function | Type | Schedule | Description |
|----------|------|----------|-------------|
| `refreshSecurityMetadata` | Scheduled | Every 6 hours | Batch refresh SSL certificates and security metadata for all active checks |

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
| `enableDomainExpiry` | Callable | Enable domain monitoring for a check (Nano tier) |
| `disableDomainExpiry` | Callable | Disable domain monitoring |
| `updateDomainExpiry` | Callable | Update alert thresholds and settings |
| `refreshDomainExpiry` | Callable | Manual domain refresh (rate limited: 50/day) |
| `bulkEnableDomainExpiry` | Callable | Enable for multiple checks at once |
| `getDomainIntelligence` | Callable | Retrieve domain data for all enabled checks |

**RDAP Features:**
- Modern RDAP protocol (not legacy WHOIS)
- Multi-level caching (in-memory, Firestore, IANA bootstrap)
- Smart frequency scaling as expiry approaches
- Alert thresholds: 30, 14, 7, 1 days before expiration
- Renewal detection and confirmation

### Email Alert Functions

| Function | Type | Description |
|----------|------|-------------|
| `saveEmailSettings` | Callable | Configure global email recipients and events |
| `updateEmailPerCheck` | Callable | Set per-check email overrides |
| `bulkUpdateEmailPerCheck` | Callable | Update email settings for multiple checks |
| `getEmailSettings` | Callable | Retrieve current email configuration |
| `getEmailUsage` | Callable | Check email quota usage (hourly/monthly) |
| `sendTestEmail` | Callable | Send test email to verify delivery |

**Quotas:**
- Free: 10/hour, 50/month
- Nano: 100/hour, 1000/month

### SMS Alert Functions

| Function | Type | Description |
|----------|------|-------------|
| `saveSmsSettings` | Callable | Configure SMS recipients (E.164 format) |
| `updateSmsPerCheck` | Callable | Set per-check SMS overrides |
| `bulkUpdateSmsPerCheck` | Callable | Update SMS settings for multiple checks |
| `getSmsSettings` | Callable | Retrieve SMS configuration |
| `getSmsUsage` | Callable | Check SMS quota (Twilio-based) |
| `sendTestSms` | Callable | Send test SMS |

### Webhook Functions

| Function | Type | Description |
|----------|------|-------------|
| `saveWebhookSettings` | Callable | Create webhook endpoint (max 5 per user) |
| `updateWebhookSettings` | Callable | Modify webhook configuration |
| `deleteWebhook` | Callable | Remove webhook endpoint |
| `testWebhook` | Callable | Send test payload to verify delivery |
| `bulkDeleteWebhooks` | Callable | Delete multiple webhooks |
| `bulkUpdateWebhookStatus` | Callable | Enable/disable multiple webhooks |

**Delivery Features:**
- Exponential backoff retries (up to 8 attempts)
- 24-hour retry TTL
- Batch retry draining (25 retries per drain)
- Health tracking per endpoint

### History & Analytics Functions

| Function | Type | Description |
|----------|------|-------------|
| `getCheckHistoryBigQuery` | Callable | Query raw check history (rate limited: 60/user/min) |
| `getCheckStatsBigQuery` | Callable | Calculate uptime statistics |
| `getCheckStatsBatchBigQuery` | Callable | Fetch stats for multiple checks |
| `getCheckHistoryForStats` | Callable | Hourly aggregated history for trends |
| `getCheckHistoryDailySummary` | Callable | Daily summary snapshots |
| `getCheckReportMetrics` | Callable | SLA compliance metrics |
| `aggregateDailySummariesScheduled` | Scheduled (daily) | Pre-aggregate summaries for cost optimization |
| `purgeBigQueryHistory` | Scheduled (daily) | Delete data older than retention period |

### Public API

| Function | Type | Description |
|----------|------|-------------|
| `publicApi` | HTTP | RESTful API for external integrations |

**Endpoints:**
- `GET /api/checks` — List checks with pagination
- `GET /api/checks/{id}/status` — Current status
- `GET /api/checks/{id}/history` — Query history
- `GET /api/checks/{id}/stats` — Uptime statistics
- `POST /api/checks` — Create check (write scope)
- `PUT /api/checks/{id}` — Update check (write scope)
- `DELETE /api/checks/{id}` — Delete check (write scope)

**Features:**
- API key authentication (SHA256 hashed)
- Scope-based access control (read/write)
- Rate limiting (global and per-key)
- Response caching (10-minute TTL)

### Status Page Functions

| Function | Type | Description |
|----------|------|-------------|
| `getStatusPageUptime` | Callable | Retrieve uptime stats for status page |
| `getStatusPageSnapshot` | Callable | Real-time status snapshot (5-min cache) |
| `getStatusPageHeartbeat` | Callable | 30-day heartbeat history |

### API Key Management

| Function | Type | Description |
|----------|------|-------------|
| `createApiKey` | Callable | Generate new API key (max 2 per user) |
| `listApiKeys` | Callable | List all keys (hashed values only) |
| `revokeApiKey` | Callable | Disable key without deleting |
| `deleteApiKey` | Callable | Permanently delete key |

### User & Organization Functions

| Function | Type | Description |
|----------|------|-------------|
| `deleteUserAccount` | Callable | Delete account and all associated data |
| `getAllUsers` | Callable | List all users (admin only) |
| `deleteUser` | Callable | Admin delete user |
| `bulkDeleteUsers` | Callable | Admin bulk delete |
| `updateOrganizationBillingProfile` | Callable | Update billing address and tax info |

### Authentication & Webhooks

| Function | Type | Description |
|----------|------|-------------|
| `clerkWebhook` | HTTP | Receive Clerk auth webhooks (user lifecycle) |
| `syncClerkUsersToResend` | Callable | Sync users to Resend for email campaigns |

### Log Annotation Functions

| Function | Type | Description |
|----------|------|-------------|
| `getLogNotes` | Callable | Retrieve annotations on check logs |
| `addLogNote` | Callable | Add annotation (max 2000 chars) |
| `updateLogNote` | Callable | Edit existing note |
| `deleteLogNote` | Callable | Remove note |
| `getManualLogs` | Callable | Retrieve manual log entries |
| `addManualLog` | Callable | Create manual status record |

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
| `investigateCheck` | Callable | Deep troubleshooting for specific check |

### System Status

| Function | Type | Description |
|----------|------|-------------|
| `getSystemStatus` | Callable | Platform health and recent errors |

---

### Core Infrastructure Modules

**check-utils.ts** — Check execution engine
- HTTP/HTTPS request execution with timeout handling
- TCP and UDP socket checks
- SSL certificate extraction
- Response parsing and body snippet extraction
- Redirect following (max 5 hops)
- Target metadata collection (IP, geolocation, ASN, ISP)

**alert.ts** — Alert delivery system
- Email delivery via Resend
- SMS delivery via Twilio
- Webhook delivery with exponential backoff
- Alert throttling by event type (1min → 7days)
- Per-user email/SMS budgets
- Webhook retry queue management

**status-buffer.ts** — Efficient status updates
- In-memory buffer (500 doc max)
- Automatic flush on high watermark (200 docs)
- Idle timeout flush (25 seconds)
- Deduplication and failure backoff

**bigquery.ts** — Data warehouse integration
- Insert check history records
- Purge old records for cost control
- Batch processing with retry logic

**rdap-client.ts** — Domain lookup
- RDAP protocol client
- Multi-level caching
- IANA bootstrap file management
- Domain expiry extraction

**rate-limit.ts** — Rate limiting
- Fixed window rate limiter
- Per-user and per-endpoint limits
- Configurable windows and thresholds

---

### Architectural Patterns

1. **Distributed Execution** — Three regional schedulers run independently to minimize latency and avoid lock contention
2. **Status Buffering** — In-memory batching reduces Firestore writes by ~50%
3. **Alert Throttling** — Event-specific throttle windows prevent alert fatigue
4. **Multi-Layer Rate Limiting** — Per-user, per-endpoint, and per-IP protection
5. **Multi-Level Caching** — In-memory, Firestore, and HTTP response caching
6. **Graceful Degradation** — Non-blocking metadata collection, best-effort geo lookups
7. **Exponential Backoff** — Webhook delivery and failed operation retries
8. **BigQuery Optimization** — Pre-aggregated daily summaries reduce query costs
9. **Tier-Based Features** — Feature gating based on subscription tier

---

## Getting Started

1. **Sign up** at exit1.dev
2. **Add your first check** — Enter a URL and configure monitoring options
3. **Set up alerts** — Choose how and when you want to be notified
4. **Create a status page** — Share uptime with customers (optional)
5. **Relax** — Exit1.dev monitors 24/7 so you don't have to

---

## Summary

Exit1.dev combines website monitoring, API health checks, SSL validation, and domain expiration tracking into one unified platform. With real-time alerts, intelligent verification, and built-in status pages, it provides everything teams need to ensure their web services stay online and secure.

**Stop discovering outages from your customers. Start monitoring with Exit1.dev.**
