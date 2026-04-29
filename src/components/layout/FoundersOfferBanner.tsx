import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Sparkles, ArrowRight } from 'lucide-react';
import { useAuth } from '@clerk/clerk-react';
import { usePlan } from '@/hooks/usePlan';

const OFFER_ENDS_AT = new Date('2026-05-01T00:00:00Z').getTime();

function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return 'ending';
  const totalMinutes = Math.floor(msLeft / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

export const FoundersOfferBanner = () => {
  const { isSignedIn } = useAuth();
  const { tier, isLoading } = usePlan();
  const location = useLocation();
  const [msLeft, setMsLeft] = useState(() => OFFER_ENDS_AT - Date.now());

  useEffect(() => {
    const update = () => setMsLeft(OFFER_ENDS_AT - Date.now());
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!isSignedIn || isLoading) return null;
  if (msLeft <= 0) return null;
  if (tier !== 'free' && tier !== 'nano') return null;
  if (location.pathname === '/founders-upgrade') return null;

  return (
    <Link
      to="/founders-upgrade"
      className="group block w-full border-b border-tier-pro/40 bg-gradient-to-r from-tier-pro/10 via-tier-pro/15 to-tier-pro/10 text-tier-pro z-30 transition-colors hover:from-tier-pro/15 hover:via-tier-pro/20 hover:to-tier-pro/15"
    >
      <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-1.5 text-xs">
        <Sparkles className="h-3.5 w-3.5 text-tier-pro flex-shrink-0" />
        <span className="font-semibold">Founders offer</span>
        <span className="opacity-50">·</span>
        <span className="opacity-80">
          Lock in Pro features for <span className="font-semibold">$4/mo</span>
        </span>
        <span className="opacity-50">·</span>
        <span className="font-semibold text-tier-pro">
          {formatCountdown(msLeft)}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-tier-pro underline underline-offset-4 decoration-tier-pro/40 group-hover:decoration-tier-pro">
          Upgrade now
          <ArrowRight className="h-3 w-3" />
        </span>
      </div>
    </Link>
  );
};
