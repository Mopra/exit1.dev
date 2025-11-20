import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  totalChecks: number;
  totalCheckExecutions: number;
  totalWebhooks: number;
  enabledWebhooks: number;
  checksByStatus: {
    online: number;
    offline: number;
    unknown: number;
    disabled: number;
  };
  averageChecksPerUser: number;
  recentActivity: {
    newUsers: number;
    newChecks: number;
    checkExecutions: number;
  };
  badgeUsage: {
    checksWithBadges: number;
    totalBadgeViews: number;
    recentBadgeViews: number;
  };
}

export const useAdminStats = () => {
  const { getToken } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const token = await getToken({ template: 'integration_firebase' });
      if (!token) {
        throw new Error('Authentication required');
      }

      const getAdminStats = httpsCallable(functions, 'getAdminStats');
      const result = await getAdminStats();
      
      if (result.data && typeof result.data === 'object' && 'success' in result.data) {
        const data = result.data as { 
          success: boolean; 
          data: AdminStats; 
          error?: string 
        };
        if (data.success && data.data) {
          setStats(data.data);
        } else {
          throw new Error(data.error || 'Failed to fetch admin stats');
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      console.error('Error fetching admin stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch admin stats');
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    stats,
    loading,
    error,
    refresh: fetchStats,
  };
};

