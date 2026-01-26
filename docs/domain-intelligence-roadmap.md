# Domain Intelligence - Product Roadmap

## Overview

This roadmap outlines expansion opportunities for Domain Intelligence, leveraging data we already collect and extending into adjacent monitoring capabilities.

---

## Data We Already Collect (Underutilized)

| Data Point | Current Use | Expansion Opportunity |
|------------|-------------|----------------------|
| Registrar name/URL | Display only | Registrar health monitoring, consolidation insights |
| Nameservers | Display only | DNS provider monitoring, misconfiguration detection |
| Registry status codes | Display only | Security alerts (transfer locks, holds, disputes) |
| Creation date | Display only | Domain age insights, trust signals |
| Last update date | Display only | Change detection, unauthorized modification alerts |

---

## Phase 1: Leverage Existing Data
**Effort: Low | Impact: High**

These features require minimal backend work since we already have the data.

### 1.1 Registry Status Change Alerts
**Problem:** Domain gets flagged for legal disputes, UDRP proceedings, or placed on hold - user finds out too late.

**Solution:** Monitor status codes and alert on concerning changes:
- `serverHold` - domain suspended by registry
- `clientTransferProhibited` removed - someone unlocked transfers
- `pendingDelete` - domain entering deletion
- `redemptionPeriod` - domain expired and in grace period

**User Value:** Know immediately when something's wrong with your domain's legal or security status.

---

### 1.2 Unauthorized Modification Detection
**Problem:** Someone gains access to your registrar account and modifies DNS or transfers the domain.

**Solution:** 
- Track `lastUpdated` timestamp
- Alert when it changes unexpectedly (outside of user-initiated renewals)
- Alert when nameservers change without user action

**User Value:** Catch domain hijacking attempts before damage is done.

---

### 1.3 Registrar Distribution Dashboard
**Problem:** Domains scattered across many registrars = higher management overhead and security risk.

**Solution:**
- Dashboard view showing domain count per registrar
- Pie chart or breakdown visualization
- Recommendations to consolidate when spread is high

**User Value:** Understand your registrar portfolio at a glance, identify consolidation opportunities.

---

### 1.4 DNS Provider Grouping
**Problem:** If the nameserver provider has an outage, all domains using it go down.

**Solution:**
- Group domains by nameserver provider (extract from NS records)
- Show concentration percentage ("80% of your domains use Cloudflare DNS")
- Flag high concentration as potential risk

**User Value:** Identify single points of failure in your DNS infrastructure.

---

## Phase 2: Expand Monitoring Scope
**Effort: Medium | Impact: High**

These features require new data collection but align naturally with domain monitoring.

### 2.1 SSL Certificate Expiration Monitoring
**Problem:** SSL certificates expire separately from domains, causing browser security warnings.

**Solution:**
- Query SSL certificate expiry for each monitored domain
- Add to existing alert thresholds (30, 14, 7, 1 day)
- Show SSL expiry alongside domain expiry in dashboard

**Implementation Notes:**
- Can use existing domain list - no new user input needed
- TLS handshake to extract certificate info
- Consider checking both apex domain and www subdomain

**User Value:** Complete domain health monitoring - domains + SSL in one place.

---

### 2.2 DNS Provider Health Warnings
**Problem:** Major DNS providers occasionally have outages that affect millions of domains.

**Solution:**
- Maintain list of major DNS providers and their status
- Cross-reference with user's nameservers
- Alert when a provider the user depends on has known issues

**Implementation Notes:**
- Could integrate with status page APIs (Cloudflare, AWS Route53, etc.)
- Or use community-reported outage data

**User Value:** Proactive warning when your DNS provider is having problems.

---

## Phase 3: Advanced Security
**Effort: Medium-High | Impact: Medium**

These features target security-conscious users and larger organizations.

### 3.1 DNSSEC Health Monitoring
**Problem:** DNSSEC misconfiguration can silently break DNS resolution for security-conscious users.

**Solution:**
- Check if DNSSEC is enabled for each domain
- Validate DNSSEC chain is properly configured
- Alert on DNSSEC failures or misconfigurations

**Implementation Notes:**
- Requires DNS queries with DNSSEC validation
- More complex than simple RDAP queries

**User Value:** Ensure your DNS security is actually working.

---

### 3.2 Registrar Security Scoring
**Problem:** Not all registrars have equal security practices.

**Solution:**
- Rate registrars based on security features (2FA support, transfer locks, etc.)
- Flag domains at registrars with poor security track records
- Recommend migration for high-risk registrars

**Implementation Notes:**
- Requires maintaining registrar security database
- Could be controversial - needs careful framing

**User Value:** Understand if your registrar is putting your domains at risk.

---

### 3.3 Domain Portfolio Export & Reporting
**Problem:** Security teams need domain data for audits and compliance.

**Solution:**
- Export all domain data to CSV/JSON
- Include: domain, registrar, expiry, creation date, age, nameservers, status codes
- Scheduled reports via email

**User Value:** Easy compliance reporting and portfolio documentation.

---

## Phase 4: Nice-to-Have
**Effort: Low | Impact: Low**

Lower priority features that add polish.

### 4.1 Domain Age Analytics
**Problem:** For SEO and security teams, domain age matters but is hard to track.

**Solution:**
- Show domain age prominently (calculated from creation date)
- Sort/filter by domain age
- Flag newly registered domains (could indicate unauthorized additions)

**User Value:** Useful for SEO analysis and security audits.

---

### 4.2 Historical Timeline
**Problem:** Hard to track what changed and when.

**Solution:**
- Log all detected changes (expiry updates, nameserver changes, status changes)
- Show timeline view per domain
- Useful for forensics after incidents

**User Value:** Audit trail for domain changes.

---

## Implementation Priority Matrix

| Feature | Effort | Impact | Priority |
|---------|--------|--------|----------|
| Registry status alerts | Low | High | P0 |
| Unauthorized change detection | Low | High | P0 |
| Registrar distribution dashboard | Low | Medium | P1 |
| DNS provider grouping | Low | Medium | P1 |
| SSL certificate monitoring | Medium | High | P1 |
| DNS provider health warnings | Medium | Medium | P2 |
| DNSSEC monitoring | Medium | Medium | P2 |
| Domain portfolio export | Low | Medium | P2 |
| Registrar security scoring | High | Medium | P3 |
| Domain age analytics | Low | Low | P3 |
| Historical timeline | Medium | Low | P3 |

---

## Success Metrics

### Phase 1
- % of users who enable status change alerts
- Number of unauthorized change alerts triggered (validates feature value)
- User engagement with registrar/DNS dashboards

### Phase 2
- Adoption rate of SSL monitoring
- Reduction in SSL-related incidents for users
- DNS provider warning accuracy

### Phase 3
- Enterprise/security-focused user adoption
- Export feature usage
- DNSSEC issue detection rate

---

## Dependencies & Considerations

### Technical
- Phase 1 features can ship independently
- SSL monitoring requires new infrastructure for certificate checks
- DNSSEC validation requires DNS library with DNSSEC support

### Product
- Consider feature gating (some features Nano-only, others available to all paid plans)
- UI/UX for surfacing alerts without overwhelming users
- Balance between proactive alerts and alert fatigue

### Marketing
- Each phase is an opportunity for feature announcement
- Security features appeal to enterprise buyers
- SSL monitoring is highly marketable ("complete domain health")
