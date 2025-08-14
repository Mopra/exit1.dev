import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from '../ui';

type Phase = 'sign-in' | 'verifying';

// Debug logging setup
const DEBUG_MODE = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true' || (window as any).VITE_DEBUG === 'true';
const log = (message: string, data?: any) => {
  if (DEBUG_MODE) {
    console.log(`[LoginForm] ${message}`, data || '');
  }
};

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isLoaded: isSignInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: isSignUpLoaded, signUp } = useSignUp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(location.state?.message || null);

  const emailRef = useRef<HTMLInputElement>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);

  // Protected OAuth handlers with rate limiting protection
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
      console.error(`[LoginForm] ${strategy} error:`, err);
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
  };
  
  const handlePasswordBlur = () => {
    const error = validatePassword(password);
    setPasswordError(error);
  };

  const trySignUpFallback = async () => {
    if (!signUp) {
      setError('Authentication service is not ready. Please try again.');
      return;
    }

    log('Attempting sign-up fallback');
    try {
      const result = await signUp.create({
        emailAddress: email,
        password,
      });

      if (result.status === 'complete') {
        log('Sign-up fallback complete, setting active session');
        await setActive?.({ session: result.createdSessionId });
        const from = location.state?.from?.pathname || '/checks';
        navigate(from, { replace: true });
      } else if (result.status === 'missing_requirements') {
        log('Sign-up requires email verification - preparing code');
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        setPhase('verifying');
        setMessage('We created your account. Enter the code sent to your email.');
      } else {
        log('Sign-up incomplete', { status: result.status });
        setError('Sign up incomplete. Please try again.');
      }
    } catch (err: unknown) {
      const e = err as any;
      log('Sign-up fallback error', e);
      setError(e?.errors?.[0]?.message || 'Could not create your account. Please try again.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    log('Form submission started');
    
    // Clear any previous messages
    setMessage(null);
    
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
      const e = err as any;
      const first = e?.errors?.[0];
      const code = first?.code as string | undefined;
      const msg = first?.message as string | undefined;

      log('Sign in error', { code, message: msg });

      const looksLikeNoAccount =
        code === 'form_identifier_not_found' ||
        code === 'identifier_not_found' ||
        msg?.toLowerCase()?.includes('not found');

      if (looksLikeNoAccount && isSignUpLoaded) {
        await trySignUpFallback();
      } else if (code === 'form_password_incorrect') {
        setError('Incorrect email or password.');
      } else {
        setError(msg || 'An error occurred during sign in.');
      }
    } finally {
      setLoading(false);
      log('Form submission completed');
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signUp) return;

    setLoading(true);
    setError(null);

    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === 'complete') {
        await setActive?.({ session: result.createdSessionId });
        const from = location.state?.from?.pathname || '/checks';
        navigate(from, { replace: true });
      } else {
        setError('Verification failed. Please try again.');
      }
    } catch (err: unknown) {
      const e = err as any;
      setError(e?.errors?.[0]?.message || 'An error occurred during verification.');
    } finally {
      setLoading(false);
    }
  };

  const isButtonDisabled = loading || !!oauthLoading || !isSignInLoaded || !isSignUpLoaded;

  return (
    <div className={cn("flex flex-col gap-2 sm:gap-6", className)} {...props}>
      <Card className="mx-0 sm:mx-0">
        <CardHeader className="text-center pb-2 sm:pb-6 px-3 sm:px-6 pt-4 sm:pt-6">
          <CardTitle className="text-lg sm:text-xl">{phase === 'sign-in' ? 'Welcome back' : 'Verify your email'}</CardTitle>
          <CardDescription className="text-sm">
            {phase === 'sign-in' ? 'Sign in with your Google, GitHub, or Discord account' : 'Enter the verification code sent to your email'}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 px-3 sm:px-6 pb-3 sm:pb-6">
          {phase === 'sign-in' ? (
            <form onSubmit={handleSubmit}>
              <div className="grid gap-3 sm:gap-6">
                <div className="flex flex-col gap-3 sm:gap-4">
                  <Button 
                    variant="outline" 
                    className="w-full cursor-pointer" 
                    type="button"
                    onClick={() => handleOAuthSignIn('oauth_google')}
                    disabled={isButtonDisabled}
                  >
                    {oauthLoading === 'oauth_google' ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing In...</span>
                      </div>
                    ) : (
                      'Sign in with Google'
                    )}
                  </Button>
                  
                  <Button 
                    variant="outline" 
                    className="w-full cursor-pointer" 
                    type="button"
                    onClick={() => handleOAuthSignIn('oauth_github')}
                    disabled={isButtonDisabled}
                  >
                    {oauthLoading === 'oauth_github' ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing In...</span>
                      </div>
                    ) : (
                      'Sign in with GitHub'
                    )}
                  </Button>

                  <Button 
                    variant="outline" 
                    className="w-full cursor-pointer" 
                    type="button"
                    onClick={() => handleOAuthSignIn('oauth_discord')}
                    disabled={isButtonDisabled}
                  >
                    {oauthLoading === 'oauth_discord' ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing In...</span>
                      </div>
                    ) : (
                      'Sign in with Discord'
                    )}
                  </Button>
                </div>
                
                <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                  <span className="relative z-10 bg-card px-2 text-muted-foreground">
                    Or continue with
                  </span>
                </div>
                
                <div className="grid gap-3 sm:gap-6">
                  <div className="grid gap-2 sm:gap-3">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="m@example.com"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onBlur={handleEmailBlur}
                      ref={emailRef}
                      className={emailError ? 'border-red-500' : ''}
                    />
                    {emailError && (
                      <p className="text-red-400 text-sm">{emailError}</p>
                    )}
                  </div>
                  <div className="grid gap-2 sm:gap-3">
                    <div className="flex items-center">
                      <Label htmlFor="password">Password</Label>
                      <Link
                        to="/forgot-password"
                        className="ml-auto text-sm underline-offset-4 hover:underline cursor-pointer"
                      >
                        Forgot your password?
                      </Link>
                    </div>
                    <Input 
                      id="password" 
                      type="password" 
                      required 
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={handlePasswordBlur}
                      className={passwordError ? 'border-red-500' : ''}
                    />
                    {passwordError && (
                      <p className="text-red-400 text-sm">{passwordError}</p>
                    )}
                  </div>
                  
                  {(!isSignInLoaded || !isSignUpLoaded) && (
                    <div className="text-muted-foreground text-sm flex items-center">
                      <Spinner size="sm" className="mr-2" />
                      Initializing authentication service...
                    </div>
                  )}
                  
                  {message && <p className="text-green-600 text-sm">{message}</p>}
                  {error && <p className="text-destructive text-sm">{error}</p>}
                  
                  <Button type="submit" className="w-full cursor-pointer" disabled={isButtonDisabled}>
                    {loading ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing In...</span>
                      </div>
                    ) : (
                      'Sign In'
                    )}
                  </Button>
                </div>
                
                <div className="text-center text-sm">
                  Don&apos;t have an account?{" "}
                  <Link to="/sign-up" className="underline underline-offset-4 cursor-pointer">
                    Sign up
                  </Link>
                </div>
              </div>
            </form>
          ) : (
            <form onSubmit={handleVerify}>
              <div className="grid gap-3 sm:gap-6">
                <div className="grid gap-2 sm:gap-3">
                  <Label htmlFor="code">Verification Code</Label>
                  <Input
                    id="code"
                    type="text"
                    placeholder="Enter the code sent to your email"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
                
                {error && <p className="text-destructive text-sm">{error}</p>}
                {message && <p className="text-green-600 text-sm">{message}</p>}
                
                <Button type="submit" className="w-full cursor-pointer" disabled={loading}>
                  {loading ? (
                    <div className="flex items-center justify-center w-full">
                      <Spinner size="sm" className="mr-2" />
                      <span>Verifying...</span>
                    </div>
                  ) : (
                    'Verify'
                  )}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
