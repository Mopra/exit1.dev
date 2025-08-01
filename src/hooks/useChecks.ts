import { useEffect, useState, useRef, useCallback } from 'react';
import { db } from '../firebase';
import { 
  updateDoc, 
  deleteDoc, 
  doc, 
  writeBatch,
  collection
} from 'firebase/firestore';
import type { Website } from '../types';
import { auth } from '../firebase'; // Added import for auth
import { apiClient } from '../api/client';
import { checksCache, cacheKeys } from '../utils/cache';

// Development flag for debug logging
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_DEBUG_CHECKS === 'true';

export function useChecks(
  userId: string | null, 
  log: (msg: string) => void,
  onStatusChange?: (name: string, previousStatus: string, newStatus: string) => void
) {
  const [checks, setChecks] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const previousStatuses = useRef<Record<string, string>>({});
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const optimisticUpdatesRef = useRef<Set<string>>(new Set()); // Track optimistic updates
  const manualChecksInProgressRef = useRef<Set<string>>(new Set()); // Track manual checks in progress

  // Polling function to get checks
  const pollChecks = useCallback(async () => {
    if (!userId) return;
    
    try {
      // Check cache first
      const cacheKey = cacheKeys.checks(userId);
      const cachedData = checksCache.get(cacheKey);
      
      if (cachedData) {
        // Use cached data
        (cachedData as Website[]).forEach(check => {
          const previousStatus = previousStatuses.current[check.id];
          const currentStatus = check.status || 'unknown';
          
          if (previousStatus && previousStatus !== currentStatus) {
            if (DEBUG_MODE) {
              log(`Status change: ${check.name} went from ${previousStatus} to ${currentStatus}`);
            }
            if (onStatusChange) {
              onStatusChange(check.name, previousStatus, currentStatus);
            }
          }
          
          previousStatuses.current[check.id] = currentStatus;
        });
        
        setChecks(cachedData);
        setLoading(false);
        return;
      }
      
      // Fetch from API if not cached
      const result = await apiClient.getChecks();
      if (result.success && result.data) {
        // Track status changes for notifications
        result.data.forEach(check => {
          const previousStatus = previousStatuses.current[check.id];
          const currentStatus = check.status || 'unknown';
          
          if (previousStatus && previousStatus !== currentStatus) {
            if (DEBUG_MODE) {
              log(`Status change: ${check.name} went from ${previousStatus} to ${currentStatus}`);
            }
            if (onStatusChange) {
              onStatusChange(check.name, previousStatus, currentStatus);
            }
          }
          
          previousStatuses.current[check.id] = currentStatus;
        });
        
        // Update cache
        checksCache.set(cacheKey, result.data);
        
        setChecks(result.data);
      } else {
        log('Failed to fetch checks: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error polling checks:', error);
      log('Error polling checks: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId, log, onStatusChange]);

  useEffect(() => {
    if (!userId) return;
    
    // Only log debug info in development mode
    if (DEBUG_MODE) {
      console.log('[useChecks] User ID:', userId);
      console.log('[useChecks] Firebase auth current user:', auth.currentUser?.uid);
      console.log('[useChecks] Firebase auth state:', auth.currentUser ? 'authenticated' : 'not authenticated');
      
      // Check if Firebase user ID matches Clerk user ID
      if (auth.currentUser && auth.currentUser.uid !== userId) {
        console.warn('[useChecks] User ID mismatch! Clerk:', userId, 'Firebase:', auth.currentUser.uid);
        log('Warning: User ID mismatch detected. This may cause permission issues.');
      }
    }
    
    setLoading(true);
    
    // Initial load
    pollChecks();
    
    // Smart polling: only poll when tab is active and increase interval to reduce reads
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab is hidden, clear interval to save resources
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      } else {
        // Tab is visible, restart polling
        if (!pollingIntervalRef.current) {
          pollChecks(); // Immediate check when tab becomes visible
          pollingIntervalRef.current = setInterval(pollChecks, 60000); // Increased to 60 seconds
        }
      }
    };
    
    // Set up polling interval (every 60 seconds instead of 30)
    pollingIntervalRef.current = setInterval(pollChecks, 60000);
    
    // Listen for tab visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Cleanup function
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [userId, pollChecks, log]);

  // Invalidate cache when checks are modified
  const invalidateCache = useCallback(() => {
    if (userId) {
      checksCache.delete(cacheKeys.checks(userId));
    }
  }, [userId]);



  // Direct Firestore operations with optimistic updates
  const addCheck = useCallback(async (name: string, url: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // BASIC SPAM PROTECTION: Frontend validation
    // Check for reasonable limits (frontend only - backend has stricter limits)
    if (checks.length >= 100) {
      throw new Error("You have reached the maximum limit of 100 checks. Please delete some checks before adding new ones.");
    }
    
    // Enhanced URL validation
    if (!url.trim().match(/^https?:\/\/.+/)) {
      throw new Error("Invalid URL format. Must start with http:// or https://");
    }
    
    // Check URL length
    if (url.length < 10) {
      throw new Error("URL too short (minimum 10 characters)");
    }
    
    if (url.length > 2048) {
      throw new Error("URL too long (maximum 2048 characters)");
    }
    
    // Check for blocked domains
    const blockedDomains = ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'example.com', 'test.com', 'invalid.com'];
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      
      const isBlocked = blockedDomains.some(blocked => 
        hostname === blocked || hostname.endsWith(`.${blocked}`)
      );
      
      if (isBlocked) {
        throw new Error("This domain is not allowed for monitoring");
      }
      
      // Check for local addresses
      if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
        throw new Error("Local addresses are not allowed");
      }
      
    } catch (error) {
      if (error instanceof Error && error.message.includes("domain")) {
        throw error;
      }
      throw new Error("Invalid URL format");
    }
    
    // Check for duplicates - only within the same type (default to 'website' for backward compatibility)
    const existing = checks.find(w => w.url === url && w.type === 'website');
    if (existing) {
      throw new Error("Check URL already exists in your website list");
    }
    
    const now = Date.now();
    
    // Create optimistic check data
    const optimisticCheck: Website = {
      id: `temp_${Date.now()}`, // Temporary ID
      url: url.trim(),
      name: (name || url).trim(),
      userId,
      createdAt: now,
      updatedAt: now,
      status: "unknown" as const,
      downtimeCount: 0,
      lastChecked: 0,
      orderIndex: 0, // Add to top of list
      lastDowntime: null,
      checkFrequency: 5, // Default 5 minutes between checks
      consecutiveFailures: 0,
      userTier: 'free' as const,
      type: 'website' as const,
    };

    // Optimistically add to local state
    setChecks(prevChecks => [optimisticCheck, ...prevChecks]);
    optimisticUpdatesRef.current.add(optimisticCheck.id);

    try {
      // Shift all existing checks' orderIndex up by 1 to make room for new check at top
      const batch = writeBatch(db);
      checks.forEach(check => {
        const docRef = doc(db, 'checks', check.id);
        batch.update(docRef, { orderIndex: (check.orderIndex || 0) + 1 });
      });
      
      // Ensure all required fields are present and match Firestore rules exactly
      const checkData = {
        url: url.trim(),
        name: (name || url).trim(),
        userId,
        createdAt: now,
        updatedAt: now,
        status: "unknown" as const,
        downtimeCount: 0,
        lastChecked: 0,
        orderIndex: 0, // Add to top of list
        lastDowntime: null,
        // Required fields for cost optimization
        checkFrequency: 5, // Default 5 minutes between checks
        consecutiveFailures: 0,
        userTier: 'free' as const, // Default to free tier
        // Default type for backward compatibility
        type: 'website' as const,
      };
      
      // Validate data before sending to Firestore
      if (!checkData.url.match(/^https?:\/\/.+/)) {
        throw new Error("Invalid URL format. Must start with http:// or https://");
      }
      
      if (checkData.name.length < 2 || checkData.name.length > 50) {
        throw new Error("Name must be between 2 and 50 characters");
      }
      
      // Add the new check to the batch
      const newCheckRef = doc(collection(db, 'checks'));
      batch.set(newCheckRef, checkData);
      
      // Commit both the orderIndex updates and the new check creation
      await batch.commit();
      
      // Remove from optimistic updates and invalidate cache
      optimisticUpdatesRef.current.delete(optimisticCheck.id);
      invalidateCache();
      
      // Update the optimistic check with the real ID
      setChecks(prevChecks => 
        prevChecks.map(check => 
          check.id === optimisticCheck.id 
            ? { ...check, id: newCheckRef.id }
            : check
        )
      );
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(prevChecks => prevChecks.filter(check => check.id !== optimisticCheck.id));
      optimisticUpdatesRef.current.delete(optimisticCheck.id);
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot add check. Check user authentication and Firestore rules.');
      } else {
        log('Error adding check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache, log]);

  const updateCheck = useCallback(async (id: string, name: string, url: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    // Check for duplicates (excluding current check) - only within the same type
    const existing = checks.find(w => 
      w.url === url && 
      w.id !== id && 
      w.type === check.type
    );
    if (existing) {
      const typeLabel = check.type === 'rest_endpoint' ? 'API' : 'website';
      throw new Error(`Check URL already exists in your ${typeLabel} list`);
    }
    
    // Validate data before sending to Firestore
    if (!url.trim().match(/^https?:\/\/.+/)) {
      throw new Error("Invalid URL format. Must start with http:// or https://");
    }
    
    const trimmedName = (name || url).trim();
    if (trimmedName.length < 2 || trimmedName.length > 50) {
      throw new Error("Name must be between 2 and 50 characters");
    }
    
    // Store original values for rollback
    const originalCheck = { ...check };
    
    // Optimistically update local state
    setChecks(prevChecks => 
      prevChecks.map(c => 
        c.id === id 
          ? { 
              ...c, 
              name: trimmedName, 
              url: url.trim(), 
              updatedAt: Date.now(),
              lastChecked: 0 // Force re-check on next scheduled run
            }
          : c
      )
    );
    optimisticUpdatesRef.current.add(id);
    
    const updateData = {
      url: url.trim(),
      name: trimmedName,
      updatedAt: Date.now(),
      lastChecked: 0, // Force re-check on next scheduled run
    };
    
    try {
      await updateDoc(doc(db, 'checks', id), updateData);
      
      // Remove from optimistic updates and invalidate cache
      optimisticUpdatesRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(prevChecks => 
        prevChecks.map(c => c.id === id ? originalCheck : c)
      );
      optimisticUpdatesRef.current.delete(id);
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot update check. Check user authentication and Firestore rules.');
      } else {
        log('Error updating check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache, log]);

  const deleteCheck = useCallback(async (id: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    // Store original state for rollback
    const originalChecks = [...checks];
    
    // Optimistically remove from local state
    setChecks(prevChecks => prevChecks.filter(c => c.id !== id));
    optimisticUpdatesRef.current.add(id);
    
    try {
      await deleteDoc(doc(db, 'checks', id));
      
      // Remove from optimistic updates and invalidate cache
      optimisticUpdatesRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(originalChecks);
      optimisticUpdatesRef.current.delete(id);
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot delete check. Check user authentication and Firestore rules.');
      } else {
        log('Error deleting check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache, log]);

  const reorderChecks = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!userId) throw new Error('Authentication required');
    
    if (fromIndex === toIndex) return;
    
    const sortedChecks = [...checks].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
    const movedCheck = sortedChecks[fromIndex];
    
    if (!movedCheck) {
      throw new Error("Check not found at specified index");
    }
    
    // Store original state for rollback
    const originalChecks = [...checks];
    
    // Create new order
    const newOrder = [...sortedChecks];
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, movedCheck);
    
    // Optimistically update local state
    const optimisticallyReordered = newOrder.map((check, index) => ({
      ...check,
      orderIndex: index
    }));
    
    setChecks(optimisticallyReordered);
    optimisticUpdatesRef.current.add(movedCheck.id);
    
    // Update orderIndex for all affected checks
    const batch = writeBatch(db);
    newOrder.forEach((check, index) => {
      const docRef = doc(db, 'checks', check.id);
      batch.update(docRef, { orderIndex: index });
    });
    
    try {
      await batch.commit();
      
      // Remove from optimistic updates and invalidate cache
      optimisticUpdatesRef.current.delete(movedCheck.id);
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(originalChecks);
      optimisticUpdatesRef.current.delete(movedCheck.id);
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot reorder checks. Check user authentication and Firestore rules.');
      } else {
        log('Error reordering checks: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache, log]);

  const toggleCheckStatus = useCallback(async (id: string, disabled: boolean) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    const now = Date.now();
    
    // Store original state for rollback
    const originalCheck = { ...check };
    
    // Optimistically update local state
    setChecks(prevChecks => 
      prevChecks.map(c => 
        c.id === id 
          ? {
              ...c,
              disabled,
              disabledAt: disabled ? now : null,
              disabledReason: disabled ? "Manually disabled by user" : null,
              consecutiveFailures: disabled ? c.consecutiveFailures : 0,
              lastFailureTime: disabled ? c.lastFailureTime : null,
              updatedAt: now
            }
          : c
      )
    );
    optimisticUpdatesRef.current.add(id);
    
    try {
      if (disabled) {
        await updateDoc(doc(db, 'checks', id), {
          disabled,
          disabledAt: now,
          disabledReason: "Manually disabled by user",
          updatedAt: now
        });
      } else {
        await updateDoc(doc(db, 'checks', id), {
          disabled,
          disabledAt: null,
          disabledReason: null,
          consecutiveFailures: 0,
          lastFailureTime: null,
          updatedAt: now
        });
      }
      
      // Remove from optimistic updates and invalidate cache
      optimisticUpdatesRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(prevChecks => 
        prevChecks.map(c => c.id === id ? originalCheck : c)
      );
      optimisticUpdatesRef.current.delete(id);
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot toggle check status. Check user authentication and Firestore rules.');
      } else {
        log('Error toggling check status: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache, log]);

  const bulkDeleteChecks = useCallback(async (ids: string[]) => {
    if (!userId) throw new Error('Authentication required');
    
    // Verify all checks exist and belong to user
    const checksToDelete = checks.filter(w => ids.includes(w.id));
    if (checksToDelete.length !== ids.length) {
      throw new Error("Some checks not found or don't belong to you");
    }
    
    // Store original state for rollback
    const originalChecks = [...checks];
    
    // Optimistically remove from local state
    setChecks(prevChecks => prevChecks.filter(c => !ids.includes(c.id)));
    ids.forEach(id => optimisticUpdatesRef.current.add(id));
    
    const batch = writeBatch(db);
    ids.forEach(id => {
      const docRef = doc(db, 'checks', id);
      batch.delete(docRef);
    });
    
    try {
      await batch.commit();
      
      // Remove from optimistic updates and invalidate cache
      ids.forEach(id => optimisticUpdatesRef.current.delete(id));
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(originalChecks);
      ids.forEach(id => optimisticUpdatesRef.current.delete(id));
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot delete checks. Check user authentication and Firestore rules.');
      } else {
        log('Error deleting checks: ' + error.message);
      }
      throw error;
    }
  }, [userId, checks, log, invalidateCache]);

  const bulkToggleCheckStatus = useCallback(async (ids: string[], disabled: boolean) => {
    if (!userId) throw new Error('Authentication required');
    
    // Verify all checks exist and belong to user
    const checksToUpdate = checks.filter(w => ids.includes(w.id));
    if (checksToUpdate.length !== ids.length) {
      throw new Error("Some checks not found or don't belong to you");
    }
    
    const now = Date.now();
    
    // Store original state for rollback
    const originalChecks = [...checks];
    
    // Optimistically update local state
    setChecks(prevChecks => 
      prevChecks.map(c => 
        ids.includes(c.id)
          ? {
              ...c,
              disabled,
              disabledAt: disabled ? now : null,
              disabledReason: disabled ? "Bulk disabled by user" : null,
              consecutiveFailures: disabled ? c.consecutiveFailures : 0,
              lastFailureTime: disabled ? c.lastFailureTime : null,
              updatedAt: now
            }
          : c
      )
    );
    ids.forEach(id => optimisticUpdatesRef.current.add(id));
    
    const batch = writeBatch(db);
    
    ids.forEach(id => {
      const docRef = doc(db, 'checks', id);
      if (disabled) {
        batch.update(docRef, {
          disabled,
          disabledAt: now,
          disabledReason: "Bulk disabled by user",
          updatedAt: now
        });
      } else {
        batch.update(docRef, {
          disabled,
          disabledAt: null,
          disabledReason: null,
          consecutiveFailures: 0,
          lastFailureTime: null,
          updatedAt: now
        });
      }
    });
    
    try {
      await batch.commit();
      
      // Remove from optimistic updates and invalidate cache
      ids.forEach(id => optimisticUpdatesRef.current.delete(id));
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(originalChecks);
      ids.forEach(id => optimisticUpdatesRef.current.delete(id));
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot update checks. Check user authentication and Firestore rules.');
      } else {
        log('Error updating checks: ' + error.message);
      }
      throw error;
    }
  }, [userId, checks, log, invalidateCache]);

  // Manual check function with optimistic updates
  const manualCheck = useCallback(async (id: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    const now = Date.now();
    
    // Store original state for rollback
    const originalCheck = { ...check };
    
    // Optimistically update local state - show that check is in progress
    setChecks(prevChecks => 
      prevChecks.map(c => 
        c.id === id 
          ? {
              ...c,
              lastChecked: now,
              status: 'unknown' as const, // Reset to unknown while checking
              updatedAt: now
            }
          : c
      )
    );
    optimisticUpdatesRef.current.add(id);
    manualChecksInProgressRef.current.add(id);
    
    try {
      // Call the manual check API
      const result = await apiClient.manualCheck(id);
      
      if (result.success && result.data) {
        // Update with the actual result
        setChecks(prevChecks => 
          prevChecks.map(c => 
            c.id === id 
              ? {
                  ...c,
                  lastChecked: result.data!.lastChecked,
                  status: result.data!.status as Website['status'], // Type assertion for API response
                  updatedAt: now
                }
              : c
          )
        );
      } else {
        // If API call failed, revert to original state
        setChecks(prevChecks => 
          prevChecks.map(c => c.id === id ? originalCheck : c)
        );
        throw new Error(result.error || 'Manual check failed');
      }
      
      // Remove from optimistic updates and invalidate cache
      optimisticUpdatesRef.current.delete(id);
      manualChecksInProgressRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(prevChecks => 
        prevChecks.map(c => c.id === id ? originalCheck : c)
      );
      optimisticUpdatesRef.current.delete(id);
      manualChecksInProgressRef.current.delete(id);
      
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot perform manual check. Check user authentication and Firestore rules.');
      } else {
        log('Error performing manual check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache, log]);

  // Manual refresh function
  const refresh = useCallback(() => {
    invalidateCache();
    pollChecks();
  }, [invalidateCache, pollChecks]);

  return { 
    checks, 
    loading, 
    addCheck, 
    updateCheck, 
    deleteCheck, 
    bulkDeleteChecks,
    reorderChecks,
    toggleCheckStatus,
    bulkToggleCheckStatus,
    manualCheck, // Expose manual check function
    refresh, // Expose refresh function for manual cache invalidation
    optimisticUpdates: Array.from(optimisticUpdatesRef.current), // Expose optimistic updates for UI feedback
    manualChecksInProgress: Array.from(manualChecksInProgressRef.current) // Expose manual checks in progress for UI feedback
  };
} 
