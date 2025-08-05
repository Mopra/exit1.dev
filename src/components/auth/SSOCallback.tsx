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
  const [isProcessing, setIsProcessing] = useState(false);
  const message = 'Processing Authentication';
  const hasProcessed = useRef(false); // Prevent multiple executions

  // Debug logging for OAuth callback
  useEffect(() => {
    console.log('SSO Callback URL params:', {
      strategy: searchParams.get('__clerk_strategy'),
      redirectUrl: searchParams.get('__clerk_redirect_url'),
      sessionId: searchParams.get('__clerk_created_session_id'),
      error: searchParams.get('__clerk_error'),
      cancelled: searchParams.get('__clerk_cancelled'),
      status: searchParams.get('__clerk_status'),
      allParams: Object.fromEntries(searchParams.entries())
    });
  }, [searchParams]);

  useEffect(() => {
    if (!signInLoaded || !signUpLoaded || hasProcessed.current || isProcessing) return;

    const handleSSOCallback = async () => {
      hasProcessed.current = true; // Mark as processed to prevent re-execution
      setIsProcessing(true);
      
      try {
        // Check for OAuth errors first
        const error = searchParams.get('__clerk_error');
        if (error) {
          const decodedError = decodeURIComponent(error);
          console.error('OAuth error received:', decodedError);
          setError(decodedError);
          setTimeout(() => {
            navigate('/login', { replace: true });
          }, 3000);
          return;
        }

        // Check if user cancelled the OAuth flow
        const cancelled = searchParams.get('__clerk_cancelled');
        if (cancelled === 'true') {
          console.log('OAuth flow was cancelled by user');
          navigate('/login', { replace: true });
          return;
        }

        // Get the session ID
        const createdSessionId = searchParams.get('__clerk_created_session_id');
        if (!createdSessionId) {
          console.error('No session ID found in callback');
          setError('Authentication failed: No session created');
          setTimeout(() => {
            navigate('/login', { replace: true });
          }, 3000);
          return;
        }

        // Determine if this is a sign-up or sign-in based on the strategy
        const strategy = searchParams.get('__clerk_strategy');
        const isSignUp = strategy && strategy.includes('oauth_');
        
        // Get the intended redirect URL
        const redirectUrl = searchParams.get('__clerk_redirect_url') || '/checks';
        
        console.log('SSO callback processing:', {
          strategy,
          isSignUp,
          hasSessionId: !!createdSessionId,
          redirectUrl
        });

        try {
          if (isSignUp) {
            // Handle sign-up flow
            await setSignUpActive({ session: createdSessionId });
            console.log('Sign-up active session set successfully');
          } else {
            // Handle sign-in flow
            await setSignInActive({ session: createdSessionId });
            console.log('Sign-in active session set successfully');
          }
          
          // Navigate to the intended destination
          navigate(redirectUrl, { replace: true });
        } catch (sessionError: any) {
          console.error('Error setting active session:', sessionError);
          setError('Failed to complete authentication. Please try again.');
          setTimeout(() => {
            navigate('/login', { replace: true });
          }, 3000);
        }
      } catch (err: any) {
        console.error('SSO callback error:', err);
        setError(err.message || 'Authentication failed');
        setTimeout(() => {
          navigate('/login', { replace: true });
        }, 3000);
      } finally {
        setIsProcessing(false);
      }
    };

    // Add a timeout fallback in case the callback gets stuck
    const timeoutId = setTimeout(() => {
      if (!hasProcessed.current) {
        console.warn('SSO callback timeout - redirecting to login');
        navigate('/login', { replace: true });
      }
    }, 10000); // 10 second timeout

    handleSSOCallback();

    return () => clearTimeout(timeoutId);
  }, [signInLoaded, signUpLoaded, searchParams, navigate, setSignInActive, setSignUpActive, isProcessing]);

  if (error) {
    return (
      <div className={`min-h-screen ${theme.colors.background.primary} ${theme.colors.text.primary} ${typography.fontFamily.body} flex items-center justify-center`}>
        <div className="text-center">
          <div className={`text-xl tracking-widest uppercase mb-2 ${theme.colors.text.error}`}>Authentication Error</div>
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
        <div className="text-sm opacity-80">→ Completing authentication process</div>
      </div>
    </div>
  );
};

export default SSOCallback; 