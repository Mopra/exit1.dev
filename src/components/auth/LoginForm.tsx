import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSignIn } from '@clerk/clerk-react';
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
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

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

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>
            Sign in with your Google, GitHub, or Discord account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="grid gap-6">
              <div className="flex flex-col gap-4">
                <Button 
                  variant="outline" 
                  className="w-full" 
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
                  className="w-full" 
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
                  className="w-full" 
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
              
              <div className="grid gap-6">
                <div className="grid gap-3">
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
                <div className="grid gap-3">
                  <div className="flex items-center">
                    <Label htmlFor="password">Password</Label>
                    <a
                      href="#"
                      className="ml-auto text-sm underline-offset-4 hover:underline"
                    >
                      Forgot your password?
                    </a>
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
                
                {!isLoaded && (
                  <div className="text-muted-foreground text-sm flex items-center">
                    <Spinner size="sm" className="mr-2" />
                    Initializing authentication service...
                  </div>
                )}
                
                {error && <p className="text-destructive text-sm">{error}</p>}
                
                <Button type="submit" className="w-full" disabled={isButtonDisabled}>
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
                <Link to="/sign-up" className="underline underline-offset-4">
                  Sign up
                </Link>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
      
      <div className="text-muted-foreground text-center text-xs text-balance">
        By clicking continue, you agree to our <a href="#" className="underline underline-offset-4">Terms of Service</a>{" "}
        and <a href="#" className="underline underline-offset-4">Privacy Policy</a>.
      </div>
    </div>
  )
}
