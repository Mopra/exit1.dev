import React from 'react';
import { Link } from 'react-router-dom';
import { Rocket, X } from 'lucide-react';
import { Alert, AlertDescription } from './alert';
import { Button } from './button';

interface UpgradeBannerProps {
  message: string;
  onDismiss?: () => void;
}

export const UpgradeBanner: React.FC<UpgradeBannerProps> = ({ message, onDismiss }) => {
  return (
    <Alert className="border-amber-500/30 bg-amber-500/10 backdrop-blur-sm relative">
      <Rocket className="h-4 w-4 text-amber-400 self-center !translate-y-0" />
      <AlertDescription className={`text-sm text-foreground flex items-center gap-3 flex-wrap ${onDismiss ? 'pr-8' : ''}`}>
        <span>{message}</span>
        <Button asChild size="sm" className="cursor-pointer w-fit shrink-0">
          <Link to="/billing">Upgrade to Nano</Link>
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
