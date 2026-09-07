import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { LoadingScreen } from './components/ui';

const AuthReadyContext = createContext(false);

// Debug logging setup - only log important state changes
const DEBUG_MODE = import.meta.env.DEV || import.meta.env.VITE_DEBUG_AUTH === 'true';
const log = (message: string, data?: any) => {
  if (DEBUG_MODE) {
    console.log(`[AuthReadyProvider] ${message}`, data || '');
  }
};

export function useAuthReady() {
  return useContext(AuthReadyContext);
}

export function AuthReadyProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded, userId } = useAuth();
  const [authReady, setAuthReady] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const synced = useRef(false);

  const [firebaseUser, setFirebaseUser] = useState<typeof auth.currentUser>(null);
  const [firebaseLoaded, setFirebaseLoaded] = useState(false);

  // Only log important state changes, not every render
  if (isLoaded && firebaseLoaded && authReady) {
    log('Auth ready', { isSignedIn, firebaseUser: !!firebaseUser });
  }

  useEffect(() => {
    log('Setting up Firebase auth state listener');
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      log('Firebase auth state changed', { user: !!user, uid: user?.uid });
      setFirebaseUser(user);
      setFirebaseLoaded(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isLoaded || !firebaseLoaded) {
      return;
    }

    // The Firebase custom token carries the Clerk user id as its uid, so the two
    // sessions must name the same person. They drift apart when Clerk swaps the
    // signed-in user in place without passing through a signed-out state, which
    // is what dashboard impersonation and multi-session account switching do.
    // Left alone, the UI reads Clerk's user while every Firestore query and
    // callable runs as the previous one. Drop the stale Firebase session and
    // let the sync below mint a token for the current Clerk user.
    if (isSignedIn && firebaseUser && userId && firebaseUser.uid !== userId) {
      log('Desync detected: Firebase uid does not match Clerk user, re-syncing', {
        firebaseUid: firebaseUser.uid,
        clerkUserId: userId,
      });
      synced.current = false;
      auth.signOut();
      return;
    }

    if (isSignedIn && !firebaseUser && !synced.current) {
      synced.current = true;
      setShowLoading(true);
      log('Starting Clerk to Firebase sync');
      (async () => {
        try {
          const token = await getToken({ template: 'integration_firebase' });
          if (token) {
            log('Got Firebase custom token, signing in');
            await signInWithCustomToken(auth, token);
            log('Firebase signInWithCustomToken completed successfully');
          } else {
            log('No Firebase custom token received');
          }
        } catch (error) {
          console.error('[AuthReadyProvider] Error during auth sync:', error);
        } finally {
          setShowLoading(false);
          log('Auth sync completed, hiding loading screen');
        }
      })();
    } else if (!isSignedIn && firebaseUser) {
      log('Desync detected: Signing out from Firebase');
      auth.signOut();
    }
  }, [isLoaded, firebaseLoaded, isSignedIn, firebaseUser, userId, getToken]);

  useEffect(() => {
    if (isLoaded && firebaseLoaded) {
      const ready = (isSignedIn && !!firebaseUser) || (!isSignedIn && !firebaseUser);
      setAuthReady(ready);
    }
  }, [isLoaded, firebaseLoaded, isSignedIn, firebaseUser]);

  if (showLoading) {
    return <LoadingScreen type="auth" message="Initializing secure session" loadingState="loading" />;
  }
  return (
    <AuthReadyContext.Provider value={authReady}>
      {children}
    </AuthReadyContext.Provider>
  );
} 