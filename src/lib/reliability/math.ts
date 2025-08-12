/*
 * Reliability score math per spec in reliabilitydoc.md
 */

export type IncidentSeverity = 'TLS_DNS' | 'HTTP_5XX' | 'SLOW' | 'NETWORK' | 'OTHER'

export interface Incident {
  id?: string
  startedAt: number | string | Date
  endedAt?: number | string | Date
  severity?: IncidentSeverity
  planned?: boolean
}

export interface LatencySample {
  ts: number | string | Date
  p50: number
  p95: number
}

export interface ErrorRateSample {
  ts: number | string | Date
  requests: number
  errors: number
}

export interface CheckConfig {
  siteId: string
  checkIntervalSec: number
}

export interface ScoreInputs {
  windowStart: number | string | Date
  windowEnd: number | string | Date
  checkConfigs: CheckConfig[]
  incidents: Incident[]
  latency?: LatencySample[]
  errorRates?: ErrorRateSample[]
  multiRegionFailFraction?: number
  weights?: Partial<{
    A: number
    F: number
    R: number
    C: number
    E: number
    B: number
  }>
  useOptional?: {
    latency?: boolean
    errorQuality?: boolean
    blastRadius?: boolean
  }
}

export interface ScoreParts {
  A: number
  F: number
  R: number
  K: number
  C?: number
  E?: number
  B?: number
  S_base: number
}

const DEFAULT_WEIGHTS = {
  A: 0.6,
  F: 0.2,
  R: 0.2,
} as const

const OPTIONAL_WEIGHTS = {
  C: 0.15,
  E: 0.1,
  B: 0.1,
} as const

const SEVERITY_WEIGHTS: Record<IncidentSeverity, number> = {
  TLS_DNS: 1.2,
  HTTP_5XX: 1.0,
  SLOW: 0.5,
  NETWORK: 1.0,
  OTHER: 1.0,
}

const POWER_P = 1.3
const MAINTENANCE_PENALTY_FACTOR = 0.2
const MTTR_CAP_MINUTES = 60

export function minutesBetween(start: number | string | Date, end: number | string | Date): number {
  const s = toMillis(start)
  const e = toMillis(end)
  if (e <= s) return 0
  return (e - s) / 60000
}

export function clipToWindow(
  startedAt: number | string | Date,
  endedAt: number | string | Date | undefined,
  windowStart: number | string | Date,
  windowEnd: number | string | Date,
): { overlapped: boolean; minutes: number } {
  const s = toMillis(startedAt)
  const e = endedAt ? toMillis(endedAt) : toMillis(windowEnd)
  const ws = toMillis(windowStart)
  const we = toMillis(windowEnd)
  const startClipped = Math.max(s, ws)
  const endClipped = Math.min(e, we)
  if (endClipped <= startClipped) return { overlapped: false, minutes: 0 }
  return { overlapped: true, minutes: (endClipped - startClipped) / 60000 }
}

export function computeAvailabilityA(
  incidents: Incident[],
  windowStart: number | string | Date,
  windowEnd: number | string | Date,
  options?: { windowMinutesOverride?: number }
): number {
  const windowMinutes = options?.windowMinutesOverride ?? minutesBetween(windowStart, windowEnd)
  if (windowMinutes <= 0) return 1

  let downtimePenaltyNumerator = 0
  for (const inc of incidents) {
    const { overlapped, minutes } = clipToWindow(inc.startedAt, inc.endedAt, windowStart, windowEnd)
    if (!overlapped || minutes <= 0) continue
    const severity = (inc.severity ?? 'OTHER') as IncidentSeverity
    const plannedFactor = inc.planned ? MAINTENANCE_PENALTY_FACTOR : 1
    const weighted = SEVERITY_WEIGHTS[severity] * plannedFactor * minutes
    downtimePenaltyNumerator += Math.pow(weighted, POWER_P)
  }

  const denom = Math.pow(windowMinutes, POWER_P)
  const downtimePenalty = denom > 0 ? downtimePenaltyNumerator / denom : 0
  return clamp01(1 - downtimePenalty)
}

export function computeFrequencyF(incidents: Incident[], windowStart: number | string | Date, windowEnd: number | string | Date): number {
  const n = incidents.reduce((acc, inc) => {
    const { overlapped } = clipToWindow(inc.startedAt, inc.endedAt, windowStart, windowEnd)
    if (!overlapped) return acc
    if (inc.planned) return acc
    return acc + 1
  }, 0)
  const beta = 1 / 3
  return 1 / (1 + beta * n)
}

export function computeRecoveryR(incidents: Incident[], windowStart: number | string | Date, windowEnd: number | string | Date): number {
  const durations: number[] = []
  for (const inc of incidents) {
    if (inc.planned) continue
    const { overlapped, minutes } = clipToWindow(inc.startedAt, inc.endedAt, windowStart, windowEnd)
    if (!overlapped || minutes <= 0) continue
    durations.push(minutes)
  }
  if (durations.length === 0) return 1
  const mttr = durations.reduce((a, b) => a + b, 0) / durations.length
  return Math.max(0, 1 - mttr / MTTR_CAP_MINUTES)
}

