import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
} from '@fortawesome/free-regular-svg-icons';
import { 
  faExclamationTriangle,
  faTimes,
  faArrowLeft
} from '@fortawesome/free-solid-svg-icons';

import { Button, DataTable, FilterBar } from '../components/ui';
import { theme, typography } from '../config/theme';
import { formatResponseTime } from '../utils/formatters.tsx';
import type { Website } from '../types';
import type { CheckHistory } from '../api/types';
import { apiClient } from '../api/client';
import { useChecks } from '../hooks/useChecks';

interface IncidentData {
  id: string;
  time: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  statusCode?: number;
  responseTime?: number;
  error?: string;
  timestamp: number;
}

const Incidents: React.FC = () => {
  const { checkId, hour, timestamp } = useParams<{ 
    checkId: string; 
    hour: string; 
    timestamp: string; 
  }>();
  const navigate = useNavigate();
  const { userId } = useAuth();
  
  const log = React.useCallback(
    (msg: string) => console.log(`[Incidents] ${msg}`),
    []
  );
  
  const { checks } = useChecks(userId ?? null, log);
  
  const [website, setWebsite] = useState<Website | null>(null);
  const [checkHistory, setCheckHistory] = useState<IncidentData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'unknown'>('all');
  const [lastDataUpdate, setLastDataUpdate] = useState<number>(0);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(Date.now());
  const pollingIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

  // Find the website by checkId - only update when checks actually change
  useEffect(() => {
    if (checkId && checks) {
      const foundWebsite = checks.find(check => check.id === checkId);
      if (foundWebsite && (!website || website.id !== foundWebsite.id || website.status !== foundWebsite.status)) {
        setWebsite(foundWebsite);
      }
    }
  }, [checkId, checks, website]);

  // Parse URL parameters
  const hourNumber = hour ? parseInt(hour, 10) : 0;
  const timestampNumber = timestamp ? parseInt(timestamp, 10) : 0;

  useEffect(() => {
    if (website && hourNumber >= 0 && hourNumber <= 23 && timestampNumber > 0) {
      fetchIncidents();
    }
  }, [website, hourNumber, timestampNumber]);

  // Background data fetching - doesn't show loading state
  const fetchDataInBackground = React.useCallback(async () => {
    if (!website) return;
    
    setIsUpdating(true);
    const fetchStartTime = Date.now();
    
    try {
      // Calculate the hour start and end timestamps
      const hourStart = new Date(timestampNumber);
      hourStart.setMinutes(0, 0, 0);
      const hourEnd = new Date(hourStart);
      hourEnd.setHours(hourStart.getHours() + 1);
      
      const startTime = hourStart.getTime();
      const endTime = hourEnd.getTime();
      
      // Fetch incidents from BigQuery for the specific hour
      const response = await apiClient.getIncidentsForHour(website.id, startTime, endTime);
      
      if (response.success && response.data) {
        // Map the BigQuery data to incident format
        const hourIncidents = response.data
          .map((entry: CheckHistory) => ({
            id: entry.id,
            time: new Date(entry.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            }),
            status: entry.status as 'online' | 'offline' | 'unknown',
            statusCode: entry.statusCode,
            responseTime: entry.responseTime,
            error: entry.error,
            timestamp: entry.timestamp
          }))
          .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
        
        setCheckHistory(hourIncidents);
        setLastDataUpdate(fetchStartTime);
      }
    } catch (err) {
      console.error('Error fetching incidents in background from BigQuery:', err);
    } finally {
      setIsUpdating(false);
    }
  }, [website, timestampNumber]);

  // Background polling for data updates
  useEffect(() => {
    if (!website || checkHistory.length === 0) return; // Only poll if we have initial data
    
    // Smart polling: only poll when tab is active
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab is hidden, clear interval to save resources
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      } else {
        // Tab is visible, restart polling
        if (!pollingIntervalRef.current) {
          fetchDataInBackground(); // Immediate check when tab becomes visible
          pollingIntervalRef.current = setInterval(() => {
            fetchDataInBackground();
          }, 60000); // Increased to 60 seconds
        }
      }
    };
    
    const interval = setInterval(() => {
      fetchDataInBackground();
    }, 60000); // Increased to 60 seconds
    
    // Store interval reference for cleanup
    pollingIntervalRef.current = interval;
    
    // Listen for tab visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      pollingIntervalRef.current = null;
    };
  }, [website, checkHistory.length, fetchDataInBackground]);

  // Update current time every second for timestamp display
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  const fetchIncidents = async () => {
    if (!website) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Calculate the hour start and end timestamps
      const hourStart = new Date(timestampNumber);
      hourStart.setMinutes(0, 0, 0);
      const hourEnd = new Date(hourStart);
      hourEnd.setHours(hourStart.getHours() + 1);
      
      const startTime = hourStart.getTime();
      const endTime = hourEnd.getTime();
      
      // Fetch incidents from BigQuery for the specific hour
      const response = await apiClient.getIncidentsForHour(website.id, startTime, endTime);
      
      if (response.success && response.data) {
        // Map the BigQuery data to incident format
        const hourIncidents = response.data
          .map((entry: CheckHistory) => ({
            id: entry.id,
            time: new Date(entry.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            }),
            status: entry.status as 'online' | 'offline' | 'unknown',
            statusCode: entry.statusCode,
            responseTime: entry.responseTime,
            error: entry.error,
            timestamp: entry.timestamp
          }))
          .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
        
        setCheckHistory(hourIncidents);
        setLastDataUpdate(Date.now());
      } else {
        setError(response.error || 'Failed to fetch incidents from BigQuery');
      }
    } catch (err) {
      console.error('Error fetching incidents from BigQuery:', err);
      setError('Failed to fetch incidents from BigQuery');
    } finally {
      setLoading(false);
    }
  };



  const formatError = (error?: string) => {
    if (!error) return 'N/A';
    return error.length > 50 ? `${error.substring(0, 50)}...` : error;
  };

  const formatHour = (hour: number) => {
    return `${hour.toString().padStart(2, '0')}:00`;
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatTimeSinceUpdate = (lastUpdate: number) => {
    const seconds = Math.floor((currentTime - lastUpdate) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  // Filter checks based on status filter
  const filteredChecks = checkHistory.filter(check => {
    if (statusFilter === 'all') return true;
    return check.status === statusFilter;
  });

  const columns = [
    {
      key: 'time',
      header: 'Time',
      render: (incident: IncidentData) => (
        <div className={`${typography.fontFamily.mono} text-sm ${theme.colors.text.primary}`}>
          {incident.time}
        </div>
      )
    },
    {
      key: 'status',
      header: 'Status',
      render: (incident: IncidentData) => (
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            incident.status === 'offline' || incident.status === 'DOWN' || incident.status === 'REACHABLE_WITH_ERROR' ? 'bg-red-500' : 
            incident.status === 'online' || incident.status === 'UP' || incident.status === 'REDIRECT' ? 'bg-green-500' : 'bg-yellow-500'
          }`} />
          <span className={`text-sm font-medium ${
            incident.status === 'offline' || incident.status === 'DOWN' || incident.status === 'REACHABLE_WITH_ERROR' ? 'text-red-400' : 
            incident.status === 'online' || incident.status === 'UP' || incident.status === 'REDIRECT' ? 'text-green-400' : 'text-yellow-400'
          }`}>
            {incident.status.toUpperCase()}
          </span>
        </div>
      )
    },
    {
      key: 'statusCode',
      header: 'Status Code',
      render: (incident: IncidentData) => (
        <div className={`${typography.fontFamily.mono} text-sm ${theme.colors.text.muted}`}>
          {incident.statusCode || 'N/A'}
        </div>
      )
    },
    {
      key: 'responseTime',
      header: 'Response Time',
      render: (incident: IncidentData) => (
        <div className={`${typography.fontFamily.mono} text-sm ${theme.colors.text.muted}`}>
          {formatResponseTime(incident.responseTime)}
        </div>
      )
    },
    {
      key: 'error',
      header: 'Error Details',
      render: (incident: IncidentData) => (
        <div className={`text-sm ${theme.colors.text.muted} max-w-xs truncate`} title={incident.error}>
          {formatError(incident.error)}
        </div>
      )
    }
  ];

  if (!website) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <FontAwesomeIcon icon={faExclamationTriangle} className="w-12 h-12 text-red-400 mb-4" />
          <h2 className={`text-xl font-semibold ${typography.fontFamily.sans} ${theme.colors.text.primary} mb-2`}>
            Check Not Found
          </h2>
          <p className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted} mb-4`}>
            The requested check could not be found.
          </p>
          <Button onClick={() => navigate('/checks')}>
            <FontAwesomeIcon icon={faArrowLeft} className="w-4 h-4 mr-2" />
            Back to Checks
          </Button>
        </div>
      </div>
    );
  }

  if (hourNumber < 0 || hourNumber > 23 || timestampNumber <= 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <FontAwesomeIcon icon={faExclamationTriangle} className="w-12 h-12 text-red-400 mb-4" />
          <h2 className={`text-xl font-semibold ${typography.fontFamily.sans} ${theme.colors.text.primary} mb-2`}>
            Invalid Parameters
          </h2>
          <p className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted} mb-4`}>
            The hour or timestamp parameters are invalid.
          </p>
          <Button onClick={() => navigate(`/statistics/${checkId}`)}>
            <FontAwesomeIcon icon={faArrowLeft} className="w-4 h-4 mr-2" />
            Back to Statistics
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        {/* Top Row - Navigation and Title */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              onClick={() => navigate(`/statistics/${checkId}`)}
              className="flex items-center gap-2"
            >
              <FontAwesomeIcon icon={faArrowLeft} className="w-4 h-4" />
              Back to Statistics
            </Button>
            <div className="flex items-center gap-3">
              <FontAwesomeIcon icon={faExclamationTriangle} className="w-6 h-6 text-red-500" />
              <div>
                <h1 className={`text-2xl font-semibold ${typography.fontFamily.sans} ${theme.colors.text.primary}`}>
                  Check History for {website.name}
                </h1>
                <p className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                  {formatHour(hourNumber)} on {formatDate(timestampNumber)}
                </p>
              </div>
            </div>
          </div>
        </div>
        
        {/* Filter Bar */}
        <FilterBar
          timeRange="24h"
          onTimeRangeChange={() => {}} // Not used in incidents page
          searchTerm=""
          onSearchChange={() => {}} // Not used in incidents page
          statusFilter={statusFilter}
          onStatusChange={(status) => setStatusFilter(status as 'all' | 'online' | 'offline' | 'unknown')}
          websiteFilter=""
          onWebsiteChange={() => {}} // Not used in incidents page
          variant="compact"
          className="mb-4"
        />
        
        {/* Check Count */}
        <div className="flex items-center justify-end gap-2">
          <FontAwesomeIcon icon={faExclamationTriangle} className="w-4 h-4 text-red-400" />
          <span className={`text-sm ${theme.colors.text.muted}`}>
            {filteredChecks.length} of {checkHistory.length} check{filteredChecks.length !== 1 ? 's' : ''}
          </span>
          {isUpdating && (
            <span className={`text-xs ${theme.colors.text.muted} animate-pulse`}>
              • updating
            </span>
          )}
          {lastDataUpdate > 0 && (
            <span className={`text-xs ${theme.colors.text.muted}`}>
              • updated {formatTimeSinceUpdate(lastDataUpdate)}
            </span>
          )}
        </div>
      </div>

      {/* Incidents Table */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
            Loading incidents...
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.error}`}>
            {error}
          </div>
        </div>
             ) : filteredChecks.length === 0 ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
            {statusFilter === 'all' 
              ? 'No checks found for this hour' 
              : `No ${statusFilter} checks found for this hour`
            }
          </div>
        </div>
      ) : (
        <DataTable
          data={filteredChecks}
          columns={columns}
          getItemId={(item) => item.id}
          getItemName={(item) => `${item.time} - ${item.status}`}
          emptyState={{
            icon: faTimes,
            title: "No Checks",
            description: statusFilter === 'all' 
              ? "No checks found for this hour"
              : `No ${statusFilter} checks found for this hour`
          }}
        />
      )}
    </div>
  );
};

export default Incidents; 