import { useEffect, useState } from 'react';

interface Website {
  id: string;
  name: string;
  url: string;
  status?: 'online' | 'offline';
  lastChecked?: number;
  // minutes between checks
  checkFrequency?: number;
  nextCheckAt?: number;
}

// Default interval in seconds if a check doesn't specify one (fallback to 1 minute)
const DEFAULT_INTERVAL_SECONDS = 60;

export function useCountdowns(websites: Website[]) {
  const [countdowns, setCountdowns] = useState<{ [id: string]: number }>({});

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns(() => {
        const updated: { [id: string]: number } = {};
        const now = Date.now();
        
        websites.forEach(w => {
          // Prefer explicit scheduling using nextCheckAt when present
          if (typeof w.nextCheckAt === 'number' && w.nextCheckAt > 0) {
            const seconds = Math.max(0, Math.ceil((w.nextCheckAt - now) / 1000));
            updated[w.id] = seconds;
            return;
          }

          // Fallback to lastChecked + checkFrequency based countdown
          const last = w.lastChecked || 0;
          const intervalSeconds = Math.max(1, Math.round((w.checkFrequency ?? (DEFAULT_INTERVAL_SECONDS / 60)) * 60));

          if (!last) {
            updated[w.id] = intervalSeconds;
            return;
          }

          if (last > now || (now - last) > intervalSeconds * 2000) {
            updated[w.id] = intervalSeconds;
            return;
          }

          const timeSinceLastCheck = Math.floor((now - last) / 1000);
          const timeUntilNextCheck = intervalSeconds - timeSinceLastCheck;
          updated[w.id] = timeUntilNextCheck <= 0 ? intervalSeconds : timeUntilNextCheck;
        });
        
        return updated;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [websites]);

  return countdowns;
} 