export function computeConfidenceK(checkConfigs: CheckConfig[]): number {
  if (!checkConfigs || checkConfigs.length === 0) return 1
  const values = checkConfigs.map((c) => Math.min(1, 60 / Math.max(1, c.checkIntervalSec)))
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  return clamp01(avg)
}

export function computeLatencyC(samples: LatencySample[]): number {
  if (!samples || samples.length === 0) return 1
  const ratios: number[] = []
  for (const s of samples) {
    if (s.p50 <= 0) continue
    const j = (s.p95 - s.p50) / s.p50
    if (!isFinite(j) || j < 0) continue
    ratios.push(j)
  }
  if (ratios.length === 0) return 1
  const avgJ = ratios.reduce((a, b) => a + b, 0) / ratios.length
  const gamma = 2.0
  return Math.exp(-gamma * avgJ)
}

export function computeErrorQualityE(samples: ErrorRateSample[]): number {
  if (!samples || samples.length === 0) return 1
  let totalReq = 0
  let totalErr = 0
  for (const s of samples) {
    totalReq += Math.max(0, s.requests)
    totalErr += Math.max(0, s.errors)
  }
  if (totalReq <= 0) return 1
  const e = totalErr / totalReq
  return 1 - Math.min(1, e / 0.01)
}

export function combineGeometric(values: Record<string, number>, weights: Record<string, number>): number {
  // Normalize weights so that only provided value keys are considered
  const keys = Object.keys(weights).filter((k) => values[k] !== undefined)
  if (keys.length === 0) return 1
  const totalWeight = keys.reduce((a, k) => a + (weights[k] ?? 0), 0)
  if (totalWeight <= 0) return 1
  const normalized: Record<string, number> = {}
  for (const k of keys) normalized[k] = (weights[k] ?? 0) / totalWeight
  let product = 1
  for (const k of keys) {
    const x = clamp01(values[k])
    const w = normalized[k]
    product *= Math.pow(x, w)
  }
  return product
}

export function computeReliabilityScore(inputs: ScoreInputs): { score: number; parts: ScoreParts; weights: Record<string, number> } {
  const { windowStart, windowEnd, incidents, checkConfigs } = inputs
  const windowMinutesSingle = minutesBetween(windowStart, windowEnd)
  const siteCount = Math.max(1, checkConfigs?.length ?? 1)
  const effectiveWindowMinutes = windowMinutesSingle * siteCount

  const A = computeAvailabilityA(incidents, windowStart, windowEnd, { windowMinutesOverride: effectiveWindowMinutes })
  const F = computeFrequencyF(incidents, windowStart, windowEnd)
  const R = computeRecoveryR(incidents, windowStart, windowEnd)
  const K = computeConfidenceK(checkConfigs)

  let C: number | undefined
  let E: number | undefined
  let B: number | undefined

  if (inputs.useOptional?.latency && inputs.latency) C = computeLatencyC(inputs.latency)
  if (inputs.useOptional?.errorQuality && inputs.errorRates) E = computeErrorQualityE(inputs.errorRates)
  if (inputs.useOptional?.blastRadius && typeof inputs.multiRegionFailFraction === 'number') {
    const q = clamp01(inputs.multiRegionFailFraction)
    B = 1 - q
  }

  const baseWeights = { ...DEFAULT_WEIGHTS }
  if (C !== undefined || E !== undefined || B !== undefined) {
    // Include optional weights and renormalize later in combineGeometric
    if (C !== undefined) (baseWeights as any).C = OPTIONAL_WEIGHTS.C
    if (E !== undefined) (baseWeights as any).E = OPTIONAL_WEIGHTS.E
    if (B !== undefined) (baseWeights as any).B = OPTIONAL_WEIGHTS.B
  }
  // Allow override
  const weights = { ...baseWeights, ...(inputs.weights ?? {}) } as Record<string, number>

  const S_base = combineGeometric(
    { A, F, R, ...(C !== undefined ? { C } : {}), ...(E !== undefined ? { E } : {}), ...(B !== undefined ? { B } : {}) },
    weights,
  )
  const score = 10 * S_base * (0.5 + 0.5 * K)

  const parts: ScoreParts = { A, F, R, K, ...(C !== undefined ? { C } : {}), ...(E !== undefined ? { E } : {}), ...(B !== undefined ? { B } : {}), S_base }
  return { score, parts, weights }
}

// Utilities
function clamp01(x: number): number {
  if (!isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function toMillis(x: number | string | Date): number {
  if (typeof x === 'number') return x
  if (x instanceof Date) return x.getTime()
  const t = Date.parse(x)
  return isNaN(t) ? 0 : t
}

export const ReliabilityMath = {
  minutesBetween,
  clipToWindow,
  computeAvailabilityA,
  computeFrequencyF,
  computeRecoveryR,
  computeConfidenceK,
  computeLatencyC,
  computeErrorQualityE,
  combineGeometric,
  computeReliabilityScore,
}


