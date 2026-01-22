# Getting started

This page is a simple guide to get your first monitoring checks live, configure alerts, and understand the core settings.

## Quick start (5 minutes)
1. **Create your first check**: Add a URL or host:port to monitor.
2. **Pick the right interval**: Use longer intervals unless the service is truly critical.
3. **Enable alerts**: Turn on Email, SMS, or Webhooks (or all three).
4. **Verify delivery**: Send a test Email/SMS or test a webhook.
5. **Watch Logs**: Confirm your first events and understand how logs are stored.

## Create your first check
Go to **Checks ? Add Check** and fill in:
- **URL / Host:Port**
  - For HTTP/HTTPS: enter a domain or full URL.
  - For TCP/UDP: enter `host:port` (example: `db.example.com:5432`).
- **Display name**: Friendly label for dashboards and alerts.
- **Check type**
  - **Website** or **REST endpoint** for HTTP/HTTPS.
  - **TCP** / **UDP** to verify a port is reachable.
- **Check frequency**: Choose how often we probe the target.

### Recommended defaults
- **Frequency**: 5–15 minutes for most sites; 1–2 minutes only for critical paths.
- **Immediate re-check**: Keep enabled for fewer false alarms.
- **Down confirmation attempts**: Default is 4 consecutive failures.

## Important settings explained
Use these settings to tune accuracy vs. noise:

### Check frequency
Pick from 1, 2, 5, 10, 15, 30, 60 minutes, or 24 hours.
- Short intervals detect incidents faster but can increase noise.
- Longer intervals smooth out brief DNS or network hiccups.

### Immediate re-check (recommended)
When enabled, Exit1 re-checks a failed endpoint after **30 seconds** to confirm it is a real outage before alerting.

### Down confirmation attempts
How many consecutive failed checks are required before marking a target as down.
- Default: **4**
- Range: **1–99**

### HTTP method
For HTTP/HTTPS checks you can choose GET, POST, PUT, PATCH, DELETE, or HEAD.
- **GET is recommended** for uptime checks (some hosts block HEAD).

### Request headers
Add custom headers (one per line). Example:
```
Authorization: Bearer YOUR_TOKEN
Accept: application/json
```
Default User-Agent is `Exit1-Website-Monitor/1.0`.

### Request body
For POST/PUT/PATCH, provide a JSON body (or any plain text) that your endpoint expects.

### Response validation
Provide comma-separated keywords (for example: `success,online,healthy`).
If none are found in the response body, the check is treated as failed.

### Force no-cache
Adds `Cache-Control: no-cache` to the request. Use this if your site is heavily cached.

### Status handling
For HTTP checks, **2xx and 3xx are treated as Up**, and **401/403 also count as Up** for protected endpoints.

### TCP/UDP checks
TCP/UDP checks only verify that a port is reachable. No HTTP headers, bodies, or SSL rules apply.

## Alerts basics
Exit1 supports Email, SMS, and Webhook notifications. All channels can be configured globally and per-check.

### Email alerts
**Setup**
1. Go to **Emails**.
2. Add your email address.
3. Choose alert types: **Down**, **Up**, **SSL Error**, **SSL Warning**.
4. Optionally customize per-check alerts.
5. Send a **Test Email** to confirm delivery.

**How email alerts behave**
- Alerts send only when a check flips states.
- Down/Up alerts can resend roughly a minute after the last one.
- Hourly caps: **Free = 10 emails/hour**, **Nano = 100 emails/hour**.
- Monthly caps apply: **Free = 10 emails/month**, **Nano = 1000 emails/month**.
- **Flap suppression** waits for the number of consecutive results you choose (1–5).
- SSL and domain reminders use longer windows and count toward the budget.

### SMS alerts
**Availability**: SMS alerts are available on the **Nano plan** or for administrators.

**Setup**
1. Go to **SMS**.
2. Add a phone number.
3. Choose alert types (Down, Up, SSL Error, SSL Warning).
4. Optionally customize per-check alerts.
5. Send a **Test SMS**.

**How SMS alerts behave**
- Texts send only when a check flips states.
- Down/Up alerts can resend roughly a minute after the last one.
- SMS uses a **separate hourly budget** to avoid spam.
- Flap suppression waits for the number of consecutive results you choose (1–5).
- SSL and domain reminders use longer windows and count toward the budget.

### Webhook alerts
**Setup**
1. Go to **Webhooks** and click **New Webhook**.
2. Provide an **HTTPS URL** for your endpoint.
3. Select events (Down, Up, SSL Error, SSL Warning).
4. Choose **All checks** or **Include** specific checks only.
5. Optional: add a **secret** and **custom headers** (JSON).
6. Choose a webhook type: **Slack**, **Discord**, or **Generic**.
7. Save and **Test Webhook**.

**Notes**
- Use a secret to help your receiver validate requests.
- Custom headers must be valid JSON (for example: `{"Authorization": "Bearer TOKEN"}`).

## Logs basics
Logs help you understand **why** an alert fired.

**How logs work**
- Logs are stored only when a check changes state or errors.
- If a service is stable, logs will be quiet.

**How to use logs**
1. Go to **Logs**.
2. Select a check and time range.
3. Review status, response time, and any error details.

## What to do next
- Add checks for every critical endpoint.
- Enable at least one alert channel (Email is the fastest to set up).
- Use Webhooks to connect alerts to incident workflows (Slack, Discord, custom systems).
- Watch Logs after your first alert to confirm everything is configured correctly.
