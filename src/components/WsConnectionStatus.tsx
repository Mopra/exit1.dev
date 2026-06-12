/**
 * Phase 5 surface for the WS pipeline state.
 *
 * - `WsConnectionIndicator` — small pill rendered in the page header.
 *   Green when every region is live, amber while a region is in the
 *   reconnect-hysteresis window, red once a region has flipped to
 *   fallback. Tooltip names each region's state.
 *
 * - `WsFallbackBanner` — top-of-page banner that surfaces after 10s of
 *   accumulated fallback. The 10s threshold is a deliberate level above
 *   the 8s hysteresis cutover so users don't see "we just temporarily
 *   degraded" flash for normal reconnect cycles, but DO see persistent
 *   degradation that affects what they're looking at.
 */
import React, { useEffect, useState } from 'react';
import { Wifi, WifiOff, RefreshCw, AlertTriangle } from 'lucide-react';
import type { RegionStatus, RegionWsState } from '@/hooks/useCheckStream';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface IndicatorProps {
  aggregateState: RegionWsState;
  regions: RegionStatus[];
}

const STATE_LABEL: Record<RegionWsState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  authing: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  fallback: 'Stale',
};

const STATE_TONE: Record<RegionWsState, 'ok' | 'warn' | 'bad' | 'muted'> = {
  idle: 'muted',
  connecting: 'warn',
  authing: 'warn',
  live: 'ok',
  reconnecting: 'warn',
  fallback: 'bad',
};

const TONE_CLASSES: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
  ok: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  bad: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  muted: 'bg-muted/40 text-muted-foreground border-border',
};

const TONE_DOT: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-rose-400',
  muted: 'bg-muted-foreground',
};

const STATE_DETAIL: Record<RegionWsState, string> = {
  idle: 'Not yet connected.',
  connecting: 'Opening the WebSocket to this region.',
  authing: 'Authenticating the WebSocket session.',
  live: 'Streaming probe results in real time.',
  reconnecting: 'Lost the stream — retrying. Showing the last streamed values until it returns.',
  fallback: 'Stream unavailable for this region. Up/down status still updates promptly, but timing data (last checked, response time) comes from periodic backend syncs and can be up to an hour old.',
};

export const WsConnectionIndicator: React.FC<IndicatorProps> = ({ aggregateState, regions }) => {
  const [open, setOpen] = useState(false);
  const tone = STATE_TONE[aggregateState];
  const baseLabel = STATE_LABEL[aggregateState];

  // When aggregate isn't 'live', name the region driving the indicator
  // so users know which connection is degraded. Picks the worst region
  // (matches the deriveAggregate priority in the hook).
  let label = baseLabel;
  if (aggregateState !== 'live' && regions.length > 0) {
    const worst =
      regions.find(r => r.state === 'fallback') ??
      regions.find(r => r.state !== 'live');
    if (worst) label = `${baseLabel} (${worst.region})`;
  }

  const Icon =
    tone === 'ok' ? Wifi
    : tone === 'bad' ? WifiOff
    : tone === 'warn' ? RefreshCw
    : Wifi;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${label} — click for details`}
        className={
          'inline-flex h-9 items-center gap-1.5 px-2 sm:px-3 text-sm font-medium rounded-md border cursor-pointer transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
          TONE_CLASSES[tone]
        }
      >
        <Icon className={'h-4 w-4' + (tone === 'warn' ? ' animate-spin' : '')} />
        <span className="hidden sm:inline">{label}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-8 sm:p-8">
          <DialogHeader className="text-left sm:text-left gap-3">
            <DialogTitle className="flex items-center gap-2">
              <span className={'inline-block h-2 w-2 rounded-full ' + TONE_DOT[tone]} />
              {baseLabel}
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              This badge shows the state of the real-time stream that feeds the
              probe table and charts. When it's green, you're seeing results
              the instant our runners post them. Otherwise the page falls back
              to periodic backend syncs: up/down status changes still arrive
              promptly, but timing values (last checked, response time) can
              lag up to an hour and are marked as stale.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="text-sm font-medium">Regions</div>
            {regions.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No regions connected yet.
              </div>
            ) : (
              <ul className="space-y-2">
                {regions.map(r => {
                  const rTone = STATE_TONE[r.state];
                  return (
                    <li
                      key={r.region}
                      className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                    >
                      <span className={'mt-1.5 inline-block h-2 w-2 rounded-full shrink-0 ' + TONE_DOT[rTone]} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{r.region}</span>
                          <span className="text-xs text-muted-foreground">{STATE_LABEL[r.state]}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {STATE_DETAIL[r.state]}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

interface BannerProps {
  fallbackRegion: { region: string; since: number } | null;
}

const BANNER_THRESHOLD_MS = 10_000;

export const WsFallbackBanner: React.FC<BannerProps> = ({ fallbackRegion }) => {
  // Track local time so the banner shows up exactly 10s after fallback
  // engages without depending on parent re-renders. Tick every 2s — the
  // banner is a low-resolution surface, we don't need 1Hz precision.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!fallbackRegion) return;
    const t = setInterval(() => tick(n => n + 1), 2_000);
    return () => clearInterval(t);
  }, [fallbackRegion]);

  if (!fallbackRegion) return null;
  const elapsed = Date.now() - fallbackRegion.since;
  if (elapsed < BANNER_THRESHOLD_MS) return null;

  const seconds = Math.floor(elapsed / 1000);
  return (
    <div className="flex items-start gap-3 px-4 py-3 mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-300">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="text-sm">
        <div className="font-medium">Live data unavailable for {fallbackRegion.region}</div>
        <div className="text-xs text-rose-300/80">
          Reconnecting for {seconds}s — up/down status stays current, but
          last-checked times and response times come from periodic backend
          syncs and can be up to an hour old.
        </div>
      </div>
    </div>
  );
};
