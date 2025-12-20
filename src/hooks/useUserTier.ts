import { useState, useEffect } from 'react';

// NOTE: User tiers are NOT implemented yet. This hook exposes a placeholder
// shape for future use but should NOT be used to gate or enforce behavior.
// Do not rely on tier values for any runtime logic until tiers are implemented.
import { getAuth } from 'firebase/auth';

export type UserTier = 'free' | 'nano';

export interface UserTierInfo {
  tier: UserTier;
  checkFrequency: number; // minutes
  maxWebsites: number;
  features: string[];
}

const TIER_CONFIG: Record<UserTier, UserTierInfo> = {
  free: {
    tier: 'free',
    checkFrequency: 1,
    maxWebsites: 100, // Reasonable limit with spam protection
    features: [
      'Up to 1 minute check interval',
      'Up to 100 websites',
      'Basic monitoring',
      'Webhook support',
      'Spam protection enabled'
    ]
  },
  nano: {
    tier: 'nano',
    checkFrequency: 1,
    maxWebsites: 100, // Reasonable limit with spam protection
    features: [
      'Up to 1 minute check interval',
      'Up to 100 websites',
      'Webhook support',
      'Higher email budgets'
    ]
  }
};

export const useUserTier = () => {
  const [userTier, setUserTier] = useState<UserTier>('free');
  const [loading, setLoading] = useState(true);
  const auth = getAuth();

  useEffect(() => {
    const detectUserTier = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          setUserTier('free');
          setLoading(false);
          return;
        }

        // TODO: Implement actual user tier detection logic
        // This could check a users collection, subscription status, etc.
        // For now, default all users to free tier
        setUserTier('free');
        setLoading(false);
      } catch (error) {
        console.warn('Error detecting user tier, defaulting to free:', error);
        setUserTier('free');
        setLoading(false);
      }
    };

    detectUserTier();
  }, [auth.currentUser]);

  const tierInfo = TIER_CONFIG[userTier];

  return {
    userTier,
    tierInfo,
    loading,
    isNano: userTier === 'nano'
  };
}; 