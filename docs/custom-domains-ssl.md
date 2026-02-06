# Custom Domains for Status Pages — Caddy On-Demand TLS

Implementation guide for letting users attach their own domain (e.g. `status.acme.com`) to an Exit1 status page with automatic TLS via Caddy.

---

## How It Works

```
Visitor opens https://status.acme.com
    |
    | DNS: CNAME status.acme.com -> caddy.exit1.dev (VM with static IP)
    v
Caddy on VM
    |  No cert cached for this domain?
    |  → Calls "ask" endpoint (Cloud Function) to verify domain is registered
    |  → Approved? Obtains Let's Encrypt cert automatically
    |  → Caches cert on disk for future requests
    |
    | reverse_proxy → Firebase Hosting
    v
Firebase Hosting (SPA)
    |
    | Client-side: window.location.hostname === "status.acme.com"
    | App.tsx detects custom domain, queries Firestore
    v
PublicStatus.tsx renders the matching status page
```

Caddy's on-demand TLS provisions certificates at the moment of the first request.
There is no need to pre-register hostnames with any API — Caddy calls a validation
endpoint ("ask") to check whether a domain should be allowed, then obtains and
renews the Let's Encrypt certificate automatically.

---

## What Already Exists in the Codebase

| Layer | Status | Where |
|-------|--------|-------|
| Custom domain detection | Done | `src/App.tsx:51-59` — checks `window.location.hostname` against an allowlist |
| Firestore lookup by hostname | Done | `src/pages/PublicStatus.tsx:385-389` — queries `status_pages` where `customDomain.hostname == host` |
| Domain type | Done | `src/types.ts:160-163` — `StatusPageCustomDomain { hostname, status }` |
| UI to enter a hostname | Done | `src/pages/Status.tsx` — input field, normalized + validated before save |
| Firestore write | Done | `src/pages/Status.tsx:373-399` — saves `customDomain` to status page doc |
| Backend validation endpoint | **Not built** | Needs `validateCustomDomain` Cloud Function |
| VM + Caddy | **Not built** | Needs Compute Engine VM with Caddy |
| DNS instructions in UI | **Partial** | Currently no CNAME target shown to the user |
| Verification flow | **Not built** | `customDomain.status` exists but is never updated |

---

## VM Strategy

This VM serves double duty:

1. **Caddy reverse proxy** — on-demand TLS for custom status page domains
2. **ICMP ping / low-level checks** — raw socket access not available in Cloud Functions

A single **e2-small** (~$14/mo) or **e2-micro** (~$7/mo) in `us-central1` is sufficient.
Caddy is extremely lightweight and leaves plenty of headroom for ping workers.

---

## Part 1 — VM + Caddy Setup (One-Time)

### 1.1 Create a Compute Engine VM

```bash
gcloud compute instances create exit1-proxy \
  --project=exit1-dev \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --tags=http-server,https-server
```

### 1.2 Reserve a Static IP

```bash
# Reserve a static external IP
gcloud compute addresses create exit1-proxy-ip \
  --project=exit1-dev \
  --region=us-central1

# Get the IP address
gcloud compute addresses describe exit1-proxy-ip \
  --project=exit1-dev \
  --region=us-central1 \
  --format='get(address)'

# Assign it to the VM
gcloud compute instances delete-access-config exit1-proxy \
  --project=exit1-dev \
  --zone=us-central1-a \
  --access-config-name="External NAT"

gcloud compute instances add-access-config exit1-proxy \
  --project=exit1-dev \
  --zone=us-central1-a \
  --address=<STATIC_IP>
```

### 1.3 Firewall Rules

```bash
# Allow HTTP (port 80) — needed for Let's Encrypt HTTP-01 challenges
gcloud compute firewall-rules create allow-http \
  --project=exit1-dev \
  --allow=tcp:80 \
  --target-tags=http-server

# Allow HTTPS (port 443)
gcloud compute firewall-rules create allow-https \
  --project=exit1-dev \
  --allow=tcp:443 \
  --target-tags=https-server
```

### 1.4 DNS Record

Add an A record in your `exit1.dev` Cloudflare DNS (Free plan is fine):

```
Type:  A
Name:  caddy               (=> caddy.exit1.dev)
Value: <STATIC_IP>
Proxy: OFF (gray cloud)    — Caddy needs direct traffic for ACME challenges
```

### 1.5 Install Caddy

SSH into the VM and install Caddy:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### 1.6 Caddyfile

Write to `/etc/caddy/Caddyfile`:

```caddyfile
{
    on_demand_tls {
        ask https://us-central1-exit1-dev.cloudfunctions.net/validateCustomDomain
    }
}

:443 {
    tls {
        on_demand
    }

    reverse_proxy https://app.exit1.dev {
        header_up Host app.exit1.dev
    }
}

# Redirect HTTP to HTTPS (also needed for ACME HTTP-01 challenges —
# Caddy handles challenge routes automatically before the redirect fires)
:80 {
    redir https://{host}{uri} permanent
}
```

**What this does:**

