import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Spinner from '../ui/Spinner';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Divider from '../ui/Divider';
import { colors } from '../../config/theme';
import AuthLayout from './AuthLayout';

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

  // Protected OAuth handlers with rate limiting protection - moved before early return
  const handleOAuthSignIn = useCallback(async (strategy: 'oauth_google' | 'oauth_github' | 'oauth_discord') => {
    // Safety check for signIn availability
    if (!signIn) {
      console.log(`[CustomSignIn] signIn not available yet`);
      return;
    }

    // Prevent multiple concurrent OAuth attempts
    if (oauthLoading || loading) {
      console.log(`[CustomSignIn] OAuth ${strategy} blocked - already in progress`);
      return;
    }

    setOauthLoading(strategy);
    setError(null);

    try {
      const from = location.state?.from?.pathname || '/websites';
      
      await signIn.authenticateWithRedirect({ 
        strategy, 
        redirectUrl: `${window.location.origin}/sso-callback`, 
        redirectUrlComplete: from 
      });
    } catch (err: any) {
      console.error(`[CustomSignIn] ${strategy} error:`, err);
      
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
    setEmailError(validateEmail(email));
  };
  const handlePasswordBlur = () => {
    setPasswordError(validatePassword(password));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Safety check for Clerk availability
    if (!signIn || !setActive) {
      setError('Authentication service is not ready. Please try again.');
      return;
    }

    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    setEmailError(emailErr);
    setPasswordError(passwordErr);
    if (emailErr || passwordErr) return;
    setLoading(true);
    setError(null);

    try {
      const result = await signIn.create({
        identifier: email,
        password,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        // Navigate to the original page they were trying to access, or default to /websites
        const from = location.state?.from?.pathname || '/websites';
        navigate(from, { replace: true });
      } else {
        // If incomplete, might need to handle other factors, but for password it's usually complete
        setError('Sign in incomplete. Please try again.');
      }
    } catch (err: unknown) {
      const error = err as { errors?: Array<{ message: string }> };
      setError(error.errors?.[0]?.message || 'An error occurred during sign in.');
    } finally {
      setLoading(false);
    }
  };

  const isButtonDisabled = loading || !!oauthLoading || !isLoaded;

  return (
    <AuthLayout title="Sign In">
      <Button 
        variant="secondary" 
        className="w-full" 
        onClick={() => handleOAuthSignIn('oauth_google')}
        disabled={isButtonDisabled}
      >
        {oauthLoading === 'oauth_google' ? (
          <Spinner size="sm" className="mr-2" />
        ) : (
          <FontAwesomeIcon icon={['fab', 'google']} className="mr-2" />
        )}
        {oauthLoading === 'oauth_google' ? 'Signing In...' : 'Sign In with Google'}
      </Button>
      
      <Button 
        variant="secondary" 
        className="w-full mt-4" 
        onClick={() => handleOAuthSignIn('oauth_github')}
        disabled={isButtonDisabled}
      >
        {oauthLoading === 'oauth_github' ? (
          <Spinner size="sm" className="mr-2" />
        ) : (
          <FontAwesomeIcon icon={['fab', 'github']} className="mr-2" />
        )}
        {oauthLoading === 'oauth_github' ? 'Signing In...' : 'Sign In with GitHub'}
      </Button>
      
      <Button 
        variant="secondary" 
        className="w-full mt-4" 
        onClick={() => handleOAuthSignIn('oauth_discord')}
        disabled={isButtonDisabled}
      >
        {oauthLoading === 'oauth_discord' ? (
          <Spinner size="sm" className="mr-2" />
        ) : (
          <FontAwesomeIcon icon={['fab', 'discord']} className="mr-2" />
        )}
        {oauthLoading === 'oauth_discord' ? 'Signing In...' : 'Sign In with Discord'}
      </Button>
      <Divider className="my-6">or</Divider>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            onBlur={handleEmailBlur}
            placeholder="Enter your email"
            required
            error={emailError}
            ref={emailRef}
            touched={true}
          />
        </div>
        <div>
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            onBlur={handlePasswordBlur}
            placeholder="Enter your password"
            required
            error={passwordError}
            touched={true}
          />
        </div>
        {!isLoaded && <div className={`${colors.text.secondary} text-sm flex items-center`}>
          <Spinner size="sm" className="mr-2" />
          Initializing authentication service...
        </div>}
        {error && <p className={`${colors.text.error} text-sm`}>{error}</p>}
        <Button type="submit" disabled={isButtonDisabled} className="w-full">
          {loading ? <Spinner size="sm" className="mr-2" /> : null}
          {loading ? 'Signing In...' : 'Sign In'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm">
        Don&apos;t have an account? <Link to="/sign-up" className={`${colors.text.primary} underline`}>Sign Up</Link>
      </p>
      <div className="flex items-center justify-center mt-4 h-1 rounded-full bg-blue-950"></div>
    </AuthLayout>
  );
};

export default CustomSignIn; 