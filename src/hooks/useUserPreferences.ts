import { useState, useEffect, useCallback } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/firebase';
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
export function useUserPreferences(userId: string | null | undefined): UseUserPreferencesResult {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      setPreferences(null);
      return;
    }

    const prefsRef = doc(db, 'userPreferences', userId);

    const unsubscribe = onSnapshot(
      prefsRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setPreferences(snapshot.data() as UserPreferences);
        } else {
          // Initialize with default preferences
          const defaultPrefs: UserPreferences = {
            userId,
            sorting: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
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
  }, [userId]);

  const updateSorting = useCallback(
    async (page: keyof NonNullable<UserPreferences['sorting']>, sortOption: string) => {
      if (!userId) return;

      const prefsRef = doc(db, 'userPreferences', userId);

      try {
        // Use setDoc with merge to handle both create and update cases
        // This avoids the issue where updateDoc fails if document doesn't exist
        await setDoc(
          prefsRef,
          {
            userId,
            [`sorting.${page}`]: sortOption,
            createdAt: preferences?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      } catch (error) {
        console.error('Error updating sorting preference:', error);
        throw error;
      }
    },
    [userId, preferences]
  );

  return {
    preferences,
    loading,
    updateSorting,
  };
}
