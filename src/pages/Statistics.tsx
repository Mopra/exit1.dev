import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faChartLine,
  faArrowLeft,
  faExclamationTriangle
} from '@fortawesome/pro-regular-svg-icons';

import { Button, TimeRangeSelector, StatisticsCard } from '../components/ui';
import { theme, typography } from '../config/theme';
import { formatResponseTime } from '../utils/formatters.tsx';
import type { Website } from '../types';
import type { CheckHistory } from '../api/types';
import PulseMonitor from '../components/check/PulseMonitor';
import { apiClient } from '../api/client';
import { useChecks } from '../hooks/useChecks';

interface ChartDataPoint {
  time: string;
  responseTime: number;
  status: 'online' | 'offline' | 'unknown' | 'no-data' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  statusCode?: number;
  timestamp: number;
  hour?: number;
}

interface StatisticsData {
  uptime: number;
  averageResponseTime: number;
  totalChecks: number;
  downtimeCount: number;
  lastDowntime?: string;
  chartData: ChartDataPoint[];
}

import type { TimeRange } from '../components/ui/TimeRangeSelector';

const Statistics: React.FC = () => {
  const { checkId } = useParams<{ checkId: string }>();
  const navigate = useNavigate();
  const { userId } = useAuth();
  
  const log = useCallback(
    (msg: string) => console.log(`[Statistics] ${msg}`),
    []
  );
  
  const { checks } = useChecks(userId ?? null, log);
  
  const [website, setWebsite] = useState<Website | null>(null);
  const [statistics, setStatistics] = useState<StatisticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [timeRange, setTimeRange] = useState<'24h' | '7d'>('24h');
  const [lastDataUpdate, setLastDataUpdate] = useState<number>(0);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(Date.now());

  // Find the website by checkId - only update when checks actually change
  useEffect(() => {
    if (checkId && checks) {
      const foundWebsite = checks.find(check => check.id === checkId);
      if (foundWebsite && (!website || website.id !== foundWebsite.id || website.status !== foundWebsite.status)) {
        setWebsite(foundWebsite);
      }
    }
  }, [checkId, checks, website]);

  // Convert real history data to statistics with hour-level aggregation
  const processHistoryData = useCallback((history: CheckHistory[]): StatisticsData => {
    // If no history data, return empty statistics
    if (!history || history.length === 0) {
      return {
        uptime: 0,
        averageResponseTime: 0,
        totalChecks: 0,
        downtimeCount: 0,
        lastDowntime: undefined,
        chartData: []
      };
    }

    // Create hourly buckets for the last 24 hours
    const now = new Date();
    const hourlyData: { [hour: number]: ChartDataPoint[] } = {};
    
    // Initialize all 24 hours with empty arrays
    for (let i = 0; i < 24; i++) {
      const hour = (now.getHours() - i + 24) % 24;
      hourlyData[hour] = [];
    }

    // Group data points by hour
    history.forEach(entry => {
      const entryDate = new Date(entry.timestamp);
      const hour = entryDate.getHours();
      
      if (!hourlyData[hour]) {
        hourlyData[hour] = [];
      }
      
      hourlyData[hour].push({
        time: entryDate.toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: false 
        }),
        responseTime: entry.responseTime || 0,
        status: entry.status,
        statusCode: entry.statusCode,
        timestamp: entry.timestamp,
        hour: hour
      });
    });

    // Create aggregated chart data - one point per hour
    const aggregatedChartData: ChartDataPoint[] = [];
    const allDataPoints: ChartDataPoint[] = [];
    
    // Process hours in chronological order (oldest to newest)
    for (let i = 23; i >= 0; i--) {
      const hour = (now.getHours() - i + 24) % 24;
      const hourData = hourlyData[hour] || [];
      
      if (hourData.length > 0) {
        // Determine hour status: if any check in the hour was offline, mark the hour as offline
        const hasOffline = hourData.some(point => point.status === 'offline');
        const avgResponseTime = hourData.reduce((sum, p) => sum + p.responseTime, 0) / hourData.length;
        
        const aggregatedPoint: ChartDataPoint = {
          time: `${hour.toString().padStart(2, '0')}:00`,
          responseTime: avgResponseTime,
          status: hasOffline ? 'offline' : 'online',
          statusCode: hourData[hourData.length - 1]?.statusCode,
          timestamp: hourData[hourData.length - 1]?.timestamp || now.getTime() - (i * 60 * 60 * 1000),
          hour: hour
        };
        
        aggregatedChartData.push(aggregatedPoint);
        allDataPoints.push(...hourData);
      } else {
        // No data for this hour, mark as no-data
        const hourTimestamp = now.getTime() - (i * 60 * 60 * 1000);
        aggregatedChartData.push({
          time: `${hour.toString().padStart(2, '0')}:00`,
          responseTime: 0,
          status: 'no-data',
          timestamp: hourTimestamp,
          hour: hour
        });
      }
    }
    
    // Calculate statistics from all data points
    const onlinePoints = allDataPoints.filter(p => p.status === 'online' || p.status === 'UP' || p.status === 'REDIRECT');
    const uptime = allDataPoints.length > 0 ? (onlinePoints.length / allDataPoints.length) * 100 : 0;
    const averageResponseTime = onlinePoints.length > 0 
      ? onlinePoints.reduce((sum, p) => sum + p.responseTime, 0) / onlinePoints.length 
      : 0;
    const downtimeCount = allDataPoints.filter(p => p.status === 'offline' || p.status === 'DOWN' || p.status === 'REACHABLE_WITH_ERROR').length;
    
    // Find last downtime
    const lastOfflinePoint = allDataPoints.reverse().find(p => p.status === 'offline' || p.status === 'DOWN' || p.status === 'REACHABLE_WITH_ERROR');
    const lastDowntime = lastOfflinePoint ? lastOfflinePoint.time : undefined;
    
    return {
      uptime: Math.round(uptime * 100) / 100,
      averageResponseTime: Math.round(averageResponseTime),
      totalChecks: allDataPoints.length,
      downtimeCount,
      lastDowntime,
      chartData: aggregatedChartData // Use aggregated data for chart
    };
  }, []);



  // Background data fetching - doesn't show loading state
  const fetchDataInBackground = useCallback(async () => {
    if (!website) return;
    
    setIsUpdating(true);
    const fetchStartTime = Date.now();
    try {
      // Calculate time range
      const now = Date.now();
      let startDate: number;
      let endDate: number;
      
      if (timeRange === '24h') {
        startDate = now - (24 * 60 * 60 * 1000);
        endDate = now;
      } else {
        // 7 days
        startDate = now - (7 * 24 * 60 * 60 * 1000);
        endDate = now;
      }
      
      // Fetch data from BigQuery
      const response = await apiClient.getCheckHistoryForStats(website.id, startDate, endDate);
      if (response.success && response.data) {
        const data = processHistoryData(response.data);
        setStatistics(data);
        setLastDataUpdate(fetchStartTime);
      }
    } catch (error) {
      console.error('Error fetching data in background:', error);
    } finally {
      setIsUpdating(false);
    }
  }, [website, timeRange, processHistoryData]);

  // Initial data fetch with loading state
  useEffect(() => {
    if (website) {
      setLoading(true);
      
      const fetchData = async () => {
        const fetchStartTime = Date.now();
        try {
          // Calculate time range
          const now = Date.now();
          let startDate: number;
          let endDate: number;
          
          if (timeRange === '24h') {
            startDate = now - (24 * 60 * 60 * 1000);
            endDate = now;
          } else {
            // 7 days
            startDate = now - (7 * 24 * 60 * 60 * 1000);
            endDate = now;
          }
          
          // Fetch data from BigQuery
          const response = await apiClient.getCheckHistoryForStats(website.id, startDate, endDate);
          if (response.success && response.data) {
            const data = processHistoryData(response.data);
            setStatistics(data);
            setLastDataUpdate(fetchStartTime);
          } else {
            console.error('Failed to fetch check history from BigQuery:', response.error);
            setStatistics(null);
          }
        } catch (error) {
          console.error('Error fetching data:', error);
          setStatistics(null);
        } finally {
          setLoading(false);
        }
      };
      
      fetchData();
    }
  }, [website, timeRange, processHistoryData]);

  // Background polling for data updates
  useEffect(() => {
    if (!website || !statistics) return; // Only poll if we have initial data
    
    const interval = setInterval(() => {
      fetchDataInBackground();
    }, 30000); // Poll every 30 seconds
    
    return () => clearInterval(interval);
  }, [website, statistics, fetchDataInBackground]);

  // Update current time every second for timestamp display
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);



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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button 
            variant="ghost" 
            onClick={() => navigate('/checks')}
            className="flex items-center gap-2"
          >
            <FontAwesomeIcon icon={faArrowLeft} className="w-4 h-4" />
            Back
          </Button>
          <div className="flex items-center gap-3">
            <FontAwesomeIcon icon={faChartLine} className="w-6 h-6 text-blue-500" />
            <div>
              <h1 className={`text-2xl font-semibold ${typography.fontFamily.sans} ${theme.colors.text.primary}`}>
                Statistics for {website.name}
              </h1>
              <p className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                {timeRange === '24h' ? 'Last 24 hours' : 'Last 7 days'}
                {lastDataUpdate > 0 && (
                  <span className="ml-2 text-xs opacity-60">
                    • Updated {Math.max(1, Math.round((currentTime - lastDataUpdate) / 1000))}s ago
                    {isUpdating && (
                      <span className="ml-1 text-blue-400">
                        • Updating...
                      </span>
                    )}
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
        
        {/* Time Range Selector */}
        <TimeRangeSelector
          value={timeRange}
          onChange={(range: '24h' | '7d') => setTimeRange(range)}
          variant="compact"
          options={['24h', '7d']}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>
      ) : !statistics ? (
        <div className="flex flex-col items-center justify-center py-12">
          <FontAwesomeIcon icon={faChartLine} className="w-12 h-12 text-gray-400 mb-4" />
          <p className={`text-lg font-medium ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
            No check history available yet
          </p>
          <p className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted} mt-2`}>
            Check history will appear here after the first few checks are performed
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Statistics Cards - Dynamic Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <StatisticsCard
              title="Uptime"
              value={`${statistics.uptime}%`}
              color="green"
            />
            <StatisticsCard
              title="Avg Response"
              value={formatResponseTime(statistics.averageResponseTime)}
              color="blue"
            />
            <StatisticsCard
              title="Total Checks"
              value={statistics.totalChecks}
              color="purple"
            />
            <StatisticsCard
              title="Downtime"
              value={statistics.downtimeCount}
              color="red"
            />
          </div>

          {/* Pulse Monitor Chart */}
          <div className="relative bg-gradient-to-br from-black/60 to-gray-950/90 backdrop-blur-md rounded-xl p-6 border border-gray-800/60 shadow-lg">
            <PulseMonitor 
              data={statistics.chartData.map(point => ({
                time: point.time,
                status: point.status,
                timestamp: point.timestamp,
                hour: point.hour
              }))}
              timeRange={timeRange}
              onHourClick={(hour, timestamp) => {
                navigate(`/incidents/${website.id}/${hour}/${timestamp}`);
              }}
              onSuccessfulHourClick={(hour, timestamp) => {
                navigate(`/successful-checks/${website.id}/${hour}/${timestamp}`);
              }}
            />
          </div>
        </div>
      )}

    </div>
  );
};

export default Statistics; 