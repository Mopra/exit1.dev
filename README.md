# Exit1.dev

Real-time website and API monitoring with multi-region checks, SSL tracking, and intelligent alerting.

**[exit1.dev](https://exit1.dev)**

> **Source-available, not open source.** This code is published for transparency and reference. See [LICENSE](LICENSE) for terms.

## What it does

Exit1 monitors your websites and APIs from multiple global regions every 2 minutes. When something goes down, you get notified via email, SMS, or webhook — with smart throttling so you don't get spammed.

- HTTP/HTTPS endpoint monitoring with response validation
- SSL certificate expiration tracking and alerts
- Multi-region checks (US, Europe, Asia)
- Performance analytics and uptime history
- Public status pages
- Domain intelligence (WHOIS/registration monitoring)
- REST API for programmatic access
- BigQuery-powered log storage and analytics

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend:** Firebase Cloud Functions (Gen2), Firestore, BigQuery
- **Auth:** Clerk
- **Notifications:** Resend (email), Twilio (SMS), Svix (webhooks)
- **Hosting:** Firebase Hosting

## Quick Links

| | | |
|---|---|---|
| **Website** | [exit1.dev](https://exit1.dev) — Learn about the platform | [Repo](https://github.com/Mopra/exit1.dev.website) |
| **Monitor App** | [app.exit1.dev](https://app.exit1.dev) — Sign in and manage your checks | [Repo](https://github.com/Mopra/exit1.dev) |
| **Documentation** | [docs.exit1.dev](https://docs.exit1.dev) — Guides, API reference, and setup instructions | [Repo](https://github.com/Mopra/exit1.dev.docs) |

## License

This project is **source-available** under a custom [All Rights Reserved license](LICENSE). You may view the code for personal, educational, and reference purposes. Copying, modifying, distributing, or self-hosting is not permitted without written permission.

For licensing inquiries: connect@exit1.dev
