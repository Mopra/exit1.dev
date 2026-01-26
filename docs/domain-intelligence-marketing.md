# Domain Intelligence - Marketing Content

## Overview

**Domain Intelligence** is an automated domain expiration monitoring system that tracks when domain registrations are about to expire and alerts users before it happens. It's integrated directly into the uptime monitoring platform - no additional setup required.

---

## The Problem We Solve

### Pain Points

1. **Forgotten Domain Renewals** - Domains expire without warning, causing website downtime, lost email, and potential loss of the domain to competitors or squatters

2. **Manual Tracking is Error-Prone** - Managing spreadsheets or calendars for domain renewals is tedious and unreliable

3. **Registrar Emails Get Lost** - Renewal notices from registrars often end up in spam or are overlooked

4. **Multiple Domains = Multiple Headaches** - Users with many domains across different registrars struggle to keep track

5. **Sudden Outages** - When a domain expires, all services go down - websites, email, APIs - often during critical business hours

6. **No Unified View** - Information is scattered across different registrar dashboards

### The Cost of a Forgotten Domain

- Immediate website downtime
- Email delivery failures
- API integrations break
- Customer trust damaged
- Potential permanent loss of domain to squatters
- Expensive recovery fees from registrars

---

## Key Features

### Automatic Domain Monitoring
- Extracts domain names from monitored URLs automatically
- Zero manual setup - enable it and it just works
- Supports all major TLDs (.com, .net, .org, .io, .dev, .co.uk, etc.)

### Real-Time Dashboard
- Color-coded status indicators (Active, Expiring Soon, Expired, Error)
- Sortable by expiry date, domain name, status, or last checked
- Search and filter across all domains
- Group by folder for organization
- Stats overview: Total, Expiring Soon, Healthy, Errors

### Smart Alert System
- Default alerts at **30, 14, 7, and 1 day(s)** before expiry
- Customizable thresholds per domain
- Multi-channel notifications:
  - Email (detailed HTML with urgency indicators)
  - SMS (concise alert text)
  - Webhooks (Slack, Discord, or custom)

### Intelligent Check Frequency
The system checks more frequently as expiry approaches:
- 90+ days out: monthly checks
- 30-90 days: bi-weekly checks
- 7-30 days: every 3 days
- 1-7 days: daily checks
- Under 1 day: twice daily

### Rich Domain Information
For each domain, users see:
- Days until expiry (prominently displayed)
- Exact expiration date
- Registrar name and URL
- Domain creation date
- Last update date
- Nameservers
- Registry status codes

### Renewal Detection
Automatically detects when a domain is renewed (expiry extends 30+ days) and sends a confirmation notification.

---

## How It Works

1. **Enable on Checks** - Navigate to Domain Intelligence, click "Enable for checks"
2. **Select Checks** - Choose which uptime checks should have domain monitoring (bulk selection up to 50 at once)
3. **Automatic Processing** - System extracts domains, validates RDAP support, and performs initial query
4. **Monitor Dashboard** - View all domains sorted by urgency with color-coded status
5. **Get Alerts** - Receive notifications as expiry dates approach

---

## Technical Highlights

- **RDAP Protocol** - Modern, standardized replacement for WHOIS with more reliable, structured data
- **IANA Bootstrap** - Automatically routes queries to the correct authoritative RDAP server for any TLD
- **Real-Time Updates** - Changes appear instantly across all devices
- **Intelligent Caching** - Fast lookups with 24-hour cache for bootstrap data
- **Global TLD Support** - Works with most major TLDs including two-level TLDs (.co.uk, .com.au)
- **Subdomain Handling** - Automatically extracts root domain from complex URLs

---

## Unique Selling Points

1. **Integrated with Uptime Monitoring** - Unlike standalone domain monitors, this is built into your uptime platform - one tool for all website health

2. **No Additional Setup** - Domains are auto-detected from URLs you're already monitoring

