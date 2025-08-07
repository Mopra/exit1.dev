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
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '../ui';

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

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-background text-foreground font-sans flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
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
      const error = err as { errors?: Array<{ message: string }> };
      setError(error.errors?.[0]?.message || 'An error occurred during sign up.');
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
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Create an account</CardTitle>
          <CardDescription>
            {phase === 'initial' 
              ? 'Sign up with your Google, GitHub, or Discord account'
              : 'Enter the verification code sent to your email'
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          {phase === 'initial' ? (
            <form onSubmit={handleSignUp}>
              <div className="grid gap-6">
                <div className="flex flex-col gap-4">
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
                      <>
                        <FontAwesomeIcon icon={['fab', 'google']} className="mr-2" />
                        Sign up with Google
                      </>
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
                      <>
                        <FontAwesomeIcon icon={['fab', 'github']} className="mr-2" />
                        Sign up with GitHub
                      </>
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
                      <>
                        <FontAwesomeIcon icon={['fab', 'discord']} className="mr-2" />
                        Sign up with Discord
                      </>
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
                    />
                  </div>
                  <div className="grid gap-3">
                    <Label htmlFor="password">Password</Label>
                    <Input 
                      id="password" 
                      type="password" 
                      placeholder="Create a password"
                      required 
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
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
            <form onSubmit={handleVerify}>
              <div className="grid gap-6">
                <div className="grid gap-3">
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
      
      <div className="text-muted-foreground text-center text-xs text-balance">
        By clicking continue, you agree to our <a href="#" className="underline underline-offset-4">Terms of Service</a>{" "}
        and <a href="#" className="underline underline-offset-4">Privacy Policy</a>.
      </div>
    </div>
  )
}
