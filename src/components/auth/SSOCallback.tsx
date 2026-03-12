import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthenticateWithRedirectCallback } from '@clerk/clerk-react';
import { Spinner } from '../ui';
import { isOnboardingComplete } from '@/pages/Onboarding';

const SSOCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const afterUrl = searchParams.get('__clerk_redirect_url') || '/checks';
  // New signups always go to onboarding (unless already completed)
  const afterSignUpUrl = isOnboardingComplete() ? afterUrl : '/onboarding';

  return (
    <div className={`min-h-svh bg-background text-foreground font-sans flex items-center justify-center`}>
      <div className="text-center">
        <Spinner size="lg" className="mb-4" />
        <div className="text-xl tracking-widest uppercase mb-2">Processing Authentication</div>
        <div className="text-sm opacity-80">→ Completing authentication process</div>
        <AuthenticateWithRedirectCallback afterSignInUrl={afterUrl} afterSignUpUrl={afterSignUpUrl} />
      </div>
    </div>
  );
};

export default SSOCallback;