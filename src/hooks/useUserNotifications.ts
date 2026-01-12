import { useState, useEffect } from 'react';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db, auth } from '@/firebase';
import { onAuthStateChanged } from 'firebase/auth';

export interface UserNotification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  createdAt: number;
  read: boolean;
  readAt?: number;
  link?: string;
}

export const useUserNotifications = () => {
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  // Get Firebase Auth UID (which matches request.auth.uid in security rules)
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

  useEffect(() => {
    // Use Firebase Auth UID instead of Clerk userId for Firestore queries
    const uid = firebaseUid;
    
    if (!uid) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    if (!isVisible) {
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, 'user_notifications'),
      where('userId', '==', uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const notifs = snapshot.docs.map(doc => {
          const data = doc.data();
          return { 
            id: doc.id, 
            ...data,
            createdAt: data.createdAt || 0,
            read: data.read || false,
          } as UserNotification;
        });
      
        setNotifications(notifs);
        setLoading(false);
      },
      (error: any) => {
        console.error("Error fetching user notifications:", error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [firebaseUid, isVisible]);

  const unreadCount = notifications.filter(n => !n.read).length;

  return { notifications, loading, unreadCount };
};
