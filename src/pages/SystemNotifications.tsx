import React from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { PageHeader, PageContainer } from '@/components/layout';
import { NotificationManager } from '@/components/admin/NotificationManager';
import { Bell, Shield } from 'lucide-react';

const SystemNotifications: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();

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
              <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
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

  return (
    <PageContainer>
      <PageHeader 
        title="System Notifications"
        description="Manage system-wide notifications for all users"
        icon={Bell}
      />
      <div className="p-4 sm:p-6">
        <NotificationManager />
      </div>
    </PageContainer>
  );
};

export default SystemNotifications;

