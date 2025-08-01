import { useEffect, useState, useRef, useCallback } from 'react';
import { db } from '../firebase';
import { 
  collection, 
  query, 
  where, 
  updateDoc, 
  deleteDoc, 
  doc, 
  writeBatch,
  onSnapshot,
  orderBy
} from 'firebase/firestore';
import type { Website } from '../types';
import { auth } from '../firebase'; // Added import for auth

// Cache for check results to reduce Firestore reads
const checkCache = new Map<string, {
  data: Website[];
  lastUpdated: number;
  expiresAt: number;
}>();

// Cache configuration
const CACHE_DURATION_MS = 30 * 1000; // 30 seconds
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Clean up expired cache entries
const cleanupCache = () => {
  const now = Date.now();
  for (const [key, entry] of checkCache.entries()) {
    if (now > entry.expiresAt) {
      checkCache.delete(key);
    }
  }
};

// Initialize cache cleanup
setInterval(cleanupCache, CACHE_CLEANUP_INTERVAL_MS);

// Development flag for debug logging
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_DEBUG_CHECKS === 'true';

export function useChecks(
  userId: string | null, 
  log: (msg: string) => void,
  onStatusChange?: (name: string, previousStatus: string, newStatus: string) => void
) {
  const [checks, setChecks] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const firstSnapshot = useRef(true);
  const previousStatuses = useRef<Record<string, string>>({});
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Real-time listener setup
  const setupRealtimeListener = useCallback(() => {
    if (!userId) return;
    
    // Clean up existing listener
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    
    try {
      // Create query with ordering
      const q = query(
        collection(db, 'checks'), 
        where('userId', '==', userId),
        orderBy('orderIndex', 'asc')
      );
      
      // Set up real-time listener
      unsubscribeRef.current = onSnapshot(q, (querySnapshot) => {
        const checksData = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...(doc.data() as Omit<Website, 'id'>)
        }));
        
        // Sort checks: those with orderIndex first, then by createdAt
        const sortedChecks = checksData.sort((a, b) => {
          if (a.orderIndex !== undefined && b.orderIndex !== undefined) {
            return a.orderIndex - b.orderIndex;
          }
          if (a.orderIndex !== undefined) return -1;
          if (b.orderIndex !== undefined) return 1;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        
        // Update cache
        const now = Date.now();
        const cacheKey = `checks_${userId}`;
        checkCache.set(cacheKey, {
          data: sortedChecks,
          lastUpdated: now,
          expiresAt: now + CACHE_DURATION_MS
        });
        
        setChecks(sortedChecks);
        
        // Track status changes for notifications
        if (!firstSnapshot.current) {
          sortedChecks.forEach(check => {
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
        }
        
        firstSnapshot.current = false;
        setLoading(false);
      }, (error) => {
        console.error('Error in real-time listener:', error);
        log('Error in real-time listener: ' + error.message);
        setLoading(false);
      });
      
    } catch (error) {
      console.error('Error setting up real-time listener:', error);
      log('Error setting up real-time listener: ' + (error as Error).message);
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
    
    // Set up real-time listener
    setupRealtimeListener();
    
    // Cleanup function
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [userId, setupRealtimeListener, log]);

  // Invalidate cache when checks are modified
  const invalidateCache = useCallback(() => {
    if (userId) {
      const cacheKey = `checks_${userId}`;
      checkCache.delete(cacheKey);
    }
  }, [userId]);

  // Direct Firestore operations
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
    
    try {
      // Add the new check to the batch
      const newCheckRef = doc(collection(db, 'checks'));
      batch.set(newCheckRef, checkData);
      
      // Commit both the orderIndex updates and the new check creation
      await batch.commit();
      
      // Invalidate cache after successful operation
      invalidateCache();
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot add check. Check user authentication and Firestore rules.');
      } else {
        log('Error adding check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache]);

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
    
    const updateData = {
      url: url.trim(),
      name: trimmedName,
      updatedAt: Date.now(),
      lastChecked: 0, // Force re-check on next scheduled run
    };
    
    try {
      await updateDoc(doc(db, 'checks', id), updateData);
      
      // Invalidate cache after successful operation
      invalidateCache();
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot update check. Check user authentication and Firestore rules.');
      } else {
        log('Error updating check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache]);

  const deleteCheck = useCallback(async (id: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    try {
      await deleteDoc(doc(db, 'checks', id));
      
      // Invalidate cache after successful operation
      invalidateCache();
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot delete check. Check user authentication and Firestore rules.');
      } else {
        log('Error deleting check: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache]);

  const reorderChecks = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!userId) throw new Error('Authentication required');
    
    if (fromIndex === toIndex) return;
    
    const sortedChecks = [...checks].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
    const movedCheck = sortedChecks[fromIndex];
    
    if (!movedCheck) {
      throw new Error("Check not found at specified index");
    }
    
    // Create new order
    const newOrder = [...sortedChecks];
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, movedCheck);
    
    // Update orderIndex for all affected checks
    const batch = writeBatch(db);
    newOrder.forEach((check, index) => {
      const docRef = doc(db, 'checks', check.id);
      batch.update(docRef, { orderIndex: index });
    });
    
    try {
      await batch.commit();
      
      // Invalidate cache after successful operation
      invalidateCache();
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot reorder checks. Check user authentication and Firestore rules.');
      } else {
        log('Error reordering checks: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, checks, invalidateCache]);

  const toggleCheckStatus = useCallback(async (id: string, disabled: boolean) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    const now = Date.now();
    
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
    
    // Invalidate cache after successful operation
    invalidateCache();
  }, [userId, checks, invalidateCache]);

  const bulkDeleteChecks = useCallback(async (ids: string[]) => {
    if (!userId) throw new Error('Authentication required');
    
    // Verify all checks exist and belong to user
    const checksToDelete = checks.filter(w => ids.includes(w.id));
    if (checksToDelete.length !== ids.length) {
      throw new Error("Some checks not found or don't belong to you");
    }
    
    const batch = writeBatch(db);
    ids.forEach(id => {
      const docRef = doc(db, 'checks', id);
      batch.delete(docRef);
    });
    
    try {
      await batch.commit();
      
      // Invalidate cache after successful operation
      invalidateCache();
    } catch (error: any) {
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
      
      // Invalidate cache after successful operation
      invalidateCache();
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot update checks. Check user authentication and Firestore rules.');
      } else {
        log('Error updating checks: ' + error.message);
      }
      throw error;
    }
  }, [userId, checks, log, invalidateCache]);

  // Manual refresh function
  const refresh = useCallback(() => {
    invalidateCache();
    setupRealtimeListener();
  }, [invalidateCache, setupRealtimeListener]);

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
    refresh // Expose refresh function for manual cache invalidation
  };
} 
