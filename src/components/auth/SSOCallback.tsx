import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthenticateWithRedirectCallback } from '@clerk/clerk-react';
import { Spinner } from '../ui';

const SSOCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  // LoginForm/SignUpForm already resolve the post-auth destination (always a
  // path like `/onboarding` or `/onboarding?next=/checks`) and stash it in
  // `__clerk_redirect_url`. Trust it, but validate to avoid open-redirect —
  // only accept same-origin paths.
  const raw = searchParams.get('__clerk_redirect_url');
  const target = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/onboarding';

  return (
    <div className={`min-h-svh bg-background text-foreground font-sans flex items-center justify-center`}>
      <div className="text-center">
        <Spinner size="lg" className="mb-4" />
        <div className="text-xl tracking-widest uppercase mb-2">Processing Authentication</div>
        <div className="text-sm opacity-80">→ Completing authentication process</div>
        <AuthenticateWithRedirectCallback afterSignInUrl={target} afterSignUpUrl={target} />
      </div>
    </div>
  );
};

export default SSOCallback;
