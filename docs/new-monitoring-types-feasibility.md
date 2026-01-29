# New Monitoring Types: Feasibility & Implementation Analysis

**Date:** January 28, 2026
**Author:** Technical Analysis
**Status:** Research & Planning

## Executive Summary

This document analyzes the feasibility of implementing four new monitoring types requested by a user:
1. **WebSocket (WS) Monitoring** ✅ Fully Feasible
2. **WebSocket Secure (WSS) Monitoring** ✅ Fully Feasible
3. **ICMP Ping Monitoring** ⚠️ Limited (Alternative Approach Required)
4. **DNS Record Monitoring** ✅ Fully Feasible

All monitoring types can be implemented within the existing Cloud Functions architecture, with ICMP ping requiring a hybrid approach or third-party integration due to platform limitations.

---

## 1. WebSocket (WS/WSS) Monitoring

### Overview
WebSocket monitoring allows real-time connection testing to WebSocket endpoints, validating that connections can be established and optionally checking for specific message content or patterns.

### ✅ Feasibility: **HIGH**

### Technical Implementation

#### Core Library
Use the [`ws` library](https://github.com/websockets/ws) - the most popular, battle-tested WebSocket client for Node.js with native support in Node.js v22+ (our current runtime).

```javascript
import WebSocket from 'ws';

async function checkWebSocketEndpoint(url, options = {}) {
  const {
    timeout = 10000,
    expectedMessage = null,
    messageToSend = null,
    followRedirects = true
  } = options;

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let ws;

    try {
      ws = new WebSocket(url, {
        handshakeTimeout: timeout,
        followRedirects
      });

      // Timeout handler
      const timeoutId = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connection timeout after ${timeout}ms`));
      }, timeout);

      ws.on('open', () => {
        const connectionTime = Date.now() - startTime;

        // If we just need to verify connection
        if (!expectedMessage && !messageToSend) {
          clearTimeout(timeoutId);
          ws.close();
          resolve({
            status: 'UP',
            responseTime: connectionTime,
            message: 'WebSocket connection established'
          });
          return;
        }

        // Send test message if specified
        if (messageToSend) {
          ws.send(messageToSend);
        }
      });

      ws.on('message', (data) => {
        const responseTime = Date.now() - startTime;
        const message = data.toString();

        // Check for expected content
        if (expectedMessage) {
          const containsExpected = message.includes(expectedMessage);
          clearTimeout(timeoutId);
          ws.close();

          resolve({
            status: containsExpected ? 'UP' : 'CONTENT_MISMATCH',
            responseTime,
            message: message.substring(0, 1000), // Capture first 1KB
            contentMatch: containsExpected
          });
        } else {
          clearTimeout(timeoutId);
          ws.close();
          resolve({
            status: 'UP',
            responseTime,
            message: message.substring(0, 1000)
          });
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timeoutId);
        if (code !== 1000) { // Normal closure
          reject(new Error(`WebSocket closed with code ${code}: ${reason}`));
        }
      });

    } catch (error) {
      reject(error);
    }
  });
}
```

#### Integration Points

**Check Configuration (Firestore `checks` collection):**
```typescript
interface WebSocketCheck extends BaseCheck {
  type: 'websocket' | 'websocket_secure';
  url: string; // ws:// or wss://
  messageToSend?: string; // Optional message to send on connection
  expectedMessage?: string; // Optional content validation
  expectedMessageMode?: 'contains' | 'exact' | 'regex'; // How to match
  followRedirects?: boolean;
  customHeaders?: Record<string, string>; // For initial HTTP handshake
}
```

**Execution Flow:**
1. Scheduler picks up WebSocket checks (same as existing HTTP checks)
2. `checkWebSocketEndpoint()` executes the connection test
3. Results recorded with standard metrics:
   - Connection time (handshake completion)
   - Message round-trip time (if sending/receiving)
   - Content validation status
   - Error details on failure

#### Features to Implement

**Phase 1 (MVP):**
- [x] Basic WS/WSS connection testing
- [x] Connection timeout configuration
- [x] Response time measurement
- [x] Status determination (UP/DOWN)

**Phase 2 (Enhanced):**
- [ ] Send custom messages on connect
- [ ] Content validation (text contains check)
- [ ] Message round-trip timing
- [ ] Custom headers for HTTP upgrade request

**Phase 3 (Advanced):**
- [ ] Regex pattern matching for responses
- [ ] Multiple message exchange sequences
- [ ] Ping/pong heartbeat monitoring
- [ ] Authentication support (Bearer tokens, etc.)

### Cost Impact

#### Minimal Additional Costs

**Compute Time:**
- WebSocket checks complete faster than HTTP checks (10-20ms for handshake vs 50-500ms for HTTP)
- Similar CPU-sec consumption to existing TCP checks
- **Impact:** Negligible increase

**Network Egress:**
- WebSocket handshake ~500 bytes (HTTP upgrade request + response)
- Optional message exchange: 100-1000 bytes typically
- **Per check:** ~1 KB per execution
- **At scale (10,000 checks/2min):** ~5 KB × 30 runs/hour = 150 KB/hour = 3.6 MB/day = 108 MB/month per 10K checks
- Well within Firebase's 5 GB free tier
- **Impact:** Negligible increase

**Function Invocations:**
- No additional invocations (uses existing scheduler)
- **Impact:** None

**Total Estimated Cost Increase:** < $0.01/month per 10,000 WebSocket checks

### Implementation Effort

- **Complexity:** Low-Medium
- **Development Time:** 4-6 hours
- **Testing Time:** 2-3 hours
- **Dependencies:** `ws` package (already stable in Node.js ecosystem)

### References & Resources

- [WebSocket Implementation for Node.js - GitHub](https://github.com/websockets/ws)
- [Node.js WebSocket Documentation](https://nodejs.org/en/learn/getting-started/websocket)
- [WebSocket Libraries for Node - Ably Blog](https://ably.com/blog/websocket-libraries-for-node)
- [How to Use WebSocket in Node.js - Apidog](https://apidog.com/blog/how-to-use-websocket-in-node-js/)

---

## 2. ICMP Ping Monitoring

### Overview
ICMP ping monitoring tests network-level connectivity to hosts without requiring HTTP services, useful for monitoring infrastructure like backup servers, network devices, and edge infrastructure.

### ⚠️ Feasibility: **MEDIUM** (Platform Limitations)

### Critical Limitation

**Firebase Cloud Functions (and all serverless platforms) cannot send ICMP packets directly.**

#### Why?
- ICMP requires raw socket access with `CAP_NET_RAW` Linux kernel capability
- Cloud Functions run in containerized environments without this capability
- Even command-line `ping` utilities won't work
- This is a fundamental security restriction across all major serverless platforms (AWS Lambda, Azure Functions, Google Cloud Functions)

**Source:** [AWS Lambda Ping Discussion](https://repost.aws/questions/QUuZk4GSIdQcqvKrsiay82Hw/ping-url-or-dns-name-from-lambda-function), [ICMP Sockets - Patrick Ekman](https://ekman.cx/articles/icmp_sockets/)

### Alternative Approaches

#### Option 1: HTTP-Based Reachability (Recommended ✅)

**Implementation:** Extend existing HTTP checks with "ping-like" behavior.

```javascript
async function checkHttpReachability(host, options = {}) {
  const {
    port = 80,
    protocol = 'http',
    timeout = 5000
  } = options;

  const url = `${protocol}://${host}:${port}`;
  const startTime = Date.now();

  try {
    // Use HEAD request for minimal data transfer
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual' // Don't follow redirects
    });

    const responseTime = Date.now() - startTime;

    return {
      status: 'REACHABLE',
      responseTime,
      httpStatus: response.status,
      reachable: true
    };

  } catch (error) {
    return {
      status: 'UNREACHABLE',
      responseTime: Date.now() - startTime,
      error: error.message,
      reachable: false
    };
  }
}
```

**Pros:**
- Works within Cloud Functions restrictions
- No additional cost or complexity
- Provides response time metrics
- Already have HTTP monitoring infrastructure

**Cons:**
- Requires target to run a web server
- Not true ICMP ping (different network layer)
- Cannot test network equipment without HTTP interface

**User Impact:**
- Most servers today run HTTP services (even minimal ones)
- Can recommend users set up lightweight HTTP endpoints on infrastructure
- Could provide nginx/lighttpd config examples for minimal health endpoints

#### Option 2: TCP Port Check (Currently Supported ✅)

**We already support this!** TCP checks can verify connectivity to any port.

```typescript
// Already implemented in check-utils.ts
async function checkTcpEndpoint(url, timeout) {
  // Connects to TCP port and verifies socket establishment
  // Example: tcp://backup-server.example.com:22 (SSH)
  // Example: tcp://192.168.1.1:443 (HTTPS port)
}
```

**Usage for "ping-like" monitoring:**
- `tcp://server.example.com:22` (SSH port for Linux servers)
- `tcp://server.example.com:3389` (RDP port for Windows servers)
- `tcp://server.example.com:443` (HTTPS port)

