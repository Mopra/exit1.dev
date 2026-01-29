# Custom Domains SSL for Status Pages

This document outlines options for enabling automatic SSL provisioning for custom domains on user status pages.

## Problem

Users want to use their own domains (e.g., `status.example.com`) for their status pages. Currently:
- The app code already detects custom domains and routes to the correct status page
- DNS: Users point their CNAME to `app.exit1.dev`
- **Issue**: Firebase Hosting requires each custom domain to be manually added in the Firebase Console for SSL to work
- This doesn't scale for a SaaS product

## Current Architecture

```
User visits status.example.com
        ↓
    CNAME → app.exit1.dev
        ↓
    Firebase Hosting (no SSL cert for status.example.com)
        ↓
    ❌ SSL Error
```

## Solution Options

### Option 1: Cloudflare for SaaS (Recommended)

**Cost**: $20/month (Pro plan) + $0.10/hostname after first 100

**How it works**:
- Cloudflare acts as a proxy between custom domains and Firebase
- Automatically provisions SSL certificates for any custom hostname
- Handles certificate renewal automatically

**Architecture**:
```
User visits status.example.com
        ↓
    CNAME → custom.exit1.dev (Cloudflare)
        ↓
    Cloudflare (auto SSL provisioning)
        ↓
    Fallback origin → app.exit1.dev (Firebase)
        ↓
    ✅ Works with valid SSL
```

**Setup Steps**:

1. **Upgrade exit1.dev to Pro plan** ($20/month)
   - Cloudflare Dashboard → exit1.dev → Overview → Change plan

2. **Enable Custom Hostnames**
   - Go to SSL/TLS → Custom Hostnames
   - Click "Enable Custom Hostnames"

3. **Create a fallback origin**
   - Add a DNS record: `custom-origin.exit1.dev` → points to Firebase
   - Or use `app.exit1.dev` as the fallback origin

4. **Configure the fallback origin in Cloudflare**
   - SSL/TLS → Custom Hostnames → Add Fallback Origin
   - Enter: `app.exit1.dev` or `custom-origin.exit1.dev`

5. **Add custom hostnames via API**
   When a user adds a custom domain in the app, call the Cloudflare API:
   
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/custom_hostnames" \
     -H "Authorization: Bearer {api_token}" \
     -H "Content-Type: application/json" \
     --data '{
       "hostname": "status.example.com",
       "ssl": {
         "method": "http",
         "type": "dv"
       }
     }'
   ```

6. **Update user DNS instructions**
   Change from:
   > Create a CNAME record pointing to `app.exit1.dev`
   
   To:
   > Create a CNAME record pointing to `custom.exit1.dev`

**API Integration** (Firebase Function):

```typescript
// functions/src/custom-domains.ts
import { onCall } from 'firebase-functions/v2/https';

const CLOUDFLARE_ZONE_ID = 'your_zone_id';
const CLOUDFLARE_API_TOKEN = 'your_api_token';

export const addCustomHostname = onCall(async (request) => {
  const { hostname } = request.data;
  
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/custom_hostnames`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostname,
        ssl: { method: 'http', type: 'dv' },
      }),
    }
  );
  
  return response.json();
});

export const deleteCustomHostname = onCall(async (request) => {
  const { hostnameId } = request.data;
  
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/custom_hostnames/${hostnameId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
      },
    }
  );
  
  return response.json();
});
```

---

### Option 2: Cloudflare Workers (Cheaper Alternative)

**Cost**: $5/month (Workers Paid plan) or free tier (100k requests/day)

**How it works**:
- A Cloudflare Worker acts as a reverse proxy
- Custom domains point to the Worker
- Worker fetches content from Firebase and serves it
- Cloudflare handles SSL automatically for domains in your zone

**Limitations**:
- Custom domains must be added to YOUR Cloudflare account (not automatic)
- Or users must use Cloudflare and set up the Worker on their end
- More complex setup for true multi-tenant custom domains

**Architecture**:
```
User visits status.example.com
        ↓
    CNAME → status-proxy.exit1.dev (Cloudflare Worker)
        ↓
    Worker fetches from app.exit1.dev
        ↓
    Returns response with correct headers
        ↓
    ✅ Works (but domain must be in your CF account)
```

**Worker Code**:

```javascript
// workers/status-proxy.js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    
    // Preserve the original host for the app to detect
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.hostname);
    
    // Fetch from Firebase
    const firebaseUrl = `https://app.exit1.dev${url.pathname}${url.search}`;
    
    const response = await fetch(firebaseUrl, {
      method: request.method,
      headers,
      body: request.body,
    });
    
    // Return with modified headers
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Served-By', 'exit1-status-proxy');
    
    return newResponse;
  },
};
```

**Setup Steps**:

1. **Create Worker**
   - Cloudflare Dashboard → Workers & Pages → Create Worker
   - Deploy the proxy code above

2. **Add Custom Domain Route**
   - Workers & Pages → Your Worker → Settings → Triggers
   - Add custom domain route

3. **Update app to read X-Forwarded-Host**
   - Modify `App.tsx` to check `X-Forwarded-Host` header for custom domain detection

**Problem with Workers approach**:
The custom domain still needs to be in YOUR Cloudflare account to get automatic SSL. For truly user-provided domains, you'd need to:
- Have users add their domain to Cloudflare (bad UX)
- Or use Cloudflare for SaaS anyway

---

### Option 3: Migrate to Vercel

**Cost**: Free tier available, Pro $20/month for teams

**How it works**:
- Vercel has built-in support for custom domains with automatic SSL
- Add domains via Vercel API, SSL provisioned automatically

**Pros**:
- Simpler API than Cloudflare
- Built specifically for frontend hosting
- Good Next.js integration if you migrate

**Cons**:
- Requires migrating from Firebase Hosting
- Need to handle Firebase Functions separately (or migrate to Vercel Functions)

---

### Option 4: Keep Manual (Current State)

**Cost**: Free

For now, custom domains can be added manually:

1. User requests custom domain in app
2. Admin manually adds domain in Firebase Console → Hosting → Add custom domain
3. SSL provisioned by Firebase (15-30 min)

**Suitable for**:
- Low volume of custom domain requests
- Early stage while evaluating other options

---

## Recommendation

**Short term**: Use Option 4 (manual) for `status.exit1.dev` and any early customers.

**Long term**: Implement Option 1 (Cloudflare for SaaS) when:
- You have paying customers using custom domains
- The $20/month cost is justified by revenue

## Implementation Checklist

- [ ] Add `status.exit1.dev` manually to Firebase Hosting (immediate fix)
- [ ] Decide on long-term solution
- [ ] If Cloudflare for SaaS:
  - [ ] Upgrade to Pro plan
  - [ ] Configure fallback origin
  - [ ] Create Firebase Function for Cloudflare API integration
  - [ ] Update Status.tsx to call the function when adding custom domains
  - [ ] Update DNS instructions in the UI
- [ ] Update `customDomain.status` field to reflect actual SSL status from Cloudflare API

## References

- [Cloudflare for SaaS docs](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/)
- [Cloudflare Custom Hostnames API](https://developers.cloudflare.com/api/operations/custom-hostname-for-a-zone-list-custom-hostnames)
- [Vercel Domains API](https://vercel.com/docs/rest-api/endpoints#domains)
