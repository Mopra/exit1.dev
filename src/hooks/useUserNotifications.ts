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

  // Get Firebase Auth UID (which matches request.auth.uid in security rules)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUid(user?.uid || null);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Use Firebase Auth UID instead of Clerk userId for Firestore queries
    const uid = firebaseUid;
    
    if (!uid) {
      setNotifications([]);
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
  }, [firebaseUid]);

  const unreadCount = notifications.filter(n => !n.read).length;

  return { notifications, loading, unreadCount };
};

