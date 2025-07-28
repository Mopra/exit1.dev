import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faChartLine,
  faArrowLeft,
  faExclamationTriangle
} from '@fortawesome/pro-regular-svg-icons';

import { Button, TimeRangeSelector } from '../components/ui';
import { theme, typography } from '../config/theme';
import type { Website } from '../types';
import type { CheckHistory, CheckAggregation } from '../api/types';
import PulseMonitor from '../components/check/PulseMonitor';
import { apiClient } from '../api/client';
import { useChecks } from '../hooks/useChecks';

interface ChartDataPoint {
  time: string;
  responseTime: number;
  status: 'online' | 'offline' | 'unknown' | 'no-data';
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
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');

  // Find the website by checkId
  useEffect(() => {
    if (checkId && checks) {
      const foundWebsite = checks.find(check => check.id === checkId);
      setWebsite(foundWebsite || null);
    }
  }, [checkId, checks]);

  // Convert real history data to statistics with hour-level aggregation
  const processHistoryData = (history: CheckHistory[]): StatisticsData => {
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
    const onlinePoints = allDataPoints.filter(p => p.status === 'online');
    const uptime = allDataPoints.length > 0 ? (onlinePoints.length / allDataPoints.length) * 100 : 0;
    const averageResponseTime = onlinePoints.length > 0 
      ? onlinePoints.reduce((sum, p) => sum + p.responseTime, 0) / onlinePoints.length 
      : 0;
    const downtimeCount = allDataPoints.filter(p => p.status === 'offline').length;
    
    // Find last downtime
    const lastOfflinePoint = allDataPoints.reverse().find(p => p.status === 'offline');
    const lastDowntime = lastOfflinePoint ? lastOfflinePoint.time : undefined;
    
    return {
      uptime: Math.round(uptime * 100) / 100,
      averageResponseTime: Math.round(averageResponseTime),
      totalChecks: allDataPoints.length,
      downtimeCount,
      lastDowntime,
      chartData: aggregatedChartData // Use aggregated data for chart
    };
  };

  // Convert aggregated data to statistics
  const processAggregatedData = (aggregations: CheckAggregation[]): StatisticsData => {
    if (!aggregations || aggregations.length === 0) {
      return {
        uptime: 0,
        averageResponseTime: 0,
        totalChecks: 0,
        downtimeCount: 0,
        lastDowntime: undefined,
        chartData: []
      };
    }

    const dataPoints: ChartDataPoint[] = aggregations.map(agg => ({
      time: new Date(agg.hourTimestamp).toLocaleString('en-US', { 
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        hour12: false 
      }),
      responseTime: agg.averageResponseTime,
      status: agg.lastStatus,
      statusCode: agg.lastStatusCode,
      timestamp: agg.hourTimestamp,
      hour: new Date(agg.hourTimestamp).getHours()
    }));

    // Calculate overall statistics from aggregations
    const totalChecks = aggregations.reduce((sum, agg) => sum + agg.totalChecks, 0);
    const totalOnlineChecks = aggregations.reduce((sum, agg) => sum + agg.onlineChecks, 0);
    const uptime = totalChecks > 0 ? (totalOnlineChecks / totalChecks) * 100 : 0;
    
    // Weighted average response time
    const weightedResponseTime = aggregations.reduce((sum, agg) => 
      sum + (agg.averageResponseTime * agg.onlineChecks), 0);
    const averageResponseTime = totalOnlineChecks > 0 ? weightedResponseTime / totalOnlineChecks : 0;
    
    const downtimeCount = aggregations.reduce((sum, agg) => sum + agg.offlineChecks, 0);
    
    // Find last downtime
    const lastOfflineAgg = dataPoints.reverse().find(p => p.status === 'offline');
    const lastDowntime = lastOfflineAgg ? lastOfflineAgg.time : undefined;
    
    return {
      uptime: Math.round(uptime * 100) / 100,
      averageResponseTime: Math.round(averageResponseTime),
      totalChecks,
      downtimeCount,
      lastDowntime,
      chartData: dataPoints.reverse() // Reverse back to chronological order
    };
  };

  useEffect(() => {
    if (website) {
      setLoading(true);
      
      const fetchData = async () => {
        try {
          if (timeRange === '24h') {
            // Fetch raw history data for 24 hours
            const response = await apiClient.getCheckHistory(website.id);
            if (response.success && response.data) {
              const data = processHistoryData(response.data.history);
              setStatistics(data);
            } else {
              console.error('Failed to fetch check history:', response.error);
              setStatistics(null);
            }
          } else {
            // Fetch aggregated data for 7d or 30d
            const days = timeRange === '7d' ? 7 : 30;
            const response = await apiClient.getCheckAggregations(website.id, days);
            if (response.success && response.data) {
              const data = processAggregatedData(response.data.aggregations);
              setStatistics(data);
            } else {
              console.error('Failed to fetch check aggregations:', response.error);
              setStatistics(null);
            }
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
  }, [website, timeRange]);

  const formatResponseTime = (time: number) => {
    if (time === 0) return 'N/A';
    if (time < 1000) return `${time}ms`;
    return `${(time / 1000).toFixed(1)}s`;
  };

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
                {timeRange === '24h' ? 'Last 24 hours' : timeRange === '7d' ? 'Last 7 days' : 'Last 30 days'}
              </p>
            </div>
          </div>
        </div>
        
        {/* Time Range Selector */}
        <TimeRangeSelector
          value={timeRange}
          onChange={setTimeRange}
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
          {/* Statistics Cards - Dark Mode */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Uptime Card */}
            <div className="relative bg-gradient-to-br from-gray-800/50 to-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200">
              <div className="absolute inset-0 bg-gradient-to-br from-green-500/5 to-green-600/5 rounded-xl"></div>
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-medium ${typography.fontFamily.sans} text-green-400/80`}>
                    Uptime
                  </span>
                </div>
                <div className={`text-2xl font-bold ${typography.fontFamily.sans} text-green-300`}>
                  {statistics.uptime}%
                </div>
              </div>
            </div>

            {/* Average Response Card */}
            <div className="relative bg-gradient-to-br from-gray-800/50 to-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-blue-600/5 rounded-xl"></div>
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-medium ${typography.fontFamily.sans} text-blue-400/80`}>
                    Avg Response
                  </span>
                </div>
                <div className={`text-2xl font-bold ${typography.fontFamily.sans} text-blue-300`}>
                  {formatResponseTime(statistics.averageResponseTime)}
                </div>
              </div>
            </div>

            {/* Total Checks Card */}
            <div className="relative bg-gradient-to-br from-gray-800/50 to-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200">
              <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-purple-600/5 rounded-xl"></div>
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-medium ${typography.fontFamily.sans} text-purple-400/80`}>
                    Total Checks
                  </span>
                </div>
                <div className={`text-2xl font-bold ${typography.fontFamily.sans} text-purple-300`}>
                  {statistics.totalChecks}
                </div>
              </div>
            </div>

            {/* Downtime Card */}
            <div className="relative bg-gradient-to-br from-gray-800/50 to-gray-900/50 backdrop-blur-sm rounded-xl p-4 border border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200">
              <div className="absolute inset-0 bg-gradient-to-br from-red-500/5 to-red-600/5 rounded-xl"></div>
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-medium ${typography.fontFamily.sans} text-red-400/80`}>
                    Downtime
                  </span>
                </div>
                <div className={`text-2xl font-bold ${typography.fontFamily.sans} text-red-300`}>
                  {statistics.downtimeCount}
                </div>
              </div>
            </div>
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