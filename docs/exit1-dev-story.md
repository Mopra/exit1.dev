# Building Exit1.dev: How I Made Premium Website Monitoring Free

*Tired of paying premium for basic tools.*

That's the simple truth that started this whole journey. I was paying $20-50/month for website monitoring services that, frankly, weren't doing anything particularly complex. They were just pinging URLs and sending me emails when things broke. 

So I built my own. And I made it free.

## The Problem with Premium Monitoring

Let's be honest about what most monitoring services actually do:

1. **HTTP requests** - They make GET/HEAD requests to your URLs
2. **Status checking** - They verify response codes and response times  
3. **Alerting** - They send emails/webhooks when things go down
4. **Basic analytics** - They track uptime percentages and response times

That's it. That's the entire value proposition of services charging $20-100/month per user.

The "premium" features? SSL certificate monitoring, domain expiry tracking, custom headers, response validation - these are all trivial to implement. The real cost isn't in the features, it's in the infrastructure to run checks at scale.

But here's the thing: **modern cloud infrastructure makes this incredibly cheap to run at scale.**

## The Architecture That Makes It Possible

Exit1.dev is built on a foundation that would have been impossible just a few years ago. Here's how I made premium monitoring free:

### The Core: Firebase Functions + Firestore

The entire backend runs on **Firebase Functions** - Google's serverless platform. No servers to manage, no scaling headaches, no infrastructure costs until you actually need them.

```typescript
// The heart of the system - one function that checks everything
export const checkAllChecks = onSchedule(`every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`, async () => {
  // Get all checks that need checking
  const checksSnapshot = await firestore
    .collection("checks")
    .where("nextCheckAt", "<=", now)
    .where("disabled", "==", false)
    .limit(CONFIG.MAX_WEBSITES_PER_RUN)
    .get();

  // Process in optimized batches
  const batchSize = CONFIG.getOptimalBatchSize(filteredChecks.length);
  const maxConcurrentChecks = CONFIG.getDynamicConcurrency(filteredChecks.length);
  
  // Execute all checks with true parallelism
  await processBatchesInParallel(checks, batchSize, maxConcurrentChecks);
});
```

**One function. Every minute. Checking thousands of websites.**

### The Cost Optimization Magic

Here's where it gets interesting. Traditional monitoring services run individual functions or containers for each check. That's expensive and inefficient.

I built a **single, highly optimized function** that:

1. **Batches everything** - Processes up to 5,000 websites per run
2. **Uses aggressive concurrency** - Up to 200 concurrent HTTP requests
3. **Implements smart timeouts** - Fast sites get 5-second timeouts, slow sites get 10 seconds
4. **Auto-disables dead sites** - Stops wasting resources on permanently down websites
5. **Uses circuit breakers** - Prevents cascade failures

```typescript
// Dynamic performance optimization based on load
const batchSize = CONFIG.getOptimalBatchSize(filteredChecks.length);
const maxConcurrentChecks = CONFIG.getDynamicConcurrency(filteredChecks.length);

// Adaptive timeout calculation
getAdaptiveTimeout(website: { responseTime?: number; consecutiveFailures: number }): number {
  if (website.consecutiveFailures > 3) {
    return this.HTTP_TIMEOUT_MS; // Full timeout for problematic sites
  }
  
  if (website.responseTime && website.responseTime < 1000) {
    return this.FAST_HTTP_TIMEOUT_MS; // 2 seconds for fast sites
  }
  
  return this.HTTP_TIMEOUT_MS; // Default timeout
}
```

### The Data Architecture

**Real-time state in Firestore** - For the dashboard and live updates
**Historical data in BigQuery** - For analytics and reporting

This dual approach gives you:
- **Instant updates** in the UI (Firestore real-time listeners)
- **Unlimited historical data** (BigQuery scales to petabytes)
- **Cost efficiency** (Firestore for hot data, BigQuery for cold data)

