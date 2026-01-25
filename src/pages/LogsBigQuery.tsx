import React, { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { type DateRange } from "react-day-picker"
import { useNavigate, useSearchParams } from 'react-router-dom';

import { List, FileText, FileSpreadsheet, Check, Info, X, Plus } from 'lucide-react';

import { Button, FilterBar, StatusBadge, Badge, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, GlowCard, ScrollArea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Alert, AlertDescription, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, Spinner } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import SlideOut from '../components/ui/slide-out';
import { Database } from 'lucide-react';
import { formatResponseTime } from '../utils/formatters.tsx';
import type { CheckHistory, ManualLogEntry } from '../api/types';
import { apiClient } from '../api/client';
import { useChecks } from '../hooks/useChecks';
import { useMobile } from '../hooks/useMobile';
import { getTableHoverColor } from '../lib/utils';
import { useHorizontalScroll } from '../hooks/useHorizontalScroll';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useDebounce } from '../hooks/useDebounce';
import { LogDetailsSheet } from '../components/logs/LogDetailsSheet';
import { ColumnControls, type ColumnConfig } from '../components/logs/ColumnControls';
import { LogsSkeleton } from '../components/logs/LogsSkeleton';
import { LogsEmptyState } from '../components/logs/LogsEmptyState';
import { highlightSearchTerm } from '../utils/searchHighlight';

interface LogEntry {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteUrl: string;
  time: string;
  date: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled';
  statusCode?: number;
  responseTime?: number;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  error?: string;
  timestamp: number;
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
  isManual?: boolean;
  manualMessage?: string;
}

const SLOW_STAGE_THRESHOLDS_MS = {
  dnsMs: 3000,
  connectMs: 4000,
  tlsMs: 4000,
  ttfbMs: 4000,
} as const;

type SlowStageLabel = 'DNS' | 'CONNECT' | 'TLS' | 'TTFB';

type ManualLogStatus = 'online' | 'offline' | 'unknown' | 'disabled';

const SLOW_STAGE_STYLES: Record<SlowStageLabel, string> = {
  DNS: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  CONNECT: 'border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  TLS: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  TTFB: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
};

const getSlowStageTags = (entry: LogEntry) => {
  const stages: Array<{ label: SlowStageLabel; value?: number; threshold: number }> = [
    { label: 'DNS', value: entry.dnsMs, threshold: SLOW_STAGE_THRESHOLDS_MS.dnsMs },
    { label: 'CONNECT', value: entry.connectMs, threshold: SLOW_STAGE_THRESHOLDS_MS.connectMs },
    { label: 'TLS', value: entry.tlsMs, threshold: SLOW_STAGE_THRESHOLDS_MS.tlsMs },
    { label: 'TTFB', value: entry.ttfbMs, threshold: SLOW_STAGE_THRESHOLDS_MS.ttfbMs },
  ];

  return stages
    .filter(stage => typeof stage.value === 'number' && stage.value > stage.threshold)
    .map(stage => ({
      label: stage.label,
      value: stage.value as number,
      className: SLOW_STAGE_STYLES[stage.label],
    }));
};

