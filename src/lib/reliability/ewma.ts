export interface EwmaPoint {
  ts: number
  value: number
}

export function ewma(points: EwmaPoint[], alpha: number): EwmaPoint[] {
  if (!points || points.length === 0) return []
  const a = Math.min(1, Math.max(0, alpha))
  const out: EwmaPoint[] = []
  let prev = points[0].value
  out.push({ ts: points[0].ts, value: prev })
  for (let i = 1; i < points.length; i += 1) {
    const v = points[i].value
    prev = a * v + (1 - a) * prev
    out.push({ ts: points[i].ts, value: prev })
  }
  return out
}

export function rollupDaily(points: EwmaPoint[]): { dayStart: number; value: number }[] {
  if (!points || points.length === 0) return []
  const byDay = new Map<number, number[]>()
  for (const p of points) {
    const d = startOfUtcDay(p.ts)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(p.value)
  }
  const days = Array.from(byDay.keys()).sort((a, b) => a - b)
  return days.map((d) => {
    const arr = byDay.get(d)!
    const avg = arr.reduce((x, y) => x + y, 0) / arr.length
    return { dayStart: d, value: avg }
  })
}

function startOfUtcDay(ts: number): number {
  const date = new Date(ts)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  return Date.UTC(y, m, d)
}

export const ReliabilityEwma = { ewma, rollupDaily }