- Any HTTPS request to this VM triggers on-demand TLS
- Before issuing a cert, Caddy calls the `ask` URL with `?domain=status.acme.com`
- If the ask endpoint returns `2xx`, Caddy obtains a Let's Encrypt cert
- Caddy then reverse-proxies to Firebase Hosting at `app.exit1.dev`
- The `Host` header is rewritten to `app.exit1.dev` so Firebase serves the SPA
- The browser still sees `status.acme.com` in the URL bar, so `window.location.hostname` detection works

### 1.7 Start Caddy

```bash
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy

# Check logs if something goes wrong
sudo journalctl -u caddy -f
```

### 1.8 Certificate Storage

Caddy stores certificates on disk at `/var/lib/caddy/.local/share/caddy/`.
On a persistent Compute Engine boot disk, this survives reboots.
No external storage backend needed.

---

## Part 2 — Backend Implementation

The backend is dramatically simpler than the Cloudflare for SaaS approach.
Only one function is needed: the ask endpoint that Caddy calls.

### 2.1 New File: `functions/src/custom-domains.ts`

```typescript
import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

// ── Ask Endpoint ──────────────────────────────────────────────────────
// Caddy calls this before issuing a TLS certificate for a custom domain.
// Returns 200 if the domain is registered, 404 otherwise.
//
// Caddy sends: GET /validateCustomDomain?domain=status.acme.com
//
// This must respond fast — Caddy calls it during the TLS handshake.
export const validateCustomDomain = onRequest(
  { region: 'us-central1' },
  async (req, res) => {
    const domain = req.query.domain as string;

    if (!domain) {
      res.status(400).send('missing domain parameter');
      return;
    }

    const snap = await admin.firestore()
      .collection('status_pages')
      .where('customDomain.hostname', '==', domain)
      .limit(1)
      .get();

    if (snap.empty) {
      res.status(404).send('not found');
      return;
    }

    res.status(200).send('ok');
  }
);

// ── Verify Domain ─────────────────────────────────────────────────────
// Called by the UI when the user clicks "Verify".
// Attempts an HTTPS request to the custom domain to confirm it's working.
import { onCall, HttpsError } from 'firebase-functions/v2/https';

export const verifyCustomDomain = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');

  const { statusPageId } = request.data;
  if (!statusPageId) throw new HttpsError('invalid-argument', 'statusPageId required');

  const db = admin.firestore();
  const pageRef = db.doc(`status_pages/${statusPageId}`);
  const pageSnap = await pageRef.get();

  if (!pageSnap.exists || pageSnap.data()?.userId !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Not your status page');
  }

  const hostname = pageSnap.data()?.customDomain?.hostname;
  if (!hostname) throw new HttpsError('not-found', 'No custom domain set');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(`https://${hostname}`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const isActive = response.ok;

    await pageRef.update({
      'customDomain.status': isActive ? 'verified' : 'pending',
      updatedAt: Date.now(),
    });

    return { status: isActive ? 'verified' : 'pending', httpStatus: response.status };
  } catch {
    // DNS not pointing yet, cert not issued, or timeout
    await pageRef.update({
      'customDomain.status': 'pending',
      updatedAt: Date.now(),
    });
    return { status: 'pending', error: 'Domain not reachable — check CNAME record' };
  }
});
```

### 2.2 Export from `functions/src/index.ts`

```typescript
export { validateCustomDomain, verifyCustomDomain } from './custom-domains';
```

### 2.3 Firestore Type

The existing `StatusPageCustomDomain` type needs no extra fields (no Cloudflare IDs):

```typescript
// src/types.ts
export type StatusPageCustomDomain = {
  hostname?: string | null;
  status?: 'pending' | 'verified' | 'error';
};
```

---

## Part 3 — Frontend Changes

### 3.1 Saving a Custom Domain

When the user saves a custom domain, just write it to Firestore with `status: 'pending'`.
No backend API call needed — the domain becomes active automatically when the user
points their CNAME and the first visitor arrives.

```typescript
// In Status.tsx — on save
if (normalizedCustomDomain) {
  await pageRef.update({
    'customDomain.hostname': normalizedCustomDomain,
    'customDomain.status': 'pending',
    updatedAt: Date.now(),
  });
}
```

### 3.2 Removing a Custom Domain

Just clear it from Firestore. No API call to deregister anything.
Caddy will stop serving the domain because the ask endpoint will return 404.
The cached cert will expire naturally.

```typescript
await pageRef.update({
  customDomain: null,
  updatedAt: Date.now(),
});
```

### 3.3 Show DNS Instructions

After the user saves a custom domain, display:

```
Add a CNAME record at your DNS provider:

  Type:   CNAME
  Name:   status          (or whatever subdomain you chose)
  Value:  caddy.exit1.dev

Once the DNS record propagates (usually 1–10 minutes),
your custom domain will automatically get a TLS certificate
on the first visit.
```

> **Note for Cloudflare users:** If your domain uses Cloudflare, set the
> CNAME record to **DNS-only mode (gray cloud)**. Do not proxy it.

### 3.4 Verification

Add a "Verify" button that calls `verifyCustomDomain`:

```typescript
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