const formatLocalDateTimeValue = (timestamp: number) => {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const LogsBigQuery: React.FC = () => {
  const { userId } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const log = React.useCallback(
    (msg: string) => console.log(`[LogsBigQuery] ${msg}`),
    []
  );
  
  // Use non-realtime mode to reduce Firestore reads - Logs page only needs the checks list for the dropdown
  const { checks, loading: checksLoading } = useChecks(userId ?? null, log, { realtime: false });
  // < 1024px stacks filter bar; < 768px hides column controls; < 500px simplifies status/pagination
  const isUnderLg = useMobile();
  const isMdDown = useMobile(768);
  const isVerySmall = useMobile(500);
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();
  
  // localStorage persistence
  const [websiteFilter, setWebsiteFilter] = useLocalStorage<string>('logs-website-filter', '');
  
  // Handle URL parameter for deep linking (e.g., from email alerts)
  useEffect(() => {
    const checkIdFromUrl = searchParams.get('check');
    if (checkIdFromUrl && checks && checks.length > 0) {
      // Validate that the check exists before setting it
      const checkExists = checks.some(c => c.id === checkIdFromUrl);
      if (checkExists) {
        setWebsiteFilter(checkIdFromUrl);
        // Clear the URL parameter after applying it
        setSearchParams({}, { replace: true });
      }
    }
  }, [searchParams, checks, setWebsiteFilter, setSearchParams]);
  
  const allowedTimeRanges = React.useMemo(() => ['1h', '24h', '7d', '30d'] as ('1h' | '24h' | '7d' | '30d')[], []);
  const [dateRange, setDateRange] = useLocalStorage<'1h' | '24h' | '7d' | '30d'>('logs-date-range', '1h');
  const [statusFilter, setStatusFilter] = useLocalStorage<'all' | 'online' | 'offline' | 'unknown' | 'disabled'>('logs-status-filter', 'all');
  const [columnVisibility, setColumnVisibility] = useLocalStorage<Record<string, boolean>>('logs-column-visibility', {
    website: true,
    time: true,
    status: true,
    responseTime: true,
    statusCode: true,
    target: true
  });
  const selectedCheck = React.useMemo(() => {
    if (!checks || !websiteFilter || websiteFilter === 'all') return null;
    return checks.find((check) => check.id === websiteFilter) ?? null;
  }, [checks, websiteFilter]);
  
  // Column configuration
  const columnConfig: ColumnConfig[] = [
    { key: 'website', label: 'Website', visible: columnVisibility.website },
    { key: 'time', label: 'Time', visible: columnVisibility.time },
    { key: 'status', label: 'Status', visible: columnVisibility.status },
    { key: 'responseTime', label: 'Response Time', visible: columnVisibility.responseTime },
    { key: 'statusCode', label: 'Status Code', visible: columnVisibility.statusCode },
    { key: 'target', label: 'Target', visible: columnVisibility.target }
  ];

  const manualLogStatusOptions: Array<{ value: ManualLogStatus; label: string }> = [
    { value: 'unknown', label: 'Unknown' },
    { value: 'online', label: 'Online' },
    { value: 'offline', label: 'Offline' },
    { value: 'disabled', label: 'Paused' }
  ];
  
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [manualLogs, setManualLogs] = useState<ManualLogEntry[]>([]);
  const [manualLogsLoading, setManualLogsLoading] = useState(false);
  const [manualLogsError, setManualLogsError] = useState<string | null>(null);
  // Use skeleton as the only loading indicator
  const [isDataReady, setIsDataReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const [lastDataUpdate, setLastDataUpdate] = useState<number>(0);
  const [isUpdating] = useState<boolean>(false);
  // Progressive row reveal (perceived performance)
  const [visibleRowCount, setVisibleRowCount] = useState<number>(0);
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  
  // Row details state
  const [selectedLogEntry, setSelectedLogEntry] = useState<LogEntry | null>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [detailsDefaultTab, setDetailsDefaultTab] = useState<'comment' | 'details' | 'raw'>('details');
  const [autoFocusTextarea, setAutoFocusTextarea] = useState(false);

  const [isManualLogOpen, setIsManualLogOpen] = useState(false);
  const [manualLogMessage, setManualLogMessage] = useState('');
  const [manualLogTimestamp, setManualLogTimestamp] = useState(() => formatLocalDateTimeValue(Date.now()));
  const [manualLogStatus, setManualLogStatus] = useState<ManualLogStatus>('unknown');
  const [manualLogSaving, setManualLogSaving] = useState(false);
  const [manualLogSaveError, setManualLogSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isManualLogOpen) return;
    setManualLogMessage('');
    setManualLogTimestamp(formatLocalDateTimeValue(Date.now()));
    setManualLogStatus('unknown');
    setManualLogSaveError(null);
  }, [isManualLogOpen]);
  
  // New enhanced features
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');

  // Dismiss state for data retention alert
  const [isDataRetentionAlertDismissed, setIsDataRetentionAlertDismissed] = useLocalStorage<boolean>('logs-data-retention-alert-dismissed', false);

  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage] = useState<number>(25);
  const filtersKey = React.useMemo(() => {
    return [
      websiteFilter,
      statusFilter,
      debouncedSearchTerm,
      dateRange,
      customStartDate,
      customEndDate
    ].join('|');
  }, [websiteFilter, statusFilter, debouncedSearchTerm, dateRange, customStartDate, customEndDate]);
  const lastFiltersKeyRef = React.useRef<string>('');
  
  // Date range for calendar
  const [calendarDateRange, setCalendarDateRange] = useState<DateRange | undefined>(undefined);

  useEffect(() => {
    if (!allowedTimeRanges.includes(dateRange)) {
      setDateRange('1h');
    }
  }, [allowedTimeRanges, dateRange, setDateRange]);
  
  // Handle calendar date range change
  const handleCalendarDateRangeChange = (range: DateRange | undefined) => {
    setCalendarDateRange(range);
    if (range?.from && range?.to) {
      setCustomStartDate(range.from.toISOString().split('T')[0]);
      setCustomEndDate(range.to.toISOString().split('T')[0]);
    } else if (!range) {
      setCustomStartDate('');
      setCustomEndDate('');
    }
  };
  
  // Pagination state
  const [totalPages, setTotalPages] = useState<number>(0);
  const [totalLogs, setTotalLogs] = useState<number>(0);
  
  // Cache for paginated data (only cache current page)
  const [pageCache, setPageCache] = useState<Map<string, { data: LogEntry[], timestamp: number, page: number }>>(new Map());
  const [lastEventByWebsite, setLastEventByWebsite] = useState<Map<string, { timestamp: number | null; fetchedAt: number; status: 'ok' | 'error' }>>(new Map());
  const selectedLastEvent = React.useMemo(() => {
    if (!selectedCheck) return undefined;
    return lastEventByWebsite.get(selectedCheck.id);
  }, [lastEventByWebsite, selectedCheck]);
  
  // Export modal state
  const [showExportModal, setShowExportModal] = useState(false);
  const [selectedExportFormat, setSelectedExportFormat] = useState<'csv' | 'excel'>('csv');
  
  // Tiered cache configuration - aggressive cost optimization
  const CACHE_DURATION = {
    PAGE_1: 2 * 60 * 1000,           // 2 minutes for latest logs (page 1)
    PAGES_2_3: 5 * 60 * 1000,        // 5 minutes for recent pages (2-3)
    PAGES_4_10: 15 * 60 * 1000,      // 15 minutes for older pages (4-10)
    PAGES_10_PLUS: 60 * 60 * 1000    // 1 hour for very old pages (10+)
  };
  const LAST_EVENT_CACHE_MS = 10 * 60 * 1000;

  // Helper function to get cache duration based on page number
  const getCacheDuration = (page: number): number => {
    if (page === 1) return CACHE_DURATION.PAGE_1;
    if (page <= 3) return CACHE_DURATION.PAGES_2_3;
    if (page <= 10) return CACHE_DURATION.PAGES_4_10;
    return CACHE_DURATION.PAGES_10_PLUS;
  };

  // Helper function to get cache tier description
  const getCacheTierDescription = (page: number): string => {
    if (page === 1) return '2min cache';
    if (page <= 3) return '5min cache';
    if (page <= 10) return '15min cache';
    return '1hour cache';
  };

  const fetchLastEventTimestamp = React.useCallback(async (websiteId: string) => {
    if (!websiteId) return;
    const now = Date.now();
    const cached = lastEventByWebsite.get(websiteId);
    if (cached && (now - cached.fetchedAt) < LAST_EVENT_CACHE_MS) return;

    const response = await apiClient.getCheckHistoryBigQuery(
      websiteId,
      1,
      1,
      '',
      'all'
    );

    if (response.success && response.data) {
      const timestamp = response.data.data[0]?.timestamp ?? null;
      setLastEventByWebsite(prev => new Map(prev).set(websiteId, {
        timestamp,
        fetchedAt: now,
        status: 'ok'
      }));
      return;
    }

    setLastEventByWebsite(prev => new Map(prev).set(websiteId, {
      timestamp: cached?.timestamp ?? null,
      fetchedAt: now,
      status: 'error'
    }));
  }, [LAST_EVENT_CACHE_MS, lastEventByWebsite]);

  // Calculate date range based on selection
  const getDateRange = () => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    // If custom range is set, use it
    if (customStartDate && customEndDate) {
      const startTs = new Date(customStartDate + 'T00:00:00').getTime();
      const endTs = new Date(customEndDate + 'T23:59:59').getTime();
      if (!Number.isNaN(startTs) && !Number.isNaN(endTs)) {
        return { start: startTs, end: endTs };
      }
    }

    switch (dateRange) {
      case '1h':
        return { start: now - (60 * 60 * 1000), end: now };
      case '24h':
        return { start: now - oneDay, end: now };
      case '7d':
        return { start: now - (7 * oneDay), end: now };
      case '30d':
        return { start: now - (30 * oneDay), end: now };
      default:
        return { start: now - (60 * 60 * 1000), end: now };
    }
  };

  // Column visibility handlers
  const handleColumnToggle = (key: string) => {
    setColumnVisibility(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  // Row details handlers
  const handleRowClick = (entry: LogEntry) => {
    setSelectedLogEntry(entry);
    setDetailsDefaultTab('details');
    setAutoFocusTextarea(false);
    setIsDetailsOpen(true);
  };

  const handleAddLogEntry = (e: React.MouseEvent, entry: LogEntry) => {
    e.stopPropagation(); // Prevent row click
    setSelectedLogEntry(entry);
    setDetailsDefaultTab('comment');
    setAutoFocusTextarea(true);
    setIsDetailsOpen(true);
  };

  const handleCreateManualLog = async () => {
    if (!selectedCheck || manualLogSaving) return;

    const trimmed = manualLogMessage.trim();
    if (!trimmed) {
      setManualLogSaveError('Message is required.');
      return;
    }

    const parsedTimestamp = manualLogTimestamp ? new Date(manualLogTimestamp).getTime() : Date.now();
    const timestamp = Number.isNaN(parsedTimestamp) ? Date.now() : parsedTimestamp;

    setManualLogSaving(true);
    setManualLogSaveError(null);

    const response = await apiClient.addManualLog(
      selectedCheck.id,
      trimmed,
      timestamp,
      manualLogStatus
    );

    if (response.success && response.data) {
      setManualLogs((prev) =>
        [response.data!, ...prev].sort((a, b) => b.timestamp - a.timestamp)
      );
      setIsManualLogOpen(false);
      setManualLogSaving(false);
      return;
    }

    setManualLogSaveError(response.error || 'Failed to create manual log.');
    setManualLogSaving(false);
  };

  // Fetch logs for current page with caching
  const fetchLogs = async (forceRefresh = false) => {
    if (!websiteFilter || websiteFilter === 'all') return;
    
    setError(null);

    // Wait for websites ("checks") to be loaded before validating websiteFilter.
    // Otherwise we can incorrectly clear the persisted filter on initial page load.
    if (checksLoading) return;
    if (!checks || checks.length === 0) {
      setWebsiteFilter('');
      setIsDataReady(true);
      return;
    }
    
    // Validate that the selected website still exists
    const website = checks?.find(w => w.id === websiteFilter);
    if (!website) {
      // Website was deleted, clear the filter and select first available
      if (checks && checks.length > 0) {
        setWebsiteFilter(checks[0].id);
      } else {
        setWebsiteFilter('');
      }
      setIsDataReady(true);
      return;
    }
    
    try {
      const now = Date.now();
      const dateRangeObj = getDateRange();
      const cacheKey = `${websiteFilter}-${currentPage}-${statusFilter}-${debouncedSearchTerm}-${dateRange}-${customStartDate}-${customEndDate}`;
      // Opportunistic cache cleanup (no background intervals)
      setPageCache(prev => {
        const newCache = new Map<string, { data: LogEntry[], timestamp: number, page: number }>();
        for (const [key, cacheEntry] of prev.entries()) {
          const cacheDuration = getCacheDuration(cacheEntry.page);
          if (now - cacheEntry.timestamp < cacheDuration) {
            newCache.set(key, cacheEntry);
          }
        }
        return newCache;
      });

      const cached = pageCache.get(cacheKey);
      
      // Use cache if available and not expired, unless force refresh
      const cacheDuration = getCacheDuration(currentPage);
      if (!forceRefresh && cached && (now - cached.timestamp) < cacheDuration) {
        setLogEntries(cached.data);
        setLastDataUpdate(cached.timestamp);
        setIsDataReady(true);
        return;
      }
      
      // Fetch paginated data from BigQuery with filters
      // includeFullDetails=true to get GEO, DNS/TLS timing, and edge metadata
      const response = await apiClient.getCheckHistoryBigQuery(
        websiteFilter, 
        currentPage, 
        itemsPerPage, 
        debouncedSearchTerm, 
        statusFilter,
        dateRangeObj.start,
        dateRangeObj.end,
        true // includeFullDetails - fetch all columns for log detail views
      );
      
      if (response.success && response.data) {
        const websiteLogs = response.data.data.map((entry: CheckHistory) => ({
          id: entry.id,
          websiteId: website.id,
          websiteName: website.name,
          websiteUrl: website.url,
          time: new Date(entry.timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          }),
          date: new Date(entry.timestamp).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          }),
          status: entry.status as LogEntry['status'],
          statusCode: entry.statusCode,
          responseTime: entry.responseTime,
          dnsMs: entry.dnsMs,
          connectMs: entry.connectMs,
          tlsMs: entry.tlsMs,
          ttfbMs: entry.ttfbMs,
          error: entry.error,
          timestamp: entry.timestamp,
          targetHostname: entry.targetHostname,
          targetIp: entry.targetIp,
          targetIpsJson: entry.targetIpsJson,
          targetIpFamily: entry.targetIpFamily,
          targetCountry: entry.targetCountry,
          targetRegion: entry.targetRegion,
          targetCity: entry.targetCity,
          targetLatitude: entry.targetLatitude,
          targetLongitude: entry.targetLongitude,
          targetAsn: entry.targetAsn,
          targetOrg: entry.targetOrg,
          targetIsp: entry.targetIsp,
          cdnProvider: entry.cdnProvider,
          edgePop: entry.edgePop,
          edgeRayId: entry.edgeRayId,
          edgeHeadersJson: entry.edgeHeadersJson,
        }));
        
        // Update pagination state - handle cost-optimized response (no total count)
        // If total is -1, we don't have a count (cost optimization) - estimate from hasNext
        const hasNextPage = response.data.pagination.hasNext;
        const actualTotal = response.data.pagination.total;
        if (actualTotal === -1) {
          // No total count - use cursor-based pagination
          // Estimate totalPages based on current page + hasNext
          setTotalPages(hasNextPage ? currentPage + 1 : currentPage);
          setTotalLogs(-1); // -1 indicates unknown
        } else {
          setTotalPages(response.data.pagination.totalPages);
          setTotalLogs(actualTotal);
        }
        
        // Update cache for this page with filters
        setPageCache(prev => new Map(prev).set(cacheKey, {
          data: websiteLogs,
          timestamp: now,
          page: currentPage
        }));
        
        setLogEntries(websiteLogs);
        setLastDataUpdate(now);
        setIsDataReady(true);
      } else {
        // Handle API error response
        const errorMessage = response.error || 'Failed to fetch logs from BigQuery';
        
        // If website not found, clear the filter
        if (errorMessage.includes('not found') || errorMessage.includes('Website not found')) {
          if (checks && checks.length > 0) {
            setWebsiteFilter(checks[0].id);
          } else {
            setWebsiteFilter('');
          }
        } else {
          setError(errorMessage);
        }
        setIsDataReady(true);
      }
    } catch (err) {
      console.error('Error fetching BigQuery logs:', err);
      setError('Failed to fetch logs from BigQuery');
      setIsDataReady(true);
    }
  };

  const fetchManualLogs = async () => {
    if (!websiteFilter || websiteFilter === 'all') {
      setManualLogs([]);
      setManualLogsError(null);
      setManualLogsLoading(false);
      return;
    }

    if (checksLoading) return;

    setManualLogsLoading(true);
    setManualLogsError(null);

    try {
      const dateRangeObj = getDateRange();
      const response = await apiClient.getManualLogs(
        websiteFilter,
        dateRangeObj.start,
        dateRangeObj.end
      );

      if (response.success && response.data) {
        setManualLogs(response.data);
      } else {
        setManualLogs([]);
        setManualLogsError(response.error || 'Failed to load manual logs');
      }
    } catch (err) {
      console.error('Error fetching manual logs:', err);
      setManualLogs([]);
      setManualLogsError('Failed to load manual logs');
    } finally {
      setManualLogsLoading(false);
    }
  };

  // Initial data fetch when website is selected or filters change
  useEffect(() => {
    if (!websiteFilter || checksLoading) return;

    const filtersChanged = lastFiltersKeyRef.current !== '' && lastFiltersKeyRef.current !== filtersKey;
    if (filtersChanged && currentPage !== 1) {
      lastFiltersKeyRef.current = filtersKey;
      setCurrentPage(1);
      return;
    }

    lastFiltersKeyRef.current = filtersKey;
    fetchLogs();
  }, [websiteFilter, checksLoading, currentPage, filtersKey]);

  useEffect(() => {
    if (!websiteFilter || checksLoading) {
      setManualLogs([]);
      setManualLogsLoading(false);
      setManualLogsError(null);
      return;
    }
    fetchManualLogs();
  }, [websiteFilter, checksLoading, dateRange, customStartDate, customEndDate]);

  // Prevent brief empty-state flash: set loading immediately on filter changes
  useEffect(() => {
    if (!checksLoading && websiteFilter && websiteFilter !== 'all') {
      setIsDataReady(false);
    }
  }, [checksLoading, websiteFilter, currentPage, statusFilter, debouncedSearchTerm, dateRange, customStartDate, customEndDate]);

  // Ensure checks are loaded before attempting to fetch and auto-select a website if none selected
  useEffect(() => {
    if (checksLoading) return;
    if (!checks || checks.length === 0) {
      // If no checks available, clear the filter
      if (websiteFilter && websiteFilter !== 'all') {
        setWebsiteFilter('');
      }
      return;
    }

    // Validate that the selected website still exists
    if (websiteFilter && websiteFilter !== 'all') {
      const websiteExists = checks.some(w => w.id === websiteFilter);
      if (!websiteExists) {
        // Selected website was deleted, clear and select first available
        setWebsiteFilter(checks[0].id);
        return; // setting websiteFilter will trigger fetch via the other effect
      }
    }

    // Auto-select first website if none selected
    if (!websiteFilter || websiteFilter === 'all') {
      setWebsiteFilter(prev => prev && prev !== 'all' ? prev : checks[0].id);
      return; // setting websiteFilter will trigger fetch via the other effect
    }
  }, [checks]);

  useEffect(() => {
    if (!isDataReady) return;
    if (logEntries.length > 0) return;
    if (!websiteFilter || websiteFilter === 'all') return;
    if (checksLoading) return;
    void fetchLastEventTimestamp(websiteFilter);
  }, [isDataReady, logEntries.length, websiteFilter, checksLoading, fetchLastEventTimestamp]);

  const formatTimeSinceUpdate = (lastUpdate: number) => {
    const seconds = Math.floor((Date.now() - lastUpdate) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  const manualLogEntries = React.useMemo<LogEntry[]>(() => {
    if (!selectedCheck) return [];
    return manualLogs.map((entry) => ({
      id: entry.id,
      websiteId: entry.websiteId,
      websiteName: selectedCheck.name,
      websiteUrl: selectedCheck.url,
      time: new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }),
      date: new Date(entry.timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }),
      status: entry.status as LogEntry['status'],
      timestamp: entry.timestamp,
      isManual: true,
      manualMessage: entry.message
    }));
  }, [manualLogs, selectedCheck]);

  const filteredManualLogs = React.useMemo(() => {
    if (!manualLogEntries.length) return [];
    const term = debouncedSearchTerm.trim().toLowerCase();
    return manualLogEntries.filter((entry) => {
      if (statusFilter !== 'all' && entry.status !== statusFilter) {
        return false;
      }
      if (!term) return true;
      const haystack = [
        entry.manualMessage,
        entry.websiteName,
        entry.websiteUrl,
        entry.status
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [manualLogEntries, debouncedSearchTerm, statusFilter]);

  const visibleColumnCount = [
    columnVisibility.website,
    columnVisibility.time,
    columnVisibility.status,
    columnVisibility.responseTime,
    columnVisibility.statusCode,
    columnVisibility.target
  ].filter(Boolean).length + 1;

  const manualLogCount = filteredManualLogs.length;
  const hasAnyLogs = logEntries.length > 0 || manualLogCount > 0;

  // Pagination logic - now using server-side pagination
  const revealedLogs = logEntries.slice(0, visibleRowCount);

  // Reveal rows from top -> bottom after data is ready
  useEffect(() => {
    if (!isDataReady) {
      setVisibleRowCount(0);
      return;
    }

    if (!logEntries.length) {
      setVisibleRowCount(0);
      return;
    }

    if (prefersReducedMotion) {
      setVisibleRowCount(logEntries.length);
      return;
    }

    setVisibleRowCount(0);
    const batchSize = 1;
    const intervalMs = 50;
    let nextCount = 0;

    const id = window.setInterval(() => {
      nextCount = Math.min(logEntries.length, nextCount + batchSize);
      setVisibleRowCount(nextCount);
      if (nextCount >= logEntries.length) {
        window.clearInterval(id);
      }
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [isDataReady, logEntries, prefersReducedMotion]);

  // Pagination handlers
  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  // Export data to CSV
  const exportToCSV = () => {
    if (!logEntries.length) return;
    
    const headers = ['Status', 'Name', 'URL', 'Date', 'Time', 'Status Code', 'Response Time (ms)', 'Error'];
    const csvContent = [
      headers.join(','),
      ...logEntries.map(entry => [
        entry.status,
        `"${entry.websiteName}"`, // Escape quotes in CSV
        `"${entry.websiteUrl}"`, // Escape quotes in CSV
        entry.date,
        entry.time,
        entry.statusCode || 'N/A',
        entry.responseTime || 'N/A',
        `"${(entry.error || 'N/A').replace(/"/g, '""')}"` // Escape quotes in CSV
      ].join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `website-logs-${websiteFilter}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Export data to Excel (proper XLSX format)
  const exportToExcel = async () => {
    if (!logEntries.length) return;

    // Lazy-load xlsx only when exporting (it's a very large dependency).
    const XLSX = await import('xlsx');
    
    // Prepare data for Excel
    const excelData = logEntries.map(entry => ({
      'Status': entry.status,
      'Name': entry.websiteName,
      'URL': entry.websiteUrl,
      'Date': entry.date,
      'Time': entry.time,
      'Status Code': entry.statusCode || 'N/A',
      'Response Time (ms)': entry.responseTime || 'N/A',
      'Error': entry.error || 'N/A'
    }));
    
    // Create workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    
    // Set column widths for better readability
    const columnWidths = [
      { wch: 12 }, // Status
      { wch: 20 }, // Name
      { wch: 30 }, // URL
      { wch: 12 }, // Date
      { wch: 10 }, // Time
      { wch: 12 }, // Status Code
      { wch: 15 }, // Response Time
      { wch: 40 }  // Error
    ];
    worksheet['!cols'] = columnWidths;
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Website Logs');
    
    // Generate and download file
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `website-logs-${websiteFilter}-${new Date().toISOString().split('T')[0]}.xlsx`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Handle export with format selection
  const handleExport = async () => {
    if (selectedExportFormat === 'csv') {
      exportToCSV();
    } else {
      await exportToExcel();
    }
    setShowExportModal(false);
  };

  // Open export modal
  const openExportModal = () => {
    setShowExportModal(true);
  };

  // Clear filters
  const clearFilters = () => {
    setSearchTerm('');
    setStatusFilter('all');
    setDateRange('1h');
    setCustomStartDate('');
    setCustomEndDate('');
    setCalendarDateRange(undefined);
  };

  const handleOpenChecks = React.useCallback(() => {
    navigate('/checks');
  }, [navigate]);

  // Get status border color
  const getStatusBorderColor = (status: string) => {
    switch (status) {
      case 'online':
      case 'UP':
      case 'REDIRECT':
        return 'border-l-green-500/50';
      case 'offline':
      case 'DOWN':
      case 'REACHABLE_WITH_ERROR':
        return 'border-l-red-500/50';
      case 'disabled':
        return 'border-l-amber-500/50';
      default:
        return 'border-l-yellow-500/50';
    }
  };

  const renderLogRow = (item: LogEntry, index: number, animate: boolean) => {
    const isManual = item.isManual;
    const hoverClass = isManual
      ? getTableHoverColor('info')
      : getTableHoverColor(
        item.status === 'online' || item.status === 'UP' || item.status === 'REDIRECT'
          ? 'success'
          : item.status === 'offline' || item.status === 'DOWN' || item.status === 'REACHABLE_WITH_ERROR'
          ? 'error'
          : 'neutral'
      );
    const slowStages = isManual ? [] : getSlowStageTags(item);
    const hasSlowStages = slowStages.length > 0;
    const rowClasses = [
      hoverClass,
      isManual ? 'border-l-sky-500/60 bg-sky-500/5 dark:bg-sky-500/10' : getStatusBorderColor(item.status),
      hasSlowStages ? 'bg-amber-500/5 dark:bg-amber-500/10' : '',
      'border-l-4 transition-colors group cursor-pointer',
      animate ? 'animate-in fade-in slide-in-from-top-1 duration-500 ease-out' : ''
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <TableRow
        key={`${isManual ? 'manual' : 'check'}-${item.id}`}
        style={animate ? { animationDelay: `${index * 28}ms` } : undefined}
        className={rowClasses}
        onClick={() => handleRowClick(item)}
      >
        {columnVisibility.website && (
          <TableCell className="px-4 py-5">
            <div className="flex flex-col gap-1.5">
              <div className="font-medium text-foreground">
                {highlightSearchTerm(item.websiteName, searchTerm)}
              </div>
              <div className="text-xs font-mono text-muted-foreground truncate max-w-xs">
                {highlightSearchTerm(item.websiteUrl, searchTerm)}
              </div>
            </div>
          </TableCell>
        )}
        {columnVisibility.time && (
          <TableCell className="px-4 py-5">
            <div className="text-sm font-mono text-muted-foreground">{item.time}</div>
            <div className="text-xs font-mono text-muted-foreground">{item.date}</div>
          </TableCell>
        )}
        {columnVisibility.status && (
          <TableCell className="px-4 py-5">
            <StatusBadge status={item.status} />
          </TableCell>
        )}
        {columnVisibility.responseTime && (
          <TableCell className="px-4 py-5">
            {isManual ? (
              <div className="text-xs text-muted-foreground truncate max-w-[240px]">
                {item.manualMessage
                  ? highlightSearchTerm(item.manualMessage, searchTerm)
                  : 'No message'}
              </div>
            ) : (
              <>
                <div className="text-sm font-mono text-muted-foreground">
                  {item.responseTime ? formatResponseTime(item.responseTime) : '-'}
                </div>
                {hasSlowStages && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {slowStages.map(stage => (
                      <Badge
                        key={`${item.id}-${stage.label}`}
                        variant="outline"
                        className={`text-[10px] font-mono leading-none ${stage.className}`}
                      >
                        {stage.label} {formatResponseTime(stage.value)}
                      </Badge>
                    ))}
                  </div>
                )}
              </>
            )}
          </TableCell>
        )}
        {columnVisibility.statusCode && (
          <TableCell className="px-4 py-5">
            <div className="text-sm font-mono text-muted-foreground">{item.statusCode || '-'}</div>
          </TableCell>
        )}
        {columnVisibility.target && (
          <TableCell className="px-4 py-5">
            {isManual ? (
              <div>
                <div className="text-sm font-mono text-muted-foreground">Manual entry</div>
                <div className="text-xs font-mono text-muted-foreground/80">-</div>
              </div>
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="min-w-0 cursor-pointer">
                      <div className="text-sm font-mono text-muted-foreground truncate max-w-[260px]">
                        {item.targetIp || item.targetHostname || '-'}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground/80 truncate max-w-[260px]">
                        {(() => {
                          const parts = [item.targetCity, item.targetRegion, item.targetCountry].filter(Boolean);
                          if (parts.length) return parts.join(', ');
                          if (item.cdnProvider || item.edgePop) return `${item.cdnProvider || 'cdn'}${item.edgePop ? ` ƒ?› ${item.edgePop}` : ''}`;
                          return 'ƒ?"';
                        })()}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="space-y-1 max-w-[360px]">
                      <div className="text-xs font-mono">
                        <span className="text-muted-foreground">IP:</span> {item.targetIp || '-'}
                      </div>
                      <div className="text-xs font-mono">
                        <span className="text-muted-foreground">Geo:</span>{' '}
                        {[item.targetCity, item.targetRegion, item.targetCountry].filter(Boolean).join(', ') || '-'}
                      </div>
                      <div className="text-xs font-mono">
                        <span className="text-muted-foreground">ASN:</span> {item.targetAsn || '-'} {item.targetOrg ? ` ƒ?› ${item.targetOrg}` : ''}
                      </div>
                      <div className="text-xs font-mono">
                        <span className="text-muted-foreground">Edge:</span> {item.cdnProvider || '-'} {item.edgePop ? ` ƒ?› ${item.edgePop}` : ''} {item.edgeRayId ? ` ƒ?› ${item.edgeRayId}` : ''}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </TableCell>
        )}
        <TableCell className="px-4 py-5">
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => handleAddLogEntry(e, item)}
            className="h-8 text-xs"
          >
            Add comment
          </Button>
        </TableCell>
      </TableRow>
    );
  };

  return (
    <PageContainer>
      <PageHeader 
        title="Logs" 
        description="View detailed check history and logs"
        icon={Database}
      />
      
      {/* Data Retention Information Panel */}
      {!isDataRetentionAlertDismissed && (
        <Alert className="mt-4 mb-4 bg-sky-500/10 border-sky-500/20 backdrop-blur-sm relative">
          <Info className="h-4 w-4 text-sky-400" />
          <AlertDescription className="text-sm text-foreground pr-8">
            We retain log data for 90 days. Data older than 90 days is automatically removed.
          </AlertDescription>
          <button
            onClick={() => setIsDataRetentionAlertDismissed(true)}
            className="absolute top-3 right-3 rounded-sm opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 p-1"
            aria-label="Dismiss alert"
          >
            <X className="h-4 w-4 text-foreground" />
          </button>
        </Alert>
      )}
      
      {/* Filter Bar */}
      <div className="z-10 bg-background/80 backdrop-blur-sm border-b border-border py-3">
          <FilterBar
            timeRange={customStartDate && customEndDate ? '' : dateRange}
            onTimeRangeChange={(range) => setDateRange(range as '1h' | '24h' | '7d' | '30d')}
            timeRangeOptions={allowedTimeRanges}
            disableTimeRangeToggle={Boolean(customStartDate && customEndDate)}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
            onCustomStartDateChange={setCustomStartDate}
            onCustomEndDateChange={setCustomEndDate}
            dateRange={calendarDateRange}
            onDateRangeChange={handleCalendarDateRangeChange}
            maxDateRangeDays={30}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder="Search websites, errors..."
            statusFilter={statusFilter}
            onStatusChange={(status) => setStatusFilter(status as 'all' | 'online' | 'offline' | 'unknown' | 'disabled')}
            statusOptions={[
              { value: 'all', label: 'All Statuses' },
              { value: 'online', label: 'Online' },
              { value: 'offline', label: 'Offline' },
              { value: 'disabled', label: 'Paused' },
              { value: 'unknown', label: 'Unknown' },
            ]}
            websiteFilter={websiteFilter}
            onWebsiteChange={setWebsiteFilter}
            websiteOptions={checks?.map(website => ({ value: website.id, label: website.name })) || []}
            includeAllWebsitesOption={false}
            onRefresh={() => {
              fetchLogs(true);
              fetchManualLogs();
            }}
            onExport={openExportModal}
            loading={false}
            canExport={logEntries.length > 0}
            variant="full"
            layout={isUnderLg ? 'stacked' : 'inline'}
            stackedOrder={['website', 'timeRange', 'dateRange', 'status', 'search', 'actions']}
          />
      </div>

      {/* Logs Table */}
      <div className="flex-1 overflow-auto p-4 sm:p-6 space-y-8 pb-14">
      {checksLoading ? (
        <LogsSkeleton rows={10} />
      ) : !checks || checks.length === 0 ? (
        <div className="pt-24">
          <LogsEmptyState
            variant="no-checks"
            onOpenChecks={handleOpenChecks}
          />
        </div>
      ) : !isDataReady ? (
        <LogsSkeleton rows={10} />
      ) : error ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm font-sans text-destructive`}>
            {error}
          </div>
        </div>
      ) : !websiteFilter || websiteFilter === 'all' ? (
        <div className="pt-24">
          <LogsEmptyState
            variant="no-website"
            onSelectWebsite={() => setWebsiteFilter(checks?.[0]?.id || '')}
            onAddWebsite={handleOpenChecks}
          />
        </div>
      ) : !hasAnyLogs && !manualLogsLoading ? (
        <div className="pt-24">
          <LogsEmptyState
            variant="no-logs"
            onClearFilters={clearFilters}
            check={selectedCheck}
            onOpenChecks={handleOpenChecks}
            lastEventAt={selectedLastEvent?.timestamp}
            lastEventStatus={selectedLastEvent?.status}
          />
        </div>
      ) : (
        <div className="space-y-5">
          {manualLogsError && (
            <div className="text-xs text-destructive">{manualLogsError}</div>
          )}
          {/* Status Information */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-5 bg-neutral-900/30 rounded-lg border border-neutral-800/50">
            {/* Left side - Log count and status */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <List className="w-4 h-4 text-neutral-400" />
                <span className={`text-sm font-medium text-foreground`}>
                  {totalLogs === -1 
                    ? `${logEntries.length} log${logEntries.length !== 1 ? 's' : ''} loaded`
                    : `${totalLogs} log${totalLogs !== 1 ? 's' : ''}`}
                </span>
                {manualLogCount > 0 && (
                  <Badge variant="outline" className="text-[10px] font-mono uppercase">
                    +{manualLogCount} manual
                  </Badge>
                )}
              </div>
              
              {/* Status indicators */}
              <div className="flex items-center gap-3">
                {isUpdating && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 bg-primary rounded-full animate-pulse"></div>
                    <span className={`text-xs text-muted-foreground`}>
                      updating
                    </span>
                  </div>
                )}
                {!isVerySmall && lastDataUpdate > 0 && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 bg-primary rounded-full"></div>
                    <span className={`text-xs text-muted-foreground`}>
                      updated {formatTimeSinceUpdate(lastDataUpdate)}
                    </span>
                      {Date.now() - lastDataUpdate > getCacheDuration(currentPage) && (
                        <span className="text-xs text-primary">
                        ({getCacheTierDescription(currentPage)})
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            {/* Right side - Controls and page info */}
            <div className="flex items-center gap-3">
              {!isMdDown && (
                <ColumnControls
                  columns={columnConfig}
                  onColumnToggle={handleColumnToggle}
                />
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsManualLogOpen(true)}
                disabled={!selectedCheck}
                className="h-8 text-xs"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Log Entry
              </Button>
              {(totalPages > 1 || totalLogs === -1) && (
                <div className="text-xs text-neutral-500">
                  {totalLogs === -1 
                    ? `Page ${currentPage}` 
                    : `Page ${currentPage} of ${totalPages}`}
                </div>
              )}
            </div>
          </div>
          
          <GlowCard>
            <ScrollArea className="overflow-x-auto" onMouseDown={handleHorizontalScroll}>
              <div className="min-w-[1000px] w-full">
                <Table>
                  <TableHeader className="bg-muted border-b">
                    <TableRow>
                      {columnVisibility.website && (
                        <TableHead className="px-4 py-4">
                          <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Website</div>
                        </TableHead>
                      )}
                      {columnVisibility.time && (
                        <TableHead className="px-4 py-4">
                          <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Time</div>
                        </TableHead>
                      )}
                      {columnVisibility.status && (
                        <TableHead className="px-4 py-4">
                          <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Status</div>
                        </TableHead>
                      )}
                      {columnVisibility.responseTime && (
                        <TableHead className="px-4 py-4">
                          <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Response Time</div>
                        </TableHead>
                      )}
                      {columnVisibility.statusCode && (
                        <TableHead className="px-4 py-4">
                          <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Status Code</div>
                        </TableHead>
                      )}
                      {columnVisibility.target && (
                        <TableHead className="px-4 py-4">
                          <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Target</div>
                        </TableHead>
                      )}
                      <TableHead className="px-4 py-4 w-32">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Actions</div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-border">
                    {manualLogsLoading && (
                      <TableRow>
                        <TableCell colSpan={visibleColumnCount} className="px-4 py-4 text-sm text-muted-foreground">
                          Loading manual entries...
                        </TableCell>
                      </TableRow>
                    )}
                    {manualLogCount > 0 && (
                      <TableRow className="bg-muted/40">
                        <TableCell colSpan={visibleColumnCount} className="px-4 py-3">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-mono uppercase text-muted-foreground">Manual entries</div>
                            <Badge variant="outline" className="text-[10px] font-mono uppercase">
                              {manualLogCount} manual
                            </Badge>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    {manualLogCount > 0 && filteredManualLogs.map((item, index) => renderLogRow(item, index, false))}
                    {manualLogCount > 0 && logEntries.length > 0 && (
                      <TableRow className="bg-muted/40">
                        <TableCell colSpan={visibleColumnCount} className="px-4 py-2">
                          <div className="text-xs font-mono uppercase text-muted-foreground">Check logs</div>
                        </TableCell>
                      </TableRow>
                    )}
                    {revealedLogs.map((item, index) => renderLogRow(item, index, true))}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </GlowCard>
          
          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="pt-8">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                totalItems={totalLogs}
                itemsPerPage={itemsPerPage}
                onPageChange={goToPage}
                showQuickJump={false}
                isMobile={isVerySmall}
              />
            </div>
          )}
        </div>
      )}

      {/* Row Details Sheet */}
      <LogDetailsSheet
        isOpen={isDetailsOpen}
        onClose={() => {
          setIsDetailsOpen(false);
          setAutoFocusTextarea(false);
        }}
        logEntry={selectedLogEntry}
        defaultTab={detailsDefaultTab}
        autoFocusTextarea={autoFocusTextarea}
      />

      {/* Manual Log Entry Slide-out */}
      <SlideOut
        open={isManualLogOpen}
        onOpenChange={setIsManualLogOpen}
        title="Create Log Entry"
        subtitle={selectedCheck ? `Manual note for ${selectedCheck.name}` : 'Select a website to add a manual log'}
        icon={<Plus className="w-4 h-4 text-primary" />}
      >
        <div className="space-y-5">
          {selectedCheck ? (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="text-xs uppercase text-muted-foreground font-mono">Website</div>
              <div className="mt-1 text-sm font-medium text-foreground">{selectedCheck.name}</div>
              <div className="text-xs font-mono text-muted-foreground break-all">{selectedCheck.url}</div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Select a website from the filter bar to add a manual log entry.
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="manual-log-message" className="text-xs">Entry</Label>
            <Textarea
              id="manual-log-message"
              placeholder="Add context about the event..."
              value={manualLogMessage}
              onChange={(event) => {
                setManualLogMessage(event.target.value);
                if (manualLogSaveError) {
                  setManualLogSaveError(null);
                }
              }}
              className="min-h-[120px] font-mono text-sm"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="manual-log-timestamp" className="text-xs">Time</Label>
              <Input
                id="manual-log-timestamp"
                type="datetime-local"
                value={manualLogTimestamp}
                onChange={(event) => setManualLogTimestamp(event.target.value)}
                className="h-9"
              />
              <div className="text-xs text-muted-foreground">Local time</div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-log-status" className="text-xs">Status</Label>
              <Select
                value={manualLogStatus}
                onValueChange={(value) => setManualLogStatus(value as ManualLogStatus)}
              >
                <SelectTrigger id="manual-log-status" className="h-9 cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {manualLogStatusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {manualLogSaveError && (
            <div className="text-xs text-destructive">{manualLogSaveError}</div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="outline"
              onClick={() => setIsManualLogOpen(false)}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={handleCreateManualLog}
              disabled={manualLogSaving || !manualLogMessage.trim() || !selectedCheck}
              className="flex-1"
            >
              {manualLogSaving ? <Spinner size="sm" className="mr-2" /> : null}
              {manualLogSaving ? 'Saving...' : 'Create entry'}
            </Button>
          </div>
        </div>
      </SlideOut>

      {/* Export Slide-out */}
      <SlideOut
        open={showExportModal}
        onOpenChange={setShowExportModal}
        title="Export Logs"
        subtitle="Choose your preferred export format"
        icon={<FileText className="w-4 h-4 text-primary" />}
      >
        <div className="space-y-6">
          <div className={`text-sm text-muted-foreground`}>
            Choose your preferred export format:
          </div>

          <div className="space-y-3">
            {/* CSV Option */}
            <button
              onClick={() => setSelectedExportFormat('csv')}
              className={`w-full p-4 rounded-lg border transition-all cursor-pointer ${
                selectedExportFormat === 'csv'
                  ? `border hover:bg-accent`
                  : `border bg-muted hover:hover:bg-accent`
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${
                  selectedExportFormat === 'csv' 
                    ? 'bg-primary/20 text-primary' 
                    : 'bg-neutral-700 text-neutral-400'
                }`}>
                  <FileText className="w-5 h-5" />
                </div>
                <div className="flex-1 text-left">
                  <div className={`font-medium text-foreground`}>
                    CSV Format
                  </div>
                  <div className={`text-sm text-muted-foreground`}>
                    Comma-separated values, compatible with most spreadsheet applications
                  </div>
                </div>
                {selectedExportFormat === 'csv' && (
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>
            </button>

            {/* Excel Option */}
            <button
              onClick={() => setSelectedExportFormat('excel')}
              className={`w-full p-4 rounded-lg border transition-all cursor-pointer ${
                selectedExportFormat === 'excel'
                  ? `border hover:bg-accent`
                  : `border bg-muted hover:hover:bg-accent`
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${
                  selectedExportFormat === 'excel' 
                    ? 'bg-primary/20 text-primary' 
                    : 'bg-neutral-700 text-neutral-400'
                }`}>
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <div className="flex-1 text-left">
                  <div className={`font-medium text-foreground`}>
                    Excel Format (.xlsx)
                  </div>
                  <div className={`text-sm text-muted-foreground`}>
                    Native Excel format with proper formatting and column widths
                  </div>
                </div>
                {selectedExportFormat === 'excel' && (
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-4">
            <Button
              variant="outline"
              onClick={() => setShowExportModal(false)}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={handleExport}
              className="flex-1"
            >
              Export
            </Button>
          </div>
        </div>
      </SlideOut>
      </div>
    </PageContainer>
  );
};

export default LogsBigQuery; 

