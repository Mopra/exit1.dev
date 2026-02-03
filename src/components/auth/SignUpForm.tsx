import React, { useState, useCallback } from 'react';
import { useSignUp } from '@clerk/clerk-react';
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
import { db } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';

type Phase = 'initial' | 'verifying';

export function SignUpForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isLoaded, signUp, setActive } = useSignUp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('initial');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);

  const validateEmail = (value: string): string | undefined => {
    if (!value) return 'Email is required';
    if (!/^[\w-.]+@([\w-]+\.)+[\w-]{2,}$/.test(value)) return 'Invalid email format';
    return undefined;
  };
  
  const validatePassword = (value: string): string | undefined => {
    if (!value) return 'Password is required';
    return undefined;
  };

  if (!isLoaded) {
    return (
      <div className="min-h-svh bg-background text-foreground font-sans flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    setEmailError(emailErr);
    setPasswordError(passwordErr);
    
    if (emailErr || passwordErr) {
      return;
    }
    
    setLoading(true);

    try {
      // Check migration table to see if user already exists in dev instance
      const normalizedEmail = email.toLowerCase().trim();
      
      try {
        const migrationDocRef = doc(db, 'userMigrations', normalizedEmail);
        const migrationDoc = await getDoc(migrationDocRef);
        
        if (migrationDoc.exists()) {
          const migrationData = migrationDoc.data();
          if (migrationData.instance === 'dev' && !migrationData.migrated) {
            // User exists in dev instance - block sign-up
            setError('An account with this email already exists. Please sign in instead.');
            return;
          }
          // If migrated, allow sign-up (though this shouldn't happen normally)
        }
      } catch (firestoreError) {
        // If Firestore check fails, log but continue with sign-up
        // This allows new users to sign up even if migration table is unavailable
        console.warn('[SignUpForm] Migration table check failed:', firestoreError);
      }
      
      const result = await signUp.create({
        emailAddress: email,
        password,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        const from = location.state?.from?.pathname || '/checks';
        navigate(from, { replace: true });
      } else if (result.status === 'missing_requirements') {
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        setPhase('verifying');
      } else {
        setError('Sign up incomplete.');
      }
    } catch (err: unknown) {
      const error = err as any;
      console.error('[SignUpForm] Sign-up error:', error);
      console.error('[SignUpForm] Error details:', {
        message: error?.message,
        errors: error?.errors,
        status: error?.status,
        code: error?.errors?.[0]?.code,
      });
      
      // Provide more specific error messages
      const errorMessage = error?.errors?.[0]?.message;
      const errorCode = error?.errors?.[0]?.code;
      
      if (errorCode === 'form_identifier_exists' || errorMessage?.toLowerCase().includes('already exists')) {
        setError('An account with this email already exists. Please sign in instead.');
      } else if (errorCode === 'form_password_pwned') {
        setError('This password has been found in a data breach. Please choose a different password.');
      } else if (errorCode === 'form_password_length_too_short') {
        setError('Password is too short. Please choose a longer password.');
      } else if (errorMessage) {
        setError(errorMessage);
      } else {
        setError('An error occurred during sign up. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        const from = location.state?.from?.pathname || '/checks';
        navigate(from, { replace: true });
      } else {
        setError('Verification failed. Please try again.');
      }
    } catch (err: unknown) {
      const error = err as { errors?: Array<{ message: string }> };
      setError(error.errors?.[0]?.message || 'An error occurred during verification.');
    } finally {
      setLoading(false);
    }
  };

  // Protected OAuth handlers with rate limiting protection
  const handleOAuthSignUp = useCallback(async (strategy: 'oauth_google' | 'oauth_github' | 'oauth_discord') => {
    if (oauthLoading || loading) {
      return;
    }

    setOauthLoading(strategy);
    setError(null);

    try {
      const from = location.state?.from?.pathname || '/checks';
      
      const redirectUrl = new URL(`${window.location.origin}/sso-callback`);
      redirectUrl.searchParams.set('__clerk_strategy', strategy);
      redirectUrl.searchParams.set('__clerk_redirect_url', from);
      
      await signUp.authenticateWithRedirect({ 
        strategy, 
        redirectUrl: redirectUrl.toString(), 
        redirectUrlComplete: from 
      });
    } catch (err: any) {
      console.error(`[SignUpForm] ${strategy} error:`, err);
      
      if (err.status === 429 || err.message?.includes('rate') || err.message?.includes('Rate')) {
        setError('Too many sign-up attempts. Please wait a moment and try again.');
      } else {
        setError(err.errors?.[0]?.message || `Failed to sign up with ${strategy.replace('oauth_', '')}. Please try again.`);
      }
      
      setOauthLoading(null);
    }
  }, [signUp, location.state, oauthLoading, loading]);

  const isButtonDisabled = loading || !!oauthLoading;

  return (
    <div className={cn("flex flex-col gap-2 sm:gap-6", className)} {...props}>
      <Card className="mx-0 sm:mx-0">
        <CardHeader className="text-center pb-2 sm:pb-6 px-3 sm:px-6 pt-4 sm:pt-6">
          <CardTitle className="text-lg sm:text-xl">Create an account</CardTitle>
          <CardDescription className="text-sm">
            {phase === 'initial' 
              ? 'Sign up with your Google, GitHub, or Discord account'
              : 'Enter the verification code sent to your email'
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 px-3 sm:px-6 pb-3 sm:pb-6">
          {phase === 'initial' ? (
            <form onSubmit={handleSignUp} noValidate>
              <div className="grid gap-3 sm:gap-6">
                <div className="flex flex-col gap-3 sm:gap-4">
                  <Button 
                    variant="outline" 
                    className="w-full" 
                    type="button"
                    onClick={() => handleOAuthSignUp('oauth_google')}
                    disabled={isButtonDisabled}
                  >
                    {oauthLoading === 'oauth_google' ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing Up...</span>
                      </div>
                    ) : (
                      'Sign up with Google'
                    )}
                  </Button>
                  
                  <Button 
                    variant="outline" 
                    className="w-full" 
                    type="button"
                    onClick={() => handleOAuthSignUp('oauth_github')}
                    disabled={isButtonDisabled}
                  >
                    {oauthLoading === 'oauth_github' ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing Up...</span>
                      </div>
                    ) : (
                      'Sign up with GitHub'
                    )}
                  </Button>

                  <Button 
                    variant="outline" 
                    className="w-full" 
                    type="button"
                    onClick={() => handleOAuthSignUp('oauth_discord')}
                    disabled={isButtonDisabled}
                  >
                    {oauthLoading === 'oauth_discord' ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing Up...</span>
                      </div>
                    ) : (
                      'Sign up with Discord'
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
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (emailError) {
                          setEmailError(validateEmail(e.target.value));
                        }
                      }}
                      onBlur={() => {
                        const error = validateEmail(email);
                        setEmailError(error);
                      }}
                      className={emailError ? 'border-red-500' : ''}
                    />
                    {emailError && (
                      <p className="text-red-400 text-sm">{emailError}</p>
                    )}
                  </div>
                  <div className="grid gap-2 sm:gap-3">
                    <Label htmlFor="password">Password</Label>
                    <Input 
                      id="password" 
                      type="password" 
                      placeholder="Create a password"
                      required 
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (passwordError) {
                          setPasswordError(validatePassword(e.target.value));
                        }
                      }}
                      onBlur={() => {
                        const error = validatePassword(password);
                        setPasswordError(error);
                      }}
                      className={passwordError ? 'border-red-500' : ''}
                    />
                    {passwordError && (
                      <p className="text-red-400 text-sm">{passwordError}</p>
                    )}
                  </div>
                  
                  {error && <p className="text-destructive text-sm">{error}</p>}
                  
                  <Button type="submit" className="w-full" disabled={isButtonDisabled}>
                    {loading ? (
                      <div className="flex items-center justify-center w-full">
                        <Spinner size="sm" className="mr-2" />
                        <span>Signing Up...</span>
                      </div>
                    ) : (
                      'Sign Up'
                    )}
                  </Button>
                </div>
                
                <div className="text-center text-sm">
                  Already have an account?{" "}
                  <Link to="/login" className="underline underline-offset-4">
                    Sign In
                  </Link>
                </div>
              </div>
            </form>
          ) : (
            <form onSubmit={handleVerify} noValidate>
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
                
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? (
                    <div className="flex items-center justify-center w-full">
                      <Spinner size="sm" className="mr-2" />
                      <span>Verifying...</span>
                    </div>
                  ) : (
                    'Verify'
                  )}
                </Button>
                
                <div className="text-center text-sm">
                  Already have an account?{" "}
                  <Link to="/login" className="underline underline-offset-4">
                    Sign In
                  </Link>
                </div>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