**Pros:**
- Already implemented and working
- Verifies network connectivity
- Works for infrastructure without HTTP
- Fast (<100ms typically)

**Cons:**
- Requires open port on target
- Not exactly ICMP ping

**Recommendation:** Document TCP checks as "ping alternative" for infrastructure monitoring.

#### Option 3: Third-Party Ping API Integration (Future Enhancement 🔮)

Use external services that provide ICMP ping via HTTP API.

**Example Services:**
- [Globalping API](https://blog.globalping.io/run-ping-with-http-using-globalping-api/) - Free ICMP ping via HTTP
- CloudProber by Google (self-hosted)
- Commercial ping monitoring services (Pingdom, UptimeRobot, etc.)

**Implementation:**
```javascript
async function checkIcmpViaGlobalping(host, options = {}) {
  const { locations = ['US-East'], timeout = 10000 } = options;

  const response = await fetch('https://api.globalping.io/v1/measurements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'ping',
      target: host,
      locations: locations.map(loc => ({ magic: loc })),
      measurementOptions: {
        packets: 3
      }
    })
  });

  const measurement = await response.json();
  const results = await pollForResults(measurement.id, timeout);

  return {
    status: results.stats.loss < 100 ? 'UP' : 'DOWN',
    responseTime: results.stats.avg,
    packetLoss: results.stats.loss,
    jitter: results.stats.mdev
  };
}
```

**Pros:**
- True ICMP ping capability
- Multi-location testing possible
- Works within Cloud Functions

**Cons:**
- Dependency on third-party service
- Additional API call latency (200-500ms overhead)
- Potential costs for commercial services
- Rate limits on free tiers

**Cost Impact:**
- Globalping: Free tier available, then usage-based
- Would add egress costs for API calls (~5-10 KB per check)
- API response handling adds compute time

#### Option 4: Hybrid Architecture with Compute Engine VM (Complex ⚠️)

Deploy a lightweight VM with raw socket capabilities to perform actual ICMP pings, orchestrated by Cloud Functions.

**Architecture:**
```
Cloud Functions (Scheduler)
    ↓ (HTTP API)
Compute Engine VM (f1-micro)
    ↓ (Real ICMP Ping)
Target Servers
    ↓ (Results)
Cloud Functions (Process Results)
```

**Pros:**
- True ICMP ping capability
- Full control over implementation
- Can support advanced features (MTU discovery, etc.)

**Cons:**
- **Significant complexity increase**
- **Always-on VM costs:** ~$5-10/month per region
- Requires VM management, updates, monitoring
- Additional failure points
- Overkill for most use cases

**Recommendation:** Only consider if users specifically demand true ICMP and are willing to pay premium tier.

### Recommended Implementation Strategy

**Phase 1 (Immediate):**
1. Document TCP port checks as "Infrastructure Connectivity Monitoring"
2. Market as ping alternative: "Monitor servers without web interfaces"
3. Add UI guidance: "Use tcp://hostname:22 for Linux servers, tcp://hostname:3389 for Windows"

**Phase 2 (3-6 months):**
1. If user demand is high, integrate Globalping API or similar
2. Add new check type: `ping` that uses third-party API
3. Transparent to users (they configure target, we handle API)

**Phase 3 (12+ months, Premium Tier):**
1. If enterprise customers demand true ICMP, build hybrid architecture
2. Deploy regional ICMP ping VMs
3. Offer as premium add-on ($5-10/month)

### Cost Impact

#### Option 1 (HTTP Reachability):
- **Additional Cost:** $0 (uses existing HTTP infrastructure)

#### Option 2 (TCP Port Checks):
- **Additional Cost:** $0 (already implemented)

#### Option 3 (Third-Party API):
- **API Costs:** Variable (Globalping free tier → $0.0001/ping commercial)
- **Network Egress:** ~10 KB per check
- **Compute Time:** Minimal increase
- **Estimated:** < $0.05/month per 1,000 ping checks

#### Option 4 (VM-based):
- **Compute Engine VM:** $5-10/month per region (f1-micro/e2-micro)
- **Network Egress:** Negligible (ICMP packets are tiny)
- **Total for 3 regions:** $15-30/month fixed cost

### Implementation Effort

- **Option 1:** 1-2 hours (mostly documentation)
- **Option 2:** 0 hours (already done, just document)
- **Option 3:** 6-10 hours (API integration + testing)
- **Option 4:** 40-60 hours (VM deployment, orchestration, monitoring, security)

### References & Resources

- [Better Stack: Best Ping Monitoring Tools 2026](https://betterstack.com/community/comparisons/ping-monitoring-tools/)
- [UptimeRobot: ICMP Ping Monitoring](https://uptimerobot.com/knowledge-hub/monitoring/icmp-ping-monitoring/)
- [Globalping: Run Ping with HTTP](https://blog.globalping.io/run-ping-with-http-using-globalping-api/)
- [AWS Lambda Ping Limitations](https://repost.aws/questions/QUuZk4GSIdQcqvKrsiay82Hw/ping-url-or-dns-name-from-lambda-function)

---

## 3. DNS Record Monitoring

### Overview
Monitor DNS records for changes in A, AAAA, CNAME, MX, TXT, NS records. Critical for web hosting companies to detect unauthorized DNS changes that could impact service availability or security.

### ✅ Feasibility: **HIGH**

### Technical Implementation

#### Core Library
Node.js native `dns/promises` module - no external dependencies required! Stable and well-maintained in Node.js v22+.

**Official Documentation:** [Node.js DNS Module](https://nodejs.org/api/dns.html), [Node.js DNS/Promises API](https://forwardemail.net/en/blog/docs/node-js-dns-over-https)

```javascript
import { promises as dns } from 'dns';

async function checkDnsRecords(domain, recordTypes = ['A'], options = {}) {
  const {
    expectedRecords = {},
    checkForChanges = true,
    nameservers = ['8.8.8.8', '1.1.1.1'], // Google DNS, Cloudflare DNS
    timeout = 5000
  } = options;

  const resolver = new dns.Resolver();
  resolver.setServers(nameservers);

  const results = {};
  const changes = [];
  const errors = [];

  for (const recordType of recordTypes) {
    try {
      let records;
      const startTime = Date.now();

      switch (recordType.toUpperCase()) {
        case 'A':
          records = await resolver.resolve4(domain);
          break;
        case 'AAAA':
          records = await resolver.resolve6(domain);
          break;
        case 'CNAME':
          records = await resolver.resolveCname(domain);
          break;
        case 'MX':
          records = await resolver.resolveMx(domain);
          // Returns array of { priority, exchange }
          records = records.map(r => `${r.priority} ${r.exchange}`);
          break;
        case 'TXT':
          records = await resolver.resolveTxt(domain);
          // TXT records are arrays of strings, flatten them
          records = records.map(arr => arr.join(''));
          break;
        case 'NS':
          records = await resolver.resolveNs(domain);
          break;
        case 'SOA':
          const soa = await resolver.resolveSoa(domain);
          records = [{
            nsname: soa.nsname,
            hostmaster: soa.hostmaster,
            serial: soa.serial,
            refresh: soa.refresh,
            retry: soa.retry,
            expire: soa.expire,
            minttl: soa.minttl
          }];
          break;
        case 'CAA':
          records = await resolver.resolveCaa(domain);
          records = records.map(r => `${r.critical} ${r.issue || r.issuewild || r.iodef}`);
          break;
        default:
          errors.push({ recordType, error: 'Unsupported record type' });
          continue;
      }

      const responseTime = Date.now() - startTime;

      // Sort records for consistent comparison
      const sortedRecords = Array.isArray(records)
        ? records.sort()
        : [records];

      results[recordType] = {
        records: sortedRecords,
        count: sortedRecords.length,
        responseTime,
        timestamp: new Date().toISOString()
      };

      // Check for changes if we have expected values
      if (checkForChanges && expectedRecords[recordType]) {
        const expected = Array.isArray(expectedRecords[recordType])
          ? expectedRecords[recordType].sort()
          : [expectedRecords[recordType]];

        const current = sortedRecords;

        if (JSON.stringify(expected) !== JSON.stringify(current)) {
          changes.push({
            recordType,
            expected,
            current,
            added: current.filter(r => !expected.includes(r)),
            removed: expected.filter(r => !current.includes(r))
          });
        }
      }

    } catch (error) {
      errors.push({
        recordType,
        error: error.code || error.message
      });

      results[recordType] = {
        records: [],
        error: error.message,
        errorCode: error.code // ENOTFOUND, ENODATA, etc.
      };
    }
  }

  // Determine overall status
  const hasErrors = errors.length > 0;
  const hasChanges = changes.length > 0;

  let status = 'UP';
  if (hasErrors && errors.length === recordTypes.length) {
    status = 'DOWN'; // All queries failed
  } else if (hasChanges) {
    status = 'CHANGED'; // Records changed from expected
  } else if (hasErrors) {
    status = 'PARTIAL'; // Some queries failed
  }

  return {
    status,
    domain,
    results,
    changes,
    errors,
    timestamp: new Date().toISOString()
  };
}
```

#### Integration Points

**Check Configuration (Firestore `checks` collection):**
```typescript
interface DnsCheck extends BaseCheck {
  type: 'dns';
  domain: string; // e.g., 'example.com'
  recordTypes: ('A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA' | 'CAA')[];

  // Expected values for change detection
  expectedRecords?: {
    A?: string[];
    AAAA?: string[];
    CNAME?: string[];
    MX?: string[];
    TXT?: string[];
    NS?: string[];
  };

  // Alert on any change vs specific changes
  alertOnAnyChange: boolean;

  // Custom nameservers (default: 8.8.8.8, 1.1.1.1)
  nameservers?: string[];

  // Check frequency (recommend: 1 hour - 24 hours for DNS)
  checkFrequency: number; // In minutes (default: 1440 = daily)
}
```

**Execution Flow:**
1. Scheduler picks up DNS checks (likely less frequent - daily or every 6 hours)
2. `checkDnsRecords()` executes DNS lookups for specified record types
3. Compare current records with previous/expected values
4. Detect changes: added records, removed records, modified records
5. Alert if changes detected (configurable)
6. Store current state for next comparison

**Storage Strategy:**
Store DNS record snapshots in Firestore `checks` document:
```typescript
{
  ...otherFields,
  dnsRecordSnapshot: {
    lastChecked: Timestamp,
    records: {
      A: ['1.2.3.4', '5.6.7.8'],
      MX: ['10 mail1.example.com', '20 mail2.example.com'],
      TXT: ['v=spf1 include:_spf.google.com ~all']
    }
  }
}
```

#### Features to Implement

**Phase 1 (MVP):**
- [x] Query A, AAAA, MX, TXT, CNAME, NS records
- [x] Store record snapshots
- [x] Detect changes (add/remove/modify)
- [x] Alert on changes
- [x] Response time measurement

**Phase 2 (Enhanced):**
- [ ] SOA record monitoring (serial number changes)
- [ ] CAA record monitoring (certificate authority authorization)
- [ ] DNSSEC validation status
- [ ] Multi-nameserver comparison (detect propagation issues)
- [ ] TTL monitoring

**Phase 3 (Advanced):**
- [ ] Historical record change timeline
- [ ] DNS propagation checker (query multiple nameservers globally)
- [ ] Reverse DNS (PTR) record checks
- [ ] DMARC/SPF/DKIM validation for email records

#### DNS Check Frequency Recommendations

Unlike HTTP/WebSocket monitoring that runs every 1-5 minutes, DNS checks should run less frequently:

- **Critical production domains:** Every 1 hour
- **Important client domains:** Every 6 hours
- **Standard monitoring:** Every 24 hours (daily)
- **Low-priority domains:** Every 7 days (weekly)

**Reasoning:**
- DNS records change infrequently (hours/days between changes)
- DNS has caching/TTL mechanisms
- Reduces costs and load on DNS servers
- Still provides timely alerts (1-24 hour detection window acceptable for DNS)

### Cost Impact

#### Extremely Low Cost

**Compute Time:**
- DNS queries complete in 10-50ms typically
- Much faster than HTTP checks
- Minimal CPU usage
- **Per check:** ~0.01 CPU-sec

**Network Egress:**
- DNS query: ~100-200 bytes
- DNS response: ~200-500 bytes
- **Per check:** ~500 bytes total
- **At scale (1,000 domains checked daily):**
  - 500 bytes × 1,000 checks/day = 500 KB/day = 15 MB/month
- **At scale (10,000 domains checked daily):**
  - 150 MB/month
- Well within Firebase's 5 GB free tier

**Function Invocations:**
- No additional invocations (uses existing scheduler)
- Same batch execution model
- **Impact:** None

**Firestore Storage:**
- Store DNS record snapshots: ~1-5 KB per domain
- **10,000 domains:** ~50 MB storage
- Firestore: 1 GB free tier
- **Cost:** $0

**Total Estimated Cost Increase:** < $0.01/month per 10,000 DNS checks (daily frequency)

**Cost Comparison:**
- Much cheaper than HTTP checks (less data, faster execution)
- Can safely offer DNS monitoring with generous limits
- No third-party API costs (native Node.js)

### Implementation Effort

- **Complexity:** Low (native Node.js APIs)
- **Development Time:** 6-8 hours
- **Testing Time:** 3-4 hours
- **UI/UX Time:** 4-6 hours (record type selection, change visualization)
- **Dependencies:** None (native Node.js)

### User Experience Considerations

**Setup Flow:**
1. User adds domain to monitor
2. Selects record types (A, MX, TXT, etc.)
3. System fetches current records as "baseline"
4. User can adjust expected values if needed
5. Chooses alert preference:
   - Alert on ANY change
   - Alert only on specific record type changes
   - No alerts, just logging

**Alert Examples:**
```
⚠️ DNS Change Detected: example.com

Record Type: A
Previous: 1.2.3.4
Current: 5.6.7.8

Record Type: MX
Added: 30 mail3.example.com
Removed: None

Checked: Jan 28, 2026 2:15 PM UTC
```

**Dashboard Display:**
- Show current vs expected records
- Highlight changes in red/yellow
- Provide "Accept as New Baseline" button
- Historical change timeline

### References & Resources

- [Node.js DNS Module Documentation](https://nodejs.org/api/dns.html)
- [Node.js DNS over HTTPS Implementation 2026](https://forwardemail.net/en/blog/docs/node-js-dns-over-https)
- [DNS Promises Module - Bun Reference](https://bun.com/reference/node/dns/promises)
- [How to Write a DNS Checker with Node.js](https://cheatcode.co/blog/how-to-write-a-dns-checker-with-node-js)

---

## 4. Summary & Recommendations

### Implementation Priority

| Monitoring Type | Priority | Feasibility | Cost Impact | User Value | Implementation Effort |
|----------------|----------|-------------|-------------|------------|---------------------|
| **DNS Records** | 🔥 HIGH | ✅ Excellent | Minimal ($0.01/mo) | High (hosting companies) | Low (6-8 hrs) |
| **WebSocket (WS/WSS)** | 🔥 HIGH | ✅ Excellent | Minimal ($0.01/mo) | High (real-time apps) | Low-Medium (4-6 hrs) |
| **TCP Port (Existing)** | ✅ IMMEDIATE | ✅ Ready | None | Medium-High | None (document only) |
| **ICMP Ping (HTTP)** | 🟡 MEDIUM | ⚠️ Limited | None | Medium | Low (1-2 hrs) |
| **ICMP Ping (API)** | 🟡 LOW | ⚠️ Depends on 3rd party | Low ($0.05/mo) | Medium | Medium (6-10 hrs) |
| **ICMP Ping (VM)** | ⚠️ FUTURE | ⚠️ Complex | High ($15-30/mo) | Low (niche) | Very High (40-60 hrs) |

### Recommended Rollout Plan

#### Sprint 1 (Week 1-2): Quick Wins
1. **Document TCP Port Monitoring** as ping alternative
   - Update docs with "Infrastructure Monitoring" section
   - Add UI guidance for common ports (SSH, RDP, HTTPS)
   - Promote as existing feature: "Already available!"

2. **Implement DNS Record Monitoring** (MVP)
   - Support A, AAAA, MX, TXT, CNAME, NS records
   - Change detection and alerting
   - Daily check frequency default
   - ~8-10 hours total effort

#### Sprint 2 (Week 3-4): Real-Time Protocol Support
3. **Implement WebSocket Monitoring** (MVP)
   - Basic WS/WSS connection testing
   - Response time measurement
   - Optional message sending
   - Content validation
   - ~6-8 hours total effort

4. **Enhance DNS Monitoring**
   - Add SOA, CAA record types
   - Multi-nameserver comparison
   - Historical change timeline
   - ~4-6 hours effort

#### Sprint 3 (Month 2): Advanced Features
5. **WebSocket Advanced Features**
   - Regex pattern matching
   - Authentication support
   - Ping/pong heartbeat monitoring
   - ~6-8 hours effort

6. **Evaluate ICMP Ping Demand**
   - Monitor user feedback and feature requests
   - If high demand: integrate Globalping API (~8-10 hours)
   - If low demand: promote TCP checks more prominently

### Cost Summary (Per 10,000 Checks/Month)

| Monitoring Type | Firebase Costs | Third-Party Costs | Total/Month |
|----------------|---------------|-------------------|-------------|
| **Current (HTTP/TCP/UDP)** | ~$0.50 | ~$0 | $0.50 |
| **+ DNS Monitoring** | +$0.01 | $0 | $0.51 |
| **+ WebSocket Monitoring** | +$0.01 | $0 | $0.52 |
| **+ TCP-as-Ping** | $0 | $0 | $0.52 |
| **+ ICMP (API-based)** | +$0.02 | +$1-5 | $1.54-5.54 |
| **+ ICMP (VM-based)** | +$0.02 | +$15-30 | $15.54-30.54 |

### User Communication Strategy

**Email to Requesting User:**

> Hi [User],
>
> Thank you for the detailed feature request! Great news - we can support most of what you've asked for:
>
> **✅ WebSocket (WS/WSS) Monitoring** - Coming soon! We'll add full support for monitoring WebSocket services with text content validation, just like you have in FreshPing. ETA: 2-3 weeks.
>
> **✅ Infrastructure Monitoring (Ping Alternative)** - Available now! While true ICMP ping isn't possible in our serverless architecture, you can use TCP port checks to monitor servers without webpages:
> - For Linux servers: `tcp://your-server.com:22` (SSH port)
> - For Windows servers: `tcp://your-server.com:3389` (RDP port)
> - For network devices: `tcp://device-ip:443` or any open port
>
> This provides network-level connectivity monitoring without requiring a web server. We're also exploring third-party ICMP API integration for true ping if there's enough demand.
>
> **✅ DNS Record Monitoring** - Coming soon! We'll add daily monitoring of A, AAAA, MX, TXT, CNAME, NS records with change alerts. Perfect for your hosting business use case. ETA: 2-3 weeks.
>
> We'll keep you updated as these features roll out. Thanks for helping us prioritize!

### Questions for Product Decision

1. **Pricing Strategy:** Should DNS and WebSocket monitoring be:
   - Included in all tiers at same limits as HTTP checks?
   - Available at higher limits in paid tiers only?
   - Offered as separate add-on?

2. **ICMP Ping Approach:** Based on user feedback, should we:
   - Stop at TCP port checks + documentation?
   - Integrate third-party ping API (Globalping, etc.)?
   - Build VM-based solution for premium tier?

3. **DNS Check Frequency:** Should we:
   - Enforce less frequent checking for DNS (daily minimum)?
   - Allow same frequency as HTTP checks (may increase costs slightly)?
   - Use adaptive checking (more frequent after detecting changes)?

4. **Feature Marketing:** How to position these new monitoring types:
   - "Infrastructure Monitoring" (TCP + DNS)
   - "Real-Time Protocol Monitoring" (WebSocket)
   - "Advanced Network Monitoring" (all together)

---

## 5. Technical Architecture Changes

### Database Schema Updates

**Firestore `checks` collection additions:**
```typescript
interface Check {
  // ... existing fields ...

  // New check types
  type: 'website' | 'api' | 'tcp' | 'udp' | 'websocket' | 'dns';

  // WebSocket-specific fields
  websocketConfig?: {
    messageToSend?: string;
    expectedMessage?: string;
    expectedMessageMode?: 'contains' | 'exact' | 'regex';
    followRedirects?: boolean;
    customHeaders?: Record<string, string>;
  };

  // DNS-specific fields
  dnsConfig?: {
    recordTypes: ('A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA' | 'CAA')[];
    nameservers?: string[];
    alertOnAnyChange: boolean;
  };

  // DNS record snapshot storage
  dnsRecordSnapshot?: {
    lastChecked: Timestamp;
    records: Record<string, string[]>;
  };

  // WebSocket response data
  websocketLastMessage?: {
    timestamp: Timestamp;
    message: string;
    contentMatch?: boolean;
  };
}
```

### Function Updates

**File: `functions/src/check-utils.ts`**
- Add `checkWebSocketEndpoint()` function
- Add `checkDnsRecords()` function
- Update `checkWebsite()` dispatcher to route new types

**File: `functions/src/types.ts`**
- Add WebSocketCheck interface
- Add DnsCheck interface
- Add WebSocketConfig interface
- Add DnsConfig interface

**No changes required to:**
- Scheduler functions (already support any check type)
- Alert functions (work with existing status changes)
- BigQuery streaming (schema flexible enough)

### UI/UX Updates

**File: `src/components/check/CheckForm.tsx`**
- Add "WebSocket" and "DNS" to check type dropdown
- Conditional rendering for WebSocket config fields
- Conditional rendering for DNS config fields
- Record type multi-select for DNS checks
- Baseline record display for DNS checks

**File: `src/pages/Checks.tsx`**
- Display WebSocket-specific metrics (message content)
- Display DNS-specific metrics (record counts, changes)
- Add "DNS Changes" badge/indicator
- Add "Accept as Baseline" action for DNS checks

**New Component: `src/components/check/DnsRecordDisplay.tsx`**
- Show current vs expected DNS records
- Highlight changes (added/removed/modified)
- Provide diff view for complex changes
- "Accept Changes" button

### Testing Requirements

**Unit Tests:**
- WebSocket connection handling
- WebSocket timeout behavior
- WebSocket message validation (contains, exact, regex)
- DNS query execution for all record types
- DNS change detection logic
- DNS error handling (NXDOMAIN, SERVFAIL, etc.)

**Integration Tests:**
- End-to-end WebSocket check execution
- End-to-end DNS check execution
- Alert triggering on WebSocket failures
- Alert triggering on DNS changes
- BigQuery history recording for new check types

**Manual Testing:**
- Test against real WebSocket services (public echo servers)
- Test DNS checks against various domains
- Verify UI displays WebSocket/DNS data correctly
- Test DNS change detection with known changes
- Verify alert notifications include relevant details

---

## 6. Risks & Mitigations

### Risk: WebSocket Connection Limits

**Issue:** Cloud Functions limits 500 outbound connections per second per instance.

**Mitigation:**
- WebSocket checks complete in <1 second typically
- Batch processing already limits concurrency
- Monitor connection pool usage
- Add connection pooling if needed

### Risk: DNS Query Rate Limits

**Issue:** Some DNS providers rate-limit queries.

**Mitigation:**
- Recommend daily checking frequency (not per-minute)
- Use public DNS resolvers (Google, Cloudflare) not authoritative nameservers
- Implement exponential backoff on rate limit errors
- Cache results briefly to avoid duplicate queries

### Risk: Third-Party Service Dependencies

**Issue:** External ping APIs could go down or change pricing.

**Mitigation:**
- Clearly document that ICMP ping uses third-party service
- Support multiple providers (fallback)
- Monitor API availability
- Set up billing alerts for API costs

### Risk: False Positives on DNS Changes

**Issue:** Users might get alerted for legitimate DNS changes they made.

**Mitigation:**
- Provide "Accept as New Baseline" UI action
- Add "Recently Changed" indicator to suppress alerts for N hours
- Optional "maintenance window" feature to suppress alerts
- Detailed change information in alerts (what exactly changed)

### Risk: Cost Overruns at Scale

**Issue:** If millions of DNS/WebSocket checks run, costs could increase.

**Mitigation:**
- Monitor Firebase usage dashboard daily
- Set up billing alerts at $10, $50, $100 thresholds
- Implement per-user check limits
- Consider tier-based check frequency limits
- DNS checks default to daily (not per-minute)

---

## 7. Future Enhancements (Beyond MVP)

### DNS Monitoring Advanced Features

1. **DNSSEC Validation**
   - Verify cryptographic signatures on DNS records
   - Alert on DNSSEC validation failures
   - Useful for security-conscious organizations

2. **DNS Propagation Checker**
   - Query multiple nameservers globally
   - Detect propagation delays
   - Show per-nameserver results

3. **DNS Performance Monitoring**
   - Track query response times over time
   - Alert on degraded DNS performance
   - Compare resolver performance

4. **Email Security Records**
   - Automated SPF, DKIM, DMARC validation
   - Alert on misconfigurations
   - Suggest improvements

### WebSocket Monitoring Advanced Features

1. **Message Sequence Testing**
   - Send multiple messages in sequence
   - Validate ordered responses
   - Test bidirectional communication flows

2. **Ping/Pong Heartbeat Monitoring**
   - Monitor WebSocket heartbeat mechanisms
   - Track heartbeat interval stability
   - Alert on missed heartbeats

3. **Authentication Support**
   - Bearer token authentication
   - Custom auth headers
   - OAuth2 integration

4. **Binary Protocol Support**
   - Support binary WebSocket frames
   - Protocol buffers validation
   - Custom binary pattern matching

### ICMP Ping (If Implemented)

1. **Packet Loss Tracking**
   - Send multiple packets
   - Calculate loss percentage
   - Alert on >X% packet loss

2. **Jitter Monitoring**
   - Track ping time variability
   - Alert on unstable connections
   - Useful for VoIP/video services

3. **Traceroute Integration**
   - Show network path to target
   - Identify problematic hops
   - Diagnose routing issues

4. **MTU Discovery**
   - Detect path MTU
   - Alert on MTU changes
   - Diagnose fragmentation issues

---

## Conclusion

**All requested monitoring types are feasible** with varying levels of implementation complexity and cost impact:

- ✅ **WebSocket (WS/WSS):** Fully supported, low cost, straightforward implementation
- ✅ **DNS Record Monitoring:** Fully supported, very low cost, straightforward implementation
- ⚠️ **ICMP Ping:** Partially supported via TCP checks (existing) or third-party APIs (future)

**Recommended approach:**
1. Ship DNS and WebSocket monitoring in next 2-3 weeks
2. Document TCP port checks as ping alternative (immediate)
3. Evaluate user demand for true ICMP ping
4. If demand exists, integrate third-party ping API (month 2-3)

**Total cost impact for 10,000 checks/month:** < $0.02 additional (negligible)

**Development effort:** ~20-25 hours for DNS + WebSocket MVP

**Business impact:** Competitive feature parity with services like FreshPing, UptimeRobot, and Site24x7 while maintaining cost efficiency.

---

**Document Version:** 1.0
**Last Updated:** January 28, 2026
**Next Review:** After MVP implementation (March 2026)
