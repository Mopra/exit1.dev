# React Native Integration Guide

This guide covers how to integrate Exit1 monitoring functionality into a React Native application.

## Table of Contents

- [Manual Check API](#manual-check-api)
- [Check Settings Reference](#check-settings-reference)
- [API Endpoints](#api-endpoints)

---

## Manual Check API

The "Check Now" functionality uses a Firebase Callable Function to trigger an immediate check.

### Request Format

**Function Name:** `manualCheck`

**Input:**
```typescript
{ checkId: string }
```

**Response:**
```typescript
{ status: string; lastChecked: number }
```

### React Native Implementation

Using Firebase React Native SDK:

```typescript
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';

const functions = getFunctions();

async function triggerManualCheck(checkId: string): Promise<{ status: string; lastChecked: number }> {
  try {
    const manualCheck = httpsCallable(functions, 'manualCheck');
    const result = await manualCheck({ checkId });

    // result.data = { status: 'online' | 'offline', lastChecked: 1706500000000 }
    return result.data as { status: string; lastChecked: number };
  } catch (error: any) {
    // Handle errors:
    // - 'unauthenticated': User not logged in
    // - 'not-found': Check doesn't exist
    // - 'permission-denied': Check belongs to another user
    throw error;
  }
}
```

### Requirements

1. **User must be authenticated** - The function validates `request.auth.uid`
2. **User must own the check** - The function verifies `checkData.userId === uid`

### Backend Behavior

When called, the function:

1. Validates authentication and ownership
2. Performs the actual check (HTTP request, TCP, or UDP based on check type)
3. Records the result in check history
4. Updates the check document with new status, response time, SSL info
5. Triggers alerts if status changed (email, SMS, webhook)
6. Returns the new status and timestamp

### Error Handling

The function throws `HttpsError` in these cases:

| Error Code | Description |
|------------|-------------|
| `unauthenticated` | No auth token provided |
| `not-found` | Check document doesn't exist |
| `permission-denied` | Check doesn't belong to authenticated user |

---

## Check Settings Reference

### Core Settings (All Check Types)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name (2-50 characters) |
| `url` | string | Yes | Target URL or `tcp://host:port` / `udp://host:port` |
| `type` | string | Yes | `'website'`, `'rest_endpoint'`, `'tcp'`, or `'udp'` |
| `folder` | string \| null | No | Optional folder for organizing checks |
| `disabled` | boolean | No | Enable/disable monitoring (default: `false`) |
| `checkFrequency` | number | Yes | Interval in seconds: 60, 120, 300, 600, 900, 1800, 3600, 86400 |
| `checkRegion` | string | No | `'us-central1'`, `'europe-west1'`, or `'asia-southeast1'` |

#### Tier-Based Frequency Limits

| Tier | Minimum Interval |
|------|------------------|
| Free | 5 minutes (300 seconds) |
| Nano | 2 minutes (120 seconds) |

---

### Failure Confirmation Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `immediateRecheckEnabled` | boolean | `true` | Auto-recheck after 30 seconds on failure before alerting |
| `downConfirmationAttempts` | number | `4` | Consecutive failures required to confirm outage (range: 1-99) |

#### How Failure Confirmation Works

- When `immediateRecheckEnabled: true`:
  - Failed checks auto-recheck within a 5-minute window
  - Outage confirmed only after `downConfirmationAttempts` consecutive failures
  - Prevents false alerts from transient network issues

- When `immediateRecheckEnabled: false`:
  - Alerts trigger immediately on first failure
  - Use for critical services where any downtime matters

---

### HTTP/REST Endpoint Settings

Only applicable for `type: 'website'` or `type: 'rest_endpoint'`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `httpMethod` | string | `'GET'` | HTTP verb: GET, POST, PUT, PATCH, DELETE, HEAD |
| `expectedStatusCodes` | number[] | See below | Status codes considered "up" |
| `requestHeaders` | object | `{}` | Custom headers as key-value pairs |
| `requestBody` | string | `null` | JSON body for POST/PUT/PATCH requests |
| `responseTimeLimit` | number | `null` | Max acceptable response time in ms (max: 25,000) |
| `cacheControlNoCache` | boolean | `false` | Add `Cache-Control: no-cache` header |

#### Default Expected Status Codes

| Check Type | Default Codes |
|------------|---------------|
| Website | `[200, 201, 202, 204, 301, 302, 303, 307, 308]` |
| REST API | `[200, 201, 202, 204]` |

#### Status Code Format

You can specify individual codes or ranges:
- Individual: `200, 201, 204`
- Range: `200-299`
- Mixed: `200-299, 301, 302`

---

### Response Validation

| Field | Type | Description |
|-------|------|-------------|
| `responseValidation.containsText` | string[] | Strings that must ALL appear in response body |

Check fails if any required text is missing. Matching is case-insensitive.

**Example:**
```typescript
responseValidation: {
  containsText: ["healthy", "status: ok"]
}
```

---

### Domain Expiry Monitoring (Nano Tier Only)

| Field | Type | Description |
|-------|------|-------------|
| `domainExpiry.enabled` | boolean | Enable domain registration monitoring |
| `domainExpiry.alertThresholds` | number[] | Days before expiry to alert (default: `[30, 14, 7, 1]`) |

Automatically monitors domain registration expiry via RDAP and sends alerts at configured thresholds.

---

### Read-Only Status Fields

These fields are set by the system and returned in check data:

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Current status: `'online'`, `'offline'`, or `'unknown'` |
| `lastChecked` | number | Timestamp of last check execution |
| `responseTime` | number | Response time in milliseconds |
| `consecutiveFailures` | number | Current failure streak count |
| `consecutiveSuccesses` | number | Current success streak count |
| `lastError` | string | Error message from last failure |
| `lastStatusCode` | number | HTTP status code from last check |
| `detailedStatus` | string | `'UP'`, `'REDIRECT'`, `'REACHABLE_WITH_ERROR'`, or `'DOWN'` |

#### SSL Certificate Info

| Field | Type | Description |
|-------|------|-------------|
| `sslCertificate.valid` | boolean | Certificate validity |
| `sslCertificate.issuer` | string | Certificate issuer |
| `sslCertificate.subject` | string | Certificate subject |
| `sslCertificate.validFrom` | number | Timestamp when cert became valid |
| `sslCertificate.validTo` | number | Timestamp when cert expires |
| `sslCertificate.daysUntilExpiry` | number | Days until expiration |

#### Target Metadata (Geo & Network Info)

| Field | Type | Description |
|-------|------|-------------|
| `targetIp` | string | Resolved IP address |
| `targetCountry` | string | Country code from GeoIP |
| `targetCity` | string | City from GeoIP |
| `targetAsn` | number | Autonomous System Number |
| `targetOrg` | string | Organization name |
| `targetIsp` | string | ISP name |

---

## Example Check Objects

### Website Check

```typescript
const websiteCheck = {
  name: "Company Website",
  url: "https://example.com",
  type: "website",
  checkFrequency: 300, // 5 minutes
  checkRegion: "us-central1",
  immediateRecheckEnabled: true,
  downConfirmationAttempts: 4,
  expectedStatusCodes: [200, 301, 302],
};
```

### REST API Check

```typescript
const apiCheck = {
  name: "Production API",
  url: "https://api.example.com/health",
  type: "rest_endpoint",
  folder: "Production",
  checkFrequency: 120, // 2 minutes (Nano tier)
  checkRegion: "us-central1",

  // Failure confirmation
  immediateRecheckEnabled: true,
  downConfirmationAttempts: 3,

  // HTTP settings
  httpMethod: "GET",
  expectedStatusCodes: [200],
  requestHeaders: {
    "Authorization": "Bearer xxx",
    "Accept": "application/json"
  },
  responseTimeLimit: 5000, // 5 seconds max

  // Response validation
  responseValidation: {
    containsText: ["healthy", "ok"]
  }
};
```

### TCP Port Check

```typescript
const tcpCheck = {
  name: "Database Server",
  url: "tcp://db.example.com:5432",
  type: "tcp",
  checkFrequency: 300,
  checkRegion: "us-central1",
  immediateRecheckEnabled: true,
  downConfirmationAttempts: 2,
};
```

### UDP Port Check

```typescript
const udpCheck = {
  name: "DNS Server",
  url: "udp://ns1.example.com:53",
  type: "udp",
  checkFrequency: 600, // 10 minutes
  checkRegion: "europe-west1",
  immediateRecheckEnabled: false, // Alert on first failure
};
```

---

## API Endpoints

### Firebase Callable Functions

| Function | Description |
|----------|-------------|
| `createCheck` | Create a new check |
| `manualCheck` | Trigger immediate check |

### Firestore Collections

| Collection | Description |
|------------|-------------|
| `checks` | Check configurations |
| `checks/{checkId}/history` | Check execution history (read-only, managed by backend) |

### Direct Firestore Operations

Checks can be read, updated, and deleted directly via Firestore:

```typescript
import firestore from '@react-native-firebase/firestore';

// Read user's checks
const checksRef = firestore()
  .collection('checks')
  .where('userId', '==', currentUser.uid);

// Update a check
await firestore()
  .collection('checks')
  .doc(checkId)
  .update({
    name: 'Updated Name',
    checkFrequency: 600,
    updatedAt: Date.now(),
  });

// Delete a check
await firestore()
  .collection('checks')
  .doc(checkId)
  .delete();
```

---

## Validation Rules

### URL Validation

- Length: 10-2,048 characters
- Allowed protocols: `http://`, `https://`, `tcp://`, `udp://`
- Blocked: localhost, 127.0.0.1, private IP ranges, example.com

### Check Limits

| Tier | Max Checks | Min Interval | Domain Monitoring |
|------|------------|--------------|-------------------|
| Free | 200 | 5 minutes | No |
| Nano | 200 | 2 minutes | Yes |

### Alert Rate Limits

| Tier | Email/Hour | Email/Month | SMS/Hour |
|------|------------|-------------|----------|
| Free | 10 | 10 | 0 |
| Nano | 100 | 1,000 | 30 |
