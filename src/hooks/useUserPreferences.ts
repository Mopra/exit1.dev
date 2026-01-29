import { useState, useEffect, useCallback, useRef } from 'react';
import { doc, onSnapshot, setDoc, deleteField } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from '@/firebase';
import type { UserPreferences } from '@/types';

interface UseUserPreferencesResult {
  preferences: UserPreferences | null;
  loading: boolean;
  updateSorting: (page: keyof NonNullable<UserPreferences['sorting']>, sortOption: string) => Promise<void>;
}

/**
 * Hook to manage user preferences stored in Firestore
 * Preferences are synced across devices and sessions
 */
export function useUserPreferences(_userId: string | null | undefined): UseUserPreferencesResult {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  // Use ref to track createdAt without adding to callback dependencies
  const createdAtRef = useRef<number | null>(null);

  // Wait for Firebase auth to be ready - use Firebase UID, not Clerk's userId
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUid(user?.uid || null);
      setAuthChecked(true); // Mark that we've received the auth state
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Don't do anything until Firebase auth has been checked
    if (!authChecked) {
      return;
    }

    if (!firebaseUid) {
      // User is not signed in with Firebase
      setLoading(false);
      setPreferences(null);
      return;
    }

    const prefsRef = doc(db, 'userPreferences', firebaseUid);

    const unsubscribe = onSnapshot(
      prefsRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const rawData = snapshot.data();

          // Handle legacy format where "sorting.checks" was stored as literal field name
          // instead of nested { sorting: { checks: value } }
          const legacyChecksSort = rawData['sorting.checks'] as string | undefined;
          const data: UserPreferences = {
            ...rawData,
            sorting: rawData.sorting ?? (legacyChecksSort ? { checks: legacyChecksSort } : {}),
          } as UserPreferences;

          createdAtRef.current = data.createdAt ?? null;
          setPreferences(data);
        } else {
          // Initialize with default preferences
          const now = Date.now();
          createdAtRef.current = now;
          const defaultPrefs: UserPreferences = {
            userId: firebaseUid,
            sorting: {},
            createdAt: now,
            updatedAt: now,
          };
          setPreferences(defaultPrefs);
        }
        setLoading(false);
      },
      (error) => {
        console.error('Error fetching user preferences:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [firebaseUid, authChecked]);

  const updateSorting = useCallback(
    async (page: keyof NonNullable<UserPreferences['sorting']>, sortOption: string) => {
      if (!firebaseUid) {
        console.warn('Cannot save sort preference: not authenticated');
        throw new Error('Not authenticated');
      }

      const now = Date.now();
      // Use ref value for createdAt to avoid stale closures
      const createdAt = createdAtRef.current ?? now;
      const prefsRef = doc(db, 'userPreferences', firebaseUid);

      // IMPORTANT: Firestore's merge:true replaces nested objects entirely, it doesn't deep merge.
      // We must preserve existing sorting preferences by spreading them into the new object.
      const existingSorting = preferences?.sorting || {};
      const writeData: Record<string, unknown> = {
        userId: firebaseUid,
        sorting: {
          ...existingSorting,
          [page]: sortOption,
        },
        createdAt,
        updatedAt: now,
        // Clean up legacy literal field names (e.g., "sorting.checks" instead of nested sorting.checks)
        // These were created by old code and cause confusion
        [`sorting.${page}`]: deleteField(),
      };
      await setDoc(prefsRef, writeData, { merge: true });
    },
    [firebaseUid, preferences?.sorting]
  );

  return {
    preferences,
    loading,
    updateSorting,
  };
}
