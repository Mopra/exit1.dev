import { useEffect, useState } from 'react';

interface Website {
  id: string;
  name: string;
  url: string;
  status?: 'online' | 'offline';
  lastChecked?: number;
}

// Check interval configuration - always 1 minute
const CHECK_INTERVAL_MINUTES = 1;
const CHECK_INTERVAL_SECONDS = CHECK_INTERVAL_MINUTES * 60;

export function useCountdowns(websites: Website[]) {
  const [countdowns, setCountdowns] = useState<{ [id: string]: number }>({});

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns(() => {
        const updated: { [id: string]: number } = {};
        const now = Date.now();
        
        websites.forEach(w => {
          const last = w.lastChecked || 0;
          
          // If never checked (lastChecked is 0), start countdown from full interval
          if (!last) {
            // For new websites, just start from full interval and count down
            // This will reset to full interval every time until the first check happens
            updated[w.id] = CHECK_INTERVAL_SECONDS;
            return;
          }
          
          // Handle future timestamps or very old timestamps
          if (last > now || (now - last) > CHECK_INTERVAL_SECONDS * 2000) {
            updated[w.id] = CHECK_INTERVAL_SECONDS;
            return;
          }
          
          const timeSinceLastCheck = Math.floor((now - last) / 1000);
          const timeUntilNextCheck = CHECK_INTERVAL_SECONDS - timeSinceLastCheck;
          
          if (timeUntilNextCheck <= 0) {
            updated[w.id] = CHECK_INTERVAL_SECONDS; // Reset to full interval when overdue
          } else {
            updated[w.id] = timeUntilNextCheck;
          }
        });
        
        return updated;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [websites]);

  return countdowns;
} 