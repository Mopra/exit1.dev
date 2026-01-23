# Clerk to Resend Contacts Sync

This guide explains how to sync Clerk users to Resend Contacts for marketing emails.

## Overview

- **New users**: Automatically added to Resend Contacts via Clerk webhook
- **Existing users**: One-time sync function to backfill all users
- **Data synced**: Email, first name, last name

Contacts in Resend are global - they appear in your Audience and can be targeted via Segments and Broadcasts.

## Prerequisites

- Resend account with API access (you already have `RESEND_API_KEY` configured)
- Clerk account (production and/or development instance)
- Firebase Functions deployed

## Setup

### Step 1: Set Firebase Secret for Clerk Webhook

```bash
# Set the Clerk Webhook Secret (you'll get this in Step 3)
firebase functions:secrets:set CLERK_WEBHOOK_SECRET
# Paste the signing secret when prompted
```

### Step 2: Deploy the Functions

```bash
cd functions
firebase deploy --only functions:clerkWebhook,functions:syncClerkUsersToResend
```

Note the deployed URL for `clerkWebhook`:
```
https://<region>-<project-id>.cloudfunctions.net/clerkWebhook
```

### Step 3: Configure Clerk Webhook

1. Go to [Clerk Dashboard](https://dashboard.clerk.com) > **Webhooks**
2. Click **Add Endpoint**
3. Enter the Firebase function URL from Step 2
4. Under "Subscribe to events", select:
   - `user.created`
5. Click **Create**
6. Copy the **Signing Secret** (starts with `whsec_`)
7. Set it in Firebase (see Step 1)
8. Redeploy functions if you set the secret after deploying:
   ```bash
   firebase deploy --only functions:clerkWebhook
   ```

### Step 4: Sync Existing Users (One-Time)

Backfill all existing Clerk users to Resend Contacts.

#### Option A: Using Firebase Functions Shell

```bash
cd functions
firebase functions:shell
```

Then run:
```javascript
// Dry run first (no changes made)
// Note: data is first arg, auth context is second arg
syncClerkUsersToResend({ instance: 'prod', dryRun: true }, { auth: { uid: 'admin' } })

// Actual sync
syncClerkUsersToResend({ instance: 'prod', dryRun: false }, { auth: { uid: 'admin' } })

```

#### Option B: From Your App

```typescript
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const syncUsers = httpsCallable(functions, 'syncClerkUsersToResend');

// Dry run first
const dryRunResult = await syncUsers({ instance: 'prod', dryRun: true });
console.log('Dry run result:', dryRunResult.data);

// Actual sync
const result = await syncUsers({ instance: 'prod', dryRun: false });
console.log('Sync result:', result.data);
```

#### Sync Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `instance` | `'prod'` \| `'dev'` | `'prod'` | Which Clerk instance to sync from |
| `dryRun` | `boolean` | `false` | If true, logs what would be synced without making changes |

#### Sync Response

```json
{
  "success": true,
  "stats": {
    "total": 150,
    "synced": 145,
    "skipped": 3,
    "errors": 2,
    "dryRun": false
  },
  "errors": [
    { "email": "invalid@example", "error": "Invalid email format" }
  ]
}
```

## How It Works

### Webhook Flow (New Users)

```
User signs up in Clerk
        |
        v
Clerk sends user.created webhook
        |
        v
clerkWebhook function receives it
        |
        v
Verifies signature with Svix
        |
        v
Extracts email, firstName, lastName
        |
        v
Creates contact in Resend
        |
        v
Contact appears in your Audience dashboard
```

### Sync Flow (Existing Users)

```
User calls syncClerkUsersToResend
        |
        v
Fetches all users from Clerk (paginated)
        |
        v
For each user:
  - Extract primary email
  - Create contact in Resend
  - Handle duplicates gracefully
        |
        v
Returns stats and errors
```

## Sending Marketing Emails

After syncing, you can send marketing emails via:

1. **Resend Dashboard**: Go to Broadcasts > Create Broadcast
2. **Resend API**: Use the Broadcasts API to send programmatically
3. **Segments**: Create segments to target specific users (e.g., by sign-up date)

## Troubleshooting

### Webhook not receiving events

1. Check the Clerk Dashboard > Webhooks > your endpoint for delivery logs
2. Verify the endpoint URL is correct and publicly accessible
3. Check Firebase Functions logs:
   ```bash
   firebase functions:log --only clerkWebhook
   ```

### Signature verification failed

1. Ensure `CLERK_WEBHOOK_SECRET` matches the signing secret in Clerk Dashboard
2. Redeploy functions after setting the secret:
   ```bash
   firebase deploy --only functions:clerkWebhook
   ```

### Contact already exists error

This is handled gracefully - the contact won't be duplicated. The sync will count it as "skipped".

### Rate limiting

The sync function includes a 100ms delay between API calls to avoid Resend rate limits. For very large user bases (10,000+), consider running the sync in batches.

## Firebase Secrets Reference

| Secret | Description |
|--------|-------------|
| `RESEND_API_KEY` | Your Resend API key (already configured) |
| `CLERK_WEBHOOK_SECRET` | Clerk webhook signing secret for verification |
| `CLERK_SECRET_KEY_PROD` | Clerk production secret key (already configured) |
| `CLERK_SECRET_KEY_DEV` | Clerk development secret key (already configured) |

## Files

| File | Purpose |
|------|---------|
| `functions/src/clerk-webhook.ts` | Webhook handler and sync function |
| `functions/src/env.ts` | Secret definitions |
| `functions/src/index.ts` | Function exports |
