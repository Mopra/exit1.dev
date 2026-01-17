import { useEffect, useState, useRef, useCallback } from 'react';
import { db } from '../firebase';
import {
  updateDoc,
  deleteDoc,
  doc,
  writeBatch,
  collection,
  onSnapshot,
  query,
  where,
  orderBy
} from 'firebase/firestore';
import type { Website } from '../types';
import { auth } from '../firebase'; // Added import for auth
import { onAuthStateChanged } from 'firebase/auth';
import { apiClient } from '../api/client';
import { checksCache, cacheKeys } from '../utils/cache';
import type { UpdateWebsiteRequest } from '../api/types';

// Development flag for debug logging
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_DEBUG_CHECKS === 'true';

function normalizeFolder(folder?: string | null): string | null {
  const raw = (folder ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\s+/g, ' ').trim();
  const trimmedSlashes = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmedSlashes || null;
}

function folderHasPrefix(folder: string | null | undefined, prefix: string): boolean {
  const f = normalizeFolder(folder);
  if (!f) return false;
  return f === prefix || f.startsWith(prefix + '/');
}

function replaceFolderPrefix(folder: string, fromPrefix: string, toPrefix: string): string {
  if (folder === fromPrefix) return toPrefix;
  if (folder.startsWith(fromPrefix + '/')) return toPrefix + folder.slice(fromPrefix.length);
  return folder;
}

