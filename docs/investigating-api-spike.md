# Investigating Public API Spike

## Current Situation
- publicApi invocations jumped from 0 to ~1.4K/hour suddenly
- Staying at that level (not a temporary spike)
- Total requests: 27,878

## Investigation Steps

### 1. Check Cloud Functions Logs (GCP Console)
Go to: Cloud Functions > publicApi > Logs

Look for:
- Which endpoints are being hit most (`/v1/public/checks`, `/v1/public/checks/:id/history`, etc.)
- Error patterns (401 Unauthorized, 429 Rate Limited, etc.)
- IP addresses making requests
- Request patterns (timing, frequency)

### 2. Check API Key Usage (Firestore Console)
Collection: `apiKeys`

Look for:
- `lastUsedAt` timestamps to identify recently active keys
- `lastUsedPath` to see which endpoints are being called
- Check which users these keys belong to

Query to find recent API key usage:
```
Collection: apiKeys
Order by: lastUsedAt desc
Limit: 10
```

### 3. Check for Rate Limiting
Look in logs for:
- "Rate limit exceeded" responses (429 status codes)
- This would indicate someone is hitting the rate limits

### 4. Rate Limit Configuration (public-api.ts:113-117)
Current limits:
- Pre-auth IP guard: 30 req/min per IP
- Post-auth: 10 req/min total per API key
- Post-auth: 2 req/min per specific endpoint

At 1.4K req/hour = ~23 req/min:
- If it's a single IP: Would be rate limited to 30/min
- If it's a single API key: Would be rate limited to 10/min
- Likely spread across multiple IPs or API keys

### 5. Possible Causes
1. **Legitimate API usage** - Someone building an integration
2. **Polling behavior** - An application checking status repeatedly
3. **API key scanning** - Someone testing different API keys (would show as 401s)
4. **Status page or monitoring tool** - External service polling your API

### 6. Quick Checks

#### Check recent API keys
```sql
SELECT * FROM apiKeys
ORDER BY lastUsedAt DESC
LIMIT 10
```

#### Check for specific users with high usage
Look at which `userId` values appear most in the logs

### 7. What to Do Next

If legitimate traffic:
- Monitor costs
- Consider implementing tiered rate limits
- Add API usage metrics/billing

If suspicious traffic:
- Disable suspicious API keys
- Add IP blocking if needed
- Increase rate limit strictness

If it's a bug:
- Check for any recursive calls
- Verify no internal functions are calling the public API
- Check webhook configurations

## Notes
- The publicApi function is properly rate limited
- No recent code changes that would cause this
- Frontend client doesn't poll the public API (uses Firebase Functions instead)
