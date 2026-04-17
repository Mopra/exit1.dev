import React, { useCallback, useEffect, useState } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { apiClient } from '@/api/client';
import { PageHeader, PageContainer } from '@/components/layout';
import {
  Badge,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import GlowCard from '@/components/ui/glow-card';
import { ClipboardList, RefreshCw, Shield } from 'lucide-react';
import { toast } from 'sonner';

const SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  reddit: 'Reddit',
  ai_assistant: 'AI assistant',
  twitter: 'X / Twitter',
  product_hunt: 'Product Hunt',
  hacker_news: 'Hacker News',
  friend: 'Friend',
  blog: 'Blog',
  other: 'Other',
};

const USE_CASE_LABELS: Record<string, string> = {
  infrastructure: 'Infrastructure',
  ecommerce: 'E-commerce',
  client_sites: 'Client sites',
  saas: 'SaaS',
  personal: 'Personal',
  agency: 'Agency',
  other: 'Other',
};

const TEAM_SIZE_LABELS: Record<string, string> = {
  solo: 'Just me',
  '2_5': '2–5',
  '6_20': '6–20',
  '21_100': '21–100',
  '100_plus': '100+',
};

interface Row {
  user_id: string;
  timestamp: number;
  sources: string[];
  use_cases: string[];
  team_size: string | null;
  plan_choice: string | null;
}

const formatList = (values: string[], labels: Record<string, string>) =>
  values.map((v) => labels[v] ?? v).join(', ');

const formatTimestamp = (ms: number) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
};

const AdminOnboarding: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiClient.getOnboardingResponses(500);
    if (res.success && res.data) {
      setRows(res.data.rows);
      setTotal(res.data.total);
    } else {
      setError(res.error ?? 'Failed to load responses');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const handleRefresh = async () => {
    await load();
    if (!error) toast.success('Onboarding responses refreshed');
  };

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
        title="Onboarding Responses"
        description={`${total.toLocaleString()} total response${total === 1 ? '' : 's'}`}
        icon={ClipboardList}
        actions={
          <Button
            onClick={handleRefresh}
            variant="outline"
            size="sm"
            disabled={loading}
            className="cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
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

      <div className="p-2 sm:p-4 md:p-6">
        <GlowCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Sources</TableHead>
                  <TableHead>Use cases</TableHead>
                  <TableHead>Team size</TableHead>
                  <TableHead>Plan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 6 }).map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                      No onboarding responses yet
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, i) => (
                    <TableRow key={`${row.user_id}-${row.timestamp}-${i}`}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {formatTimestamp(row.timestamp)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.user_id}
                      </TableCell>
                      <TableCell className="text-sm max-w-xs">
                        {formatList(row.sources, SOURCE_LABELS) || '—'}
                      </TableCell>
                      <TableCell className="text-sm max-w-xs">
                        {formatList(row.use_cases, USE_CASE_LABELS) || '—'}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {row.team_size ? TEAM_SIZE_LABELS[row.team_size] ?? row.team_size : '—'}
                      </TableCell>
                      <TableCell>
                        {row.plan_choice ? (
                          <Badge variant={row.plan_choice === 'nano' ? 'default' : 'secondary'}>
                            {row.plan_choice}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </GlowCard>
      </div>
    </PageContainer>
  );
};

export default AdminOnboarding;
