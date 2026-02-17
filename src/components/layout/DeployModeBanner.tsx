import { useState, useEffect } from 'react';
import { useDeployMode } from '@/hooks/useDeployMode';
import { Rocket, Clock } from 'lucide-react';

export const DeployModeBanner = () => {
  const { isDeployMode, deployMode } = useDeployMode();
  const [minutesLeft, setMinutesLeft] = useState(0);

  useEffect(() => {
    if (!deployMode) return;
    const update = () => {
      setMinutesLeft(Math.max(0, Math.ceil((deployMode.expiresAt - Date.now()) / 60000)));
    };
    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, [deployMode]);

  if (!isDeployMode) return null;

  return (
    <div className="w-full bg-amber-500/15 border-b border-amber-400/30 text-amber-200 z-30">
      <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs">
        <Rocket className="h-3.5 w-3.5 text-amber-300 flex-shrink-0 animate-pulse" />
        <span className="font-semibold">Monitoring paused</span>
        {deployMode?.reason && (
          <>
            <span className="opacity-50">·</span>
            <span className="opacity-70">{deployMode.reason}</span>
          </>
        )}
        <span className="opacity-50">·</span>
        <span className="opacity-70 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {minutesLeft > 0 ? `${minutesLeft}m remaining` : 'expiring'}
        </span>
      </div>
    </div>
  );
};
