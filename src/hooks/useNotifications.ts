import { useState, useEffect } from 'react';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '@/firebase';

export interface SystemNotification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  createdAt: number;
  active: boolean;
  expiresAt?: number;
}

export const useNotifications = () => {
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [isVisible, setIsVisible] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setIsVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    if (!isVisible) {
      setLoading(false);
      return;
    }

    // Query for active notifications
    // Note: Firestore requires an index for active == true && orderBy createdAt desc
    // If index is missing, we'll filter client-side as fallback
    let q;
    try {
      q = query(
        collection(db, 'system_notifications'),
        where('active', '==', true),
        orderBy('createdAt', 'desc')
      );
    } catch (err) {
      // Fallback: query all and filter client-side
      q = query(collection(db, 'system_notifications'));
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const now = Date.now();
        let notifs = snapshot.docs
          .map(doc => {
            const data = doc.data();
            return { 
              id: doc.id, 
              ...data,
              createdAt: data.createdAt || 0,
            } as SystemNotification;
          })
          // Filter active notifications (client-side if index missing)
          .filter(n => n.active === true)
          // Filter expired notifications
          .filter(n => !n.expiresAt || n.expiresAt > now)
          // Sort by createdAt desc (client-side if index missing)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      
        setNotifications(notifs);
        setLoading(false);
      },
      (error: any) => {
        console.error("Error fetching system notifications:", error);
        // Don't show toast for user-facing component - just fail silently
        // The index error will be shown in console with a link to create it
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [isVisible]);

  return { notifications, loading };
};

