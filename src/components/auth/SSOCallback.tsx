import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthenticateWithRedirectCallback } from '@clerk/clerk-react';
import { Spinner } from '../ui';
import { isOnboardingComplete } from '@/pages/Onboarding';

const SSOCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  // Use the localStorage cache here (the user isn't signed-in yet, so we can't
  // hit the server). On a fresh device the cache is empty → we send them to
  // /onboarding, which itself hydrates from the server and redirects to
  // /checks if they've already onboarded.
  const onboarded = isOnboardingComplete();
  const afterSignInUrl = onboarded ? (searchParams.get('__clerk_redirect_url') || '/checks') : '/onboarding';
  const afterSignUpUrl = onboarded ? (searchParams.get('__clerk_redirect_url') || '/checks') : '/onboarding';

  return (
    <div className={`min-h-svh bg-background text-foreground font-sans flex items-center justify-center`}>
      <div className="text-center">
        <Spinner size="lg" className="mb-4" />
        <div className="text-xl tracking-widest uppercase mb-2">Processing Authentication</div>
        <div className="text-sm opacity-80">→ Completing authentication process</div>
        <AuthenticateWithRedirectCallback afterSignInUrl={afterSignInUrl} afterSignUpUrl={afterSignUpUrl} />
      </div>
    </div>
  );
};

export default SSOCallback;