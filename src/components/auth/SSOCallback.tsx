import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSignIn, useSignUp, useUser } from '@clerk/clerk-react';
import Spinner from '../ui/Spinner';
import { theme, typography } from '../../config/theme';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';

const SSOCallback: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isLoaded: signInLoaded, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, setActive: setSignUpActive } = useSignUp();
  const { user } = useUser();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('Processing Authentication');
  const hasProcessed = useRef(false); // Prevent multiple executions

  const handleDiscordAutoInvite = async () => {
    if (!user) {
      console.warn('[SSOCallback] No user available for Discord auto-invite');
      setMessage('Discord connection completed (manual join required)');
      return;
    }

    try {
      setMessage('Connecting to Discord server...');
      
      // Find Discord account connection
      const discordConnection = user.externalAccounts?.find(
        account => account.verification?.strategy === 'oauth_discord'
      );

      if (!discordConnection) {
        console.warn('[SSOCallback] No Discord connection found in user external accounts');
        setMessage('Discord connection completed (manual join required)');
        return;
      }

              const discordUserId = (discordConnection as any).providerUserId || (discordConnection as any).id;
        const username = (discordConnection as any).username || user.username || 'Unknown';

      console.log('[SSOCallback] Calling Discord auto-invite function...', {
        discordUserId,
        userEmail: user.primaryEmailAddress?.emailAddress,
        username
      });

      const handleDiscordAuth = httpsCallable(functions, 'handleDiscordAuth');
      const result = await handleDiscordAuth({
        discordUserId,
        userEmail: user.primaryEmailAddress?.emailAddress,
        username
      });

      const data = result.data as any;
      console.log('[SSOCallback] Discord auto-invite result:', data);

      if (data.success) {
        if (data.alreadyMember) {
          setMessage('Welcome back! You\'re already a member of our Discord server.');
        } else if (data.inviteUrl) {
          setMessage('Discord invite created! Check your notifications for the invite link.');
          // Note: We don't auto-redirect to Discord here to avoid leaving the app
        } else {
          setMessage('Discord connection completed successfully!');
        }
      } else {
        console.error('[SSOCallback] Discord auto-invite failed:', data.error);
        setMessage(`Discord connection completed (invite failed: ${data.error})`);
      }
    } catch (error) {
      console.error('[SSOCallback] Error in Discord auto-invite:', error);
      setMessage('Discord connection completed (manual join required)');
    }
  };

  useEffect(() => {
    if (!signInLoaded || !signUpLoaded || hasProcessed.current) return;

    const handleSSOCallback = async () => {
      hasProcessed.current = true; // Mark as processed to prevent re-execution
      
      try {
        // Check if this is a sign-in or sign-up flow
        const isSignUp = searchParams.get('__clerk_status') === 'complete' && searchParams.get('__clerk_created_session_id');
        
        // Check if this was a Discord OAuth flow
        const strategy = searchParams.get('__clerk_strategy');
        const isDiscordAuth = strategy === 'oauth_discord';
        
        if (isSignUp) {
          // Handle sign-up flow
          const createdSessionId = searchParams.get('__clerk_created_session_id');
          if (createdSessionId) {
            await setSignUpActive({ session: createdSessionId });
            
            // If this was Discord auth, handle auto-invite after session is set
            if (isDiscordAuth) {
              // Wait a bit for user data to be available
              setTimeout(() => {
                handleDiscordAutoInvite().finally(() => {
                  setTimeout(() => navigate('/checks', { replace: true }), 2000);
                });
              }, 1000);
            } else {
              navigate('/checks', { replace: true });
            }
            return;
          }
        } else {
          // Handle sign-in flow
          const createdSessionId = searchParams.get('__clerk_created_session_id');
          if (createdSessionId) {
            await setSignInActive({ session: createdSessionId });
            
            // If this was Discord auth, handle auto-invite after session is set
            if (isDiscordAuth) {
              // Wait a bit for user data to be available
              setTimeout(() => {
                handleDiscordAutoInvite().finally(() => {
                  setTimeout(() => navigate('/checks', { replace: true }), 2000);
                });
              }, 1000);
            } else {
              navigate('/checks', { replace: true });
            }
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