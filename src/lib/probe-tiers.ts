import type { ChartPoint } from './ws-protocol';

export type Tier = 'normal' | 'elevated' | 'spike';

// Below this sample count the median is too noisy to drive highlighting
// — a single fresh probe can flip the baseline and produce false
// positives that defeat the "scan at a glance" goal.
export const MIN_PROBES_FOR_HIGHLIGHT = 5;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Classify a value against the column's median. Two gates per tier: a
 * relative ratio (the threshold scales with the check's baseline) and
 * an absolute delta (so 0→2ms blips on near-zero columns like DNS
 * don't trigger just because they're "infinite× median").
 */
export function tierFor(value: number, med: number): Tier {
  const delta = value - med;
  if (delta <= 0) return 'normal';
  if (value >= med * 3 && delta >= 25) return 'spike';
  if (value >= med * 2 && delta >= 10) return 'elevated';
  return 'normal';
}

export interface ProbeMedians {
  enable: boolean;
  rt: number;
  dn: number;
  cn: number;
  tl: number;
  ft: number;
}

export function computeMedians(points: readonly ChartPoint[]): ProbeMedians {
  const rt: number[] = [];
  const dn: number[] = [];
  const cn: number[] = [];
  const tl: number[] = [];
  const ft: number[] = [];
  for (const p of points) {
    if (typeof p.rt === 'number') rt.push(p.rt);
    if (typeof p.dn === 'number') dn.push(p.dn);
    if (typeof p.cn === 'number') cn.push(p.cn);
    if (typeof p.tl === 'number') tl.push(p.tl);
    if (typeof p.ft === 'number') ft.push(p.ft);
  }
  return {
    enable: rt.length >= MIN_PROBES_FOR_HIGHLIGHT,
    rt: median(rt),
    dn: median(dn),
    cn: median(cn),
    tl: median(tl),
    ft: median(ft),
  };
}

/**
 * Per-probe row-level tier — the worst classification across rt + phase
 * timings, with `down` status overriding to `spike`. Mirrors the table's
 * row-highlight rollup so the chart markers always agree with the table
 * tint for the same probe.
 */
export function computeRowTiers(
  points: readonly ChartPoint[],
): Map<number, Tier> {
  const out = new Map<number, Tier>();
  const medians = computeMedians(points);
  const keys = ['rt', 'dn', 'cn', 'tl', 'ft'] as const;
  for (const p of points) {
    if (p.st !== 'up') {
      out.set(p.t, 'spike');
      continue;
    }
    if (!medians.enable) continue;
    let tier: Tier = 'normal';
    for (const k of keys) {
      const v = p[k];
      if (typeof v !== 'number') continue;
      const t = tierFor(v, medians[k]);
      if (t === 'spike') {
        tier = 'spike';
        break;
      }
      if (t === 'elevated') tier = 'elevated';
    }
    if (tier !== 'normal') out.set(p.t, tier);
  }
  return out;
}
