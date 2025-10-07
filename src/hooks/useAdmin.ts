import { useState, useEffect } from 'react';
import { useUser } from '@clerk/clerk-react';

export const useAdmin = () => {
  const { user } = useUser();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }

    // Check admin status from Clerk's public metadata
    // This is set server-side and cannot be tampered with by users
    const adminStatus = user.publicMetadata?.admin === true;
    
    setIsAdmin(adminStatus);
    setLoading(false);
  }, [user]);

  return { isAdmin, loading };
};