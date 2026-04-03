import { useState, useEffect, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import type { PlatformUser, SortOption } from '../components/admin/UserTable';

export const useUsers = (page: number = 1, pageSize: number = 50, sortBy: SortOption = 'createdAt') => {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: pageSize,
    total: 0,
    hasNext: false,
    hasPrev: false
  });

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const getUsers = httpsCallable(functions, 'getAllUsers');
      const result = await getUsers({ page, limit: pageSize, instance: 'prod', sortBy });

      if (result.data && typeof result.data === 'object' && 'success' in result.data) {
        const data = result.data as {
          success: boolean;
          data: PlatformUser[];
          pagination?: {
            page: number;
            pageSize: number;
            total: number;
            hasNext: boolean;
            hasPrev: boolean;
          };
          error?: string
        };
        if (data.success) {
          setUsers(data.data || []);
          if (data.pagination) {
            setPagination(data.pagination);
          }
        } else {
          throw new Error(data.error || 'Failed to fetch users');
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch users');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sortBy]);

  const updateUser = useCallback(async (userId: string, updates: Partial<PlatformUser>) => {
    try {
      setError(null);

      const updateUserFn = httpsCallable(functions, 'updateUser');
      const result = await updateUserFn({ userId, updates });

      if (result.data && typeof result.data === 'object' && 'success' in result.data) {
        const data = result.data as { success: boolean; error?: string };
        if (data.success) {
          await fetchUsers();
        } else {
          throw new Error(data.error || 'Failed to update user');
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
      throw err;
    }
  }, [fetchUsers]);

  const deleteUser = useCallback(async (userId: string) => {
    try {
      setError(null);

      const deleteUserFn = httpsCallable(functions, 'deleteUser');
      const result = await deleteUserFn({ userId });

      if (result.data && typeof result.data === 'object' && 'success' in result.data) {
        const data = result.data as { success: boolean; error?: string };
        if (data.success) {
          await fetchUsers();
        } else {
          throw new Error(data.error || 'Failed to delete user');
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
      throw err;
    }
  }, [fetchUsers]);

  const bulkDeleteUsers = useCallback(async (userIds: string[]) => {
    try {
      setError(null);

      const bulkDeleteUsersFn = httpsCallable(functions, 'bulkDeleteUsers');
      const result = await bulkDeleteUsersFn({ userIds });

      if (result.data && typeof result.data === 'object' && 'success' in result.data) {
        const data = result.data as { success: boolean; error?: string };
        if (data.success) {
          await fetchUsers();
        } else {
          throw new Error(data.error || 'Failed to delete users');
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete users');
      throw err;
    }
  }, [fetchUsers]);

  // Fetch users on mount
  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  return {
    users,
    loading,
    error,
    pagination,
    refresh: fetchUsers,
    updateUser,
    deleteUser,
    bulkDeleteUsers
  };
};
