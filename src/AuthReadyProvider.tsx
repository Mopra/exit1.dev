import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { LoadingScreen } from './components/ui';

const AuthReadyContext = createContext(false);

// Development flag for debug logging
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_DEBUG_AUTH === 'true';

export function useAuthReady() {
  return useContext(AuthReadyContext);
}

export function AuthReadyProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const [authReady, setAuthReady] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const synced = useRef(false);

  const [firebaseUser, setFirebaseUser] = useState<typeof auth.currentUser>(null);
  const [firebaseLoaded, setFirebaseLoaded] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setFirebaseLoaded(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isLoaded || !firebaseLoaded) return;

    if (isSignedIn && !firebaseUser && !synced.current) {
      synced.current = true;
      setShowLoading(true);
      (async () => {
        try {
          const token = await getToken({ template: 'integration_firebase' });
          if (token) {
            if (DEBUG_MODE) {
              console.log('[AuthReadyProvider] Signing in to Firebase with custom token...');
            }
            await signInWithCustomToken(auth, token);
            if (DEBUG_MODE) {
              console.log('[AuthReadyProvider] Firebase signInWithCustomToken completed');
            }
          }
        } catch (error) {
          console.error('[AuthReadyProvider] Error during auth sync:', error);
        } finally {
          setShowLoading(false);
        }
      })();
    } else if (!isSignedIn && firebaseUser) {
      if (DEBUG_MODE) {
        console.log('[AuthReadyProvider] Desync detected: Signing out from Firebase');
      }
      auth.signOut();
    }
  }, [isLoaded, firebaseLoaded, isSignedIn, firebaseUser, getToken]);

  useEffect(() => {
    if (isLoaded && firebaseLoaded) {
      const ready = (isSignedIn && !!firebaseUser) || (!isSignedIn && !firebaseUser);
      if (DEBUG_MODE) {
        console.log('[AuthReadyProvider] Setting authReady to', ready);
      }
      setAuthReady(ready);
    }
  }, [isLoaded, firebaseLoaded, isSignedIn, firebaseUser]);

  if (DEBUG_MODE) {
    console.log('[AuthReadyProvider] Render - showLoading:', showLoading, 'authReady:', authReady, 'isLoaded:', isLoaded, 'firebaseLoaded:', firebaseLoaded);
  }

  if (showLoading) {
    if (DEBUG_MODE) {
      console.log('[AuthReadyProvider] Showing loading screen');
    }
    return <LoadingScreen type="auth" message="Initializing secure session" loadingState="loading" />;
  }

  if (DEBUG_MODE) {
    console.log('[AuthReadyProvider] Rendering children');
  }
  return (
    <AuthReadyContext.Provider value={authReady}>
      {children}
    </AuthReadyContext.Provider>
  );
} 