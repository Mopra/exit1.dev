import { useEffect, useState, useCallback, useRef } from 'react';
import { db, auth } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { apiClient } from '../api/client';
import type { Website, DomainIntelligenceItem, DomainExpiryStatus } from '../types';

export interface UseDomainIntelligenceOptions {
  /** If false, fetches data once instead of subscribing to real-time updates. Default: true */
  realtime?: boolean;
}

export interface DomainStats {
  total: number;
  expiringSoon: number; // <= 30 days
  healthy: number; // > 30 days
  expired: number;
  errors: number;
}

/**
 * Hook for managing Domain Intelligence (domain expiry monitoring)
 * 
 * Uses real-time Firestore subscription on checks collection filtered by
 * domainExpiry.enabled = true, combined with API calls for mutations.
 */
export function useDomainIntelligence(
  userId: string | null,
  options: UseDomainIntelligenceOptions = {}
) {
  const { realtime = true } = options;
  
  const [domains, setDomains] = useState<DomainIntelligenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
  
  // Track optimistic updates
  const optimisticUpdatesRef = useRef<Set<string>>(new Set());
  const refreshInProgressRef = useRef<Set<string>>(new Set());
  
  // Wait for Firebase auth to be ready
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUid(user?.uid || null);
    });
    return () => unsubscribe();
  }, []);
  
  // Transform Website with domainExpiry to DomainIntelligenceItem
  const transformToDomainItem = useCallback((check: Website): DomainIntelligenceItem | null => {
    if (!check.domainExpiry?.enabled) return null;
    
    const de = check.domainExpiry;
    return {
      checkId: check.id,
      checkName: check.name,
      checkUrl: check.url,
      folder: check.folder,
      enabled: de.enabled,
      domain: de.domain,
      registrar: de.registrar,
      registrarUrl: de.registrarUrl,
      createdDate: de.createdDate,
      updatedDate: de.updatedDate,
      expiryDate: de.expiryDate,
      nameservers: de.nameservers,
      registryStatus: de.registryStatus,
      status: de.status,
      daysUntilExpiry: de.daysUntilExpiry,
      lastCheckedAt: de.lastCheckedAt,
      nextCheckAt: de.nextCheckAt,
      lastError: de.lastError,
      consecutiveErrors: de.consecutiveErrors,
      alertThresholds: de.alertThresholds,
      alertsSent: de.alertsSent,
    };
  }, []);
  
  // Real-time subscription to checks with domain expiry enabled
  useEffect(() => {
    if (!userId || !firebaseUid) {
      setDomains([]);
      setLoading(false);
      return;
    }
    
    if (!realtime) {
      // One-time fetch via API
      const fetchDomains = async () => {
        try {
          setLoading(true);
          const result = await apiClient.getDomainIntelligence();
          if (result.success && result.data) {
            setDomains(result.data.domains);
          } else {
            setError(result.error || 'Failed to load domains');
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setLoading(false);
        }
      };
      fetchDomains();
      return;
    }
    
    // Real-time subscription
    try {
      const q = query(
        collection(db, 'checks'),
        where('userId', '==', firebaseUid),
        where('domainExpiry.enabled', '==', true)
      );
      
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const items: DomainIntelligenceItem[] = [];
          snapshot.docs.forEach((doc) => {
            const check = { id: doc.id, ...doc.data() } as Website;
            const item = transformToDomainItem(check);
            if (item) {
              items.push(item);
            }
          });
          
          // Sort by days until expiry (soonest first)
          items.sort((a, b) => {
            const aDays = a.daysUntilExpiry ?? Infinity;
            const bDays = b.daysUntilExpiry ?? Infinity;
            return aDays - bDays;
          });
          
          setDomains(items);
          setLoading(false);
          setError(null);
        },
        (err) => {
          console.error('[useDomainIntelligence] Subscription error:', err);
          setError(err.message);
          setLoading(false);
        }
      );
      
      return () => unsubscribe();
    } catch (err) {
      console.error('[useDomainIntelligence] Failed to subscribe:', err);
      setError((err as Error).message);
      setLoading(false);
    }
  }, [userId, firebaseUid, realtime, transformToDomainItem]);
  
  // Calculate stats
  const stats: DomainStats = {
    total: domains.length,
    expiringSoon: domains.filter(d => 
      d.daysUntilExpiry !== undefined && d.daysUntilExpiry <= 30 && d.daysUntilExpiry > 0
    ).length,
    healthy: domains.filter(d => 
      d.daysUntilExpiry !== undefined && d.daysUntilExpiry > 30
    ).length,
    expired: domains.filter(d => 
      d.daysUntilExpiry !== undefined && d.daysUntilExpiry <= 0
    ).length,
    errors: domains.filter(d => d.status === 'error').length,
  };
  
  // Enable domain expiry for a check
  const enableDomainExpiry = useCallback(async (
    checkId: string, 
    alertThresholds?: number[]
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      optimisticUpdatesRef.current.add(checkId);
      const result = await apiClient.enableDomainExpiry(checkId, alertThresholds);
      optimisticUpdatesRef.current.delete(checkId);
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (err) {
      optimisticUpdatesRef.current.delete(checkId);
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  // Disable domain expiry for a check
  const disableDomainExpiry = useCallback(async (
    checkId: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      optimisticUpdatesRef.current.add(checkId);
      
      // Optimistic update - remove from local state
      setDomains(prev => prev.filter(d => d.checkId !== checkId));
      
      const result = await apiClient.disableDomainExpiry(checkId);
      optimisticUpdatesRef.current.delete(checkId);
      
      if (!result.success) {
        // Rollback will happen via Firestore subscription
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (err) {
      optimisticUpdatesRef.current.delete(checkId);
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  // Update domain expiry settings
  const updateDomainExpiry = useCallback(async (
    checkId: string,
    alertThresholds: number[]
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await apiClient.updateDomainExpiry(checkId, alertThresholds);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  // Refresh domain expiry data
  const refreshDomainExpiry = useCallback(async (
    checkId: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      refreshInProgressRef.current.add(checkId);
      const result = await apiClient.refreshDomainExpiry(checkId);
      refreshInProgressRef.current.delete(checkId);
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (err) {
      refreshInProgressRef.current.delete(checkId);
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  // Bulk enable domain expiry
  const bulkEnableDomainExpiry = useCallback(async (
    checkIds: string[]
  ): Promise<{ 
    success: boolean; 
    error?: string;
    results?: Array<{ checkId: string; success: boolean; error?: string; domain?: string }>;
  }> => {
    try {
      checkIds.forEach(id => optimisticUpdatesRef.current.add(id));
      const result = await apiClient.bulkEnableDomainExpiry(checkIds);
      checkIds.forEach(id => optimisticUpdatesRef.current.delete(id));
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, results: result.data?.results };
    } catch (err) {
      checkIds.forEach(id => optimisticUpdatesRef.current.delete(id));
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  // Bulk disable domain expiry
  const bulkDisableDomainExpiry = useCallback(async (
    checkIds: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      checkIds.forEach(id => optimisticUpdatesRef.current.add(id));
      
      // Optimistic update - remove from local state
      setDomains(prev => prev.filter(d => !checkIds.includes(d.checkId)));
      
      // Disable each one (no bulk API for disable)
      const results = await Promise.all(
        checkIds.map(id => apiClient.disableDomainExpiry(id))
      );
      
      checkIds.forEach(id => optimisticUpdatesRef.current.delete(id));
      
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        return { success: false, error: `Failed to disable ${failed.length} domain(s)` };
      }
      return { success: true };
    } catch (err) {
      checkIds.forEach(id => optimisticUpdatesRef.current.delete(id));
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  // Bulk refresh domain expiry
  const bulkRefreshDomainExpiry = useCallback(async (
    checkIds: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      checkIds.forEach(id => refreshInProgressRef.current.add(id));
      
      const results = await Promise.all(
        checkIds.map(id => apiClient.refreshDomainExpiry(id))
      );
      
      checkIds.forEach(id => refreshInProgressRef.current.delete(id));
      
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        return { success: false, error: `Failed to refresh ${failed.length} domain(s)` };
      }
      return { success: true };
    } catch (err) {
      checkIds.forEach(id => refreshInProgressRef.current.delete(id));
      return { success: false, error: (err as Error).message };
    }
  }, []);
  
  return {
    domains,
    stats,
    loading,
    error,
    
    // Mutations
    enableDomainExpiry,
    disableDomainExpiry,
    updateDomainExpiry,
    refreshDomainExpiry,
    bulkEnableDomainExpiry,
    bulkDisableDomainExpiry,
    bulkRefreshDomainExpiry,
    
    // State tracking
    optimisticUpdates: Array.from(optimisticUpdatesRef.current),
    refreshInProgress: Array.from(refreshInProgressRef.current),
  };
}

/**
 * Get status badge info based on days until expiry
 */
export function getDomainStatusBadge(
  status: DomainExpiryStatus,
  daysUntilExpiry?: number
): { label: string; variant: 'success' | 'info' | 'warning' | 'danger' | 'muted' } {
  if (status === 'error') {
    return { label: 'Error', variant: 'muted' };
  }
  
  if (daysUntilExpiry === undefined) {
    return { label: 'Unknown', variant: 'muted' };
  }
  
  if (daysUntilExpiry <= 0) {
    return { label: 'Expired', variant: 'danger' };
  }
  
  if (daysUntilExpiry <= 7) {
    return { label: `${daysUntilExpiry}d`, variant: 'danger' };
  }
  
  if (daysUntilExpiry <= 30) {
    return { label: `${daysUntilExpiry}d`, variant: 'warning' };
  }
  
  if (daysUntilExpiry <= 90) {
    return { label: `${daysUntilExpiry}d`, variant: 'info' };
  }
  
  return { label: `${daysUntilExpiry}d`, variant: 'success' };
}
