import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { Activity } from 'lucide-react';
import { PageContainer, PageHeader } from '../components/layout';
import { useChecks } from '../hooks/useChecks';

const LAST_CHECK_ID_STORAGE_KEY = 'exit1_last_check_id';

const CheckDetailsRedirect: React.FC = () => {
  const { userId } = useAuth();
  const { checks, loading } = useChecks(userId ?? null, () => {}, { realtime: false });

  if (loading) {
    return (
      <PageContainer>
        <PageHeader icon={Activity} title="Check details" />
        <div className="w-full mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        </div>
      </PageContainer>
    );
  }

  if (checks.length === 0) {
    return <Navigate to="/checks" replace />;
  }

  const stored = (() => {
    try {
      return localStorage.getItem(LAST_CHECK_ID_STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  const targetId = stored && checks.some((c) => c.id === stored) ? stored : checks[0].id;

  return <Navigate to={`/checks/${targetId}`} replace />;
};

export default CheckDetailsRedirect;
