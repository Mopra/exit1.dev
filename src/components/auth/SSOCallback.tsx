import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import Spinner from '../ui/Spinner';
import { theme, typography } from '../../config/theme';

const SSOCallback: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isLoaded: signInLoaded, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, setActive: setSignUpActive } = useSignUp();
  const [error, setError] = useState<string | null>(null);
  const message = 'Processing Authentication';
  const hasProcessed = useRef(false); // Prevent multiple executions

  useEffect(() => {
    if (!signInLoaded || !signUpLoaded || hasProcessed.current) return;

    const handleSSOCallback = async () => {
      hasProcessed.current = true; // Mark as processed to prevent re-execution
      
      try {
        // Check if this is a sign-in or sign-up flow
        const isSignUp = searchParams.get('__clerk_status') === 'complete' && searchParams.get('__clerk_created_session_id');
        
        if (isSignUp) {
          // Handle sign-up flow
          const createdSessionId = searchParams.get('__clerk_created_session_id');
          if (createdSessionId) {
            await setSignUpActive({ session: createdSessionId });
            navigate('/checks', { replace: true });
            return;
          }
        } else {
          // Handle sign-in flow
          const createdSessionId = searchParams.get('__clerk_created_session_id');
          if (createdSessionId) {
            await setSignInActive({ session: createdSessionId });
            navigate('/checks', { replace: true });
            return;
          }
        }

        // If no session was created, check for errors
        const error = searchParams.get('__clerk_error');
        if (error) {
          setError(decodeURIComponent(error));
          setTimeout(() => {
            navigate('/login', { replace: true });
          }, 3000);
          return;
        }

        // Fallback: redirect to login if no clear status
        navigate('/login', { replace: true });
      } catch (err: any) {
        console.error('SSO callback error:', err);
        setError(err.message || 'Authentication failed');
        setTimeout(() => {
          navigate('/login', { replace: true });
        }, 3000);
      }
    };

    handleSSOCallback();
  }, [signInLoaded, signUpLoaded, searchParams, navigate, setSignInActive, setSignUpActive]);

  if (error) {
    return (
      <div className={`min-h-screen ${theme.colors.background.primary} ${theme.colors.text.primary} ${typography.fontFamily.body} flex items-center justify-center`}>
        <div className="text-center">
          <div className="text-xl tracking-widest uppercase mb-2 text-red-400">Authentication Error</div>
          <div className="text-sm opacity-80 mb-4">{error}</div>
          <div className="text-xs opacity-60">Redirecting to login...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${theme.colors.background.primary} ${theme.colors.text.primary} ${typography.fontFamily.body} flex items-center justify-center`}>
      <div className="text-center">
        <Spinner size="lg" className="mb-4" />
        <div className="text-xl tracking-widest uppercase mb-2">{message}</div>
        <div className="text-sm opacity-80">→ Completing sign-in process</div>
      </div>
    </div>
  );
};

export default SSOCallback; 