```typescript
// Real-time updates via Firestore listeners
const unsubscribe = onSnapshot(
  query(collection(db, "checks"), where("userId", "==", userId)),
  (snapshot) => {
    const checks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    setChecks(checks);
  }
);

// Historical analytics via BigQuery
const getCheckStats = async (websiteId: string, userId: string) => {
  const query = `
    SELECT 
      COUNT(*) as totalChecks,
      COUNTIF(status IN ('online', 'UP', 'REDIRECT')) as onlineChecks,
      AVG(response_time) as avgResponseTime
    FROM \`exit1-dev.checks.check_history\`
    WHERE website_id = @websiteId AND user_id = @userId
  `;
  return await bigquery.query({ query, params: { websiteId, userId } });
};
```

## The Features That Actually Matter

### SSL Certificate Monitoring
```typescript
// Built into every HTTPS check - no extra cost
const checkSSLCertificate = async (hostname: string, port: number = 443) => {
  return new Promise((resolve) => {
    const socket = tls.connect(port, hostname, { rejectUnauthorized: false });
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const validTo = new Date(cert.valid_to).getTime();
      const daysUntilExpiry = Math.ceil((validTo - Date.now()) / (1000 * 60 * 60 * 24));
      
      resolve({
        valid: socket.authorized,
        issuer: cert.issuer?.CN,
        subject: cert.subject?.CN,
        validFrom: new Date(cert.valid_from).getTime(),
        validTo,
        daysUntilExpiry
      });
    });
  });
};
```

### Domain Expiry Tracking
```typescript
// Uses RDAP (free, modern WHOIS replacement)
const checkDomainExpiry = async (domain: string) => {
  const rdapUrl = `https://rdap.verisign.com/domain/${domain}`;
  const response = await fetch(rdapUrl);
  const data = await response.json();
  
  const expiryDate = data.events?.find(e => e.eventAction === 'expiration')?.eventDate;
  return {
    valid: true,
    registrar: data.entities?.[0]?.vcardArray?.[1]?.[1]?.[3],
    expiryDate: new Date(expiryDate).getTime(),
    daysUntilExpiry: Math.ceil((new Date(expiryDate) - Date.now()) / (1000 * 60 * 60 * 24))
  };
};
```

### Advanced API Monitoring
```typescript
// Full REST API support with custom validation
const checkAPIEndpoint = async (website: Website) => {
  const options = {
    method: website.httpMethod || 'GET',
    headers: {
      'User-Agent': 'Exit1-Website-Monitor/1.0',
      ...website.requestHeaders
    },
    body: website.requestBody,
    timeout: CONFIG.getAdaptiveTimeout(website)
  };

  const response = await fetch(website.url, options);
  
  // Validate response
  if (website.expectedStatusCodes && !website.expectedStatusCodes.includes(response.status)) {
    throw new Error(`Expected status ${website.expectedStatusCodes}, got ${response.status}`);
  }
  
  if (website.responseValidation?.containsText) {
    const text = await response.text();
    const missing = website.responseValidation.containsText.filter(t => !text.includes(t));
    if (missing.length > 0) {
      throw new Error(`Missing required text: ${missing.join(', ')}`);
    }
  }
  
  return { status: 'online', responseTime: Date.now() - startTime, statusCode: response.status };
};
```

## The Frontend: Real-time React Application

The frontend is a **React + TypeScript** application with real-time updates:

- **Real-time updates** via Firestore listeners
- **Optimistic UI** - Changes appear instantly, sync in background
- **Cross-tab synchronization** - Changes in one tab appear in others

```typescript
// Real-time checks with optimistic updates
const { checks, updateCheck, deleteCheck, reorderChecks } = useChecks(userId);

// Optimistic reordering - UI updates immediately
const handleReorder = async (newOrder: Website[]) => {
  // Update UI immediately
  setChecks(newOrder);
  
  // Sync to backend
  try {
    await reorderChecks(newOrder.map((check, index) => ({ 
      id: check.id, 
      orderIndex: index 
    })));
  } catch (error) {
    // Revert on failure
    setChecks(originalOrder);
    toast.error('Failed to reorder checks');
  }
};
```

## The Business Model: How It Stays Free

Here's the beautiful part: **it actually costs almost nothing to run.**

### Firebase Functions Pricing
- **2 million invocations/month** - Free
- **400,000 GB-seconds compute** - Free  
- **5GB outbound data transfer** - Free

### Firestore Pricing
- **1GB storage** - Free
- **50,000 reads/day** - Free
- **20,000 writes/day** - Free

### BigQuery Pricing
- **1TB queries/month** - Free
- **10GB storage** - Free

**For a typical user with 10 websites checked every 3 minutes:**
- Functions: ~14,400 invocations/month (well under 2M free tier)
- Firestore: ~1,000 reads/day (well under 50K free tier)
- BigQuery: ~1GB storage (well under 10GB free tier)

**Total cost per user: $0.00**

Even with 1,000 users, you're still in the free tiers. The economics only break down at massive scale - which is exactly when you'd want to introduce premium features anyway.

## The Technical Challenges I Solved

### Spam Protection
```typescript
// Comprehensive spam protection
const detectSuspiciousPatterns = (checks: Website[], newUrl: string, newName: string) => {
  const newDomain = new URL(newUrl).hostname.toLowerCase();
  
  // Count checks with same domain
  const sameDomainCount = checks.filter(check => {
    try {
      return new URL(check.url).hostname.toLowerCase() === newDomain;
    } catch {
      return false;
    }
  }).length;
  
  if (sameDomainCount >= CONFIG.MAX_SIMILAR_URLS_PER_USER) {
    return { suspicious: true, reason: `Too many checks for the same domain` };
  }
  
  return { suspicious: false };
};
```

### Rate Limiting
```typescript
// Per-user rate limiting
const RATE_LIMITS = {
  CHECKS_PER_MINUTE: 10,
  CHECKS_PER_HOUR: 100, 
  CHECKS_PER_DAY: 500,
  MAX_CHECKS_PER_USER: 100
};

