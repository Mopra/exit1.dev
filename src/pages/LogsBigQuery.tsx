import React, { useState, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faList,
  faFileCsv,
  faFileExcel
} from '@fortawesome/pro-regular-svg-icons';

import { Button, DataTable, FilterBar, StatusBadge, Modal } from '../components/ui';
import { theme, typography } from '../config/theme';
import { formatResponseTime } from '../utils/formatters.tsx';
import type { CheckHistory } from '../api/types';
import { apiClient } from '../api/client';
import { useChecks } from '../hooks/useChecks';
import { useMobile } from '../hooks/useMobile';

interface LogEntry {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteUrl: string;
  time: string;
  date: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  statusCode?: number;
  responseTime?: number;
  error?: string;
  timestamp: number;
}



const LogsBigQuery: React.FC = () => {
  const { userId } = useAuth();
  const isMobile = useMobile();
  
  const log = React.useCallback(
    (msg: string) => console.log(`[LogsBigQuery] ${msg}`),
    []
  );
  
  const { checks } = useChecks(userId ?? null, log);
  
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'unknown'>('all');
  const [websiteFilter, setWebsiteFilter] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [lastDataUpdate, setLastDataUpdate] = useState<number>(0);
  const [isUpdating] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(Date.now());
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage] = useState<number>(25); // Increased for better UX
  
  // New enhanced features
  const [dateRange, setDateRange] = useState<'24h' | '7d' | '30d' | '90d' | '1y' | 'all'>('24h');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  
  // Pagination state
  const [totalPages, setTotalPages] = useState<number>(0);
  const [totalLogs, setTotalLogs] = useState<number>(0);
  
  // Cache for paginated data (only cache current page)
  const [pageCache, setPageCache] = useState<Map<string, { data: LogEntry[], timestamp: number, page: number }>>(new Map());
  
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

  // Calculate date range based on selection
  const getDateRange = () => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
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



  // Fetch logs for current page with caching
  const fetchLogs = async (forceRefresh = false) => {
    if (!websiteFilter) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const now = Date.now();
      const dateRangeObj = getDateRange();
      const cacheKey = `${websiteFilter}-${currentPage}-${statusFilter}-${searchTerm}-${dateRange}-${customStartDate}-${customEndDate}`;
      const cached = pageCache.get(cacheKey);
      
      // Use cache if available and not expired, unless force refresh
      const cacheDuration = getCacheDuration(currentPage);
      if (!forceRefresh && cached && (now - cached.timestamp) < cacheDuration) {
        setLogEntries(cached.data);
        setLastDataUpdate(cached.timestamp);
        return;
      }
      
      // Fetch paginated data from BigQuery with filters
      const response = await apiClient.getCheckHistoryBigQuery(
        websiteFilter, 
        currentPage, 
        itemsPerPage, 
        searchTerm, 
        statusFilter,
        dateRangeObj.start,
        dateRangeObj.end
      );
      
      if (response.success && response.data) {
        const website = checks?.find(w => w.id === websiteFilter);
        if (!website) return;
        
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
          status: entry.status as 'online' | 'offline' | 'unknown',
          statusCode: entry.statusCode,
          responseTime: entry.responseTime,
          error: entry.error,
          timestamp: entry.timestamp
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
      }
    } catch (err) {
      console.error('Error fetching BigQuery logs:', err);
      setError('Failed to fetch logs from BigQuery');
    } finally {
      setLoading(false);
    }
  };

  // Initial data fetch when website is selected or filters change
  useEffect(() => {
    if (websiteFilter) {
      fetchLogs();
    }
  }, [websiteFilter, currentPage, statusFilter, searchTerm, dateRange, customStartDate, customEndDate]);

  // Update current time every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  // Cache cleanup - use shortest cache duration for cleanup interval
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setPageCache(prev => {
        const newCache = new Map();
        for (const [key, cacheEntry] of prev.entries()) {
          const cacheDuration = getCacheDuration(cacheEntry.page);
          if (now - cacheEntry.timestamp < cacheDuration) {
            newCache.set(key, cacheEntry);
          }
        }
        return newCache;
      });
    }, CACHE_DURATION.PAGE_1); // Use shortest duration for cleanup interval
    
    return () => clearInterval(interval);
  }, []);

  const formatError = (error?: string) => {
    if (!error) return 'N/A';
    return error.length > 50 ? `${error.substring(0, 50)}...` : error;
  };

  const formatTimeSinceUpdate = (lastUpdate: number) => {
    const seconds = Math.floor((currentTime - lastUpdate) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  // Pagination logic - now using server-side pagination
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const displayedLogs = logEntries; // Already paginated from server

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, websiteFilter, searchTerm, dateRange, customStartDate, customEndDate]);

  // Pagination handlers
  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const goToNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  const goToPrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
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
        entry.websiteName,
        entry.websiteUrl,
        entry.date,
        entry.time,
        entry.statusCode || 'N/A',
        entry.responseTime || 'N/A',
        entry.error || 'N/A'
      ].join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `website-logs-${websiteFilter}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Export data to Excel (XLSX format)
  const exportToExcel = () => {
    if (!logEntries.length) return;
    
    // Create Excel-like content with tab-separated values
    const headers = ['Status', 'Name', 'URL', 'Date', 'Time', 'Status Code', 'Response Time (ms)', 'Error'];
    const excelContent = [
      headers.join('\t'),
      ...logEntries.map(entry => [
        entry.status,
        entry.websiteName,
        entry.websiteUrl,
        entry.date,
        entry.time,
        entry.statusCode || 'N/A',
        entry.responseTime || 'N/A',
        entry.error || 'N/A'
      ].join('\t'))
    ].join('\n');
    
    const blob = new Blob([excelContent], { type: 'application/vnd.ms-excel' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `website-logs-${websiteFilter}-${new Date().toISOString().split('T')[0]}.xls`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Handle export with format selection
  const handleExport = () => {
    if (selectedExportFormat === 'csv') {
      exportToCSV();
    } else {
      exportToExcel();
    }
    setShowExportModal(false);
  };

  // Open export modal
  const openExportModal = () => {
    setShowExportModal(true);
  };

  const columns = [
    {
      key: 'status',
      header: 'Status',
      render: (entry: LogEntry) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={entry.status} />
        </div>
      )
    },
    {
      key: 'website',
      header: isMobile ? 'Website' : 'Name & URL',
      render: (entry: LogEntry) => (
        <div className="flex flex-col">
          <div className={`font-medium ${typography.fontFamily.sans} ${theme.colors.text.primary}`}>
            {entry.websiteName}
          </div>
          {!isMobile && (
            <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted} truncate max-w-[200px] sm:max-w-xs`}>
              {entry.websiteUrl}
            </div>
          )}
        </div>
      )
    },
    {
      key: 'dateTime',
      header: isMobile ? 'Time' : 'Date & Time',
      render: (entry: LogEntry) => (
        <div className="flex flex-col">
          {!isMobile && (
            <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.primary}`}>
              {entry.date}
            </div>
          )}
          <div className={`text-xs ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
            {entry.time}
          </div>
        </div>
      )
    },
    {
      key: 'statusCode',
      header: 'Code',
      hidden: isMobile,
      render: (entry: LogEntry) => (
        <div className={`${typography.fontFamily.mono} text-sm ${theme.colors.text.muted}`}>
          {entry.statusCode || 'N/A'}
        </div>
      )
    },
    {
      key: 'responseTime',
      header: 'Time',
      hidden: isMobile,
      render: (entry: LogEntry) => (
        <div className={`${typography.fontFamily.mono} text-sm ${theme.colors.text.muted}`}>
          {formatResponseTime(entry.responseTime)}
        </div>
      )
    },
    {
      key: 'error',
      header: 'Error',
      render: (entry: LogEntry) => (
        <div className={`text-sm ${theme.colors.text.muted} ${isMobile ? 'max-w-[120px]' : 'max-w-xs'} truncate`} title={entry.error}>
          {formatError(entry.error)}
        </div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        {/* Top Row - Title */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className={`text-xl md:text-2xl uppercase tracking-widest ${typography.fontFamily.display} ${theme.colors.text.primary}`}>
                Logs
              </h1>
            </div>
          </div>
        </div>
        
        {/* Filter Bar */}
        <FilterBar
          timeRange={dateRange}
          onTimeRangeChange={(range) => setDateRange(range as '24h' | '7d' | '30d' | '90d' | '1y' | 'all')}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
          onCustomStartDateChange={setCustomStartDate}
          onCustomEndDateChange={setCustomEndDate}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search websites, errors..."
          statusFilter={statusFilter}
          onStatusChange={(status) => setStatusFilter(status as 'all' | 'online' | 'offline' | 'unknown')}
          websiteFilter={websiteFilter}
          onWebsiteChange={setWebsiteFilter}
          websiteOptions={checks?.map(website => ({ value: website.id, label: website.name })) || []}
          onRefresh={() => fetchLogs(true)}
          onExport={openExportModal}
          loading={loading}
          canExport={logEntries.length > 0}
          variant="full"
        />
      </div>



      {/* Logs Table */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
            Loading logs from BigQuery...
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.error}`}>
            {error}
          </div>
        </div>
      ) : !websiteFilter ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
            Please select a website to view logs from BigQuery
          </div>
        </div>
      ) : displayedLogs.length === 0 ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
            No logs found for this website in BigQuery
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status Information */}
          <div className={`${isMobile ? 'flex flex-col gap-2' : 'flex items-center gap-2'} p-4`}>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faList} className="w-4 h-4 text-neutral-400" />
              <span className={`text-sm ${theme.colors.text.muted}`}>
                {isMobile ? (
                  <>
                    {startIndex + 1}-{Math.min(endIndex, totalLogs)} of {totalLogs} logs
                  </>
                ) : (
                  <>
                    Showing {startIndex + 1}-{Math.min(endIndex, totalLogs)} of {totalLogs} log{totalLogs !== 1 ? 's' : ''} (page {currentPage} of {totalPages})
                  </>
                )}
              </span>
            </div>
            <div className={`flex items-center gap-2 ${isMobile ? 'text-xs' : 'text-xs'}`}>
              {isUpdating && (
                <span className={`${theme.colors.text.muted} animate-pulse`}>
                  • updating
                </span>
              )}
              {lastDataUpdate > 0 && (
                <span className={`${theme.colors.text.muted}`}>
                  • updated {formatTimeSinceUpdate(lastDataUpdate)}
                  {currentTime - lastDataUpdate > getCacheDuration(currentPage) && (
                    <span className="text-yellow-400"> ({getCacheTierDescription(currentPage)})</span>
                  )}
                </span>
              )}
            </div>
          </div>
          
          <DataTable
            data={displayedLogs}
            columns={columns}
            getItemId={(item) => item.id}
            getItemName={(item) => `${item.websiteName} - ${item.time} - ${item.status}`}
            emptyState={{
              icon: faList,
              title: "No Logs",
              description: "No logs found for this website in BigQuery"
            }}
            disableBulkSelection={true}
            disableActions={true}
          />
          
          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className={`${isMobile ? 'flex flex-col gap-4' : 'flex items-center justify-center gap-4'} pt-6`}>
              {/* Page Info */}
              <div className={`text-sm ${theme.colors.text.muted} ${isMobile ? 'text-center' : ''}`}>
                {isMobile ? (
                  <>
                    Page {currentPage} of {totalPages}
                  </>
                ) : (
                  <>
                    Page {currentPage} of {totalPages} ({totalLogs} total logs)
                  </>
                )}
              </div>
              
              {/* Navigation Controls */}
              <div className={`${isMobile ? 'flex items-center justify-center gap-2' : 'flex items-center gap-4'}`}>
                {/* Previous Button */}
                <Button
                  variant="secondary"
                  onClick={goToPrevPage}
                  disabled={currentPage === 1}
                  className={`flex items-center gap-2 ${isMobile ? 'text-sm px-3 py-2' : ''}`}
                >
                  <FontAwesomeIcon icon="chevron-left" className="w-4 h-4" />
                  {!isMobile && 'Previous'}
                </Button>
                
                {/* Page Numbers */}
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(isMobile ? 3 : 5, totalPages) }, (_, i) => {
                    let pageNum;
                    if (totalPages <= (isMobile ? 3 : 5)) {
                      pageNum = i + 1;
                    } else if (currentPage <= (isMobile ? 2 : 3)) {
                      pageNum = i + 1;
                    } else if (currentPage >= totalPages - (isMobile ? 1 : 2)) {
                      pageNum = totalPages - (isMobile ? 2 : 4) + i;
                    } else {
                      pageNum = currentPage - (isMobile ? 1 : 2) + i;
                    }
                    
                    return (
                      <Button
                        key={pageNum}
                        variant={currentPage === pageNum ? "primary" : "secondary"}
                        onClick={() => goToPage(pageNum)}
                        className={`${isMobile ? 'w-7 h-7 text-xs' : 'w-8 h-8'} p-0 flex items-center justify-center`}
                      >
                        {pageNum}
                      </Button>
                    );
                  })}
                </div>
                
                {/* Next Button */}
                <Button
                  variant="secondary"
                  onClick={goToNextPage}
                  disabled={currentPage === totalPages}
                  className={`flex items-center gap-2 ${isMobile ? 'text-sm px-3 py-2' : ''}`}
                >
                  {!isMobile && 'Next'}
                  <FontAwesomeIcon icon="chevron-right" className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Export Format Selection Modal */}
      <Modal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        title="Export Format"
        size="sm"
      >
        <div className="space-y-6">
          <div className={`text-sm ${theme.colors.text.muted}`}>
            Choose your preferred export format:
          </div>
          
          <div className="space-y-3">
            {/* CSV Option */}
            <button
              onClick={() => setSelectedExportFormat('csv')}
              className={`w-full p-4 rounded-lg border transition-all cursor-pointer ${
                selectedExportFormat === 'csv'
                  ? `${theme.colors.border.primary} ${theme.colors.background.hover}`
                  : `${theme.colors.border.secondary} ${theme.colors.background.secondary} hover:${theme.colors.background.hover}`
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${
                  selectedExportFormat === 'csv' 
                    ? 'bg-green-500/20 text-green-400' 
                    : 'bg-neutral-700 text-neutral-400'
                }`}>
                  <FontAwesomeIcon icon={faFileCsv} className="w-5 h-5" />
                </div>
                <div className="flex-1 text-left">
                  <div className={`font-medium ${theme.colors.text.primary}`}>
                    CSV Format
                  </div>
                  <div className={`text-sm ${theme.colors.text.muted}`}>
                    Comma-separated values, compatible with most spreadsheet applications
                  </div>
                </div>
                {selectedExportFormat === 'csv' && (
                  <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
                    <FontAwesomeIcon icon="check" className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>
            </button>

            {/* Excel Option */}
            <button
              onClick={() => setSelectedExportFormat('excel')}
              className={`w-full p-4 rounded-lg border transition-all cursor-pointer ${
                selectedExportFormat === 'excel'
                  ? `${theme.colors.border.primary} ${theme.colors.background.hover}`
                  : `${theme.colors.border.secondary} ${theme.colors.background.secondary} hover:${theme.colors.background.hover}`
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${
                  selectedExportFormat === 'excel' 
                    ? 'bg-blue-500/20 text-blue-400' 
                    : 'bg-neutral-700 text-neutral-400'
                }`}>
                  <FontAwesomeIcon icon={faFileExcel} className="w-5 h-5" />
                </div>
                <div className="flex-1 text-left">
                  <div className={`font-medium ${theme.colors.text.primary}`}>
                    Excel Format
                  </div>
                  <div className={`text-sm ${theme.colors.text.muted}`}>
                    Tab-separated values, optimized for Microsoft Excel
                  </div>
                </div>
                {selectedExportFormat === 'excel' && (
                  <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                    <FontAwesomeIcon icon="check" className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>
            </button>
          </div>

          {/* Action Buttons */}
          <div className={`flex items-center gap-3 pt-4 ${isMobile ? 'flex-col' : ''}`}>
            <Button
              variant="secondary"
              onClick={() => setShowExportModal(false)}
              className={isMobile ? 'w-full' : 'flex-1'}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleExport}
              className={isMobile ? 'w-full' : 'flex-1'}
            >
              Export
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default LogsBigQuery; 