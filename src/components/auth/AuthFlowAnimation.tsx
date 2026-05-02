import React, { useEffect, useState } from 'react';
import { Globe, Network, Lock, Radio, Wifi, Mail, Webhook, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';

type Item = {
  Icon: React.ComponentType<{ className?: string }> | React.FC<{ className?: string }>;
  label: string;
};

const SIGNALS: Item[] = [
  { Icon: Globe, label: 'HTTPS' },
  { Icon: Network, label: 'TCP' },
  { Icon: Lock, label: 'SSL' },
  { Icon: Wifi, label: 'WS' },
  { Icon: Radio, label: 'ICMP' },
];

const INTEGRATIONS: Item[] = [
  { Icon: Mail, label: 'Email' },
  { Icon: SlackMark, label: 'Slack' },
  { Icon: DiscordMark, label: 'Discord' },
  { Icon: TeamsMark, label: 'Teams' },
  { Icon: Webhook, label: 'Webhook' },
  { Icon: Smartphone, label: 'SMS' },
];

const TICK_MS = 2800;

export function AuthFlowAnimation({ className }: { className?: string }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const signal = SIGNALS[tick % SIGNALS.length];
  const integration = INTEGRATIONS[tick % INTEGRATIONS.length];

  return (
    <div
      className={cn(
        'auth-anim relative mx-auto w-full max-w-xs select-none',
        className,
      )}
      aria-hidden="true"
    >
      <style>{STYLE}</style>
      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-3 h-10">
        <span className="auth-wire" />

        <div className="auth-track">
          <span key={`s-${tick}`} className="auth-particle auth-particle--in">
            <signal.Icon className="size-3.5 text-muted-foreground" />
          </span>
        </div>

        <div className="auth-box">
          <span key={`p-${tick}`} className="auth-pulse" />
          <img src="/e_.svg" alt="" className="relative z-10 size-4 opacity-90" />
        </div>

        <div className="auth-track">
          <span key={`o-${tick}`} className="auth-particle auth-particle--out">
            <integration.Icon className="size-3.5 text-primary" />
          </span>
        </div>
      </div>

      <p className="mt-3 text-center text-[11px] tracking-wide text-muted-foreground">
        Monitor anything · Alert anywhere
      </p>
    </div>
  );
}

function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M5 15a2 2 0 1 1 0-4h2v4H5Zm3 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Zm2-8a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 1a2 2 0 0 1 0 4H5a2 2 0 1 1 0-4h5Zm9 2a2 2 0 1 1 0 4h-2v-4h2Zm-3 0a2 2 0 0 1-4 0V5a2 2 0 1 1 4 0v5Zm-2 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z" />
    </svg>
  );
}

function DiscordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M19.6 4.6A18 18 0 0 0 15.3 3.3l-.2.4c1.6.4 3 1 4.3 1.9a14.7 14.7 0 0 0-12.8 0 16 16 0 0 1 4.3-1.9l-.2-.4A18 18 0 0 0 6.4 4.6 19.5 19.5 0 0 0 3 16.4 18.4 18.4 0 0 0 8.5 19l.6-.9a13 13 0 0 1-2-1l.4-.3a13.1 13.1 0 0 0 11 0l.4.3a13 13 0 0 1-2 1l.6.9A18.4 18.4 0 0 0 23 16.4a19.5 19.5 0 0 0-3.4-11.8ZM9.7 14.4c-.9 0-1.7-.9-1.7-2s.7-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Zm4.6 0c-.9 0-1.7-.9-1.7-2s.7-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Z" />
    </svg>
  );
}

function TeamsMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M3 6h10v2H9v9H7V8H3V6Zm12.5 1a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm-1 1H21a1 1 0 0 1 1 1v6a4 4 0 0 1-4 4h-.2a5 5 0 0 1-3.3-1.3V8Z" />
    </svg>
  );
}

const STYLE = `
.auth-anim .auth-wire {
  position: absolute;
  left: 8%;
  right: 8%;
  top: 50%;
  height: 1px;
  transform: translateY(-0.5px);
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in oklch, var(--border) 100%, transparent) 18%,
    color-mix(in oklch, var(--border) 100%, transparent) 82%,
    transparent 100%
  );
  pointer-events: none;
}

.auth-anim .auth-track {
  position: relative;
  height: 100%;
}

.auth-anim .auth-box {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  overflow: hidden;
}

.auth-anim .auth-pulse {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(
    circle at center,
    color-mix(in oklch, var(--primary) 55%, transparent) 0%,
    transparent 70%
  );
  opacity: 0;
  animation: auth-pulse 0.9s ease-out 1s 1 both;
}

.auth-anim .auth-particle {
  position: absolute;
  top: 50%;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--background);
  border: 1px solid color-mix(in oklch, var(--primary) 35%, var(--border));
  box-shadow: 0 0 10px color-mix(in oklch, var(--primary) 30%, transparent);
  margin-top: -11px;
  opacity: 0;
  animation-duration: 1.4s;
  animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  animation-fill-mode: both;
  animation-iteration-count: 1;
}

.auth-anim .auth-particle--in {
  left: 0;
  animation-name: auth-fly-in;
}

.auth-anim .auth-particle--out {
  left: 0;
  animation-name: auth-fly-out;
  animation-delay: 1.2s;
}

@keyframes auth-fly-in {
  0%   { left: 0%;                       opacity: 0; }
  30%  {                                  opacity: 1; }
  70%  {                                  opacity: 1; }
  100% { left: calc(100% - 22px);         opacity: 0; }
}

@keyframes auth-fly-out {
  0%   { left: 0%;                       opacity: 0; }
  30%  {                                  opacity: 1; }
  70%  {                                  opacity: 1; }
  100% { left: calc(100% - 22px);         opacity: 0; }
}

@keyframes auth-pulse {
  0%   { opacity: 0;    transform: scale(0.85); }
  50%  { opacity: 0.55; transform: scale(1.08); }
  100% { opacity: 0;    transform: scale(1.15); }
}

@media (prefers-reduced-motion: reduce) {
  .auth-anim { display: none; }
}
`;
