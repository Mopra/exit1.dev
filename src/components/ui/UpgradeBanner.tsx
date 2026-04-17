import React from 'react';
import { Link } from 'react-router-dom';
import { Rocket, Sparkles, X } from 'lucide-react';
import { Alert, AlertDescription } from './alert';
import { Button } from './Button';

interface UpgradeBannerProps {
  message: string;
  description?: string;
  variant?: 'limit' | 'teaser';
  onDismiss?: () => void;
  ctaLabel?: string;
  ctaHref?: string;
}

export const UpgradeBanner: React.FC<UpgradeBannerProps> = ({
  message,
  description,
  variant = 'limit',
  onDismiss,
  ctaLabel = 'Upgrade to Nano',
  ctaHref = '/billing',
}) => {
  if (variant === 'teaser') {
    return (
      <div className="rounded-lg border border-sky-500/20 bg-gradient-to-br from-sky-500/10 via-primary/5 to-transparent backdrop-blur-sm p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-sky-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm text-foreground">{message}</p>
              {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          <Button asChild size="sm" className="cursor-pointer w-full sm:w-auto shrink-0">
            <Link to={ctaHref}>{ctaLabel}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Alert className="border-amber-500/30 bg-amber-500/10 backdrop-blur-sm relative">
      <Rocket className="h-4 w-4 text-amber-400 self-center !translate-y-0" />
      <AlertDescription className={`text-sm text-foreground flex items-center gap-3 flex-wrap ${onDismiss ? 'pr-8' : ''}`}>
        <span>{message}</span>
        <Button asChild size="sm" className="cursor-pointer w-fit shrink-0">
          <Link to={ctaHref}>{ctaLabel}</Link>
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
