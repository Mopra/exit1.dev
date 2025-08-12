
# Exit1.dev – Reliability Score Specification

## Overview
The **Reliability Score** measures the overall reliability of a monitored site, going beyond uptime percentage to include incident severity, frequency, recovery speed.

This spec supports **variable check intervals** per site.

---

## Math Specification

Let the window be \\([W_s, W_e]\\) with total minutes \(M\).

### 1) Availability Quality \(A\)
- Convex penalty for unplanned downtime.
- Planned maintenance excluded or softly penalized (×0.2).
- Severity weights:
  - TLS_DNS = 1.2
  - HTTP_5XX = 1.0
  - SLOW = 0.5
  - NETWORK = 1.0
  - OTHER = 1.0
- Power \(p = 1.3\).

\[
\text{DowntimePenalty} = \frac{\sum_i (w_i \cdot d_i)^{p}}{M^{p}}, \quad
A = \text{clamp}(1 - \text{DowntimePenalty}, 0, 1)
\]

### 2) Incident Frequency \(F\)
\( n \) = number of unplanned incidents.

\( \beta = 1/3 \) → 3 incidents ≈ 0.5 score.

\[
F = \frac{1}{1 + \beta n}
\]

### 3) Recovery \(R\)
MTTR over unplanned incidents.

Cap: \(T_{cap} = 60\) minutes.

\[
R = \max(0, 1 - \frac{\text{MTTR}}{T_{cap}})
\]

### 4) Sampling Confidence \(K\) – Variable Check Interval
\[
K = \min(1, \frac{60}{\text{checkIntervalSec}})
\]
Used as a light multiplier: \(0.5 + 0.5K\).

### Optional Upgrades
- **Latency Consistency (C)**: \( J = \frac{p95 - p50}{p50} \), \( \gamma = 2.0 \), \( C = e^{-\gamma J} \).
- **HTTP Error Quality (E)**: \( e \) = total errors / total requests, cap = 1%. \( E = 1 - \min(1, e / 0.01) \).
- **Blast Radius (B)**: if multi-region fail fraction = \(q\), \( B = 1 - q \).

### Combine via Geometric Mean + Confidence
Weights (sum to 1 when only A, F, R are used):
- Minimal: \( w_A=0.6, w_F=0.2, w_R=0.2 \)
- With C, E, B: renormalize to include them (suggested w_C=0.15, w_E=0.1, w_B=0.1).

\[
S_{base} = \prod_k X_k^{w_k}, \quad
\text{ReliabilityScore} = 100 \times S_{base} \times (0.5 + 0.5K)
\]

---

## Utility Modules

### `/src/lib/reliability/math.ts`
Functions:
- `minutesBetween()`
- `clipToWindow()`
- `computeAvailabilityA()`
- `computeFrequencyF()`
- `computeRecoveryR()`
- `computeConfidenceK()`
- `computeLatencyC()`
- `computeErrorQualityE()`
- `combineGeometric()`
- `computeReliabilityScore()`

### `/src/lib/reliability/ewma.ts`
- `ewma()`
- `rollupDaily()`

---

## Example

```ts
const inputs: ScoreInputs = {
  windowStart: "2025-07-12T00:00:00Z",
  windowEnd:   "2025-08-11T00:00:00Z",
  checkConfig: { siteId: "abc", checkIntervalSec: 300 },
  incidents: [
    { id: "i1", startedAt: "2025-07-20T10:00:00Z", endedAt: "2025-07-20T10:30:00Z", severity: "HTTP_5XX" },
    { id: "i2", startedAt: "2025-07-29T08:00:00Z", endedAt: "2025-07-29T09:00:00Z", planned: true },
  ],
  latency: [
    { ts: "2025-08-01T00:00:00Z", p50: 180, p95: 400 },
    { ts: "2025-08-02T00:00:00Z", p50: 170, p95: 600 },
  ],
  errorRates: [
    { ts: "2025-08-01T00:00:00Z", requests: 10000, errors: 40 },
  ],
  multiRegionFailFraction: 0.1,
};

const { score, parts, weights } = computeReliabilityScore(inputs);
```
