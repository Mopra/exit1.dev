import React, { useState, useCallback } from 'react';
import { useSignUp } from '@clerk/clerk-react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Spinner from '../ui/Spinner';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Divider from '../ui/Divider';
import { colors, theme, typography } from '../../config/theme';
import AuthLayout from './AuthLayout';

type Phase = 'initial' | 'verifying';

const CustomSignUp: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isLoaded, signUp, setActive } = useSignUp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('initial');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null); // Track which OAuth is loading

  if (!isLoaded) {
    return (
      <div className={`min-h-screen ${theme.colors.background.primary} ${theme.colors.text.primary} ${theme.typography.fontFamily.body} flex items-center justify-center`}>
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
        // Navigate to the original page they were trying to access, or default to /websites
        const from = location.state?.from?.pathname || '/websites';
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
        // Navigate to the original page they were trying to access, or default to /checks
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
    // Prevent multiple concurrent OAuth attempts
    if (oauthLoading || loading) {
      console.log(`[CustomSignUp] OAuth ${strategy} blocked - already in progress`);
      return;
    }

    setOauthLoading(strategy);
    setError(null);

    try {
      const from = location.state?.from?.pathname || '/checks';
      
      await signUp.authenticateWithRedirect({ 
        strategy, 
        redirectUrl: `${window.location.origin}/sso-callback`, 
        redirectUrlComplete: from 
      });
    } catch (err: any) {
      console.error(`[CustomSignUp] ${strategy} error:`, err);
      
      // Handle rate limiting specifically
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
    <AuthLayout title="Sign Up" variant="signup" outerClassName="p-4">
      {phase === 'initial' ? (
        <>
          <Button 
            variant="primary" 
            className="w-full" 
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
                <span>Sign Up with Google</span>
              </>
            )}
          </Button>
          
          <Button 
            variant="primary" 
            className="w-full mt-4" 
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
                <span>Sign Up with GitHub</span>
              </>
            )}
          </Button>
          
          <Button 
            variant="primary" 
            className="w-full mt-4" 
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
                <span>Sign Up with Discord</span>
              </>
            )}
          </Button>

          <Divider className="my-6">or</Divider>
          
          <form onSubmit={handleSignUp} className="space-y-6">
            <div>
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
              />
            </div>
            <div>
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                placeholder="Create a password"
                required
              />
            </div>
            {error && <p className={`${theme.colors.text.error} text-sm`}>{error}</p>}
            <Button type="submit" variant="primary" disabled={isButtonDisabled} className="w-full">
              {loading ? (
                <div className="flex items-center justify-center w-full">
                  <Spinner size="sm" className="mr-2" />
                  <span>Signing Up...</span>
                </div>
              ) : (
                <span>Sign Up</span>
              )}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm">
            Already have an account? <Link to="/login" className="text-green-400 hover:text-green-300 underline transition-colors">Sign In</Link>
          </p>
        </>
      ) : (
        <>
          <form onSubmit={handleVerify} className="space-y-6">
            <div>
              <Input
                label="Verification Code"
                type="text"
                value={code}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
                placeholder="Enter the code sent to your email"
                required
              />
            </div>
            {error && <p className={`${theme.colors.text.error} text-sm`}>{error}</p>}
            <Button type="submit" variant="primary" disabled={loading} className="w-full">
              {loading ? (
                <div className="flex items-center justify-center w-full">
                  <Spinner size="sm" className="mr-2" />
                  <span>Verifying...</span>
                </div>
              ) : (
                <span>Verify</span>
              )}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm">
            Already have an account? <Link to="/login" className="text-green-400 hover:text-green-300 underline transition-colors">Sign In</Link>
          </p>
        </>
      )}
      <div className="flex items-center justify-center mt-4 h-1 rounded-full bg-green-600/50"></div>
    </AuthLayout>
  );
};

export default CustomSignUp; 