const verify = httpsCallable(functions, 'verifyCustomDomain');
const result = await verify({ statusPageId });
// result.data.status === 'verified' | 'pending'
```

| `status` | UI |
|-----------|------|
| `pending` | "Waiting for DNS..." + Verify button |
| `verified` | Green check + "Custom domain active" |

No polling needed — the user clicks "Verify" when they've added their CNAME.

---

## Part 4 — TLS / SSL Details

### How the Certificate Gets Issued

1. User adds `status.acme.com` in the Exit1 UI
2. Frontend saves it to Firestore with `status: 'pending'`
3. User adds CNAME record: `status.acme.com → caddy.exit1.dev`
4. Someone visits `https://status.acme.com`
5. Caddy receives the TLS handshake, has no cert cached
6. Caddy calls `GET /validateCustomDomain?domain=status.acme.com`
7. Cloud Function checks Firestore → domain exists → returns `200`
8. Caddy requests a Let's Encrypt cert via **TLS-ALPN-01** (or HTTP-01) challenge
9. Cert issued in ~2-5 seconds, cached to disk
10. TLS handshake completes, request is proxied to Firebase Hosting
11. SPA detects `window.location.hostname`, renders the status page

**First visitor** experiences a ~2-5 second delay for cert issuance.
All subsequent visitors get instant TLS from the cached cert.

### Certificate Renewal

Caddy automatically renews certificates ~30 days before expiry.
No cron jobs or manual intervention needed.

### Rate Limits

Let's Encrypt limits:
- 50 certificates per registered domain per week
- 300 new orders per account per 3 hours
- 5 duplicate certificates per week

These are per-domain limits (e.g. per `acme.com`), not total.
Unlikely to hit these unless many customers share the same parent domain.

### End-to-End Encryption

```
Browser ──[TLS 1.2+]──> Caddy VM ──[TLS]──> app.exit1.dev (Firebase Hosting)
```

Both hops are encrypted. Firebase Hosting has a valid cert for `app.exit1.dev`.

---

## Part 5 — User-Facing Flow (End to End)

1. User navigates to **Status Pages** > edits a page > **Step 3: Appearance**
2. Under "Custom Domain", enters `status.acme.com`
3. Clicks Save
4. UI shows:
   ```
   Add this DNS record at your domain provider:

   Type:   CNAME
   Name:   status
   Value:  caddy.exit1.dev

   Status: Waiting for DNS...     [Verify]
   ```
5. User adds the CNAME record at their registrar / DNS provider
6. DNS propagates (typically 1–10 minutes)
7. User clicks **Verify** (or visits `https://status.acme.com` directly)
8. On first visit, Caddy obtains a Let's Encrypt cert in ~2-5 seconds
9. Status page loads with valid TLS
10. UI updates to: **Custom domain active**

---

## Part 6 — Costs

| Item | Cost |
|------|------|
| Compute Engine e2-small (us-central1) | ~$14/month |
| Static IP (while attached to running VM) | Free |
| Let's Encrypt certificates | Free |
| Caddy | Free (open source) |

**Total: ~$14/month** (or ~$7/month with e2-micro), regardless of how many custom domains.

Compare: Cloudflare for SaaS would be $20/month base + $0.10/hostname beyond 100.

---

## Part 7 — Checklist

### One-Time VM Setup
- [ ] Create Compute Engine VM (e2-small, us-central1)
- [ ] Reserve and assign static external IP
- [ ] Open firewall for ports 80 and 443
- [ ] Add `caddy.exit1.dev` A record pointing to static IP (gray cloud / DNS-only)
- [ ] Install Caddy on the VM
- [ ] Write Caddyfile with on-demand TLS config
- [ ] Start and enable Caddy systemd service
- [ ] Verify Caddy is running: `curl -I https://caddy.exit1.dev`

### Code Changes
- [ ] Create `functions/src/custom-domains.ts` (validateCustomDomain + verifyCustomDomain)
- [ ] Export functions from `functions/src/index.ts`
- [ ] Update `Status.tsx` — save custom domain directly to Firestore (no API call)
- [ ] Add DNS instruction UI after domain save
- [ ] Add "Verify" button calling `verifyCustomDomain`
- [ ] Update `App.tsx` allowlist to accept any hostname (or remove allowlist in favor of Firestore query)
- [ ] Deploy functions: `npx firebase deploy --only functions`

### Verification
- [ ] Test with a real subdomain you control
- [ ] Confirm first visit triggers cert issuance (check Caddy logs)
- [ ] Confirm status page loads correctly via custom domain
- [ ] Confirm "Verify" button correctly detects active domains
- [ ] Confirm removing a custom domain causes Caddy to reject new cert requests
- [ ] Confirm cert renewal works (check Caddy logs after 60 days, or force-renew with `caddy reload`)

---

## References

- [Caddy on-demand TLS](https://caddyserver.com/docs/caddyfile/options#on-demand-tls)
- [Caddy reverse_proxy directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/)
- [Install Caddy on Debian/Ubuntu](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)
