import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Recharts from 'recharts';
import { useAdmin } from '@/hooks/useAdmin';
import { apiClient } from '@/api/client';
import { PageHeader, PageContainer } from '@/components/layout';
import {
  Badge,
  BulkActionsBar,
  Button,
  Checkbox,
  ConfirmationModal,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import GlowCard from '@/components/ui/glow-card';
import { Check, ClipboardList, Copy, RefreshCw, Shield, X } from 'lucide-react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/utils/clipboard';

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
  email: string | null;
}

const rowKey = (r: Pick<Row, 'user_id' | 'timestamp'>) => `${r.user_id}|${r.timestamp}`;

const shortenId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

const UserIdCell: React.FC<{ userId: string }> = ({ userId }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(userId);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error('Failed to copy');
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-xs text-muted-foreground" title={userId}>
        {shortenId(userId)}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        title={copied ? 'Copied' : 'Copy user ID'}
        aria-label="Copy user ID"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
};

const formatList = (values: string[], labels: Record<string, string>) =>
  values.map((v) => labels[v] ?? v).join(', ');

const formatTimestamp = (ms: number) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
};

const NONE_KEY = '__none__';
const ALL_KEY = 'all';
const NONE_LABEL = '(none)';

// Admin onboarding chart accents — pulled from theme chart tokens (style.css).
const SOURCE_CHART_COLOR = 'var(--chart-1)';
const USE_CASE_CHART_COLOR = 'var(--chart-4)';
const TEAM_CHART_COLOR = 'var(--chart-5)';
const PLAN_CHART_COLOR = 'var(--chart-3)';

type Facet = { key: string; label: string; count: number };