3. **Smart Frequency Scaling** - Check frequency increases as expiry approaches - no wasted resources on domains expiring in a year

4. **Modern Protocol** - Uses RDAP (not legacy WHOIS) for more reliable, structured data

5. **Multi-Channel Alerts** - Email, SMS, and webhooks ensure you never miss a warning

6. **Webhook Automation** - Trigger automated workflows when domains are expiring (create tickets, send Slack alerts, etc.)

---

## Suggested Marketing Copy

### Taglines

- "Never lose a domain to an expired registration again"
- "Monitor your domains alongside your uptime - all in one dashboard"
- "Get ahead of domain expiration with smart, automated alerts"
- "Domain expiration monitoring on autopilot"
- "Your domains, tracked. Your business, protected."

### Value Proposition (Short)

Domain Intelligence automatically monitors when your domain registrations expire and alerts you before disaster strikes. No more spreadsheets, no more missed emails from registrars - just proactive protection for your online presence.

### Value Proposition (Long)

Every year, businesses lose domains they've built their entire brand around - simply because a renewal email got buried in spam. Domain Intelligence eliminates this risk by integrating expiration monitoring directly into your uptime dashboard. Enable it on any check, and we'll automatically track the domain, alert you at 30, 14, 7, and 1 day before expiry, and even notify you when renewals are confirmed. One dashboard. All your domains. Zero surprises.

---

## Landing Page Feature Bullets

- Automatic domain expiry monitoring for all your checks
- Multi-channel alerts at 30, 14, 7, and 1 day before expiration
- Real-time dashboard with color-coded urgency status
- RDAP-powered for accurate, up-to-date registration data
- Bulk enable across all your domains
- Renewal detection and confirmation notifications
- Supports all major TLDs worldwide
- No manual setup - domains detected from your existing checks

---

## Homepage Feature Mention

**Domain Intelligence** - Automatic domain expiration monitoring. Get alerts before your domains expire, not after disaster strikes.

---

## Blog Post Ideas

### Core Feature Posts
1. "Why Domain Expiration is the Silent Killer of Websites"
2. "From WHOIS to RDAP: How Modern Domain Monitoring Works"
3. "The True Cost of a Forgotten Domain Renewal"
4. "How to Never Lose a Domain Again: A Complete Guide"
5. "Domain Monitoring vs. Registrar Reminders: Why You Need Both"

### Security & Protection Posts
6. "Domain Hijacking: How to Detect Unauthorized Changes Before It's Too Late"
   - Focus: Monitoring lastUpdated timestamps and nameserver changes to catch unauthorized modifications
   
7. "Understanding Registry Status Codes: What serverHold, clientTransferProhibited, and pendingDelete Mean for Your Business"
   - Focus: Educate on status codes and why monitoring them matters (legal disputes, UDRP, suspensions)

8. "Is Your Domain Really Secure? The Hidden Risks of Transfer Lock Settings"
   - Focus: How removed transfer locks can indicate compromise attempts

### Infrastructure & Risk Posts
9. "DNS Provider Concentration Risk: Why Having All Your Eggs in One Basket is Dangerous"
   - Focus: What happens when your DNS provider goes down and how to assess concentration risk

10. "The Case for Registrar Consolidation: Simplify Your Domain Portfolio"
    - Focus: Security and management benefits of reducing registrar sprawl

11. "SSL Certificate Expiration: The Other Expiry Date You're Probably Forgetting"
    - Focus: Why SSL monitoring belongs alongside domain monitoring

### Technical Deep Dives
12. "Domain Age and SEO: What Your Domain's Birthday Says About Trust"
    - Focus: How domain age affects SEO and why tracking it matters

13. "Building a Domain Health Checklist: Expiry, SSL, DNS, and Beyond"
    - Focus: Comprehensive guide to all the things that can go wrong with domains

### DNSSEC Series
A dedicated content series on DNSSEC - technical enough to attract practitioners, educational enough to drive awareness.

