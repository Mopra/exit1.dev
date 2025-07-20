import { useEffect, useState, useRef, useCallback } from 'react';
import { db } from '../firebase';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  writeBatch
} from 'firebase/firestore';
import type { Website } from '../types';
import { auth } from '../firebase'; // Added import for auth


export function useWebsites(
  userId: string | null, 
  log: (msg: string) => void,
  onStatusChange?: (name: string, previousStatus: string, newStatus: string) => void
) {
  const [websites, setWebsites] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const firstSnapshot = useRef(true);
  const previousStatuses = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!userId) return;
    
    // Debug: Check Firebase authentication status
    console.log('[useWebsites] User ID:', userId);
    console.log('[useWebsites] Firebase auth current user:', auth.currentUser?.uid);
    console.log('[useWebsites] Firebase auth state:', auth.currentUser ? 'authenticated' : 'not authenticated');
    
    // Check if Firebase user ID matches Clerk user ID
    if (auth.currentUser && auth.currentUser.uid !== userId) {
      console.warn('[useWebsites] User ID mismatch! Clerk:', userId, 'Firebase:', auth.currentUser.uid);
      log('Warning: User ID mismatch detected. This may cause permission issues.');
    }
    
    setLoading(true);
    // Query without orderBy first to get all websites, then sort in memory
    const q = query(
      collection(db, 'websites'), 
      where('userId', '==', userId)
    );
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const websitesData = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...(doc.data() as Omit<Website, 'id'>)
      }));
      
      // Sort websites: those with orderIndex first, then by createdAt
      const sortedWebsites = websitesData.sort((a, b) => {
        // If both have orderIndex, sort by it
        if (a.orderIndex !== undefined && b.orderIndex !== undefined) {
          return a.orderIndex - b.orderIndex;
        }
        // If only one has orderIndex, prioritize it
        if (a.orderIndex !== undefined) return -1;
        if (b.orderIndex !== undefined) return 1;
        // If neither has orderIndex, sort by createdAt
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      
      setWebsites(sortedWebsites);
      
      // Migrate existing websites to have orderIndex if they don't have it
      const websitesNeedingMigration = websitesData.filter(w => w.orderIndex === undefined);
      if (websitesNeedingMigration.length > 0) {
        const batch = writeBatch(db);
        websitesNeedingMigration.forEach((website, index) => {
          const docRef = doc(db, 'websites', website.id);
          batch.update(docRef, { 
            orderIndex: sortedWebsites.length + index 
          });
        });
        batch.commit().catch(err => {
          console.error('Migration error:', err);
          log('Migration error: ' + err.message);
        });
      }
      
      querySnapshot.docChanges().forEach(change => {
        const data = change.doc.data();
        const name = data.name || change.doc.id;
        const websiteId = change.doc.id;
        
        if (change.type === "added" && !firstSnapshot.current) {
          log(`Website added: ${name}`);
        }
        if (change.type === "modified") {
          const newStatus = data.status;
          const previousStatus = previousStatuses.current[websiteId];
          
          log(`Website updated: ${name} (status: ${newStatus})`);
          
          // Log status changes (no notifications)
          if (previousStatus && newStatus && previousStatus !== newStatus) {
            log(`Website status changed: ${name} (${previousStatus} → ${newStatus})`);
            if (onStatusChange) {
              onStatusChange(name, previousStatus, newStatus);
            }
          }
          
          // Update previous status
          previousStatuses.current[websiteId] = newStatus;
        }
        if (change.type === "removed" && !firstSnapshot.current) {
          log(`Website removed: ${name}`);
          delete previousStatuses.current[websiteId];
        }
      });
      firstSnapshot.current = false;
      setLoading(false);
    }, (err) => {
      console.error('Firestore query error:', err);
      // Log specific error details for debugging
      if (err.code === 'permission-denied') {
        log('Permission denied: Check if user is properly authenticated with Firebase');
      } else if (err.code === 'unauthenticated') {
        log('User not authenticated: Please sign in again');
      } else {
        log('Error with real-time updates: ' + err.message);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [userId, log, onStatusChange]);

  // Direct Firestore operations
  const addWebsite = useCallback(async (name: string, url: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check user's current active website count (excluding disabled sites)
    const activeWebsites = websites.filter(w => !w.disabled);
    if (activeWebsites.length >= 10) {
      throw new Error("You have reached the maximum limit of 10 active websites. Please delete or disable some websites before adding new ones.");
    }
    
    // Check for duplicates
    const existing = websites.find(w => w.url === url);
    if (existing) {
      throw new Error("Website already exists in your list");
    }
    
    const now = Date.now();
    // Ensure all required fields are present and match Firestore rules exactly
    const websiteData = {
      url: url.trim(),
      name: (name || url).trim(),
      userId,
      createdAt: now,
      updatedAt: now,
      status: "unknown" as const,
      downtimeCount: 0,
      lastChecked: 0,
      orderIndex: websites.length, // Add to end of list
      lastDowntime: null,
    };
    
    // Validate data before sending to Firestore
    if (!websiteData.url.match(/^https?:\/\/.+/)) {
      throw new Error("Invalid URL format. Must start with http:// or https://");
    }
    
    if (websiteData.name.length < 2 || websiteData.name.length > 50) {
      throw new Error("Name must be between 2 and 50 characters");
    }
    
    try {
      await addDoc(collection(db, 'websites'), websiteData);
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot add website. Check user authentication and Firestore rules.');
      } else {
        log('Error adding website: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, websites.length]);

  const updateWebsite = useCallback(async (id: string, name: string, url: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if website exists and belongs to user
    const website = websites.find(w => w.id === id);
    if (!website) {
      throw new Error("Website not found");
    }
    
    // Check for duplicates (excluding current website)
    const existing = websites.find(w => w.url === url && w.id !== id);
    if (existing) {
      throw new Error("Website URL already exists in your list");
    }
    
    // Validate data before sending to Firestore
    if (!url.trim().match(/^https?:\/\/.+/)) {
      throw new Error("Invalid URL format. Must start with http:// or https://");
    }
    
    const trimmedName = (name || url).trim();
    if (trimmedName.length < 2 || trimmedName.length > 50) {
      throw new Error("Name must be between 2 and 50 characters");
    }
    
    try {
      await updateDoc(doc(db, 'websites', id), {
        url: url.trim(),
        name: trimmedName,
        updatedAt: Date.now(),
        lastChecked: 0, // Force re-check on next scheduled run
      });
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot update website. Check user authentication and Firestore rules.');
      } else {
        log('Error updating website: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, websites]);

  const deleteWebsite = useCallback(async (id: string) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if website exists and belongs to user
    const website = websites.find(w => w.id === id);
    if (!website) {
      throw new Error("Website not found");
    }
    
    try {
      await deleteDoc(doc(db, 'websites', id));
    } catch (error: any) {
      if (error.code === 'permission-denied') {
        log('Permission denied: Cannot delete website. Check user authentication and Firestore rules.');
      } else {
        log('Error deleting website: ' + error.message);
      }
      throw error; // Re-throw to be caught by the caller
    }
  }, [userId, websites]);

  const reorderWebsites = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!userId) throw new Error('Authentication required');
    
    if (fromIndex === toIndex) return;
    
    if (fromIndex >= websites.length || toIndex >= websites.length) {
      throw new Error("Invalid index provided");
    }
    
    // Reorder the array
    const reorderedWebsites = [...websites];
    const [movedWebsite] = reorderedWebsites.splice(fromIndex, 1);
    reorderedWebsites.splice(toIndex, 0, movedWebsite);
    
    // Update the order using orderIndex instead of modifying createdAt
    const batch = writeBatch(db);
    const now = Date.now();
    
    reorderedWebsites.forEach((website, index) => {
      const docRef = doc(db, 'websites', website.id);
      batch.update(docRef, { 
        orderIndex: index,
        updatedAt: now
      });
    });
    
    await batch.commit();
  }, [userId, websites]);

  const toggleWebsiteStatus = useCallback(async (id: string, disabled: boolean) => {
    if (!userId) throw new Error('Authentication required');
    
    // Check if website exists and belongs to user
    const website = websites.find(w => w.id === id);
    if (!website) {
      throw new Error("Website not found");
    }
    
    const now = Date.now();
    
    if (disabled) {
      await updateDoc(doc(db, 'websites', id), {
        disabled,
        disabledAt: now,
        disabledReason: "Manually disabled by user",
        updatedAt: now
      });
    } else {
      await updateDoc(doc(db, 'websites', id), {
        disabled,
        disabledAt: null,
        disabledReason: null,
        consecutiveFailures: 0,
        lastFailureTime: null,
        updatedAt: now
      });
    }
  }, [userId, websites]);

  return { 
    websites, 
    loading, 
    addWebsite, 
    updateWebsite, 
    deleteWebsite, 
    reorderWebsites,
    toggleWebsiteStatus
  };
} 