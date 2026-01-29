# API Cost Protection - Changes Summary

## Problem
Public API invocations spiked to ~1.4K/hour (~1M/month), risking function invocation costs.

## Solution Implemented

### 1. Daily Quotas (New Protection Layer)
Added daily quotas to limit total API usage per day:

- **Per API Key**: 500 requests/day
- **Per User** (all keys combined): 2,000 requests/day

When quota is exceeded:
- Returns HTTP 429 with clear error message
- Includes quota limit and reset time in response
- Logs warning to Cloud Functions logs for monitoring

### 2. Reduced Per-Minute Rate Limits
Made rate limits more conservative to reduce costs:

| Limit Type | Old Value | New Value | Impact |
|------------|-----------|-----------|---------|
| IP per minute | 30 | 20 | -33% |
| API key total per minute | 10 | 5 | -50% |
| Per endpoint per minute | 2 | 1 | -50% |

### 3. Maximum Possible Usage (After Changes)

#### Per API Key
- **Per minute**: 5 requests
- **Per hour**: 300 requests (5/min × 60)
- **Per day**: 500 requests (daily quota limit)
- **Per month**: ~15,000 requests (500/day × 30)

#### Per User (Multiple API Keys)
- **Per day**: 2,000 requests (user quota limit)
- **Per month**: ~60,000 requests (2,000/day × 30)

#### Worst Case Scenario (All Users)
With 10 active API users:
- **Per month**: ~600,000 invocations
- Still within Google's 2M free tier!

### 4. Cost Impact

Google Cloud Functions pricing:
- First 2 million invocations/month: **FREE**
- After that: $0.40 per million

**Before**: 1M invocations/month possible from single user
**After**: 60K invocations/month max per user, 600K for 10 users

✅ **Costs protected** - Even with 30+ API users, you'd stay within the free tier.

## Monitoring & Investigation

### Check Current API Key Usage
Run the usage analysis script:
```bash
npx tsx functions/scripts/check-api-key-usage.ts
```

This shows:
- Which API keys are active right now
- Last used timestamps
- Which endpoints are being called
- Recommendations for action

### Check Cloud Functions Logs
Look for these log messages:
- `API key X exceeded daily quota (500 req/day)`
- `User Y exceeded daily quota (2000 req/day)`

These warnings indicate:
1. Who is hitting the limits
2. When they hit them
3. Whether you need to adjust quotas or disable keys

### Disable Problematic API Keys
If you identify an abusive key:

**Option 1: Via Firestore Console**
1. Go to Firestore → `apiKeys` collection
2. Find the key ID
3. Set `enabled: false`

**Option 2: Via CLI**
```bash
firebase firestore:set apiKeys/KEY_ID '{"enabled": false}' --merge
```

**Option 3: Via Script**
```bash
# Add this to a script
npx firebase-tools firestore:delete apiKeys/KEY_ID
```

## Immediate Action Items

1. **Deploy these changes**:
   ```bash
   npm run deploy:functions --only publicApi
   # Or
   firebase deploy --only functions:publicApi
   ```

2. **Run the usage check**:
   ```bash
   npx tsx functions/scripts/check-api-key-usage.ts
   ```

3. **Review active keys** and disable any that seem suspicious

4. **Monitor for 24 hours** and check if invocations drop

## Expected Results

After deployment:
- Invocations should drop significantly
- Users hitting rate limits will see clear error messages
- Daily quotas will prevent runaway usage
- You'll get warning logs when limits are hit

## Future Enhancements

If you need more control:

1. **Tiered API Plans**
   - Free: 500 req/day (current)
   - Paid: 10,000 req/day
   - Enterprise: Custom limits

2. **API Key Metadata**
   - Add tier field to API keys
   - Adjust limits based on tier

3. **Automated Alerts**
   - Set up Cloud Monitoring alerts
   - Email when daily quota is exceeded
   - Dashboard for API usage metrics

4. **Request Metrics**
   - Track requests per endpoint
   - Identify most expensive endpoints
   - Optimize or cache heavily-used endpoints

## Questions & Troubleshooting

**Q: Will this break existing API users?**
A: Legitimate users making <500 requests/day won't notice any change. Heavy users will see 429 errors with clear quota information.

**Q: What if a user needs more than 500 requests/day?**
A: You can:
- Increase their specific API key's quota (requires code change)
- Create a paid tier with higher limits
- Whitelist specific API keys

**Q: How do I know who's causing the spike?**
A: Run `npx tsx functions/scripts/check-api-key-usage.ts` to see active keys and their users.

**Q: Can I adjust these limits?**
A: Yes! Edit the `RATE_LIMITS` object in [functions/src/public-api.ts:113-122](../functions/src/public-api.ts#L113-L122).