export function useChecks(
  userId: string | null, 
  log: (msg: string) => void,
  onStatusChange?: (name: string, previousStatus: string, newStatus: string) => void
) {
  const [checks, setChecks] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });
  const previousStatuses = useRef<Record<string, string>>({});
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const optimisticUpdatesRef = useRef<Set<string>>(new Set()); // Track optimistic updates
  const manualChecksInProgressRef = useRef<Set<string>>(new Set()); // Track manual checks in progress
  const folderUpdatesRef = useRef<Set<string>>(new Set()); // Track folder-only updates (don't pulse rows)

  // Wait for Firebase auth to be ready (similar to useUserNotifications pattern)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUid(user?.uid || null);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setIsVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Real-time subscription to checks using Firestore onSnapshot
  const subscribeToChecks = useCallback(() => {
    // Use Firebase auth UID instead of Clerk userId for Firestore queries
    // This ensures Firebase auth is ready before subscribing
    const uid = firebaseUid;
    if (!uid) {
      setChecks([]);
      setLoading(false);
      return;
    }

    try {
      const q = query(
        collection(db, 'checks'),
        where('userId', '==', uid),
        orderBy('orderIndex', 'asc')
      );

      unsubscribeRef.current = onSnapshot(
        q,
        (snapshot) => {
          const docs = snapshot.docs.map((d) => {
            const data = d.data() as Website;
            return { ...data, id: d.id };
          });

          // Track status changes for notifications
          docs.forEach((check) => {
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

          setChecks(docs);
          setLoading(false);
        },
        (error) => {
          console.error('[useChecks] onSnapshot error:', error);
          log('Realtime subscription error: ' + (error as Error).message);
          setLoading(false);
        }
      );
    } catch (error) {
      console.error('[useChecks] Failed to subscribe to checks:', error);
      log('Failed to subscribe to checks: ' + (error as Error).message);
      setLoading(false);
    }
  }, [firebaseUid, log, onStatusChange]);

  useEffect(() => {
    if (!userId) {
      // If no Clerk userId, clear checks and stop loading
      setChecks([]);
      setLoading(false);
      return;
    }

    // Only log debug info in development mode
    if (DEBUG_MODE) {
      console.log('[useChecks] User ID:', userId);
      console.log('[useChecks] Firebase auth current user:', auth.currentUser?.uid);
      console.log('[useChecks] Firebase auth state:', auth.currentUser ? 'authenticated' : 'not authenticated');

      if (auth.currentUser && auth.currentUser.uid !== userId) {
        console.warn('[useChecks] User ID mismatch! Clerk:', userId, 'Firebase:', auth.currentUser.uid);
        log('Warning: User ID mismatch detected. This may cause permission issues.');
      }
    }

    // Only subscribe when Firebase auth is ready
    if (!firebaseUid) {
      setLoading(true);
      return;
    }

    if (!isVisible) {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    subscribeToChecks();

    // Cleanup subscription
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [userId, firebaseUid, isVisible, subscribeToChecks, log]);

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
    
    // Allow duplicate URLs so users can monitor variants (http/https, www, paths, subdomains).
    
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
      checkFrequency: 60, // Default 60 minutes (1 hour) between checks
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
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
        nextCheckAt: now, // Check immediately on next scheduler run
        orderIndex: 0, // Add to top of list
        lastDowntime: null,
        // Required fields for cost optimization
        checkFrequency: 60, // Default 60 minutes (1 hour) between checks
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

  const updateCheck = useCallback(async (request: UpdateWebsiteRequest) => {
    if (!userId) throw new Error('Authentication required');

    const {
      id,
      name,
      url,
      checkFrequency,
      responseTimeLimit,
      immediateRecheckEnabled,
      type,
      httpMethod,
      expectedStatusCodes,
      requestHeaders,
      requestBody,
      responseValidation,
      cacheControlNoCache
    } = request;
    
    // Check if check exists and belongs to user
    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }
    
    const targetType = type ?? (check.type === 'rest_endpoint' ? 'rest_endpoint' : check.type === 'tcp' ? 'tcp' : check.type === 'udp' ? 'udp' : 'website');

    // Allow duplicate URLs so users can monitor variants (http/https, www, paths, subdomains).
    
    // Validate data before sending to Firestore
    const isSocketType = targetType === 'tcp' || targetType === 'udp';
    const urlPattern = isSocketType ? /^(tcp|udp):\/\/.+:\d+/ : /^https?:\/\/.+/;
    if (!url.trim().match(urlPattern)) {
      throw new Error(isSocketType ? "Invalid target format. Must be tcp://host:port or udp://host:port" : "Invalid URL format. Must start with http:// or https://");
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
              checkFrequency: checkFrequency ?? c.checkFrequency ?? 60,
              responseTimeLimit: responseTimeLimit === null ? undefined : (responseTimeLimit !== undefined ? responseTimeLimit : c.responseTimeLimit),
              immediateRecheckEnabled: immediateRecheckEnabled !== undefined ? immediateRecheckEnabled : c.immediateRecheckEnabled,
              type: targetType,
              httpMethod: httpMethod !== undefined ? httpMethod : c.httpMethod,
              expectedStatusCodes: expectedStatusCodes !== undefined ? expectedStatusCodes : c.expectedStatusCodes,
              requestHeaders: requestHeaders !== undefined ? requestHeaders : c.requestHeaders,
              requestBody: requestBody !== undefined ? requestBody : c.requestBody,
              responseValidation: responseValidation !== undefined ? responseValidation : c.responseValidation,
              cacheControlNoCache: cacheControlNoCache !== undefined ? cacheControlNoCache : c.cacheControlNoCache,
              updatedAt: Date.now(),
              lastChecked: 0 // Force re-check on next scheduled run
            }
          : c
      )
    );
    optimisticUpdatesRef.current.add(id);
    
    try {
      await apiClient.updateWebsite({
        id,
        url: url.trim(),
        name: trimmedName,
        checkFrequency: checkFrequency ?? check.checkFrequency ?? 60,
        responseTimeLimit,
        immediateRecheckEnabled: immediateRecheckEnabled !== undefined ? immediateRecheckEnabled : check.immediateRecheckEnabled,
        type: targetType,
        httpMethod,
        expectedStatusCodes,
        requestHeaders,
        requestBody,
        responseValidation,
        cacheControlNoCache,
      });
      
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

  // Nano feature: set / clear folder (group) for a check
  const setCheckFolder = useCallback(async (id: string, folder: string | null) => {
    if (!userId) throw new Error('Authentication required');

    const check = checks.find(w => w.id === id);
    if (!check) {
      throw new Error("Check not found");
    }

    const normalizedFolder = (() => {
      const v = (folder ?? '').trim();
      if (!v) return null;
      // keep it compact; UI uses this as a label
      return v.slice(0, 48);
    })();

    const originalCheck = { ...check };
    const now = Date.now();

    // Optimistic local update
    setChecks(prevChecks =>
      prevChecks.map(c =>
        c.id === id
          ? {
              ...c,
              folder: normalizedFolder,
              updatedAt: now,
            }
          : c
      )
    );
    folderUpdatesRef.current.add(id);

    try {
      const checkRef = doc(db, 'checks', id);
      await updateDoc(checkRef, {
        folder: normalizedFolder,
        updatedAt: now,
      });

      folderUpdatesRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      // Revert optimistic update on failure
      setChecks(prevChecks => prevChecks.map(c => (c.id === id ? originalCheck : c)));
      folderUpdatesRef.current.delete(id);

      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot update check folder. Check user authentication and Firestore rules.');
      } else {
        log('Error updating check folder: ' + error.message);
      }
      throw error;
    }
  }, [userId, checks, invalidateCache, log]);

  // Nano feature: rename a folder (updates all checks whose folder is the folder or any descendant)
  const renameFolder = useCallback(async (fromFolder: string, toFolder: string) => {
    if (!userId) throw new Error('Authentication required');

    const from = normalizeFolder(fromFolder);
    const to = normalizeFolder(toFolder);
    if (!from) throw new Error('Source folder required');
    if (!to) throw new Error('Destination folder required');
    if (from === to) return;
    if (to.startsWith(from + '/')) {
      throw new Error('Destination folder cannot be inside the folder being renamed.');
    }
    if (to.length > 48) throw new Error('Folder name is too long (max 48 characters).');

    const affected = checks.filter((c) => folderHasPrefix(c.folder, from));
    if (affected.length === 0) return;

    const now = Date.now();

    // Pre-validate: ensure replacements fit the 48 char limit
    const nextFolderById = new Map<string, string | null>();
    for (const c of affected) {
      const current = normalizeFolder(c.folder);
      if (!current) continue;
      const next = replaceFolderPrefix(current, from, to);
      if (next.length > 48) {
        throw new Error('Renaming would make some folder paths too long (max 48). Choose a shorter name.');
      }
      nextFolderById.set(c.id, next);
    }

    const originalChecks = [...checks];

    // Optimistic update
    setChecks((prev) =>
      prev.map((c) => {
        const nextFolder = nextFolderById.get(c.id);
        if (nextFolder === undefined) return c;
        folderUpdatesRef.current.add(c.id);
        return { ...c, folder: nextFolder, updatedAt: now };
      })
    );

    try {
      // Firestore batches max 500 ops; chunk to stay safe
      const ids = [...nextFolderById.keys()];
      const chunkSize = 450;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const slice = ids.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        for (const id of slice) {
          const folder = nextFolderById.get(id) ?? null;
          batch.update(doc(db, 'checks', id), { folder, updatedAt: now });
        }
        await batch.commit();
      }

      for (const id of nextFolderById.keys()) folderUpdatesRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      setChecks(originalChecks);
      for (const id of nextFolderById.keys()) folderUpdatesRef.current.delete(id);
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot rename folder. Check user authentication and Firestore rules.');
      } else {
        log('Error renaming folder: ' + error.message);
      }
      throw error;
    }
  }, [userId, checks, invalidateCache, log]);

  // Nano feature: delete a folder (removes the segment and reparents descendants to the parent)
  const deleteFolder = useCallback(async (folderPath: string) => {
    if (!userId) throw new Error('Authentication required');

    const target = normalizeFolder(folderPath);
    if (!target) throw new Error('Folder required');

    const parent = (() => {
      const parts = target.split('/').filter(Boolean);
      if (parts.length <= 1) return null;
      return parts.slice(0, -1).join('/');
    })();

    const affected = checks.filter((c) => folderHasPrefix(c.folder, target));
    if (affected.length === 0) return;

    const now = Date.now();
    const nextFolderById = new Map<string, string | null>();

    for (const c of affected) {
      const current = normalizeFolder(c.folder);
      if (!current) continue;

      if (current === target) {
        nextFolderById.set(c.id, parent);
        continue;
      }

      // current starts with target + '/'
      const remainder = current.slice(target.length + 1);
      const next = parent ? `${parent}/${remainder}` : remainder;
      nextFolderById.set(c.id, next || null);
    }

    const originalChecks = [...checks];

    // Optimistic update
    setChecks((prev) =>
      prev.map((c) => {
        const nextFolder = nextFolderById.get(c.id);
        if (nextFolder === undefined) return c;
        folderUpdatesRef.current.add(c.id);
        return { ...c, folder: nextFolder, updatedAt: now };
      })
    );

    try {
      const ids = [...nextFolderById.keys()];
      const chunkSize = 450;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const slice = ids.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        for (const id of slice) {
          const folder = nextFolderById.get(id) ?? null;
          batch.update(doc(db, 'checks', id), { folder, updatedAt: now });
        }
        await batch.commit();
      }

      for (const id of nextFolderById.keys()) folderUpdatesRef.current.delete(id);
      invalidateCache();
    } catch (error: any) {
      setChecks(originalChecks);
      for (const id of nextFolderById.keys()) folderUpdatesRef.current.delete(id);
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot delete folder. Check user authentication and Firestore rules.');
      } else {
        log('Error deleting folder: ' + error.message);
      }
      throw error;
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

  // Manual refresh function - call this after adding/updating checks to update the UI immediately
  const refresh = useCallback(() => {
    // No-op with realtime subscription, kept for API compatibility
    invalidateCache();
  }, [invalidateCache]);

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
    setCheckFolder, // Expose folder mutation (Nano feature)
    renameFolder, // Expose folder rename (Nano feature)
    deleteFolder, // Expose folder delete (Nano feature)
    refresh, // Expose refresh function for manual cache invalidation
    optimisticUpdates: Array.from(optimisticUpdatesRef.current), // Expose optimistic updates for UI feedback
    folderUpdates: Array.from(folderUpdatesRef.current), // Expose folder-only updates for UI control
    manualChecksInProgress: Array.from(manualChecksInProgressRef.current) // Expose manual checks in progress for UI feedback
  };
} 
