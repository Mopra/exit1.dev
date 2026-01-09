import React, { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { type DateRange } from "react-day-picker"
import { useNavigate } from 'react-router-dom';

import { List, FileText, FileSpreadsheet, Check } from 'lucide-react';

import { Button, FilterBar, StatusBadge, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, GlowCard, ScrollArea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import SlideOut from '../components/ui/slide-out';
import { Database } from 'lucide-react';
import { formatResponseTime } from '../utils/formatters.tsx';
import type { CheckHistory } from '../api/types';
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
}

const LogsBigQuery: React.FC = () => {
  const { userId } = useAuth();
  const navigate = useNavigate();
  
  const log = React.useCallback(
    (msg: string) => console.log(`[LogsBigQuery] ${msg}`),
    []
  );
  
  const { checks, loading: checksLoading } = useChecks(userId ?? null, log);
  // < 1024px stacks filter bar; < 768px hides column controls; < 500px simplifies status/pagination
  const isUnderLg = useMobile();
  const isMdDown = useMobile(768);
  const isVerySmall = useMobile(500);
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();
  
  // localStorage persistence
  const [websiteFilter, setWebsiteFilter] = useLocalStorage<string>('logs-website-filter', '');
  const [dateRange, setDateRange] = useLocalStorage<'24h' | '7d' | '30d' | '90d' | '1y' | 'all'>('logs-date-range', '24h');
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
  
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  // Use skeleton as the only loading indicator
  const [isDataReady, setIsDataReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const [lastDataUpdate, setLastDataUpdate] = useState<number>(0);
  const [isUpdating] = useState<boolean>(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage] = useState<number>(25);

  // Progressive row reveal (perceived performance)
  const [visibleRowCount, setVisibleRowCount] = useState<number>(0);
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  
  // Row details state
  const [selectedLogEntry, setSelectedLogEntry] = useState<LogEntry | null>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  
  // New enhanced features
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  
  // Date range for calendar
  const [calendarDateRange, setCalendarDateRange] = useState<DateRange | undefined>(undefined);
  
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
      case '24h':
        return { start: now - oneDay, end: now };
      case '7d':
        return { start: now - (7 * oneDay), end: now };
      case '30d':
        return { start: now - (30 * oneDay), end: now };
      case '90d':
        return { start: now - (90 * oneDay), end: now };
      case '1y':
        return { start: now - (365 * oneDay), end: now };
      case 'all':
        return { start: 0, end: now };
      default:
        return { start: now - (7 * oneDay), end: now };
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
    setIsDetailsOpen(true);
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
      const response = await apiClient.getCheckHistoryBigQuery(
        websiteFilter, 
        currentPage, 
        itemsPerPage, 
        debouncedSearchTerm, 
        statusFilter,
        dateRangeObj.start,
        dateRangeObj.end
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
        
        // Update pagination state
        setTotalPages(response.data.pagination.totalPages);
        setTotalLogs(response.data.pagination.total);
        
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

  // Initial data fetch when website is selected or filters change
  useEffect(() => {
    if (websiteFilter && !checksLoading) {
      fetchLogs();
    }
  }, [websiteFilter, checksLoading, currentPage, statusFilter, debouncedSearchTerm, dateRange, customStartDate, customEndDate]);

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

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, websiteFilter, debouncedSearchTerm, dateRange, customStartDate, customEndDate]);

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
    setDateRange('24h');
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

  return (
    <PageContainer>
      <PageHeader 
        title="Logs" 
        description="View detailed check history and logs"
        icon={Database}
      />
      
      {/* Sticky Filter Bar */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border py-3">
          <FilterBar
            timeRange={customStartDate && customEndDate ? '' : dateRange}
            onTimeRangeChange={(range) => setDateRange(range as '24h' | '7d' | '30d' | '90d' | '1y' | 'all')}
            disableTimeRangeToggle={Boolean(customStartDate && customEndDate)}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
            onCustomStartDateChange={setCustomStartDate}
            onCustomEndDateChange={setCustomEndDate}
            dateRange={calendarDateRange}
            onDateRangeChange={handleCalendarDateRangeChange}
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
            onRefresh={() => fetchLogs(true)}
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
      {!isDataReady ? (
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
          />
        </div>
      ) : logEntries.length === 0 ? (
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
          {/* Status Information */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-5 bg-neutral-900/30 rounded-lg border border-neutral-800/50">
            {/* Left side - Log count and status */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <List className="w-4 h-4 text-neutral-400" />
                <span className={`text-sm font-medium text-foreground`}>
                  {totalLogs} log{totalLogs !== 1 ? 's' : ''}
                </span>
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
              {totalPages > 1 && (
                <div className="text-xs text-neutral-500">
                  Page {currentPage} of {totalPages}
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
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-border">
                    {revealedLogs.map((item, index) => {
                      const hoverClass = getTableHoverColor(
                        item.status === 'online' || item.status === 'UP' || item.status === 'REDIRECT'
                          ? 'success'
                          : item.status === 'offline' || item.status === 'DOWN' || item.status === 'REACHABLE_WITH_ERROR'
                          ? 'error'
                          : 'neutral'
                      );
                      return (
                        <TableRow 
                          key={item.id} 
                          style={{ animationDelay: `${index * 28}ms` }}
                          className={`${hoverClass} ${getStatusBorderColor(item.status)} border-l-4 transition-colors group cursor-pointer animate-in fade-in slide-in-from-top-1 duration-500 ease-out`}
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
                              <div className="text-sm font-mono text-muted-foreground">
                                {item.responseTime ? formatResponseTime(item.responseTime) : '-'}
                              </div>
                            </TableCell>
                          )}
                          {columnVisibility.statusCode && (
                            <TableCell className="px-4 py-5">
                              <div className="text-sm font-mono text-muted-foreground">{item.statusCode || '-'}</div>
                            </TableCell>
                          )}
                          {columnVisibility.target && (
                            <TableCell className="px-4 py-5">
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
                                          if (item.cdnProvider || item.edgePop) return `${item.cdnProvider || 'cdn'}${item.edgePop ? ` • ${item.edgePop}` : ''}`;
                                          return '—';
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
                                        <span className="text-muted-foreground">ASN:</span> {item.targetAsn || '-'} {item.targetOrg ? `• ${item.targetOrg}` : ''}
                                      </div>
                                      <div className="text-xs font-mono">
                                        <span className="text-muted-foreground">Edge:</span> {item.cdnProvider || '-'} {item.edgePop ? `• ${item.edgePop}` : ''} {item.edgeRayId ? `• ${item.edgeRayId}` : ''}
                                      </div>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
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
        onClose={() => setIsDetailsOpen(false)}
        logEntry={selectedLogEntry}
      />

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