14. "DNSSEC Explained: What It Is and Why Your Domain Needs It"
    - Focus: Beginner-friendly introduction to DNSSEC, how DNS spoofing works, and why DNSSEC prevents it
    - Target: IT managers, business owners who've heard of DNSSEC but don't understand it

15. "How DNSSEC Actually Works: Keys, Signatures, and the Chain of Trust"
    - Focus: Technical deep dive into KSK, ZSK, DS records, and how the validation chain works
    - Target: DevOps engineers, security practitioners

16. "The Most Common DNSSEC Misconfigurations (And How to Detect Them)"
    - Focus: Real-world failure modes - expired signatures, broken chains, key rollover failures
    - Target: SREs, DNS administrators
    - Great for SEO: "DNSSEC not working", "DNSSEC validation failed"

17. "DNSSEC Rollover Gone Wrong: Lessons from High-Profile Failures"
    - Focus: Case studies of DNSSEC outages (NASA, Slack, major TLDs) and what we can learn
    - Target: Broad technical audience
    - High shareability potential

18. "Is DNSSEC Worth the Complexity? A Balanced Analysis"
    - Focus: Honest pros/cons - security benefits vs. operational overhead, when it makes sense
    - Target: Decision makers evaluating DNSSEC adoption
    - Builds trust by not being purely promotional

19. "Monitoring DNSSEC: Why Set-and-Forget Doesn't Work"
    - Focus: Why DNSSEC requires ongoing monitoring, what can go wrong after initial setup
    - Target: Teams who enabled DNSSEC and assumed they were done
    - Ties directly to our product value

20. "DNSSEC and Your Domain Portfolio: A Practical Implementation Guide"
    - Focus: Step-by-step guide to enabling and monitoring DNSSEC across multiple domains
    - Target: IT teams managing multiple domains
    - Actionable, practical content

21. "DNSSEC vs. DoH vs. DoT: Understanding Modern DNS Security Options"
    - Focus: How DNSSEC compares to DNS-over-HTTPS and DNS-over-TLS, and why they're complementary
    - Target: Security-conscious developers
    - Clarifies common confusion

---

## FAQ Content

**Q: What TLDs are supported?**
A: Domain Intelligence supports most major TLDs including .com, .net, .org, .io, .dev, .co, .ai, and many country-code TLDs. We use the RDAP protocol via IANA bootstrap, which covers the vast majority of registered domains.

**Q: How often are domains checked?**
A: Check frequency scales with urgency. Domains expiring in 90+ days are checked monthly. As expiry approaches, we increase to bi-weekly, then every 3 days, then daily, and finally twice daily in the final 24 hours.

**Q: Can I customize when I receive alerts?**
A: Yes. Default alerts are sent at 30, 14, 7, and 1 day before expiry, but you can customize these thresholds for each domain.

**Q: What notification channels are available?**
A: Email, SMS, and webhooks (including pre-formatted Slack and Discord messages).

**Q: Do I need to manually enter my domains?**
A: No. Domain Intelligence automatically extracts domains from the URLs you're already monitoring. Just enable it on your existing checks.

**Q: What happens if I renew my domain?**
A: We automatically detect renewals (when expiry extends by 30+ days) and send you a confirmation notification.

---

## Competitive Advantages

| Feature | Domain Intelligence | Typical Standalone Tools |
|---------|---------------------|-------------------------|
| Integrated with uptime monitoring | Yes | No |
| Auto-detect domains from checks | Yes | Manual entry |
| Smart check frequency scaling | Yes | Fixed intervals |
| RDAP protocol (modern) | Yes | Often legacy WHOIS |
| Multi-channel alerts | Email, SMS, Webhooks | Usually email only |
| Renewal detection | Yes | Rare |
| Single dashboard for all monitoring | Yes | Separate tool |

---

## Plan Availability

Domain Intelligence is available on the **Nano** subscription tier as a premium feature.
