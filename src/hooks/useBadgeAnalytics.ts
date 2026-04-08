import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export interface BadgeDailyStats {
  day: string;
  views: number;
  uniqueIps: number;
}

export interface BadgeCheckStats {
  checkId: string;
  userId: string;
  views: number;
  uniqueIps: number;
  checkName?: string;
}

export interface BadgeReferrerStats {
  referrer: string;
  views: number;
}

export interface BadgeTypeStats {
  badgeType: string;
  embed: boolean;
  views: number;
}

export interface BadgeAnalytics {
  totalViews: number;
  days: number;
  daily: BadgeDailyStats[];
  byCheck: BadgeCheckStats[];
  byReferrer: BadgeReferrerStats[];
  byType: BadgeTypeStats[];
}

export const useBadgeAnalytics = (days: number = 30) => {
  const { getToken } = useAuth();
  const [data, setData] = useState<BadgeAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const token = await getToken({ template: 'integration_firebase' });
      if (!token) throw new Error('Authentication required');

      const fn = httpsCallable(functions, 'getBadgeAnalytics');
      const result = await fn({ days });

      const res = result.data as { success: boolean; data: BadgeAnalytics; error?: string };
      if (res.success && res.data) {
        setData(res.data);
      } else {
        throw new Error(res.error || 'Failed to fetch badge analytics');
      }
    } catch (err) {
      console.error('Error fetching badge analytics:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch badge analytics');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [getToken, days]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { data, loading, error, refresh: fetch };
};
