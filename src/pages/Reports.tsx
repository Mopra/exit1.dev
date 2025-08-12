import React from 'react';
import { useAuth } from '@clerk/clerk-react';
import { type DateRange } from 'react-day-picker';
// removed metric icons

import { 
  GlowCard,
  CardHeader,
  CardTitle,
  CardContent,
  FilterBar,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '../components/ui';
import { glass } from '../components/ui/glass';
import { useChecks } from '../hooks/useChecks';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { TimeRange } from '../components/ui/TimeRangeSelector';
import { useMobile } from '../hooks/useMobile';
import { apiClient } from '../api/client';
import { formatDuration } from '../utils/formatters.tsx';
import { computeReliabilityScore, type ScoreInputs } from '../lib/reliability/math';
import LiquidChrome from '../components/ui/LiquidChrome';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from '../components/ui';
import * as Recharts from 'recharts';

type Metric = {
  key: string;
  label: string;
  value: string;
  helpText?: string;
};

const Reports: React.FC = () => {
  const { userId } = useAuth();
  const log = React.useCallback((msg: string) => console.log(`[Reports] ${msg}`), []);
  const { checks } = useChecks(userId ?? null, log);
  const isMobile = useMobile();

  const [websiteFilter, setWebsiteFilter] = useLocalStorage<string>('reports-website-filter', 'all');
  const [timeRange, setTimeRange] = useLocalStorage<TimeRange>('reports-date-range', '24h');
  const [calendarDateRange, setCalendarDateRange] = React.useState<DateRange | undefined>(undefined);

  const [uptimeDisplay, setUptimeDisplay] = React.useState<string>('-');
  const [metricsLoading, setMetricsLoading] = React.useState<boolean>(false);
  const [metricsError, setMetricsError] = React.useState<string | null>(null);
  const [incidentsDisplay, setIncidentsDisplay] = React.useState<string>('-');
  const [incidentsError, setIncidentsError] = React.useState<string | null>(null);
  const [downtimeDisplay, setDowntimeDisplay] = React.useState<string>('-');
  const [downtimeError, setDowntimeError] = React.useState<string | null>(null);
  const [mtbiDisplay, setMtbiDisplay] = React.useState<string>('-');
  const [mtbiError, setMtbiError] = React.useState<string | null>(null);
  const [reliabilityDisplay, setReliabilityDisplay] = React.useState<string>('—');
  const [reliabilityError, setReliabilityError] = React.useState<string | null>(null);
  const [incidentIntervals, setIncidentIntervals] = React.useState<Array<{ startedAt: number; endedAt: number }>>([]);
  const [selectedSiteCount, setSelectedSiteCount] = React.useState<number>(1);

  const websiteOptions = React.useMemo(
    () => checks?.map((w) => ({ value: w.id, label: w.name })) ?? [],
    [checks]
  );

  // Compute start/end timestamps from selected time range or calendar range
  const getStartEnd = React.useCallback((): { start: number; end: number } => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    if (calendarDateRange?.from || calendarDateRange?.to) {
      const fromDate = calendarDateRange?.from ? new Date(calendarDateRange.from) : new Date(now - oneDay);
      const toDate = calendarDateRange?.to ? new Date(calendarDateRange.to) : new Date();
      fromDate.setHours(0, 0, 0, 0);
      toDate.setHours(23, 59, 59, 999);
      return { start: fromDate.getTime(), end: toDate.getTime() };
    }

    switch (timeRange) {
      case '24h':
        return { start: now - oneDay, end: now };
      case '7d':
        return { start: now - 7 * oneDay, end: now };
      case '30d':
        return { start: now - 30 * oneDay, end: now };
      case '90d':
        return { start: now - 90 * oneDay, end: now };
      case '1y':
        return { start: now - 365 * oneDay, end: now };
      case 'all':
        return { start: 0, end: now };
      default:
        return { start: now - oneDay, end: now };
    }
  }, [calendarDateRange, timeRange]);

  // Fetch uptime stats (single site or aggregated across all)
  React.useEffect(() => {
    const run = async () => {
      if (!userId) return;
      if (!checks || checks.length === 0) {
        setUptimeDisplay('-');
        setIncidentsDisplay('-');
        return;
      }

      const selectedIds = websiteFilter && websiteFilter !== 'all'
        ? [websiteFilter]
        : checks.map((w) => w.id);

      if (selectedIds.length === 0) {
        setUptimeDisplay('-');
        return;
      }

      setMetricsLoading(true);
      setMetricsError(null);
      setIncidentsError(null);
      setDowntimeError(null);
      setMtbiError(null);
      const { start, end } = getStartEnd();

      try {
        const [statResults, historyResults] = await Promise.all([
          Promise.all(selectedIds.map((id) => apiClient.getCheckStatsBigQuery(id, start, end))),
          Promise.all(selectedIds.map((id) => apiClient.getCheckHistoryForStats(id, start, end)))
        ]);

        let totalChecks = 0;
        let onlineChecks = 0;

        statResults.forEach((r) => {
          if (r.success && r.data) {
            totalChecks += Number(r.data.totalChecks || 0);
            onlineChecks += Number(r.data.onlineChecks || 0);
          }
        });

        const uptimePct = totalChecks > 0 ? (onlineChecks / totalChecks) * 100 : 0;
        const formatted = `${uptimePct.toFixed(2)}%`;
        setUptimeDisplay(formatted);

        // Compute incidents across all selected sites
        const isOffline = (status?: string) => {
          if (!status) return false;
          const s = String(status).toUpperCase();
          return s === 'OFFLINE' || s === 'DOWN' || s === 'REACHABLE_WITH_ERROR';
        };

        let incidentsTotal = 0;
        let totalDowntimeMs = 0;
        const incidents: Array<{ startedAt: number; endedAt?: number }> = [];
        historyResults.forEach((res) => {
          if (res.success && res.data) {
            // Sort ascending by timestamp
            const entries = [...res.data].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            let prevWasOffline = false;
            let currentDowntimeStart: number | null = null;
            for (const entry of entries) {
              const offlineNow = isOffline(entry.status as string);
              if (offlineNow && !prevWasOffline) {
                incidentsTotal += 1;
                currentDowntimeStart = entry.timestamp;
              }
              // If we transition back to online, close the downtime window
              if (!offlineNow && prevWasOffline && currentDowntimeStart !== null) {
                totalDowntimeMs += Math.max(0, (entry.timestamp || 0) - currentDowntimeStart);
                incidents.push({ startedAt: currentDowntimeStart, endedAt: entry.timestamp || end });
                currentDowntimeStart = null;
              }
              prevWasOffline = offlineNow;
            }
            // If still offline at the end of range, count until end boundary
            if (prevWasOffline && currentDowntimeStart !== null) {
              totalDowntimeMs += Math.max(0, end - currentDowntimeStart);
              incidents.push({ startedAt: currentDowntimeStart, endedAt: end });
            }
          }
        });

        setIncidentsDisplay(String(incidentsTotal));
        setDowntimeDisplay(formatDuration(totalDowntimeMs));
        // Keep intervals for charting
        const finalized = incidents
          .filter((i) => typeof i.startedAt === 'number' && typeof i.endedAt === 'number')
          .map((i) => ({ startedAt: i.startedAt, endedAt: i.endedAt as number }));
        setIncidentIntervals(finalized);
        setSelectedSiteCount(Math.max(1, selectedIds.length));

        // Compute MTBI (Mean Time Between Incidents)
        // For multiple selected sites, use aggregate window across all: (windowMs * numSites) / totalIncidents
        const windowMs = Math.max(0, end - start);
        const siteCount = Math.max(1, selectedIds.length);
        if (incidentsTotal > 0 && windowMs > 0) {
          const mtbiMs = Math.floor((windowMs * siteCount) / incidentsTotal);
          setMtbiDisplay(formatDuration(mtbiMs));
        } else {
          setMtbiDisplay('—');
        }

        // Compute Reliability Score
        try {
          const checkConfigs = selectedIds.map((id) => {
            const check = checks.find((c) => c.id === id);
            const checkIntervalMinutes = check?.checkFrequency ?? 60;
            return { siteId: id, checkIntervalSec: Math.max(1, checkIntervalMinutes * 60) };
          });

          const input: ScoreInputs = {
            windowStart: start,
            windowEnd: end,
            checkConfigs,
            incidents,
          };
          const { score } = computeReliabilityScore(input);
          setReliabilityDisplay(`${score.toFixed(1)}`);
          setReliabilityError(null);
        } catch (e) {
          setReliabilityDisplay('—');
          setReliabilityError('Failed to compute reliability');
        }
      } catch (e) {
        setMetricsError('Failed to load uptime');
        setUptimeDisplay('-');
        setIncidentsError('Failed to load incidents');
        setIncidentsDisplay('—');
        setDowntimeError('Failed to load downtime');
        setDowntimeDisplay('—');
        setMtbiError('Failed to load MTBI');
        setMtbiDisplay('—');
        setReliabilityError('Failed to compute reliability');
        setReliabilityDisplay('—');
      } finally {
        setMetricsLoading(false);
      }
    };

    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, checks, websiteFilter, timeRange, calendarDateRange, getStartEnd]);

  // Metrics: uptime wired to real data; others stay placeholders for now
  const metrics: Metric[] = React.useMemo(
    () => [
      {
        key: 'uptime',
        label: 'Uptime',
        value: metricsError ? '-' : uptimeDisplay,
        helpText: metricsError ? metricsError : (metricsLoading ? 'Loading…' : 'Percentage of successful checks'),
      },
      {
        key: 'incidents',
        label: 'Incidents',
        value: incidentsError ? '—' : incidentsDisplay,
        helpText: incidentsError ? incidentsError : 'Times the site was offline',
      },
      {
        key: 'downtime',
        label: 'Total Downtime',
        value: downtimeError ? '—' : downtimeDisplay,
        helpText: downtimeError ? downtimeError : 'Sum of offline durations',
      },
      {
        key: 'mtbi',
        label: 'MTBI',
        value: mtbiError ? '—' : mtbiDisplay,
        helpText: mtbiError ? mtbiError : 'Mean Time Between Incidents',
      },
      {
        key: 'reliability',
        label: 'ORS',
        value: reliabilityError ? '—' : reliabilityDisplay,
        helpText: reliabilityError ? reliabilityError : 'Operational Reliability Score',
      },
    ], [
      uptimeDisplay,
      incidentsDisplay,
      downtimeDisplay,
      mtbiDisplay,
      metricsLoading,
      metricsError,
      incidentsError,
      downtimeError,
      mtbiError,
      reliabilityDisplay,
      reliabilityError,
    ]
  );

  // Build incidents/uptime chart data
  const chartData = React.useMemo(() => {
    const { start, end } = getStartEnd();
    if (!start || !end || end <= start) return [] as Array<{ label: string; incidents: number; downtimeMin: number; uptimePct: number }>

    const spanMs = end - start;
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const week = 7 * day;

    const bucketSize = spanMs <= 36 * hour ? hour : spanMs <= 14 * day ? day : spanMs <= 180 * day ? week : 30 * day;

    const buckets: Array<{ t: number; label: string; incidents: number; downtimeMs: number }> = [];
    const labelFor = (t: number) => {
      const d = new Date(t);
      if (bucketSize === hour) return d.toLocaleTimeString([], { hour: '2-digit' });
      if (bucketSize === day) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const alignedStart = Math.floor(start / bucketSize) * bucketSize;
    for (let t = alignedStart; t < end; t += bucketSize) {
      buckets.push({ t, label: labelFor(t), incidents: 0, downtimeMs: 0 });
    }

    // Count incidents and downtime overlap per bucket
    for (const interval of incidentIntervals) {
      const s = Math.max(interval.startedAt, start);
      const e = Math.min(interval.endedAt, end);
      if (e <= s) continue;
      // incident count at start bucket
      const startBucketIndex = Math.floor((s - alignedStart) / bucketSize);
      if (startBucketIndex >= 0 && startBucketIndex < buckets.length) {
        buckets[startBucketIndex].incidents += 1;
      }
      // downtime spread across buckets
      let bt = Math.floor(s / bucketSize) * bucketSize;
      while (bt < e) {
        const bucketEnd = bt + bucketSize;
        const overlap = Math.max(0, Math.min(e, bucketEnd) - Math.max(s, bt));
        const idx = Math.floor((bt - alignedStart) / bucketSize);
        if (idx >= 0 && idx < buckets.length && overlap > 0) {
          buckets[idx].downtimeMs += overlap;
        }
        bt = bucketEnd;
      }
    }

    return buckets.map((b) => {
      const downtimeMin = Math.round(b.downtimeMs / 60000);
      const denom = bucketSize * Math.max(1, selectedSiteCount);
      const uptimePct = denom > 0 ? Math.max(0, 100 - (b.downtimeMs / denom) * 100) : 100;
      return { label: b.label, incidents: b.incidents, downtimeMin, uptimePct: Number(uptimePct.toFixed(2)) };
    });
  }, [incidentIntervals, selectedSiteCount, getStartEnd]);

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden min-w-0 w-full max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 p-4 sm:p-6 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">Aggregated uptime and reliability metrics</p>
        </div>
      </div>

      {/* Filters */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border py-6 px-4 sm:px-6">
        <FilterBar
          timeRange={calendarDateRange ? '' : (timeRange as TimeRange)}
          onTimeRangeChange={(range) => setTimeRange(range as TimeRange)}
          disableTimeRangeToggle={Boolean(calendarDateRange)}
          dateRange={calendarDateRange}
          onDateRangeChange={setCalendarDateRange}
          searchTerm={''}
          onSearchChange={() => {}}
          hideSearch
          statusFilter={'all'}
          onStatusChange={() => {}}
          hideStatus
          websiteFilter={websiteFilter}
          onWebsiteChange={setWebsiteFilter}
          websiteOptions={websiteOptions}
          includeAllWebsitesOption={true}
          loading={false}
          canExport={false}
          variant="full"
          layout={isMobile ? 'stacked' : 'inline'}
          stackedOrder={['website', 'timeRange', 'dateRange']}
        />
      </div>

      {/* Metrics */}
      <div className="mt-6 p-4 sm:p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {metrics.map((m) => {
            const card = (
              <GlowCard key={m.key} magic={m.key === 'reliability'} className={`relative overflow-hidden p-0 ${m.key === 'reliability' ? 'cursor-pointer' : ''}`}>
                {m.key === 'reliability' && (
                  <div className="absolute inset-0 -z-0">
                    <LiquidChrome
                      baseColor={[0.12, 0.18, 0.35]}
                      speed={0.2}
                      amplitude={0.3}
                      interactive={false}
                    />
                  </div>
                )}

                {m.key === 'reliability' ? (
                  <div className="relative z-10 rounded-lg bg-black/35 backdrop-blur-sm border border-white/10 m-1">
                    <CardHeader className="space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium text-white">{m.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold text-white drop-shadow-sm">{m.value}</div>
                      {m.helpText && (
                        <p className="text-xs mt-1 text-white/80">{m.helpText}</p>
                      )}
                    </CardContent>
                  </div>
                ) : (
                  <div className="m-1">
                    <CardHeader className="space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">{m.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{m.value}</div>
                      {m.helpText && (
                        <p className="text-xs text-muted-foreground mt-1">{m.helpText}</p>
                      )}
                    </CardContent>
                  </div>
                )}
              </GlowCard>
            );

            if (m.key === 'reliability') {
              return (
                <Tooltip key={m.key}>
                  <TooltipTrigger asChild>
                    {card}
                  </TooltipTrigger>
                  <TooltipContent className={`max-w-xs ${glass('primary')}`} sideOffset={8}>
                    ORS blends uptime, incidents, recovery; adjusted by check rate. 0–10.
                  </TooltipContent>
                </Tooltip>
              );
            }

            return card;
          })}
        </div>
        {/* Incidents Over Time Chart */}
        <div className="mt-12">
          <GlowCard className="pt-16 pb-8">
            <CardContent>
              <ChartContainer
                config={{
                  incidents: { label: 'Incidents', color: 'oklch(0.65 0.25 25)' },
                  downtime: { label: 'Downtime (min)', color: 'oklch(0.60 0.18 280)' },
                  uptime: { label: 'Uptime %', color: 'oklch(0.62 0.09 231)' },
                }}
                className="aspect-[16/7] bg-transparent"
              >
                <Recharts.ComposedChart data={chartData} margin={{ left: 5, right: 5, bottom: 0, top: 10 }}>
                  <Recharts.CartesianGrid strokeDasharray="3 3" />
                  <Recharts.XAxis dataKey="label" />
                  <Recharts.YAxis yAxisId="left" orientation="left" />
                  <Recharts.YAxis yAxisId="right" orientation="right" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent /> as any} />
                  <Recharts.Bar dataKey="incidents" name="Incidents" yAxisId="left" fill="var(--color-incidents)" radius={[4,4,0,0]} />
                  <Recharts.Area dataKey="downtimeMin" name="Downtime (min)" yAxisId="left" type="monotone" stroke="var(--color-downtime)" fill="var(--color-downtime)" fillOpacity={0.2} />
                  <Recharts.Line dataKey="uptimePct" name="Uptime %" yAxisId="right" type="monotone" stroke="var(--color-uptime)" dot={false} strokeWidth={2} />
                </Recharts.ComposedChart>
              </ChartContainer>
            </CardContent>
          </GlowCard>
        </div>
      </div>
    </div>
  );
};

export default Reports;