const buildFacets = (
  values: (string | null | undefined)[],
  labels: Record<string, string>,
): Facet[] => {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v && v.length > 0 ? v : NONE_KEY;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: key === NONE_KEY ? NONE_LABEL : labels[key] ?? key,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

const buildMultiFacets = (
  arrays: string[][],
  labels: Record<string, string>,
): Facet[] => {
  const counts = new Map<string, number>();
  for (const arr of arrays) {
    if (!arr || arr.length === 0) {
      counts.set(NONE_KEY, (counts.get(NONE_KEY) ?? 0) + 1);
      continue;
    }
    for (const v of arr) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: key === NONE_KEY ? NONE_LABEL : labels[key] ?? key,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

interface DistributionChartProps {
  title: string;
  description: string;
  data: Facet[];
  color: string;
  total: number;
  activeFilter: string;
  onFilterChange: (value: string) => void;
  filterAllLabel: string;
}

const DistributionChart: React.FC<DistributionChartProps> = ({
  title,
  description,
  data,
  color,
  total,
  activeFilter,
  onFilterChange,
  filterAllLabel,
}) => {
  const chartConfig: ChartConfig = {
    count: { label: 'Responses', color },
  };
  const hasData = data.length > 0;
  const rowHeight = 28;
  const chartHeight = Math.max(160, data.length * rowHeight + 24);

  return (
    <GlowCard className="p-4 flex flex-col gap-3 h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">
            {description} · {total.toLocaleString()} response{total === 1 ? '' : 's'}
          </p>
        </div>
        {activeFilter !== ALL_KEY && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs cursor-pointer"
            onClick={() => onFilterChange(ALL_KEY)}
          >
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
        )}
      </div>
      {hasData ? (
        <ChartContainer
          config={chartConfig}
          className="w-full bg-transparent aspect-auto"
          style={{ height: chartHeight }}
        >
          <Recharts.BarChart
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 24, top: 4, bottom: 4 }}
            barCategoryGap={6}
          >
            <Recharts.CartesianGrid horizontal={false} strokeDasharray="3 3" strokeOpacity={0.25} />
            <Recharts.XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
            <Recharts.YAxis
              type="category"
              dataKey="label"
              width={110}
              tick={{ fontSize: 11 }}
              interval={0}
            />
            <ChartTooltip
              cursor={{ fillOpacity: 0.08 }}
              content={
                <ChartTooltipContent
                  hideIndicator
                  labelFormatter={(_value, payload) => payload?.[0]?.payload?.label ?? ''}
                />
              }
            />
            <Recharts.Bar
              dataKey="count"
              name="Responses"
              radius={[0, 4, 4, 0]}
              className="cursor-pointer"
              onClick={(entry: { key?: string } | undefined) => {
                if (!entry?.key) return;
                onFilterChange(entry.key === activeFilter ? ALL_KEY : entry.key);
              }}
            >
              {data.map((entry) => (
                <Recharts.Cell
                  key={entry.key}
                  fill={color}
                  fillOpacity={
                    activeFilter === ALL_KEY || activeFilter === entry.key ? 1 : 0.35
                  }
                />
              ))}
              <Recharts.LabelList
                dataKey="count"
                position="right"
                className="fill-muted-foreground"
                style={{ fontSize: 11 }}
              />
            </Recharts.Bar>
          </Recharts.BarChart>
        </ChartContainer>
      ) : (
        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">
          No data
        </div>
      )}
      <div className="mt-auto">
        <Select value={activeFilter} onValueChange={onFilterChange}>
          <SelectTrigger size="sm" className="w-full cursor-pointer" aria-label={`Filter ${title}`}>
            <SelectValue placeholder={filterAllLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_KEY} className="cursor-pointer">
              {filterAllLabel}
            </SelectItem>
            {data.map((f) => (
              <SelectItem key={f.key} value={f.key} className="cursor-pointer">
                {f.label} ({f.count.toLocaleString()})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </GlowCard>
  );
};

const AdminOnboarding: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>(ALL_KEY);
  const [useCaseFilter, setUseCaseFilter] = useState<string>(ALL_KEY);
  const [teamSizeFilter, setTeamSizeFilter] = useState<string>(ALL_KEY);
  const [planFilter, setPlanFilter] = useState<string>(ALL_KEY);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiClient.getOnboardingResponses(500);
    if (res.success && res.data) {
      setRows(res.data.rows);
      setTotal(res.data.total);
      setSelected(new Set());
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

  const matchesArrayFilter = (arr: string[], filter: string) => {
    if (filter === ALL_KEY) return true;
    if (filter === NONE_KEY) return !arr || arr.length === 0;
    return arr?.includes(filter);
  };

  const matchesScalarFilter = (value: string | null, filter: string) => {
    if (filter === ALL_KEY) return true;
    if (filter === NONE_KEY) return !value;
    return value === filter;
  };

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesArrayFilter(r.sources, sourceFilter)) return false;
      if (!matchesArrayFilter(r.use_cases, useCaseFilter)) return false;
      if (!matchesScalarFilter(r.team_size, teamSizeFilter)) return false;
      if (!matchesScalarFilter(r.plan_choice, planFilter)) return false;
      if (!q) return true;
      const sourcesText = r.sources.map((s) => SOURCE_LABELS[s] ?? s).join(' ');
      const useCasesText = r.use_cases.map((s) => USE_CASE_LABELS[s] ?? s).join(' ');
      const teamText = r.team_size ? TEAM_SIZE_LABELS[r.team_size] ?? r.team_size : '';
      const haystack = [
        r.email ?? '',
        r.user_id,
        r.plan_choice ?? '',
        sourcesText,
        useCasesText,
        teamText,
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, search, sourceFilter, useCaseFilter, teamSizeFilter, planFilter]);

  const planLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    for (const r of rows) {
      if (r.plan_choice) labels[r.plan_choice] = r.plan_choice;
    }
    return labels;
  }, [rows]);

  const sourceFacets = useMemo(
    () => buildMultiFacets(filteredRows.map((r) => r.sources), SOURCE_LABELS),
    [filteredRows],
  );
  const useCaseFacets = useMemo(
    () => buildMultiFacets(filteredRows.map((r) => r.use_cases), USE_CASE_LABELS),
    [filteredRows],
  );
  const teamSizeFacets = useMemo(
    () => buildFacets(filteredRows.map((r) => r.team_size), TEAM_SIZE_LABELS),
    [filteredRows],
  );
  const planFacets = useMemo(
    () => buildFacets(filteredRows.map((r) => r.plan_choice), planLabels),
    [filteredRows, planLabels],
  );

  const activeFilterCount =
    (sourceFilter !== ALL_KEY ? 1 : 0) +
    (useCaseFilter !== ALL_KEY ? 1 : 0) +
    (teamSizeFilter !== ALL_KEY ? 1 : 0) +
    (planFilter !== ALL_KEY ? 1 : 0);

  const resetFilters = () => {
    setSourceFilter(ALL_KEY);
    setUseCaseFilter(ALL_KEY);
    setTeamSizeFilter(ALL_KEY);
    setPlanFilter(ALL_KEY);
  };

  const allSelected = filteredRows.length > 0 && filteredRows.every((r) => selected.has(rowKey(r)));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredRows.forEach((r) => next.delete(rowKey(r)));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredRows.forEach((r) => next.add(rowKey(r)));
        return next;
      });
    }
  }, [allSelected, filteredRows]);

  const toggleRow = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(rowKey(r))),
    [rows, selected],
  );

  const handleBulkDelete = async () => {
    if (selectedRows.length === 0) return;
    setDeleting(true);
    const payload = selectedRows.map((r) => ({ user_id: r.user_id, timestamp: r.timestamp }));
    const res = await apiClient.deleteOnboardingResponses(payload);
    setDeleting(false);
    setConfirmOpen(false);
    if (res.success && res.data) {
      const { deleted, pending } = res.data;
      if (deleted > 0) {
        toast.success(`Deleted ${deleted} response${deleted === 1 ? '' : 's'}`);
      }
      if (pending > 0) {
        toast.warning(
          `${pending} row${pending === 1 ? '' : 's'} still in BigQuery streaming buffer; retry in ~30 min.`,
        );
      }
      if (deleted === 0 && pending === 0) {
        toast.error('Nothing was deleted');
      }
      await load();
    } else {
      toast.error(res.error ?? 'Failed to delete responses');
    }
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

      <div className="px-2 sm:px-4 md:px-6 pt-2 sm:pt-4 md:pt-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <DistributionChart
            title="Sources"
            description="How users found us"
            data={sourceFacets}
            color={SOURCE_CHART_COLOR}
            total={filteredRows.length}
            activeFilter={sourceFilter}
            onFilterChange={setSourceFilter}
            filterAllLabel="All sources"
          />
          <DistributionChart
            title="Use cases"
            description="What they monitor"
            data={useCaseFacets}
            color={USE_CASE_CHART_COLOR}
            total={filteredRows.length}
            activeFilter={useCaseFilter}
            onFilterChange={setUseCaseFilter}
            filterAllLabel="All use cases"
          />
          <DistributionChart
            title="Team size"
            description="People in org"
            data={teamSizeFacets}
            color={TEAM_CHART_COLOR}
            total={filteredRows.length}
            activeFilter={teamSizeFilter}
            onFilterChange={setTeamSizeFilter}
            filterAllLabel="All team sizes"
          />
          <DistributionChart
            title="Plan choice"
            description="Tier selected at signup"
            data={planFacets}
            color={PLAN_CHART_COLOR}
            total={filteredRows.length}
            activeFilter={planFilter}
            onFilterChange={setPlanFilter}
            filterAllLabel="All plans"
          />
        </div>
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search by email, user ID, source, use case, plan…"
      />
      {activeFilterCount > 0 && (
        <div className="px-4 sm:px-6 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={resetFilters}
            className="cursor-pointer"
          >
            <X className="h-4 w-4 mr-1" />
            Clear filters ({activeFilterCount})
          </Button>
        </div>
      )}

      <div className="p-2 sm:p-4 md:p-6">
        <GlowCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={toggleAll}
                      disabled={loading || filteredRows.length === 0}
                      aria-label="Select all rows"
                    />
                  </TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>User ID</TableHead>
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
                      {Array.from({ length: 8 }).map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : filteredRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                      {search ? 'No responses match your search' : 'No onboarding responses yet'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRows.map((row, i) => {
                    const key = rowKey(row);
                    const isSelected = selected.has(key);
                    return (
                      <TableRow
                        key={`${key}-${i}`}
                        data-state={isSelected ? 'selected' : undefined}
                      >
                        <TableCell className="w-10">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRow(key)}
                            aria-label="Select row"
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {formatTimestamp(row.timestamp)}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {row.email ? (
                            <span className="font-mono">{row.email}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <UserIdCell userId={row.user_id} />
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
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </GlowCard>
      </div>

      <BulkActionsBar
        selectedCount={selected.size}
        totalCount={filteredRows.length || rows.length}
        onClearSelection={() => setSelected(new Set())}
        itemLabel="response"
        actions={[
          {
            label: 'Delete',
            onClick: () => setConfirmOpen(true),
            isDelete: true,
          },
        ]}
      />

      <ConfirmationModal
        isOpen={confirmOpen}
        onClose={() => {
          if (!deleting) setConfirmOpen(false);
        }}
        onConfirm={handleBulkDelete}
        title={`Delete ${selected.size} response${selected.size === 1 ? '' : 's'}?`}
        message="This permanently removes the selected rows from BigQuery. This cannot be undone."
        confirmText={deleting ? 'Deleting…' : 'Delete'}
        variant="destructive"
        itemCount={selected.size}
        itemName="response"
      />
    </PageContainer>
  );
};

export default AdminOnboarding;
