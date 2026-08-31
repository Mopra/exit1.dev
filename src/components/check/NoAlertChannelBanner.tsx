import { memo } from 'react';
import { Link } from 'react-router-dom';
import { BellOff, ArrowRight } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/Button';

interface NoAlertChannelBannerProps {
  /** Number of enabled checks that currently cannot notify anybody. */
  checkCount: number;
}

/**
 * Shown when a user owns live monitors and not one of them can reach anybody.
 *
 * Deliberately NOT dismissible. Every other banner in the app is advisory: a limit
 * reached, a plan changed, a region fallen back. This one says the product is not
 * doing the job it was hired for, and it stops appearing the moment it stops being
 * true, which is the only dismissal that helps. An audit found this state on 380 of
 * 588 users with a live check, all of them silently.
 *
 * Styled destructive rather than warning on purpose: a monitor that cannot alert is
 * a broken monitor, not a suggestion.
 */
export const NoAlertChannelBanner = memo(function NoAlertChannelBanner({
  checkCount,
}: NoAlertChannelBannerProps) {
  const subject = checkCount === 1 ? 'This check' : `These ${checkCount} checks`;
  const verb = checkCount === 1 ? 'goes' : 'go';

  return (
    <Alert className="border-destructive/40 bg-destructive/10 backdrop-blur-sm">
      <BellOff className="h-4 w-4 text-destructive self-center !translate-y-0" />
      <AlertDescription className="text-sm text-foreground flex items-center gap-3 flex-wrap">
        <span>
          <span className="font-medium">No one will be told when {verb === 'goes' ? 'it' : 'they'} {verb} down.</span>{' '}
          {subject} {checkCount === 1 ? 'is' : 'are'} running, but you have no email, SMS or
          webhook set up.
        </span>
        <Button asChild size="sm" className="cursor-pointer w-fit shrink-0 gap-1.5">
          <Link to="/emails">
            Set up alerts
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
});
