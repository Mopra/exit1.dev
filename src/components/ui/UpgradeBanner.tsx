import React from 'react';
import { Link } from 'react-router-dom';
import { Rocket, Sparkles, X } from 'lucide-react';
import { Alert, AlertDescription } from './alert';
import { Button } from './Button';

type TargetTier = 'nano' | 'pro' | 'agency';

const TIER_LABEL: Record<TargetTier, string> = {
  nano: 'Nano',
  pro: 'Pro',
  agency: 'Agency',
};

interface UpgradeBannerProps {
  message: string;
  description?: string;
  variant?: 'limit' | 'teaser';
  onDismiss?: () => void;
  /** Tier being promoted. Drives the default `ctaLabel` when not overridden. */
  targetTier?: TargetTier;
  ctaLabel?: string;
  ctaHref?: string;
}

export const UpgradeBanner: React.FC<UpgradeBannerProps> = ({
  message,
  description,
  variant = 'limit',
  onDismiss,
  targetTier,
  ctaLabel,
  ctaHref = '/billing',
}) => {
  const resolvedCtaLabel =
    ctaLabel ?? (targetTier ? `Upgrade to ${TIER_LABEL[targetTier]}` : 'Upgrade to Nano');

  if (variant === 'teaser') {
    return (
      <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent backdrop-blur-sm p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm text-foreground">{message}</p>
              {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          <Button asChild size="sm" className="cursor-pointer w-full sm:w-auto shrink-0">
            <Link to={ctaHref}>{resolvedCtaLabel}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Alert className="border-warning/30 bg-warning/10 backdrop-blur-sm relative">
      <Rocket className="h-4 w-4 text-warning self-center !translate-y-0" />
      <AlertDescription className={`text-sm text-foreground flex items-center gap-3 flex-wrap ${onDismiss ? 'pr-8' : ''}`}>
        <span>{message}</span>
        <Button asChild size="sm" className="cursor-pointer w-fit shrink-0">
          <Link to={ctaHref}>{resolvedCtaLabel}</Link>
        </Button>
      </AlertDescription>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="absolute top-1/2 -translate-y-1/2 right-3 rounded-sm opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 p-1"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4 text-foreground" />
        </button>
      )}
    </Alert>
  );
};
