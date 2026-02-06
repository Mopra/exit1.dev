# Checks Functions: CPU Time Optimization Analysis

> **Date:** February 2026
> **Scope:** `functions/src/checks.ts`, `check-utils.ts`, `status-buffer.ts`, `security-utils.ts`, `target-metadata.ts`, `alert.ts`, `bigquery.ts`, `config.ts`

## Context

The check scheduler runs every 2 minutes across 5 regions (`us-central1`, `us-east4`, `us-west1`, `europe-west1`, `asia-southeast1`), processing up to 6,000 checks per run per region. CPU time on Cloud Functions is the largest cost driver with no obvious savings path — this document identifies where that CPU time goes and how to reduce it.

### Per-check pipeline

```
Lock acquire -> Firestore query -> HTTP/TCP/UDP check -> SSL check -> GeoIP lookup
  -> status comparison -> alert evaluation -> status buffer write -> BigQuery enqueue
```

---

## P0: Remove/Sample Per-Check Debug Logging

**Estimated CPU reduction: 25-40%**
**Effort: Low**

Cloud Logging serializes every argument to JSON before shipping. The codebase has 5-8 `logger.info`/`logger.warn` calls **per check**, most with complex objects. At 2,000 checks/run across 5 regions, that produces 50,000-80,000 JSON serializations per 2-minute cycle.

### Worst offenders

| File | Lines | Severity | Description |
|------|-------|----------|-------------|
| `check-utils.ts` | 491-504 | Critical | `createCheckHistoryRecord` logs every key of `checkResult` for every history record |
| `check-utils.ts` | 570-587 | Critical | `storeCheckHistory` logs full timing data |
| `check-utils.ts` | 889-899 | High | Logs timing details for every check (not sampled) |
| `check-utils.ts` | 902-913 | High | Logs target metadata for every check |
| `checks.ts` | 1136-1141 | Critical | `logger.warn` for "no status change" fires on ~99% of checks |
| `checks.ts` | 850, 854 | Medium | Logs recheck scheduling details |

The line at `checks.ts:1140` is the single worst offender — it fires a `warn`-level log for every check where status doesn't change (the vast majority), producing a structured log entry with buffer/DB state for each one.

### Fix

- Delete all per-check `logger.info` debug logging in `check-utils.ts` (lines 491-504, 570-587, 889-899, 902-913). These were added for debugging and are no longer needed.
- Downgrade the `checks.ts:1140` warn to `logger.debug`, or remove it entirely, or sample it at 5% using the existing `LOG_SAMPLE_RATE` pattern from other files.
- Keep only error-level logs and aggregate stats (already logged at end of run).

---

## P1: Implement Adaptive Timeouts

**Estimated CPU reduction: 10-20%**
**Effort: Low**

`config.ts:206-208` always returns a fixed 20-second timeout:

```typescript
getAdaptiveTimeout(_website: { ... }): number {
    return this.HTTP_TIMEOUT_MS; // Always 20,000ms
}
```

Every check — including sites that typically respond in 100ms — waits up to 20 seconds on timeout. When a site is actually down, the check holds a CPU slot for the full 20s before giving up.

### Fix

Use the site's historical response time to set a tighter timeout:

```typescript
getAdaptiveTimeout(website: { responseTime?: number; consecutiveFailures: number }): number {
  if (website.consecutiveFailures > 0) {
    // Already failing — use shorter timeout to free CPU faster
    return Math.min(this.HTTP_TIMEOUT_MS, 10_000);
  }
  if (typeof website.responseTime === 'number' && website.responseTime > 0) {
    // 3x historical response time, clamped between 5s and 20s
    return Math.min(this.HTTP_TIMEOUT_MS, Math.max(5_000, website.responseTime * 3));
  }
  return this.HTTP_TIMEOUT_MS;
}
```

Sites that are truly down time out in 10s instead of 20s. Sites that typically respond in 200ms time out in 5s instead of 20s. This frees CPU slots faster and reduces the overall wall-clock time of each run.

---

## P1: Cheaper Status Hash (Avoid Full JSON.stringify)

**Estimated CPU reduction: 5-10%**
**Effort: Low**

`status-buffer.ts:121-122` hashes every status update for no-op detection:

```typescript
const hashStatusData = (data: StatusUpdateData) =>
  JSON.stringify(normalizeStatusData(data));
```

`StatusUpdateData` has 30+ fields. `normalizeStatusData` destructures it, then `JSON.stringify` serializes the result. This runs **twice per entry** in some code paths (once in `processBatchEntries` at line 462, again in `processSingleEntry` at line 517).

### Fix

Hash only the fields that actually change frequently:

```typescript
const hashStatusData = (data: StatusUpdateData) => {
  const lc = typeof data.lastChecked === 'number'
    ? Math.floor(data.lastChecked / LAST_CHECKED_BUCKET_MS)
    : 0;
  const nc = typeof data.nextCheckAt === 'number'
    ? Math.floor(data.nextCheckAt / NEXT_CHECK_BUCKET_MS)
    : 0;
  const rt = typeof data.responseTime === 'number'
    ? Math.round(data.responseTime / RESPONSE_TIME_BUCKET_MS) * RESPONSE_TIME_BUCKET_MS
    : data.responseTime;
  return `${data.status}|${data.lastStatusCode}|${data.consecutiveFailures}|${data.consecutiveSuccesses}|${data.detailedStatus}|${lc}|${nc}|${rt}|${data.lastError}|${data.targetIp}|${data.checkRegion}|${data.sslCertificate?.valid}|${data.disabled}`;
};
```

