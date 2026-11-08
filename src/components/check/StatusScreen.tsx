import React, { useMemo } from 'react';
import type { Website } from '../../types';
import type { RegionWsState } from '../../hooks/useCheckStream';

/*
 * The fleet status board at the top of Checks: a black LCD panel in the
 * Doto dot-matrix face, with unlit "888" segments behind every number.
 * Styling lives in the panel kit at the end of src/style.css.
 */

type Tone = 'up' | 'down' | 'warn' | 'paused' | 'unknown';

const TONE_COLOR: Record<Tone, string> = {
  up: 'var(--primary)',
  down: 'var(--destructive)',
  warn: 'var(--warning)',
  paused: 'oklch(1 0 0 / 0.22)',
  unknown: 'oklch(1 0 0 / 0.12)',
};

// Worst first, so a bucket of several checks shows its worst member.
const TONE_RANK: Record<Tone, number> = { down: 4, warn: 3, unknown: 2, up: 1, paused: 0 };

function toneOf(check: Website): Tone {
  if (check.disabled) return 'paused';
  if (check.maintenanceMode) return 'warn';
  if (check.status === 'offline') return 'down';
  if (check.status === 'degraded') return 'warn';
  if (check.status === 'online') return 'up';
  return 'unknown';
}

const MAX_SEGMENTS = 64;

const WS_LABEL: Record<RegionWsState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  authing: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  fallback: 'Polling',
};

/** A number over its unlit segments. Doto is monospaced, so padding lines up. */
const Readout: React.FC<{ value: number | null; digits: number; className?: string; color?: string }> = ({
  value,
  digits,
  className = '',
  color,
}) => {
  const text = value == null ? '' : String(Math.round(value));
  const width = Math.max(digits, text.length);
  return (
    <span className={`lcd relative inline-block ${className}`} aria-label={value == null ? 'none' : text}>
      <span className="lcd-ghost absolute inset-0 text-right" aria-hidden>
        {'8'.repeat(width)}
      </span>
      <span className="relative" style={color ? { color } : undefined} aria-hidden>
        {value == null ? '-'.padStart(width, ' ') : text.padStart(width, ' ')}
      </span>
    </span>
  );
};

interface StatusScreenProps {
  checks: Website[];
  wsState: RegionWsState;
}

export const StatusScreen: React.FC<StatusScreenProps> = ({ checks, wsState }) => {
  const stats = useMemo(() => {
    let up = 0, down = 0, warn = 0, paused = 0, degraded = 0;
    let msTotal = 0, msCount = 0;
    const tones = checks.map(toneOf);
    tones.forEach((tone, i) => {
      if (tone === 'up') up++;
      else if (tone === 'down') down++;
      else if (tone === 'warn') warn++;
      if (checks[i].status === 'degraded' && !checks[i].disabled && !checks[i].maintenanceMode) degraded++;
      else if (tone === 'paused') paused++;
      const ms = checks[i].responseTime;
      if (tone === 'up' && typeof ms === 'number' && ms > 0) {
        msTotal += ms;
        msCount++;
      }
    });

    // One segment per check; past MAX_SEGMENTS, each segment is a bucket.
    const segCount = Math.min(tones.length, MAX_SEGMENTS);
    const segments: Tone[] = [];
    for (let s = 0; s < segCount; s++) {
      const from = Math.floor((s * tones.length) / segCount);
      const to = Math.floor(((s + 1) * tones.length) / segCount);
      let worst: Tone = tones[from];
      for (let i = from + 1; i < to; i++) {
        if (TONE_RANK[tones[i]] > TONE_RANK[worst]) worst = tones[i];
      }
      segments.push(worst);
    }

    return { up, down, warn, degraded, paused, avgMs: msCount ? msTotal / msCount : null, segments };
  }, [checks]);

  const headline =
    stats.down > 0
      ? `${stats.down} DOWN`
      : stats.degraded > 0
        ? `${stats.degraded} DEGRADED`
        : stats.warn > 0
          ? 'MAINTENANCE'
        : stats.up > 0
          ? 'ALL SYSTEMS UP'
          : 'ALL PAUSED';
  const headlineColor = stats.down > 0 ? 'var(--destructive)' : stats.warn > 0 ? 'var(--warning)' : undefined;
  const live = wsState === 'live';

  return (
    <section className="screen relative overflow-hidden p-5 sm:p-7" aria-label="Checks status board">
      <div className="flex items-center justify-between gap-4">
        <div className="panel-label flex items-center gap-2.5">
          <span
            className={`led led-on ${live ? '' : 'led-pulse'}`}
            style={{ '--led': live ? 'var(--primary)' : 'var(--warning)' } as React.CSSProperties}
            aria-hidden
          />
          <span style={{ color: live ? 'var(--primary)' : 'var(--warning)' }}>Feed</span>
          <span>{WS_LABEL[wsState]}</span>
        </div>
        <div className="panel-label opacity-60">
          Checks · {String(checks.length).padStart(2, '0')}
        </div>
      </div>

      <h2
        className="lcd mt-5 text-[32px] sm:text-[48px] tracking-[0.02em]"
        style={headlineColor ? { color: headlineColor } : undefined}
        aria-live="polite"
      >
        {headline}
      </h2>

      <div className="mt-5 flex gap-[3px]" aria-hidden>
        {stats.segments.map((tone, i) => (
          <span
            key={i}
            className="screen-seg"
            style={
              tone === 'paused' || tone === 'unknown'
                ? { background: TONE_COLOR[tone] }
                : { background: TONE_COLOR[tone], boxShadow: `0 0 6px color-mix(in oklch, ${TONE_COLOR[tone]} 60%, transparent)` }
            }
          />
        ))}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-white/[0.08] pt-5 sm:grid-cols-4">
        <div>
          <div className="panel-label opacity-60">Up</div>
          <Readout value={stats.up} digits={3} className="mt-2 text-[36px]" />
        </div>
        <div>
          <div className="panel-label" style={{ color: stats.down > 0 ? 'var(--destructive)' : undefined, opacity: stats.down > 0 ? 1 : 0.6 }}>
            Down
          </div>
          <Readout
            value={stats.down}
            digits={3}
            className="mt-2 text-[36px]"
            color={stats.down > 0 ? 'var(--destructive)' : undefined}
          />
        </div>
        <div>
          <div className="panel-label opacity-60">Avg ms</div>
          <Readout value={stats.avgMs} digits={4} className="mt-2 text-[36px]" />
        </div>
        <div>
          <div className="panel-label opacity-60">Paused</div>
          <Readout value={stats.paused} digits={3} className="mt-2 text-[36px]" />
        </div>
      </div>
    </section>
  );
};

export default StatusScreen;
