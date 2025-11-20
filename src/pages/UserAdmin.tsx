import React, { useState } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { useUsers } from '@/hooks/useUsers';
import { Button, SearchInput } from '@/components/ui';
import { PageHeader, PageContainer } from '@/components/layout';
import { Users, RefreshCw } from 'lucide-react';
import UserTable from '@/components/admin/UserTable';
import { toast } from 'sonner';

const UserAdmin: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25; // Fixed page size
  const { users, loading: usersLoading, error, pagination, refresh, deleteUser, bulkDeleteUsers } = useUsers(currentPage, pageSize);
  const [searchQuery, setSearchQuery] = useState('');

  if (adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-full max-w-md p-6 bg-card border rounded-lg">
            <div className="text-center space-y-4">
              <Users className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h2 className="text-2xl font-semibold">Access Denied</h2>
                <p className="text-muted-foreground mt-2">
                  You don't have permission to access this page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }


  const handleDeleteUser = async (id: string) => {
    try {
      await deleteUser(id);
      toast.success('User deleted successfully');
    } catch (error) {
      toast.error('Failed to delete user');
    }
  };

  const handleBulkDeleteUsers = async (ids: string[]) => {
    try {
      await bulkDeleteUsers(ids);
      toast.success(`${ids.length} users deleted successfully`);
    } catch (error) {
      toast.error('Failed to delete users');
    }
  };

  const handleRefresh = async () => {
    try {
      await refresh();
      toast.success('Users refreshed');
    } catch (error) {
      toast.error('Failed to refresh users');
    }
  };

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  // Filter users based on search query
  const filteredUsers = users.filter(user => 
    user.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.displayName && user.displayName.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <PageContainer>
      <PageHeader 
        title="User Administration"
        description="Manage users and system administration"
        icon={Users}
        actions={
          <Button
            onClick={handleRefresh}
            variant="outline"
            size="sm"
            disabled={usersLoading}
            className="cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${usersLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="px-4 sm:px-6 pt-4">
          <div className="p-4 border border-destructive rounded-lg bg-destructive/10">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        </div>
      )}

      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search users..."
      />

      {/* Users Table */}
      <div className="flex-1 p-6 min-h-0">
        <div className="h-full max-w-full overflow-hidden">
          <UserTable
            users={filteredUsers}
            onDelete={handleDeleteUser}
            onBulkDelete={handleBulkDeleteUsers}
            searchQuery={searchQuery}
            loading={usersLoading}
          />
        </div>
      </div>

      {/* Pagination Controls */}
      {pagination && (
        <div className="px-4 sm:px-6 pb-6">
          <div className="flex items-center justify-between py-4 gap-4">
            <div className="flex items-center gap-4">
              <div className="text-sm text-muted-foreground">
                Showing {((pagination.page - 1) * pagination.pageSize) + 1} to {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total} users
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1 || usersLoading}
                className="cursor-pointer"
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {currentPage} of {Math.ceil(pagination.total / pagination.pageSize)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={!pagination.hasNext || usersLoading}
                className="cursor-pointer"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
};

export default UserAdmin;
