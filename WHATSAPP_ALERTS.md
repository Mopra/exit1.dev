# WhatsApp alerts (Meta WhatsApp Cloud API)

WhatsApp is a second transport of the SMS channel. A user adds WhatsApp numbers on the SMS page, ticks the consent box, and those numbers get every alert the SMS settings allow (same events, per-check and per-folder filters, throttle, hourly and monthly budget, retry flags). Pro only, like SMS.

Why: SMS no longer reaches South Africa, Brazil, Belgium, Japan and most of the world (cost, or no sender since the Danish Twilio number was released on 2026-10-22). WhatsApp reaches every country except Cuba, Iran, North Korea and Syria.

## Code

| Piece | File |
|---|---|
| Country rule + recipient getter | `functions/src/whatsapp-countries.ts` |
| Template builders + Graph API send | `functions/src/alert-whatsapp.ts` |
| Send path (status + SSL) | `functions/src/alert.ts`, inside the SMS `deliverSmsAlert` send function |
| Credentials | `functions/src/env.ts` (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`) |
| Save / get / test callables | `functions/src/sms.ts` (`saveSmsSettings`, `getSmsSettings`, `sendTestSms({ channel: 'whatsapp' })`) |
| UI | `src/pages/Sms.tsx`, `src/hooks/useNotificationSettings.ts` |
| Firestore | `smsSettings/{uid}.whatsappRecipients`, `smsSettings/{uid}.whatsappOptInAt` |

The feature is dark while either secret holds the placeholder `unset`: `getSmsSettings` returns `whatsappAvailable: false`, the UI hides everything WhatsApp, saves with WhatsApp numbers are refused, and the alert path skips WhatsApp numbers.

Not covered yet: domain expiry alerts (`alert-domain.ts`) stay SMS only; there is no inbound webhook, so delivery failures after Meta accepts a message (for example a number without WhatsApp, error 131026) and "STOP" replies are not seen. Users turn WhatsApp off on the SMS page.

## Setup (human steps)

1. **Meta Business verification.** business.facebook.com, Security Center, verify the business (exit1 / the legal entity behind it).
2. **WhatsApp Business Account + phone number.** developers.facebook.com, create an app of type Business, add the WhatsApp product, then in WhatsApp Manager add a phone number. Display name "Exit1".
   - A number registered on WhatsApp Cloud API can not be used on the WhatsApp apps, but it can still send SMS through Twilio. Registering verifies by SMS or voice call: the Twilio toll-free +18446235510 can receive the code through Twilio's inbound SMS (forwarded by `twilioInboundSms` to morten@exit1.dev), or choose voice and read it from the Twilio call log. A fresh number is the safer choice if unsure.
3. **Payment method** in WhatsApp Manager (Meta bills per delivered template).
4. **Permanent token.** Business Settings, System Users, add a system user (Admin), assign the app and the WhatsApp Business Account, generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`, no expiry.
5. **Templates.** WhatsApp Manager, Message templates, create the four below. Category **Utility**, language **English (en)**. Names and the order of `{{n}}` must match exactly.
6. **Hand over** the token and the Phone Number ID (a long number shown next to the phone number in API Setup, not the phone number itself).

## Go-live (a session can do this)

1. `firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` with the real values.
2. Redeploy every function that binds them (Gen2 pins secret versions, `deploy:changed` will not see a secret change): `saveSmsSettings`, `getSmsSettings`, `sendTestSms`.
3. Add `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` to `/opt/exit1/repo/vps/.env` on both VPSes (exit1-eu, exit1-us), then rebuild/restart both with `/opt/exit1/deploy.sh`.
4. Deploy hosting.
5. Add an own number on the SMS page, Send test WhatsApp, then force a down/up on a test check.
6. `npm run secrets:prune` afterwards (old `unset` versions).

## Templates

Submit each with the sample values shown; Meta reviews them against the samples.

### exit1_check_down

Body:

```
Exit1 alert: {{1}} is down.
Status: {{2}}
URL: {{3}}
```

Samples: `{{1}}` Shop API, `{{2}}` 503 Service Unavailable, `{{3}}` https://shop.example.com

Footer: `Manage alerts at app.exit1.dev`

### exit1_check_up

Body:

```
Exit1 alert: {{1}} is back up.
Status: {{2}}
URL: {{3}}
```

Samples: `{{1}}` Shop API, `{{2}}` 200 OK, was offline, 120ms, `{{3}}` https://shop.example.com

Footer: `Manage alerts at app.exit1.dev`

### exit1_ssl_alert

Body:

```
Exit1 SSL alert for {{1}}: {{2}}.
URL: {{3}}
```

Samples: `{{1}}` Shop API, `{{2}}` expires in 7 days, `{{3}}` https://shop.example.com

Footer: `Manage alerts at app.exit1.dev`

### exit1_test

Body (no parameters):

```
Exit1 test: WhatsApp alerts are set up for this number. You will get a message here when one of your checks goes down or comes back up.
```

Footer: `Manage alerts at app.exit1.dev`

## Pricing

Meta charges per delivered utility template, by the recipient's country, with volume tiers. Rates are on Meta's own rate card (developers.facebook.com/docs/whatsapp/pricing, "rate cards and volume tiers by currency", or the interactive table at whatsappbusiness.com/products/platform-pricing). Since 2026-10-01 utility templates are charged even inside an open customer service window. Read the rate card for the target countries before quoting prices; the figures in earlier notes came from third-party blogs.

## After launch

Compare WhatsApp and SMS sends (`sms_sent` metrics and the ALERT log lines) for a month or two before deciding whether to retire SMS.
