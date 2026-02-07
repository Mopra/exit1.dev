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

## Related repos

- [exit1.dev.website](https://github.com/Mopra/exit1.dev.website) — Marketing site
- [exit1.dev.docs](https://github.com/Mopra/exit1.dev.docs) — Official docs
- [pradsgaardlabs.website](https://github.com/Mopra/pradsgaardlabs.website) — Company site

## License

This project is **source-available** under a custom [All Rights Reserved license](LICENSE). You may view the code for personal, educational, and reference purposes. Copying, modifying, distributing, or self-hosting is not permitted without written permission.

For licensing inquiries: hello@exit1.dev
