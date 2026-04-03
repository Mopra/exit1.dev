import { useMemo } from 'react';
import { useUser } from '@clerk/clerk-react';

export const useAdmin = () => {
  const { user, isLoaded } = useUser();
  const isAdmin = useMemo(() => user?.publicMetadata?.admin === true, [user]);
  return { isAdmin, loading: !isLoaded };
};
