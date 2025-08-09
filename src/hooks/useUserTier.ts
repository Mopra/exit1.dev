import { useState, useEffect } from 'react';

// NOTE: User tiers are NOT implemented yet. This hook exposes a placeholder
// shape for future use but should NOT be used to gate or enforce behavior.
// Do not rely on tier values for any runtime logic until tiers are implemented.
import { getAuth } from 'firebase/auth';

export type UserTier = 'free' | 'premium';

export interface UserTierInfo {
  tier: UserTier;
  checkFrequency: number; // minutes
  maxWebsites: number;
  features: string[];
}

const TIER_CONFIG: Record<UserTier, UserTierInfo> = {
  free: {
    tier: 'free',
    checkFrequency: 3,
    maxWebsites: 100, // Reasonable limit with spam protection
    features: [
      'Every 3 minutes check interval',
      'Up to 100 websites',
      'Basic monitoring',
      'Webhook support',
      'Spam protection enabled'
    ]
  },
  premium: {
    tier: 'premium',
    checkFrequency: 2,
    maxWebsites: 100, // Reasonable limit with spam protection
    features: [
      'Every 2 minutes check interval',
      'Up to 100 websites',
      'Advanced analytics',
      'Webhook support',
      'Integrations',
      'Priority support'
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
    isPremium: userTier === 'premium'
  };
}; 