String concatenation of known fields is an order of magnitude faster than `JSON.stringify` of a 30-field object with normalization.

---

## P2: Extract SSL From HTTP Socket (Eliminate Redundant TLS)

**Estimated CPU reduction: 2-5% per SSL refresh cycle**
**Effort: Medium**

When the SSL cache misses (every 30 days per check), `security-utils.ts:28-96` opens a **separate TLS socket** to extract the certificate. But the HTTP check in `check-utils.ts:235-312` also performs a TLS handshake — the certificate is available on the HTTPS socket via `socket.getPeerCertificate()`.

The current flow:
1. SSL check: DNS resolve + TCP connect + TLS handshake (separate connection)
2. HTTP check: DNS resolve + TCP connect + TLS handshake (actual check)

That's **two full TLS handshakes** per HTTPS check on cache miss.

### Fix

In `performHttpRequest`, capture the certificate from the socket's `secureConnect` event:

```typescript
socket.once("secureConnect", () => {
  secureAt = Date.now();
  setStage("TTFB");
  // Extract SSL cert from the same connection
  const cert = (socket as tls.TLSSocket).getPeerCertificate();
  if (cert && Object.keys(cert).length > 0) {
    capturedCert = cert;
  }
});
```

Then return the cert data as part of `HttpRequestResult`, eliminating the need for the separate `checkSecurityAndExpiry` call. The 30-day cache in `checkRestEndpoint` (lines 682-686) still applies — this only changes what happens on cache miss.

---

## P2: Replace randomUUID() With Lightweight ID

**Estimated CPU reduction: 1-3%**
**Effort: Low**

`check-utils.ts:507` generates a cryptographically random UUID for every BigQuery history record:

```typescript
id: `${website.id}_${now}_${randomUUID()}`,
```

`crypto.randomUUID()` reads from the kernel CSPRNG, which is heavier than needed for a non-security-critical record ID. With 2,000+ history records per run, this accumulates.

### Fix

Use a lightweight counter or `Math.random`:

```typescript
let historyIdCounter = 0;
const nextHistoryId = () => (++historyIdCounter).toString(36);

// In createCheckHistoryRecord:
id: `${website.id}_${now}_${nextHistoryId()}`,
```

The ID only needs to be unique within a BigQuery streaming insert batch, not cryptographically unpredictable.

---

## P3: Skip Geo Field Comparisons When Not Refreshing

**Estimated CPU reduction: 1-2%**
**Effort: Low**

`checks.ts:883-905` performs 20+ field comparisons on every check to determine `hasChanges`. Many of these are target geo fields (country, region, city, lat, lon, hostname, IP, ASN, org, ISP) that only change when `refreshTargetMeta` is true (every 7 days).

### Fix

Gate the geo comparisons on the refresh flag:

```typescript
const hasGeoChanges = refreshTargetMeta && (
  (check.targetLatitude ?? null) !== (checkResult.targetLatitude ?? null) ||
  (check.targetLongitude ?? null) !== (checkResult.targetLongitude ?? null) ||
  // ... other geo fields
);

const hasChanges =
  check.status !== status ||
  regionMissing ||
  // ... core fields ...
  hasGeoChanges;
```

---

## P3: Deduplicate cleanSslData Construction

**Estimated CPU reduction: <1%**
**Effort: Low**

The `cleanSslData` object with 7 conditional spreads is built identically in two places:
- `checks.ts:975-988` (no-change path)
- `checks.ts:1075-1086` (change path)

Each conditional spread (`...(x ? {k:v} : {})`) creates a temporary object.

### Fix

Extract to a helper:

```typescript
const buildCleanSslData = (
  cert: Website['sslCertificate'],
  lastChecked: number
) => ({
  valid: cert.valid,
  lastChecked,
  ...(cert.issuer ? { issuer: cert.issuer } : {}),
  ...(cert.subject ? { subject: cert.subject } : {}),
  ...(cert.validFrom ? { validFrom: cert.validFrom } : {}),
  ...(cert.validTo ? { validTo: cert.validTo } : {}),
  ...(cert.daysUntilExpiry !== undefined ? { daysUntilExpiry: cert.daysUntilExpiry } : {}),
  ...(cert.error ? { error: cert.error } : {}),
});
```

---

## Summary

| Priority | Optimization | Est. CPU Reduction | Effort |
|----------|-------------|-------------------|--------|
| **P0** | Remove/sample per-check debug logging | 25-40% | Low |
| **P1** | Adaptive timeouts based on historical response time | 10-20% | Low |
| **P1** | Cheaper status hash (string concat vs JSON.stringify) | 5-10% | Low |
| **P2** | Extract SSL cert from HTTP socket | 2-5% | Medium |
| **P2** | Replace `randomUUID()` with lightweight ID | 1-3% | Low |
| **P3** | Skip geo field comparisons when not refreshing | 1-2% | Low |
| **P3** | Deduplicate `cleanSslData` construction | <1% | Low |

**Implementing P0 + P1 alone should reduce CPU time by 40-60%**, with minimal risk and low implementation effort. The logging change in particular is the highest-ROI optimization available — it requires only deleting or downgrading log lines.
