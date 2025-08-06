import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { Button, Input, Label, Spinner, Separator } from '../ui';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { theme } from '../../config/theme';
import AuthLayout from './AuthLayout';

// Debug logging setup
const DEBUG_MODE = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true' || (window as any).VITE_DEBUG === 'true';
const log = (message: string, data?: any) => {
  if (DEBUG_MODE) {
    console.log(`[CustomSignIn] ${message}`, data || '');
  }
};

const CustomSignIn: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null); // Track which OAuth is loading

  const emailRef = useRef<HTMLInputElement>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);

  log('CustomSignIn component rendering', {
    isLoaded,
    hasSignIn: !!signIn,
    hasSetActive: !!setActive,
    loading,
    oauthLoading,
    error,
    emailLength: email.length,
    passwordLength: password.length
  });

  // Protected OAuth handlers with rate limiting protection - moved before early return
  const handleOAuthSignIn = useCallback(async (strategy: 'oauth_google' | 'oauth_github' | 'oauth_discord') => {
    log('OAuth sign in attempt', { strategy });
    
    // Safety check for signIn availability
    if (!signIn) {
      log('OAuth blocked - signIn not available yet');
      return;
    }

    // Prevent multiple concurrent OAuth attempts
    if (oauthLoading || loading) {
      log('OAuth blocked - already in progress', { oauthLoading, loading });
      return;
    }

    setOauthLoading(strategy);
    setError(null);

    try {
      const from = location.state?.from?.pathname || '/checks';
      log('Starting OAuth redirect', { strategy, from });
      
      // Add strategy and redirect URL as query parameters for better tracking
      const redirectUrl = new URL(`${window.location.origin}/sso-callback`);
      redirectUrl.searchParams.set('__clerk_strategy', strategy);
      redirectUrl.searchParams.set('__clerk_redirect_url', from);
      
      log('OAuth redirect URL:', redirectUrl.toString());
      
      await signIn.authenticateWithRedirect({ 
        strategy, 
        redirectUrl: redirectUrl.toString(), 
        redirectUrlComplete: from 
      });
      log('OAuth redirect initiated successfully');
    } catch (err: any) {
      console.error(`[CustomSignIn] ${strategy} error:`, err);
      log('OAuth error', { strategy, error: err.message, status: err.status });
      
      // Handle rate limiting specifically
      if (err.status === 429 || err.message?.includes('rate') || err.message?.includes('Rate')) {
        setError('Too many sign-in attempts. Please wait a moment and try again.');
      } else {
        setError(err.errors?.[0]?.message || `Failed to sign in with ${strategy.replace('oauth_', '')}. Please try again.`);
      }
      
      setOauthLoading(null);
    }
  }, [signIn, location.state, oauthLoading, loading]);

  useEffect(() => {
    log('Focusing email input');
    emailRef.current?.focus();
  }, []);

  // Instead of showing a loading screen, we'll render the form but disable interactions

  const validateEmail = (value: string): string | undefined => {
    if (!value) return 'Email is required';
    if (!/^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/.test(value)) return 'Invalid email format';
    return undefined;
  };
  const validatePassword = (value: string): string | undefined => {
    if (!value) return 'Password is required';
    return undefined;
  };

  const handleEmailBlur = () => {
    const error = validateEmail(email);
    setEmailError(error);
    log('Email validation', { email: email.substring(0, 3) + '***', error });
  };
  const handlePasswordBlur = () => {
    const error = validatePassword(password);
    setPasswordError(error);
    log('Password validation', { hasPassword: !!password, error });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    log('Form submission started');
    
    // Safety check for Clerk availability
    if (!signIn || !setActive) {
      const errorMsg = 'Authentication service is not ready. Please try again.';
      log('Form submission blocked - auth service not ready');
      setError(errorMsg);
      return;
    }

    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    setEmailError(emailErr);
    setPasswordError(passwordErr);
    
    if (emailErr || passwordErr) {
      log('Form validation failed', { emailErr, passwordErr });
      return;
    }
    
    setLoading(true);
    setError(null);

    try {
      log('Creating sign in session');
      const result = await signIn.create({
        identifier: email,
        password,
      });

      log('Sign in result', { status: result.status });

      if (result.status === 'complete') {
        log('Sign in complete, setting active session');
        await setActive({ session: result.createdSessionId });
        // Navigate to the original page they were trying to access, or default to /checks
        const from = location.state?.from?.pathname || '/checks';
        log('Navigating after successful sign in', { from });
        navigate(from, { replace: true });
      } else {
        // If incomplete, might need to handle other factors, but for password it's usually complete
        log('Sign in incomplete', { status: result.status });
        setError('Sign in incomplete. Please try again.');
      }
    } catch (err: unknown) {
      const error = err as { errors?: Array<{ message: string }> };
      const errorMessage = error.errors?.[0]?.message || 'An error occurred during sign in.';
      log('Sign in error', { error: errorMessage });
      setError(errorMessage);
    } finally {
      setLoading(false);
      log('Form submission completed');
    }
  };

  const isButtonDisabled = loading || !!oauthLoading || !isLoaded;
  log('Button state', { isButtonDisabled, loading, oauthLoading, isLoaded });

  return (
    <AuthLayout title="Sign In" variant="signin">
      <Button 
        variant="default" 
        className="w-full" 
        onClick={() => handleOAuthSignIn('oauth_google')}
        disabled={isButtonDisabled}
      >
        {oauthLoading === 'oauth_google' ? (
          <div className="flex items-center justify-center w-full">
            <Spinner size="sm" className="mr-2" />
            <span>Signing In...</span>
          </div>
        ) : (
          <>
            <FontAwesomeIcon icon={['fab', 'google']} className="mr-2" />
            <span>Sign In with Google</span>
          </>
        )}
      </Button>
      
      <Button 
        variant="default" 
        className="w-full mt-4" 
        onClick={() => handleOAuthSignIn('oauth_github')}
        disabled={isButtonDisabled}
      >
        {oauthLoading === 'oauth_github' ? (
          <div className="flex items-center justify-center w-full">
            <Spinner size="sm" className="mr-2" />
            <span>Signing In...</span>
          </div>
        ) : (
          <>
            <FontAwesomeIcon icon={['fab', 'github']} className="mr-2" />
            <span>Sign In with GitHub</span>
          </>
        )}
      </Button>
      
      <Button 
        variant="default" 
        className="w-full mt-4" 
        onClick={() => handleOAuthSignIn('oauth_discord')}
        disabled={isButtonDisabled}
      >
        {oauthLoading === 'oauth_discord' ? (
          <div className="flex items-center justify-center w-full">
            <Spinner size="sm" className="mr-2" />
            <span>Signing In...</span>
          </div>
        ) : (
          <>
            <FontAwesomeIcon icon={['fab', 'discord']} className="mr-2" />
            <span>Sign In with Discord</span>
          </>
        )}
      </Button>
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <Separator className="w-full" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">or</span>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <Label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            onBlur={handleEmailBlur}
            placeholder="Enter your email"
            required
            ref={emailRef}
            className={emailError ? 'border-red-500' : ''}
          />
          {emailError && (
            <p className="text-red-400 text-sm mt-2">{emailError}</p>
          )}
        </div>
        <div>
          <Label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            onBlur={handlePasswordBlur}
            placeholder="Enter your password"
            required
            className={passwordError ? 'border-red-500' : ''}
          />
          {passwordError && (
            <p className="text-red-400 text-sm mt-2">{passwordError}</p>
          )}
        </div>
        {!isLoaded && <div className={`${theme.colors.text.secondary} text-sm flex items-center`}>
          <Spinner size="sm" className="mr-2" />
          Initializing authentication service...
        </div>}
        {error && <p className={`${theme.colors.text.error} text-sm`}>{error}</p>}
        <Button type="submit" variant="default" disabled={isButtonDisabled} className="w-full">
          {loading ? (
            <div className="flex items-center justify-center w-full">
              <Spinner size="sm" className="mr-2" />
              <span>Signing In...</span>
            </div>
          ) : (
            <span>Sign In</span>
          )}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm">
        Don&apos;t have an account? <Link to="/sign-up" className="text-blue-400 hover:text-blue-300 underline transition-colors">Sign Up</Link>
      </p>
      <div className="flex items-center justify-center mt-4 h-1 rounded-full bg-blue-600/50"></div>
    </AuthLayout>
  );
};

export default CustomSignIn; 