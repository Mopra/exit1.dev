import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from '../ui';

interface EmailEmptyStateProps {
  hasRecipients: boolean;
  hasChecks: boolean;
  checkFilterMode: 'all' | 'include';
  search: string;
}

export const EmailEmptyState = memo(function EmailEmptyState({
  hasRecipients,
  hasChecks,
  checkFilterMode,
  search,
}: EmailEmptyStateProps) {
  const navigate = useNavigate();

  // Variant 1: search returned no results
  if (search.trim()) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No checks found matching &ldquo;{search}&rdquo;
        </p>
      </div>
    );
  }

  // Variant 2: "Selected only" mode with none selected
  if (hasChecks && checkFilterMode === 'include') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-1">
        <p className="text-sm font-medium">No checks selected for email alerts.</p>
        <p className="text-sm text-muted-foreground">
          Switch to &lsquo;All checks&rsquo; or enable individual checks above.
        </p>
      </div>
    );
  }

  // Variant 3: no checks exist — onboarding
  const steps = [
    {
      label: 'Add your email address above',
      done: hasRecipients,
    },
    {
      label: 'Create a check from the dashboard',
      done: false,
    },
    {
      label: 'Alerts are automatically enabled for new checks',
      done: false,
    },
  ];

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-6 px-4">
      {/* Icon */}
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted">
        <Mail className="w-8 h-8 text-muted-foreground" />
      </div>

      {/* Heading + description */}
      <div className="space-y-2 max-w-sm">
        <h3 className="text-base font-semibold">Email alerts</h3>
        <p className="text-sm text-muted-foreground">
          Get notified when your checks go down, recover, or when SSL/domain issues are
          detected.
        </p>
      </div>

      {/* Numbered steps */}
      <ol className="flex flex-col items-start gap-3 text-sm max-w-xs w-full">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-3">
            <span
              className={`flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full border text-xs font-medium mt-0.5 ${
                step.done
                  ? 'border-transparent bg-transparent text-muted-foreground'
                  : 'border-border text-muted-foreground'
              }`}
            >
              {step.done ? (
                <CheckCircle2 className="w-4 h-4 text-success" />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={
                step.done
                  ? 'line-through text-muted-foreground'
                  : 'text-foreground'
              }
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>

      {/* CTA */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate('/')}
        className="gap-1.5"
      >
        Go to Dashboard
        <ArrowRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
});