// Email throttling to prevent spam
const acquireEmailThrottleSlot = async (userId: string, checkId: string, eventType: string) => {
  const windowMs = CONFIG.EMAIL_THROTTLE_WINDOW_MS; // 1 hour
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
  
  try {
    await firestore.collection('emailRateLimits').doc(docId).create({
      userId, checkId, eventType, windowStart,
      createdAt: now,
      expireAt: Timestamp.fromMillis(windowStart + windowMs + (10 * 60 * 1000))
    });
    return true; // Slot acquired
  } catch (error) {
    return false; // Already exists - throttled
  }
};
```

### Circuit Breakers
```typescript
// Circuit breaker to prevent cascade failures
const failureCount = (global as any).__failureCount || 0;
if (failureCount > 5) {
  logger.error(`Circuit breaker open: ${failureCount} consecutive failures. Skipping this run.`);
  return;
}
```

## The Features That Actually Matter

### Professional Monitoring Features
- **SSL certificate monitoring** - Automatic for all HTTPS URLs
- **Domain expiry tracking** - Real registrar data via RDAP
- **Advanced API monitoring** - Custom methods, headers, body validation
- **Comprehensive alerting** - Email + webhooks with HMAC signatures
- **Detailed analytics** - BigQuery-powered reports and insights
- **Real-time updates** - Live status changes without page refreshes
- **Cross-tab synchronization** - Changes in one tab appear in others

## The Open Source Question

I'm seriously considering making this open source. Here's why:

1. **The code is clean** - Well-structured, documented, and maintainable
2. **The architecture is sound** - Modern patterns that others can learn from
3. **The problem is universal** - Every developer needs monitoring
4. **The community could help** - More features, better testing, wider adoption

The main question is: **what's the right license and governance model?**

- **MIT License** - Maximum adoption, but no protection against commercial competitors
- **AGPL License** - Prevents commercial competitors, but limits adoption
- **Dual licensing** - Open source for individuals, commercial license for companies

I'm leaning toward **MIT with a clear contribution agreement** that allows me to maintain control while encouraging community participation.

## The Technical Stack

### Backend
- **Firebase Functions** - Serverless compute
- **Firestore** - Real-time database
- **BigQuery** - Analytics and historical data
- **Resend** - Email delivery
- **Node.js** - Runtime environment

### Frontend  
- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Clerk** - Authentication

### Infrastructure
- **Firebase Hosting** - Static site hosting
- **Cloudflare** - CDN and DNS
- **GitHub Actions** - CI/CD

## The Performance Numbers

**Current scale:**
- **~1,000 active users**
- **~5,000 websites monitored**
- **~2.4 million checks per month**
- **~99.9% uptime**
- **~200ms average response time**

**Cost breakdown:**
- **Firebase Functions**: $0 (well under free tier)
- **Firestore**: $0 (well under free tier)  
- **BigQuery**: $0 (well under free tier)
- **Resend**: ~$20/month (email delivery)
- **Domain + hosting**: ~$10/month
- **Total**: ~$30/month for everything

**That's $0.03 per user per month.**

## What I Learned

Building this has been eye-opening. The biggest lesson isn't technical - it's about **questioning the status quo**.

Every "premium" SaaS tool is built on the same foundation:
- HTTP requests
- Database storage  
- Email delivery
- Basic analytics

The difference between a $50/month service and a free one isn't the features - it's the **business model and infrastructure choices**.

Modern cloud platforms (Firebase, Vercel, Supabase, etc.) have made it possible to build and scale applications that would have required massive infrastructure investments just a few years ago.

## The Real Question

The architecture I built can scale to millions of users with minimal changes. But the real question is: **what else can we build this way?**

Every time I see a "premium" SaaS tool, I think: "What's the actual cost to run this? What's the real complexity?"

Most of the time, the answer is: "Not much."

The tools are there. The infrastructure is there. The only thing missing is the willingness to question whether the current pricing makes sense.

## What's Next

I'm still figuring out what to do with this project. The code is solid, the architecture scales, and it's been fun to build. 

Maybe I'll open source it. Maybe I'll keep it as a side project. Maybe I'll use it as a case study for how to build cost-effective SaaS applications.

Either way, it's been a great learning experience. And if nothing else, it proves that **modern cloud infrastructure makes premium monitoring free.**

The question is: what are you going to build with these tools?
