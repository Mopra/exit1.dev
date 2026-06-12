/**
 * Phase 6 — live countdown UX.
 *
 * Renders the "last checked / next in" pair from `lastChecked` +
 * `nextCheckAt`, ticked every second by the shared `useSecondTick` hook.
 * Includes a thin progress bar that fills from 0% (at lastChecked) to
 * 100% (at nextCheckAt). When the bar reaches 100% the check is due —
 * we pulse a subtle indicator until a fresh probe result lands and
 * resets the cycle.
 *
 * Visual smoothness on the progress bar is intentionally CSS-driven
 * (computed width per render, no per-frame JS animation) so adding more
 * components on screen doesn't compound into jank.
 *
 * Accessibility: respects `prefers-reduced-motion`. The bar element is
 * hidden under that media query — the text alone carries the
 * information. The bar is decorative.
 *
 * Fallback: if `nextCheckAt` is missing the bar disappears and only the
 * "X ago" text renders — same as the disabled/never-checked case the
 * existing UI already handled via static formatters.
 */
import React from 'react';
import { Clock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui';
import { useSecondTick } from '../../hooks/useSecondTick';

interface CheckCountdownProps {
  lastChecked?: number;
  nextCheckAt?: number;
  /**
   * Compact mode: render just the live "X ago" text on one line, no
   * countdown line, no progress bar. Used in CheckCard where the existing
   * grid layout expects a single text line per cell.
   */
  compact?: boolean;
  /**
   * Stretch the progress bar to the full container width instead of the
   * default fixed 96px. Used on the mobile CheckCard so the bar spans
   * the whole card.
   */
  fullWidthBar?: boolean;
  /**
   * Tier 2b (firestore-write-reduction.md): the check's live fields are
   * rendering from Firestore (WS fallback / not yet connected), where
   * heartbeat snapshots land hourly. lastChecked/nextCheckAt may be up to
   * ~an hour old, so the countdown math is meaningless — suppress the
   * "Next in" line, progress bar, and the due/"In Queue" pulse, and mark
   * the elapsed text as stale instead.
   */
  stale?: boolean;
}

export const CheckCountdown: React.FC<CheckCountdownProps> = ({
  lastChecked,
  nextCheckAt,
  compact = false,
  fullWidthBar = false,
  stale = false,
}) => {
  const now = useSecondTick();

  if (!lastChecked) {
    return (
      <div className="flex items-center gap-2">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-sm font-mono text-muted-foreground">Never</span>
      </div>
    );
  }

  const elapsedMs = Math.max(0, now - lastChecked);
  const lastText = formatElapsed(elapsedMs);

  // Stale mode: the timestamps are from the last backend snapshot, not a
  // live stream — a countdown against them would show every check as
  // perpetually "In Queue". Render the elapsed text with an explicit
  // stale marker instead.
  if (stale) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 cursor-default">
            <Clock className="w-3 h-3 text-muted-foreground/70" />
            <span className="text-sm font-mono text-muted-foreground/70">
              {lastText} <span className="text-xs">· stale</span>
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <span className="text-xs">
            Live stream unavailable — times come from the last backend sync
            and may lag up to an hour. Up/down status still updates promptly.
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Compact mode: single-line "X ago" that ticks. Drops the bar and
  // "Next in" line — appropriate for the card where the cell is one row.
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-sm font-mono text-muted-foreground">{lastText}</span>
      </div>
    );
  }

  // No nextCheckAt → static "last checked" display, no countdown.
  if (!nextCheckAt) {
    return (
      <div className="flex items-center gap-2">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-sm font-mono text-muted-foreground">{lastText}</span>
      </div>
    );
  }

  const totalMs = Math.max(1, nextCheckAt - lastChecked);
  const remainingMs = nextCheckAt - now;
  const progress = Math.min(1, Math.max(0, elapsedMs / totalMs));
  const due = remainingMs <= 0;
  const nextText = due ? 'In Queue' : `Next ${formatRemaining(remainingMs)}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Clock className="w-3 h-3 text-muted-foreground" />
        <span className="text-sm font-mono text-muted-foreground">{lastText}</span>
      </div>
      <div className={(fullWidthBar ? '' : 'pl-5 ') + 'flex flex-col gap-1.5'}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={
                'text-xs font-mono cursor-default ' +
                (due ? 'text-primary' : 'text-muted-foreground')
              }
            >
              {nextText}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="text-xs font-mono">
              {new Date(nextCheckAt).toLocaleString()}
            </span>
          </TooltipContent>
        </Tooltip>
        {/* Progress bar. Hidden under prefers-reduced-motion — text carries the info. */}
        <div
          className={
            'h-0.5 rounded bg-muted/60 overflow-hidden motion-reduce:hidden ' +
            (fullWidthBar ? 'w-full' : 'w-24')
          }
          aria-hidden
        >
          {/* Animate scaleX, not width — width transitions force layout on
              every frame, and with 100+ rows ticking at once that reflow
              load is what made the table janky. scaleX composites on the
              GPU. */}
          <div
            className={
              'h-full w-full origin-left transition-transform duration-1000 ease-linear ' +
              (due ? 'bg-primary animate-pulse' : 'bg-primary/50')
            }
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      </div>
    </div>
  );
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'Just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.ceil(s / 3600);
  if (h < 24) return `in ${h}h`;
  const d = Math.ceil(s / 86400);
  return `in ${d}d`;
}
