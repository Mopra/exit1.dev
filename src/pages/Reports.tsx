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
  Skeleton,
  Spinner,
  Badge,
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { glass } from '../components/ui/glass';
import { BarChart3 } from 'lucide-react';
import { useChecks } from '../hooks/useChecks';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { TimeRange } from '../components/ui/TimeRangeSelector';
import { useMobile } from '../hooks/useMobile';
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
import { apiClient } from '../api/client';

type Metric = {
  key: string;
  label: string;
  value: string;
  helpText?: string;
};

type ChartDataPoint = {
  label: string;
  incidents: number;
  downtimeMin: number;
  uptimePct: number;
  avgResponseTime: number | null;
};

const Reports: React.FC = () => {
  const { userId } = useAuth();
  const log = React.useCallback((msg: string) => console.log(`[Reports] ${msg}`), []);
  const { checks } = useChecks(userId ?? null, log);
  const isMobile = useMobile();

  // v2: default to no selection so we don't accidentally load "All Websites" on first visit
  const [websiteFilter, setWebsiteFilter] = useLocalStorage<string>('reports-website-filter-v2', '');
  const isAllWebsites = websiteFilter === 'all';
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
  const [selectedSiteCount, setSelectedSiteCount] = React.useState<number>(0);
  const [responseTimeBuckets, setResponseTimeBuckets] = React.useState<Array<{ bucketStart: number; avgResponseTime: number; sampleCount: number }>>([]);
  const [reportBucketSizeMs, setReportBucketSizeMs] = React.useState<number | null>(null);
  const [avgResponseTimeDisplay, setAvgResponseTimeDisplay] = React.useState<string>('—');
  const [avgResponseTimeError, setAvgResponseTimeError] = React.useState<string | null>(null);

  const formatAvgResponseTime = (avgResponseTime: number) =>
    avgResponseTime < 1000
      ? `${Math.round(avgResponseTime)}ms`
      : `${Math.round(avgResponseTime / 1000)}s`;

  const websiteOptions = React.useMemo(
    () => checks?.map((w) => ({ value: w.id, label: w.name })) ?? [],
    [checks]
  );

  // Create stable string representation of all check IDs for comparison
  // This only changes when the actual IDs change, not when the array reference changes
  const allCheckIdsKey = React.useMemo(() => {
    if (!checks || checks.length === 0) return '';
    return checks.map((w) => w.id).sort().join(',');
  }, [checks]);

  // Memoize selected check IDs to prevent unnecessary reloads when checks array reference changes
  // but the actual selected IDs haven't changed. Use a stable string key for comparison.
  const selectedCheckIdsKey = React.useMemo(() => {
    if (!websiteFilter) return '';
    if (websiteFilter === 'all') {
      return `all:${allCheckIdsKey}`;
    }
    return `single:${websiteFilter}`;
  }, [websiteFilter, allCheckIdsKey]);

  // Get selected IDs from the key - this will only change when selectedCheckIdsKey changes
  const selectedCheckIds = React.useMemo(() => {
    if (!websiteFilter) return [];
    if (websiteFilter === 'all') {
      return checks?.map((w) => w.id) ?? [];
    }
    return [websiteFilter];
  }, [websiteFilter, selectedCheckIdsKey, checks]);

  // Create stable string representation of check frequencies for selected checks
  // This only changes when selected IDs or their frequencies change
  const selectedCheckFrequenciesKey = React.useMemo(() => {
    if (!selectedCheckIds.length || !checks) return '';
    const selectedChecks = checks.filter((c) => selectedCheckIds.includes(c.id));
    return selectedChecks.map((c) => `${c.id}:${c.checkFrequency ?? 60}`).sort().join(',');
  }, [selectedCheckIdsKey, checks]);

  // Memoize check configs for reliability score calculation - only update when selected IDs or their frequencies change
  const checkConfigsForSelected = React.useMemo(() => {
    if (!selectedCheckIds.length || !checks) return [];
    return selectedCheckIds.map((id) => {
      const check = checks.find((c) => c.id === id);
      const checkIntervalMinutes = check?.checkFrequency ?? 60;
      return { siteId: id, checkIntervalSec: Math.max(1, checkIntervalMinutes * 60) };
    });
  }, [selectedCheckIdsKey, selectedCheckFrequenciesKey]);

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

  const isLongRange = React.useMemo(() => {
    const { start, end } = getStartEnd();
    const spanMs = Math.max(0, end - start);
    return spanMs > 30 * 24 * 60 * 60 * 1000;
  }, [getStartEnd]);

  // Fetch uptime stats (single site or aggregated across all)
  React.useEffect(() => {
    const run = async () => {
      if (!userId) return;
      
      // Don't fetch anything until the user selects a website (or All Websites).
      if (!websiteFilter || selectedCheckIds.length === 0) {
        if (!checks || checks.length === 0) {
          setUptimeDisplay('-');
          setIncidentsDisplay('-');
        }
        setMetricsLoading(false);
        setMetricsError(null);
        setIncidentsError(null);
        setDowntimeError(null);
        setMtbiError(null);
        setReliabilityError(null);
        setAvgResponseTimeError(null);
        setUptimeDisplay('-');
        setIncidentsDisplay('-');
        setDowntimeDisplay('-');
        setMtbiDisplay('-');
        setReliabilityDisplay('—');
        setAvgResponseTimeDisplay('—');
        setIncidentIntervals([]);
        setResponseTimeBuckets([]);
        setReportBucketSizeMs(null);
        setSelectedSiteCount(0);
        return;
      }

      const selectedIds = selectedCheckIds;

      setMetricsLoading(true);
      setMetricsError(null);
      setIncidentsError(null);
      setDowntimeError(null);
      setMtbiError(null);
      const { start, end } = getStartEnd();

      try {
        // Fast path: in "All Websites" mode we intentionally skip pulling full history
        // (it's the biggest perf hit). Metrics that require incident windows stay unavailable.
        if (websiteFilter === 'all') {
          const statResults = await Promise.all(
            selectedIds.map((id) => apiClient.getCheckStatsBigQuery(id, start, end))
          );

          const hasStats = statResults.some((r) => r.success && r.data);
          if (!hasStats) {
            const errorMessage = statResults.find((r) => !r.success)?.error || 'Failed to load uptime';
            setMetricsError(errorMessage);
            setUptimeDisplay('-');
            setAvgResponseTimeDisplay('—');
            setAvgResponseTimeError(errorMessage);
          } else {
            let totalDurationMs = 0;
            let onlineDurationMs = 0;
            // Weighted average response time across sites (by sample count)
            let responseTimeWeightedSum = 0;
            let responseTimeWeightTotal = 0;
            let responseTimeFallbackSum = 0;
            let responseTimeFallbackCount = 0;

            statResults.forEach((r) => {
              if (r.success && r.data) {
                const siteTotalDuration = Number(r.data.totalDurationMs ?? r.data.totalChecks ?? 0);
                const siteOnlineDuration = Number(r.data.onlineDurationMs ?? r.data.onlineChecks ?? 0);
                totalDurationMs += siteTotalDuration;
                onlineDurationMs += siteOnlineDuration;

                const avg = r.data.avgResponseTime;
                const sampleCount = Number(r.data.responseSampleCount ?? r.data.totalChecks ?? 0);
                if (typeof avg === 'number' && Number.isFinite(avg)) {
                  if (sampleCount > 0) {
                    responseTimeWeightedSum += avg * sampleCount;
                    responseTimeWeightTotal += sampleCount;
                  } else if (avg > 0) {
                    responseTimeFallbackSum += avg;
                    responseTimeFallbackCount += 1;
                  }
                }
              }
            });

            const uptimePct = totalDurationMs > 0 ? (onlineDurationMs / totalDurationMs) * 100 : 0;
            const formatted = `${uptimePct.toFixed(2)}%`;
            setUptimeDisplay(formatted);
            setMetricsError(null);

            const avgResponseTime =
              responseTimeWeightTotal > 0
                ? responseTimeWeightedSum / responseTimeWeightTotal
                : responseTimeFallbackCount > 0
                  ? responseTimeFallbackSum / responseTimeFallbackCount
                  : null;
            if (avgResponseTime && avgResponseTime > 0) {
              setAvgResponseTimeDisplay(formatAvgResponseTime(avgResponseTime));
              setAvgResponseTimeError(null);
            } else {
              setAvgResponseTimeDisplay('—');
              setAvgResponseTimeError(null);
            }
          }

          setIncidentsDisplay('—');
          setDowntimeDisplay('—');
          setMtbiDisplay('—');
          setReliabilityDisplay('—');
          setIncidentIntervals([]);
          setResponseTimeBuckets([]);
          setReportBucketSizeMs(null);
          setSelectedSiteCount(selectedIds.length);
          return;
        }

        const reportResults = await Promise.all(
          selectedIds.map((id) => apiClient.getReportMetrics(id, start, end))
        );

        const reportSuccess = reportResults.some((res) => res.success && res.data);
        if (!reportSuccess) {
          const reportError = reportResults.find((res) => !res.success)?.error || 'Failed to load report metrics';
          setMetricsError(reportError);
          setUptimeDisplay('-');
          setAvgResponseTimeDisplay('—');
          setAvgResponseTimeError(reportError);
          setIncidentsError(reportError);
          setIncidentsDisplay('—');
          setDowntimeError(reportError);
          setDowntimeDisplay('—');
          setMtbiError(reportError);
          setMtbiDisplay('—');
          setReliabilityError(reportError);
          setReliabilityDisplay('—');
          setIncidentIntervals([]);
          setResponseTimeBuckets([]);
          setReportBucketSizeMs(null);
          setSelectedSiteCount(selectedIds.length);
          return;
        }

        let totalDurationMs = 0;
        let onlineDurationMs = 0;
        let responseTimeWeightedSum = 0;
        let responseTimeWeightTotal = 0;
        let responseTimeFallbackSum = 0;
        let responseTimeFallbackCount = 0;
        let incidentsTotal = 0;
        let totalDowntimeMs = 0;
        const incidents: Array<{ startedAt: number; endedAt: number }> = [];
        const responseTimeAggregate = new Map<number, { sum: number; count: number }>();
        let bucketSizeMs: number | null = null;

        reportResults.forEach((res) => {
          if (res.success && res.data) {
            const { stats, incidents: intervals, responseTimeBuckets: buckets, bucketSizeMs: serverBucketSize } = res.data;
            const siteTotalDuration = Number(stats.totalDurationMs ?? stats.totalChecks ?? 0);
            const siteOnlineDuration = Number(stats.onlineDurationMs ?? stats.onlineChecks ?? 0);
            totalDurationMs += siteTotalDuration;
            onlineDurationMs += siteOnlineDuration;

            const avg = stats.avgResponseTime;
            const sampleCount = Number(stats.responseSampleCount ?? stats.totalChecks ?? 0);
            if (typeof avg === 'number' && Number.isFinite(avg)) {
              if (sampleCount > 0) {
                responseTimeWeightedSum += avg * sampleCount;
                responseTimeWeightTotal += sampleCount;
              } else if (avg > 0) {
                responseTimeFallbackSum += avg;
                responseTimeFallbackCount += 1;
              }
            }

            if (!bucketSizeMs && typeof serverBucketSize === 'number' && serverBucketSize > 0) {
              bucketSizeMs = serverBucketSize;
            }

            if (Array.isArray(intervals)) {
              intervals.forEach((interval) => {
                const startedAt = interval.startedAt;
                const endedAt = typeof interval.endedAt === 'number' ? interval.endedAt : end;
                incidentsTotal += 1;
                totalDowntimeMs += Math.max(0, endedAt - startedAt);
                incidents.push({ startedAt, endedAt });
              });
            }

            if (Array.isArray(buckets)) {
              buckets.forEach((bucket) => {
                const bucketStart = bucket.bucketStart;
                const count = Number(bucket.sampleCount || 0);
                const avgResponseTime = Number(bucket.avgResponseTime || 0);
                const current = responseTimeAggregate.get(bucketStart) ?? { sum: 0, count: 0 };
                responseTimeAggregate.set(bucketStart, {
                  sum: current.sum + avgResponseTime * count,
                  count: current.count + count,
                });
              });
            }
          }
        });

        const mergedResponseTimeBuckets = Array.from(responseTimeAggregate.entries())
          .map(([bucketStart, agg]) => ({
            bucketStart,
            avgResponseTime: agg.count > 0 ? agg.sum / agg.count : 0,
            sampleCount: agg.count,
          }))
          .sort((a, b) => a.bucketStart - b.bucketStart);

        const uptimePct = totalDurationMs > 0 ? (onlineDurationMs / totalDurationMs) * 100 : 0;
        setUptimeDisplay(`${uptimePct.toFixed(2)}%`);
        setMetricsError(null);

        const avgResponseTime =
          responseTimeWeightTotal > 0
            ? responseTimeWeightedSum / responseTimeWeightTotal
            : responseTimeFallbackCount > 0
              ? responseTimeFallbackSum / responseTimeFallbackCount
              : null;
        if (avgResponseTime && avgResponseTime > 0) {
          setAvgResponseTimeDisplay(formatAvgResponseTime(avgResponseTime));
          setAvgResponseTimeError(null);
        } else {
          setAvgResponseTimeDisplay('—');
          setAvgResponseTimeError(null);
        }

        setIncidentsDisplay(String(incidentsTotal));
        setDowntimeDisplay(formatDuration(totalDowntimeMs));
        // Keep intervals for charting
        const finalized = incidents
          .filter((i) => typeof i.startedAt === 'number' && typeof i.endedAt === 'number')
          .map((i) => ({ startedAt: i.startedAt, endedAt: i.endedAt as number }));
        setIncidentIntervals(finalized);
        setSelectedSiteCount(selectedIds.length);
        setResponseTimeBuckets(mergedResponseTimeBuckets);
        setReportBucketSizeMs(bucketSizeMs);

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
          const input: ScoreInputs = {
            windowStart: start,
            windowEnd: end,
            checkConfigs: checkConfigsForSelected,
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
        setAvgResponseTimeError('Failed to load response time');
        setAvgResponseTimeDisplay('—');
      } finally {
        setMetricsLoading(false);
      }
    };

    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, selectedCheckIdsKey, timeRange, calendarDateRange, getStartEnd]);

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
        helpText: incidentsError
          ? incidentsError
          : (isAllWebsites ? 'Select a single website to compute incidents' : 'Times the site was offline'),
      },
      {
        key: 'downtime',
        label: 'Total Downtime',
        value: downtimeError ? '—' : downtimeDisplay,
        helpText: downtimeError
          ? downtimeError
          : (isAllWebsites ? 'Select a single website to compute downtime' : 'Sum of offline durations'),
      },
      {
        key: 'mtbi',
        label: 'MTBI',
        value: mtbiError ? '—' : mtbiDisplay,
        helpText: mtbiError
          ? mtbiError
          : (isAllWebsites ? 'Select a single website to compute MTBI' : 'Mean Time Between Incidents'),
      },
      {
        key: 'reliability',
        label: 'ORS',
        value: reliabilityError ? '—' : reliabilityDisplay,
        helpText: reliabilityError
          ? reliabilityError
          : (isAllWebsites ? 'Select a single website to compute ORS' : 'Operational Reliability Score'),
      },
      {
        key: 'responseTime',
        label: 'Avg Response',
        value: avgResponseTimeError ? '—' : avgResponseTimeDisplay,
        helpText: avgResponseTimeError ? avgResponseTimeError : 'Average response time across all checks',
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
      avgResponseTimeDisplay,
      avgResponseTimeError,
      isAllWebsites,
    ]
  );

  const hasResponseTimeBuckets = React.useMemo(
    () => responseTimeBuckets.some((bucket) => bucket.sampleCount > 0 || bucket.avgResponseTime > 0),
    [responseTimeBuckets]
  );

  // Build incidents/uptime chart data
  const chartData = React.useMemo(() => {
    if (isAllWebsites) return [] as ChartDataPoint[];
    const { start, end } = getStartEnd();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return [] as ChartDataPoint[];
    }

    const isAllTimeRange = timeRange === 'all' && !calendarDateRange?.from && !calendarDateRange?.to;
    let effectiveStart = start;

    if (isAllTimeRange) {
      let earliest = Infinity;
      for (const interval of incidentIntervals) {
        if (Number.isFinite(interval.startedAt) && interval.startedAt > 0) {
          earliest = Math.min(earliest, interval.startedAt);
        }
      }
      for (const bucket of responseTimeBuckets) {
        if (Number.isFinite(bucket.bucketStart) && bucket.bucketStart > 0) {
          earliest = Math.min(earliest, bucket.bucketStart);
        }
      }

      if (!Number.isFinite(earliest)) {
        return [] as ChartDataPoint[];
      }

      if (earliest > effectiveStart) {
        effectiveStart = earliest;
      }
    }

    const spanMs = end - effectiveStart;
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const week = 7 * day;

    const bucketSize = reportBucketSizeMs ?? (spanMs <= 36 * hour ? hour : spanMs <= 14 * day ? day : spanMs <= 180 * day ? week : 30 * day);

    const buckets: Array<{ t: number; label: string; incidents: number; downtimeMs: number }> = [];
    const labelFor = (t: number) => {
      const d = new Date(t);
      if (bucketSize === hour) return d.toLocaleTimeString([], { hour: '2-digit' });
      if (bucketSize === day) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const alignedStart = Math.floor(effectiveStart / bucketSize) * bucketSize;
    for (let t = alignedStart; t < end; t += bucketSize) {
      buckets.push({ t, label: labelFor(t), incidents: 0, downtimeMs: 0 });
    }

    // Count incidents and downtime overlap per bucket
    for (const interval of incidentIntervals) {
      const s = Math.max(interval.startedAt, effectiveStart);
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

    const responseTimeByBucket = new Map(
      responseTimeBuckets.map((bucket) => [bucket.bucketStart, bucket.avgResponseTime])
    );

    return buckets.map((b) => {
      const downtimeMin = Math.round(b.downtimeMs / 60000);
      const denom = bucketSize * Math.max(1, selectedSiteCount);
      const uptimePct = denom > 0 ? Math.max(0, 100 - (b.downtimeMs / denom) * 100) : 100;
      const avgResponseTime = responseTimeByBucket.get(b.t);
      return { 
        label: b.label, 
        incidents: b.incidents, 
        downtimeMin, 
        uptimePct: Number(uptimePct.toFixed(2)),
        avgResponseTime: typeof avgResponseTime === 'number' ? Number(avgResponseTime.toFixed(0)) : null
      };
    });
  }, [
    incidentIntervals,
    selectedSiteCount,
    responseTimeBuckets,
    reportBucketSizeMs,
    getStartEnd,
    isAllWebsites,
    timeRange,
    calendarDateRange,
  ]);

  return (
    <PageContainer>
      <PageHeader 
        title="Reports" 
        description="Aggregated uptime and reliability metrics"
        icon={BarChart3}
      />

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
          websitePlaceholder="Select website"
          loading={false}
          canExport={false}
          variant="full"
          layout={isMobile ? 'stacked' : 'inline'}
          stackedOrder={['website', 'timeRange', 'dateRange']}
        />
      </div>

      {/* Metrics */}
      <div className="mt-6 p-4 sm:p-6 relative">
        {!websiteFilter && (
          <div className="mb-6">
            <GlowCard className="p-0">
              <div className="m-1">
                <div className={`${glass('primary')} border border-border/50 rounded-lg p-4`}>
                  <div className="py-6 text-center">
                    <p className="text-base sm:text-lg font-semibold tracking-tight">
                      Select a website to load reports
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Choose a site from the filter above to start fetching metrics.
                    </p>
                  </div>
                </div>
              </div>
            </GlowCard>
          </div>
        )}

        {/* Loading Banner - always rendered, positioned absolutely to not affect layout */}
        <div 
          className={`absolute top-0 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${
            metricsLoading 
              ? 'opacity-100 translate-y-0 pointer-events-auto' 
              : 'opacity-0 -translate-y-2 pointer-events-none'
          }`}
        >
          <div className={`${glass('primary')} border border-border/50 rounded-lg p-4 flex items-center gap-3 shadow-lg max-w-md`}>
            <Spinner size="sm" />
            <div className="flex-1">
              <p className="text-sm font-medium">Crunching data...</p>
              <p className="text-xs text-muted-foreground">
                {isLongRange ? 'Large date ranges can take a minute or two.' : 'Analyzing check history and computing metrics'}
              </p>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
          {metricsLoading ? (
            // Show skeleton loaders while loading
            Array.from({ length: 6 }).map((_, index) => (
              <GlowCard key={`skeleton-${index}`} className="p-0">
                <div className="m-1">
                  <CardHeader className="space-y-0 pb-2">
                    <Skeleton className="h-4 w-20" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-16 mb-2" />
                    <Skeleton className="h-3 w-full" />
                  </CardContent>
                </div>
              </GlowCard>
            ))
          ) : (
            metrics.map((m) => {
              const card = (
                <GlowCard key={m.key} magic={m.key === 'reliability'} className={`relative overflow-hidden p-0 ${m.key === 'reliability' ? 'cursor-pointer border-2 border-dashed border-amber-500/50' : ''}`}>
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
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-medium text-white">{m.label}</CardTitle>
                          <Badge variant="outline" className="border-amber-500/50 text-amber-500 bg-amber-500/10 text-[10px] px-1.5 py-0 h-4">
                            Experimental
                          </Badge>
                        </div>
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
                    <TooltipContent className={`max-w-md ${glass('primary')}`} sideOffset={8}>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Operational Reliability Score (0–10)</p>
                        <p className="text-xs text-muted-foreground">
                          Combines availability (A), frequency (F), and recovery (R) factors.
                        </p>
                        <div className="text-xs font-mono bg-background/50 rounded p-2 space-y-1">
                          <div>S_base = A^0.6 × F^0.2 × R^0.2</div>
                          <div>ORS = 10 × S_base × (0.5 + 0.5 × K)</div>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <div>• A: Availability (downtime penalty)</div>
                          <div>• F: Frequency factor = 1/(1 + n/3)</div>
                          <div>• R: Recovery factor = max(0, 1 - MTTR/60min)</div>
                          <div>• K: Confidence (based on check frequency)</div>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return card;
            })
          )}
        </div>
        {/* Incidents Over Time Chart */}
        <div className="mt-12">
          <GlowCard className="pt-4 pb-4">
            <CardContent className={`${isMobile ? 'p-1' : 'p-2'}`}>
              {/* Fixed height container to prevent layout shift */}
              <div className={`${isMobile ? 'aspect-[4/3]' : 'aspect-[16/7]'} relative`}>
                {/* Skeleton loader - always rendered but faded out when loaded */}
                <div 
                  className={`absolute inset-0 transition-opacity duration-300 ${
                    metricsLoading ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  {/* Chart structure skeleton */}
                  <div className="absolute inset-0 flex flex-col">
                    {/* Legend skeleton */}
                    <div className={`flex items-center justify-center ${isMobile ? 'flex-wrap gap-2 mb-2' : 'gap-4 mb-4'} px-2`}>
                      {['Incidents', 'Downtime', 'Uptime', 'Response Time'].map((_, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Skeleton className="h-2.5 w-2.5 rounded-full" />
                          <Skeleton className={`h-3 ${isMobile ? 'w-12' : 'w-16'}`} />
                        </div>
                      ))}
                    </div>
                    
                    {/* Chart area with grid skeleton */}
                    <div className="flex-1 relative">
                      {/* Y-axis labels skeleton */}
                      <div className={`absolute left-0 top-0 bottom-0 ${isMobile ? 'w-8' : 'w-12'} flex flex-col justify-between py-2`}>
                        {Array.from({ length: 5 }).map((_, idx) => (
                          <Skeleton key={idx} className={`h-3 ${isMobile ? 'w-6' : 'w-8'}`} />
                        ))}
                      </div>
                      
                      {/* Grid lines and data area skeleton */}
                      <div className={`${isMobile ? 'ml-8' : 'ml-12'} h-full relative`}>
                        {/* Grid lines */}
                        <div className="h-full flex flex-col justify-between">
                          {Array.from({ length: 5 }).map((_, idx) => (
                            <div key={idx} className="w-full border-t border-dashed border-border/20" />
                          ))}
                        </div>
                        
                        {/* Animated data lines skeleton */}
                        <div className="absolute inset-0 opacity-30">
                          {Array.from({ length: 4 }).map((_, lineIdx) => (
                            <svg
                              key={lineIdx}
                              className="w-full h-full"
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                              style={{
                                animation: `pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`,
                                animationDelay: `${lineIdx * 0.15}s`,
                              }}
                            >
                              <path
                                d="M 0,85 Q 20,65 40,45 T 80,25 Q 90,20 100,15"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeDasharray="3 3"
                                className="text-muted-foreground"
                              />
                            </svg>
                          ))}
                        </div>
                      </div>
                      
                      {/* X-axis labels skeleton */}
                      <div className={`absolute bottom-0 ${isMobile ? 'left-8' : 'left-12'} right-0 flex justify-between px-1`}>
                        {Array.from({ length: 5 }).map((_, idx) => (
                          <Skeleton key={idx} className={`h-3 ${isMobile ? 'w-8' : 'w-12'}`} />
                        ))}
                      </div>
                    </div>
                    
                    {/* Subtle loading indicator */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className={`${glass('primary')} border border-border/50 rounded-lg px-3 py-1.5 flex items-center gap-2 backdrop-blur-sm transition-opacity duration-300 ${
                        metricsLoading ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <Spinner size="sm" />
                        <span className="text-xs text-muted-foreground">Loading data...</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Actual chart - always rendered but faded in when loaded */}
                <div 
                  className={`absolute inset-0 transition-opacity duration-300 ${
                    metricsLoading ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
                  }`}
                >
                  {isAllWebsites ? (
                    <div className="h-full flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">Select a single website to see charts</p>
                    </div>
                  ) : chartData.length === 0 ? (
                    <div className="h-full flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">No data available for the selected time range</p>
                    </div>
                  ) : (
                    <ChartContainer
                      config={{
                        incidents: { label: 'Incidents', color: 'oklch(0.65 0.25 25)' },
                        downtime: { label: 'Downtime (min)', color: 'oklch(0.60 0.18 280)' },
                        uptime: { label: 'Uptime %', color: 'oklch(0.62 0.09 231)' },
                        responseTime: { label: 'Response Time (ms)', color: 'oklch(0.70 0.20 120)' },
                      }}
                      className="h-full w-full bg-transparent"
                    >
                      <Recharts.LineChart 
                        data={chartData} 
                        margin={{ 
                          left: isMobile ? 10 : 5, 
                          right: isMobile ? 10 : 5, 
                          bottom: isMobile ? 20 : 0, 
                          top: isMobile ? 20 : 10 
                        }}
                      >
                        <Recharts.CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
                        <Recharts.XAxis 
                          dataKey="label" 
                          tick={{ fontSize: isMobile ? 10 : 12 }}
                          interval={isMobile ? 'preserveStartEnd' : 0}
                        />
                        <Recharts.YAxis 
                          yAxisId="left" 
                          orientation="left" 
                          tick={{ fontSize: isMobile ? 10 : 12 }}
                          width={isMobile ? 40 : 60}
                        />
                        <Recharts.YAxis 
                          yAxisId="right" 
                          orientation="right" 
                          domain={[0, 100]} 
                          tickFormatter={(v: number) => `${v}%`} 
                          tick={{ fontSize: isMobile ? 10 : 12 }}
                          width={isMobile ? 40 : 60}
                        />
                        {hasResponseTimeBuckets && (
                          <Recharts.YAxis 
                            yAxisId="responseTime" 
                            orientation="right" 
                            domain={[0, 'dataMax']} 
                            tickFormatter={(v: number) => `${v}ms`} 
                            tick={{ fontSize: isMobile ? 10 : 12 }}
                            width={isMobile ? 40 : 60}
                            offset={isMobile ? 80 : 120}
                          />
                        )}
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <ChartLegend content={<ChartLegendContent /> as any} />
                        <Recharts.Line 
                          dataKey="incidents" 
                          name="Incidents" 
                          yAxisId="left" 
                          type="monotone" 
                          stroke="var(--color-incidents)" 
                          dot={false} 
                          strokeWidth={isMobile ? 3 : 2} 
                        />
                        <Recharts.Line 
                          dataKey="downtimeMin" 
                          name="Downtime (min)" 
                          yAxisId="left" 
                          type="monotone" 
                          stroke="var(--color-downtime)" 
                          dot={false} 
                          strokeWidth={isMobile ? 3 : 2} 
                        />
                        <Recharts.Line 
                          dataKey="uptimePct" 
                          name="Uptime %" 
                          yAxisId="right" 
                          type="monotone" 
                          stroke="var(--color-uptime)" 
                          dot={false} 
                          strokeWidth={isMobile ? 3 : 2} 
                        />
                        {hasResponseTimeBuckets && (
                          <Recharts.Line 
                            dataKey="avgResponseTime" 
                            name="Response Time (ms)" 
                            yAxisId="responseTime" 
                            type="monotone" 
                            stroke="var(--color-responseTime)" 
                            dot={false} 
                            strokeWidth={isMobile ? 3 : 2} 
                          />
                        )}
                      </Recharts.LineChart>
                    </ChartContainer>
                  )}
                </div>
              </div>
            </CardContent>
          </GlowCard>
        </div>
      </div>
    </PageContainer>
  );
};

export default Reports;
