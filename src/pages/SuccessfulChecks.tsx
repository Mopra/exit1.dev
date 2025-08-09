import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { CheckCircle, X, ArrowLeft } from 'lucide-react';

import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, StatusBadge, GlowCard, ScrollArea } from '../components/ui';
import { formatResponseTime } from '../utils/formatters.tsx';
import type { Website } from '../types';
import type { CheckHistory } from '../api/types';
import { apiClient } from '../api/client';
import { useChecks } from '../hooks/useChecks';
import { useHorizontalScroll } from '../hooks/useHorizontalScroll';

interface SuccessfulCheckData {
  id: string;
  time: string;
  status: 'online';
  statusCode?: number;
  responseTime?: number;
  timestamp: number;
}

const SuccessfulChecks: React.FC = () => {
  const { checkId, hour, timestamp } = useParams<{ 
    checkId: string; 
    hour: string; 
    timestamp: string; 
  }>();
  const navigate = useNavigate();
  const { userId } = useAuth();
  
  const log = React.useCallback(
    (msg: string) => console.log(`[SuccessfulChecks] ${msg}`),
    []
  );
  
  const { checks } = useChecks(userId ?? null, log);
  
  const [website, setWebsite] = useState<Website | null>(null);
  const [successfulChecks, setSuccessfulChecks] = useState<SuccessfulCheckData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDataUpdate, setLastDataUpdate] = useState<number>(0);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(Date.now());
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();

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
      fetchSuccessfulChecks();
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
      
      // Fetch check history for the specific hour
      const response = await apiClient.getCheckHistory(website.id);
      
      if (response.success && response.data) {
        // Filter successful checks for the specific hour and only online status
        const hourSuccessfulChecks = response.data.history
          .filter((entry: CheckHistory) => {
            const entryTime = entry.timestamp;
            return entryTime >= startTime && 
                   entryTime < endTime && 
                   entry.status === 'online';
          })
          .map((entry: CheckHistory) => ({
            id: entry.id,
            time: new Date(entry.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            }),
            status: entry.status as 'online',
            statusCode: entry.statusCode,
            responseTime: entry.responseTime,
            timestamp: entry.timestamp
          }))
          .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
        
        setSuccessfulChecks(hourSuccessfulChecks);
        setLastDataUpdate(fetchStartTime);
      }
    } catch (error) {
      console.error('Error fetching data in background:', error);
    } finally {
      setIsUpdating(false);
    }
  }, [website, hourNumber, timestampNumber]);

  const fetchSuccessfulChecks = async () => {
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
      
      // Fetch check history for the specific hour
      const response = await apiClient.getCheckHistory(website.id);
      
      if (response.success && response.data) {
        // Filter successful checks for the specific hour and only online status
        const hourSuccessfulChecks = response.data.history
          .filter((entry: CheckHistory) => {
            const entryTime = entry.timestamp;
            return entryTime >= startTime && 
                   entryTime < endTime && 
                   entry.status === 'online';
          })
          .map((entry: CheckHistory) => ({
            id: entry.id,
            time: new Date(entry.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            }),
            status: entry.status as 'online',
            statusCode: entry.statusCode,
            responseTime: entry.responseTime,
            timestamp: entry.timestamp
          }))
          .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
        
        setSuccessfulChecks(hourSuccessfulChecks);
        setLastDataUpdate(Date.now());
      } else {
        setError(response.error || 'Failed to fetch successful checks');
      }
    } catch (err) {
      console.error('Error fetching successful checks:', err);
      setError('Failed to fetch successful checks');
    } finally {
      setLoading(false);
    }
  };

  // Background polling for data updates
  const pollingIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!website || successfulChecks.length === 0) return; // Only poll if we have initial data
    
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
  }, [website, successfulChecks.length, fetchDataInBackground]);

  // Update current time every second for timestamp display
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

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

  // const columns = [
  //   {
  //     key: 'time',
  //     header: 'Time',
  //     width: 'w-32',
  //     render: (check: SuccessfulCheckData) => (
  //       <div className={`font-mono text-sm text-foreground`}>
  //         {check.time}
  //       </div>
  //     )
  //   },
  //   {
  //     key: 'status',
  //     header: 'Status',
  //     width: 'w-24',
  //     render: () => (
  //       <div className="flex items-center gap-2">
  //         <div className="w-2 h-2 rounded-full bg-green-500" />
  //         <span className="text-sm font-medium text-green-400">
  //           ONLINE
  //         </span>
  //       </div>
  //     )
  //   },
  //   {
  //     key: 'statusCode',
  //     header: 'Status Code',
  //     width: 'w-28',
  //     render: (check: SuccessfulCheckData) => (
  //       <div className={`font-mono text-sm text-muted-foreground`}>
  //         {check.statusCode || 'N/A'}
  //       </div>
  //     )
  //   },
  //   {
  //     key: 'responseTime',
  //     header: 'Response Time',
  //     width: 'w-32',
  //     render: (check: SuccessfulCheckData) => (
  //       <div className={`font-mono text-sm text-muted-foreground`}>
  //         {formatResponseTime(check.responseTime)}
  //       </div>
  //     )
  //   }
  // ];

  if (!website) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <X className="w-12 h-12 text-red-400 mb-4" />
          <h2 className={`text-xl font-semibold font-sans text-foreground mb-2`}>
            Check Not Found
          </h2>
          <p className={`text-sm font-mono text-muted-foreground mb-4`}>
            The requested check could not be found.
          </p>
          <Button onClick={() => navigate('/checks')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
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
          <X className="w-12 h-12 text-red-400 mb-4" />
          <h2 className={`text-xl font-semibold font-sans text-foreground mb-2`}>
            Invalid Parameters
          </h2>
          <p className={`text-sm font-mono text-muted-foreground mb-4`}>
            The hour or timestamp parameters are invalid.
          </p>
          <Button onClick={() => navigate('/checks')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Checks
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
              onClick={() => navigate('/checks')}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Checks
            </Button>
            <div className="flex items-center gap-3">
              <CheckCircle className="w-6 h-6 text-green-500" />
              <div>
                <h1 className={`text-2xl font-semibold font-sans text-foreground`}>
                  Check History for {website.name}
                </h1>
                <p className={`text-sm font-mono text-muted-foreground`}>
                  {formatHour(hourNumber)} on {formatDate(timestampNumber)}
                </p>
              </div>
            </div>
          </div>
        </div>
        
        {/* Bottom Row - Controls and Stats */}
        <div className="flex items-center justify-between">
          {/* Left side - empty for now since we only have successful checks */}
          <div className="flex items-center gap-2">
            {/* Could add filters here in the future if needed */}
          </div>
          
          {/* Check Count */}
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-400" />
            <span className={`text-sm text-muted-foreground`}>
              {successfulChecks.length} successful check{successfulChecks.length !== 1 ? 's' : ''}
            </span>
            {isUpdating && (
              <span className={`text-xs text-muted-foreground animate-pulse`}>
                • updating
              </span>
            )}
            {lastDataUpdate > 0 && (
              <span className={`text-xs text-muted-foreground`}>
                • updated {formatTimeSinceUpdate(lastDataUpdate)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Successful Checks Table */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm font-sans text-muted-foreground`}>
            Loading successful checks...
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-32">
          <div className={`text-sm font-sans text-destructive`}>
            {error}
          </div>
        </div>
      ) : successfulChecks.length === 0 ? (
        <div className="flex items-center justify-center h-32">
          <EmptyState
            variant="empty"
            icon={CheckCircle}
            title="No Successful Checks"
            description="No successful checks found for this hour"
          />
        </div>
      ) : (
        <GlowCard>
          <ScrollArea className="overflow-x-auto" onMouseDown={handleHorizontalScroll as any}>
          <div className="min-w-[700px] w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Response Time</TableHead>
                <TableHead>Status Code</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {successfulChecks.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.time}</TableCell>
                  <TableCell>
                    <StatusBadge status={item.status} />
                  </TableCell>
                  <TableCell>{item.responseTime ? formatResponseTime(item.responseTime) : '-'}</TableCell>
                  <TableCell>{item.statusCode || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
          </ScrollArea>
        </GlowCard>
      )}
    </div>
  );
};

export default SuccessfulChecks; 