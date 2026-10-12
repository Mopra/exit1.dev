import { Link, useLocation } from 'react-router-dom';
import { Eye, Mail, Users } from 'lucide-react';
import { teamAccountLabel, useAccount } from '@/AccountProvider';

/**
 * One line under the top bar that says whose account you're in. Without it a
 * teammate can't tell their own checks from the team's at a glance. Also
 * nudges someone with an unanswered invite, which is how a person who signed
 * up from an invite email finds it again after onboarding.
 */
export function TeamAccountBanner() {
  const account = useAccount();
  const { pathname } = useLocation();

  if (account.isMember && account.activeTeam) {
    const viewer = account.role === 'viewer';
    return (
      <div className="mb-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            {viewer ? <Eye className="h-3.5 w-3.5 shrink-0" /> : <Users className="h-3.5 w-3.5 shrink-0" />}
            <span>
              Working in <strong className="font-semibold">{teamAccountLabel(account.activeTeam)}</strong>'s account
              {viewer ? ' as a viewer (read only)' : ''}
            </span>
          </span>
          <button
            type="button"
            onClick={() => account.switchAccount(null)}
            className="cursor-pointer underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            Switch to my account
          </button>
        </div>
      </div>
    );
  }

  if (account.invites.length > 0 && pathname !== '/team') {
    const count = account.invites.length;
    return (
      <div className="mb-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            {count === 1
              ? `${teamAccountLabel(account.invites[0])} invited you to their team`
              : `You have ${count} team invites`}
          </span>
          <Link to="/team" className="cursor-pointer underline underline-offset-2 opacity-80 hover:opacity-100">
            View
          </Link>
        </div>
      </div>
    );
  }

  return null;
}
