import React, { useCallback, useMemo, useState, useEffect, useRef } from "react";
import {
  Badge,
  Card,
  CardContent,
  ScrollArea,
  glassClasses,
} from "../ui";
import type { Website, CheckHistory } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { apiClient } from "../../api/client";
import {
  ChevronRight,
  ChevronDown,
} from "lucide-react";

// Hook to get responsive timeline days based on screen size
function useTimelineDays() {
  const [days, setDays] = useState(() => {
    if (typeof window === 'undefined') return 90;
    // Large screens (>= 1024px): 90 days
    if (window.innerWidth >= 1024) return 90;
    // Medium screens (>= 768px): 60 days
    if (window.innerWidth >= 768) return 60;
    // Small screens (< 768px): 30 days
    return 30;
  });

  useEffect(() => {
    const updateDays = () => {
      if (window.innerWidth >= 1024) {
        setDays(90);
      } else if (window.innerWidth >= 768) {
        setDays(60);
      } else {
        setDays(30);
      }
    };

    window.addEventListener('resize', updateDays);
    updateDays();
    return () => window.removeEventListener('resize', updateDays);
  }, []);

  return days;
}

type FolderKey = "__all__" | string;

function normalizeFolder(folder?: string | null): string | null {
  const raw = (folder ?? "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\s+/g, " ").trim();
  const trimmedSlashes = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmedSlashes || null;
}

function getChecksInFolder(checks: Website[], currentPath: FolderKey): Website[] {
  if (currentPath === "__all__") return checks;
  const normalized = normalizeFolder(currentPath);
  if (!normalized) return [];
  return checks.filter((c) => normalizeFolder(c.folder) === normalized);
}

type TimelineData = {
  check: Website;
  history: CheckHistory[];
  loading: boolean;
  error?: string;
};

type CachedTimelineData = {
  history: CheckHistory[];
  timestamp: number;
  timelineDays: number;
};

// Cache configuration
const TIMELINE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const TIMELINE_CACHE_PREFIX = 'exit1_timeline_';

// Cache utilities for timeline data
const getCacheKey = (checkId: string, timelineDays: number) => 
  `${TIMELINE_CACHE_PREFIX}${checkId}_${timelineDays}`;

const getCachedTimeline = (checkId: string, timelineDays: number): CheckHistory[] | null => {
  if (typeof window === 'undefined') return null;
  try {
    const cacheKey = getCacheKey(checkId, timelineDays);
    const cached = localStorage.getItem(cacheKey);
    if (!cached) return null;
    
    const data: CachedTimelineData = JSON.parse(cached);
    const now = Date.now();
    
    // Check if cache is still valid (not expired and same timelineDays)
    if (now - data.timestamp < TIMELINE_CACHE_TTL && data.timelineDays === timelineDays) {
      return data.history;
    }
    
    // Cache expired or timelineDays changed, remove it
    localStorage.removeItem(cacheKey);
    return null;
  } catch (error) {
    console.error('Error reading timeline cache:', error);
    return null;
  }
};

const setCachedTimeline = (checkId: string, timelineDays: number, history: CheckHistory[]): void => {
  if (typeof window === 'undefined') return;
  try {
    const cacheKey = getCacheKey(checkId, timelineDays);
    const data: CachedTimelineData = {
      history,
      timestamp: Date.now(),
      timelineDays,
    };
    localStorage.setItem(cacheKey, JSON.stringify(data));
  } catch (error) {
    console.error('Error writing timeline cache:', error);
    // If quota exceeded, try to clean up old cache entries
    if (error instanceof Error && error.name === 'QuotaExceededError') {
      cleanupTimelineCache();
    }
  }
};

const cleanupTimelineCache = (): void => {
  if (typeof window === 'undefined') return;
  try {
    const now = Date.now();
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(TIMELINE_CACHE_PREFIX)) {
        try {
          const cached = localStorage.getItem(key);
          if (cached) {
            const data: CachedTimelineData = JSON.parse(cached);
            if (now - data.timestamp >= TIMELINE_CACHE_TTL) {
              keysToRemove.push(key);
            }
          }
        } catch {
          // Invalid cache entry, remove it
          if (key) keysToRemove.push(key);
        }
      }
    }
    
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch (error) {
    console.error('Error cleaning up timeline cache:', error);
  }
};

type StatusBlock = {
  start: number;
  end: number;
  status: 'UP' | 'DOWN' | 'ERROR' | 'UNKNOWN';
  responseTime?: number;
};

function getStatusColor(status: string): string {
  if (status === 'UP' || status === 'online' || status === 'REDIRECT') return 'bg-emerald-500';
  if (status === 'DOWN' || status === 'offline') return 'bg-destructive';
  if (status === 'REACHABLE_WITH_ERROR' || status === 'ERROR') return 'bg-amber-500';
  return 'bg-gray-400/60'; // Gray for UNKNOWN/no data - more visible
}

function getDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getDayEnd(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function processHistoryToBlocks(history: CheckHistory[], timelineDays: number): StatusBlock[] {
  const now = Date.now();
  const blocks: StatusBlock[] = [];

  // Group history entries by day
  const dayMap = new Map<number, CheckHistory[]>();
  
  for (const entry of history) {
    const dayStart = getDayStart(entry.timestamp);
    if (!dayMap.has(dayStart)) {
      dayMap.set(dayStart, []);
    }
    dayMap.get(dayStart)!.push(entry);
  }

  // Always create exactly timelineDays blocks (one per day for the last N days)
  // Start from N days ago and go forward to today
  const startTime = getDayStart(now - ((timelineDays - 1) * 24 * 60 * 60 * 1000));
  
  for (let dayOffset = 0; dayOffset < timelineDays; dayOffset++) {
    const dayStart = getDayStart(startTime + (dayOffset * 24 * 60 * 60 * 1000));
    // For the last day (today), use current time instead of end of day
    const isLastDay = dayOffset === timelineDays - 1;
    const dayEnd = isLastDay ? now : getDayEnd(dayStart);
    const dayEntries = dayMap.get(dayStart) || [];
    
    // Determine day status: prioritize worst status (DOWN > ERROR > UP)
    // If no data, status remains UNKNOWN (will show as grey)
    let dayStatus: StatusBlock['status'] = 'UNKNOWN';
    let avgResponseTime: number | undefined;
    let totalResponseTime = 0;
    let responseTimeCount = 0;

    if (dayEntries.length > 0) {
      // Count statuses
      let hasDown = false;
      let hasError = false;
      let hasUp = false;

      for (const entry of dayEntries) {
        const status = getStatusFromHistory(entry);
        if (status === 'DOWN') hasDown = true;
        else if (status === 'ERROR') hasError = true;
        else if (status === 'UP') hasUp = true;

        if (entry.responseTime !== undefined) {
          totalResponseTime += entry.responseTime;
          responseTimeCount++;
        }
      }

      // Determine worst status
      if (hasDown) dayStatus = 'DOWN';
      else if (hasError) dayStatus = 'ERROR';
      else if (hasUp) dayStatus = 'UP';

      if (responseTimeCount > 0) {
        avgResponseTime = totalResponseTime / responseTimeCount;
      }
    }
    // If no data for this day, dayStatus remains 'UNKNOWN' (grey bar)

    blocks.push({
      start: dayStart,
      end: dayEnd,
      status: dayStatus,
      responseTime: avgResponseTime,
    });
  }

  // Blocks are already in chronological order (oldest to newest)
  return blocks;
}

function getStatusFromHistory(entry: CheckHistory): 'UP' | 'DOWN' | 'ERROR' | 'UNKNOWN' {
  if (entry.detailedStatus === 'UP' || entry.detailedStatus === 'REDIRECT' || entry.status === 'online') return 'UP';
  if (entry.detailedStatus === 'DOWN' || entry.status === 'offline') return 'DOWN';
  if (entry.detailedStatus === 'REACHABLE_WITH_ERROR') return 'ERROR';
  return 'UNKNOWN';
}

function getIssuesForDay(history: CheckHistory[], dayStart: number): CheckHistory[] {
  return history.filter(entry => {
    const entryDayStart = getDayStart(entry.timestamp);
    if (entryDayStart !== dayStart) return false;
    const status = getStatusFromHistory(entry);
    return status === 'DOWN' || status === 'ERROR';
  });
}

export interface CheckTimelineViewProps {
  checks: Website[];
}

export default function CheckTimelineView({
  checks,
}: CheckTimelineViewProps) {
  const timelineDays = useTimelineDays();
  const [selectedFolder] = useLocalStorage<FolderKey>("checks-timeline-selected-v1", "__all__");
  const [expandedFolders, setExpandedFolders] = useLocalStorage<string[]>("checks-timeline-expanded-v1", []);
  const [timelineData, setTimelineData] = useState<Map<string, TimelineData>>(new Map());
  const [loadingChecks, setLoadingChecks] = useState<Set<string>>(new Set());

  const expandedSet = useMemo(() => new Set(expandedFolders), [expandedFolders]);

  // Create lookup map for O(1) check access
  const checksMap = useMemo(() => {
    const map = new Map<string, Website>();
    checks.forEach(check => map.set(check.id, check));
    return map;
  }, [checks]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return [...next];
    });
  }, [setExpandedFolders]);

  const folderChecks = useMemo(() => getChecksInFolder(checks, selectedFolder), [checks, selectedFolder]);

  // Group checks by folder for display
  const checksByFolder = useMemo(() => {
    const map = new Map<string, Website[]>();
    for (const check of folderChecks) {
      const folder = normalizeFolder(check.folder) || "__ungrouped__";
      if (!map.has(folder)) {
        map.set(folder, []);
      }
      map.get(folder)!.push(check);
    }
    return map;
  }, [folderChecks]);

  const fetchCheckHistory = useCallback(async (checkId: string, useCache: boolean = true) => {
    // Check cache first
    if (useCache) {
      const cachedHistory = getCachedTimeline(checkId, timelineDays);
      if (cachedHistory) {
        return {
          checkId,
          data: {
            check: checksMap.get(checkId)!,
            history: cachedHistory,
            loading: false,
          },
          error: null,
        };
      }
    }

    const endDate = Date.now();
    const startDate = endDate - (timelineDays * 24 * 60 * 60 * 1000);
    
    // Reduced limit - we only need enough data to group by day
    // For 90 days with checks every few minutes, ~2000 should be sufficient
    const limit = Math.min(2000, timelineDays * 50);
    
    const response = await apiClient.getCheckHistoryBigQuery(
      checkId,
      1,
      limit,
      '',
      'all',
      startDate,
      endDate
    );

    if (response.success && response.data) {
      const historyData = response.data.data || [];
      
      // Cache the result
      setCachedTimeline(checkId, timelineDays, historyData as CheckHistory[]);
      
      return {
        checkId,
        data: {
          check: checksMap.get(checkId)!,
          history: historyData as CheckHistory[],
          loading: false,
        },
        error: null,
      };
    } else {
      return {
        checkId,
        data: {
          check: checksMap.get(checkId)!,
          history: [],
          loading: false,
          error: response.error || 'Failed to load history',
        },
        error: response.error || 'Failed to load history',
      };
    }
  }, [checksMap, timelineDays]);

  // Load cached data on mount and when folderChecks changes
  useEffect(() => {
    const cachedData = new Map<string, TimelineData>();
    
    for (const check of folderChecks) {
      const cachedHistory = getCachedTimeline(check.id, timelineDays);
      if (cachedHistory) {
        cachedData.set(check.id, {
          check: check,
          history: cachedHistory,
          loading: false,
        });
      }
    }
    
    if (cachedData.size > 0) {
      setTimelineData((prev) => {
        const next = new Map(prev);
        cachedData.forEach((data, checkId) => {
          next.set(checkId, data);
        });
        return next;
      });
    }
  }, [folderChecks, timelineDays]);

  // Cleanup expired cache entries periodically
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      cleanupTimelineCache();
    }, 5 * 60 * 1000); // Clean up every 5 minutes

    return () => clearInterval(cleanupInterval);
  }, []);

  // Fetch history for visible checks in parallel
  useEffect(() => {
    const checksToFetch = folderChecks.filter(
      check => !timelineData.has(check.id) && !loadingChecks.has(check.id)
    );

    if (checksToFetch.length === 0) return;

    // Mark all as loading
    setLoadingChecks((prev) => {
      const next = new Set(prev);
      checksToFetch.forEach(check => next.add(check.id));
      return next;
    });

    // Fetch all in parallel (will use cache if available)
    Promise.all(checksToFetch.map(check => fetchCheckHistory(check.id, true)))
      .then(results => {
        setTimelineData((prev) => {
          const next = new Map(prev);
          results.forEach(({ checkId, data }) => {
            next.set(checkId, data);
          });
          return next;
        });
      })
      .catch((error) => {
        // Handle any errors
        setTimelineData((prev) => {
          const next = new Map(prev);
          checksToFetch.forEach(check => {
            next.set(check.id, {
              check: check,
              history: [],
              loading: false,
              error: error instanceof Error ? error.message : 'Failed to load history',
            });
          });
          return next;
        });
      })
      .finally(() => {
        // Remove from loading set
        setLoadingChecks((prev) => {
          const next = new Set(prev);
          checksToFetch.forEach(check => next.delete(check.id));
          return next;
        });
      });
  }, [folderChecks, timelineData, loadingChecks, fetchCheckHistory]);

  // Day hover panel component
  const DayHoverPanel = React.memo(({ 
    dayStart, 
    issues, 
    position, 
    isVisible 
  }: { 
    dayStart: number; 
    issues: CheckHistory[]; 
    position: { x: number; y: number }; 
    isVisible: boolean;
  }) => {
    if (!isVisible) return null;

    const date = new Date(dayStart);
    const formattedDate = date.toLocaleDateString('en-US', { 
      weekday: 'short',
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    });

    return (
      <div
        className={cn(
          "fixed z-50 p-3 rounded-lg shadow-lg border min-w-[200px] pointer-events-none",
          glassClasses
        )}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          transform: 'translate(-50%, calc(-100% - 8px))',
        }}
      >
        <div className="text-sm font-medium mb-2">{formattedDate}</div>
        {issues.length === 0 ? (
          <div className="text-xs text-muted-foreground">No downtime recorded this day</div>
        ) : (
          <div className="space-y-1.5">
            {issues.map((issue, idx) => {
              const issueTime = new Date(issue.timestamp).toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit' 
              });
              const isDown = getStatusFromHistory(issue) === 'DOWN';
              return (
                <div key={idx} className="flex items-start gap-2 text-xs">
                  <div className={cn(
                    "size-2 rounded-full mt-1 flex-shrink-0",
                    isDown ? "bg-destructive" : "bg-amber-500"
                  )} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      {issueTime} - {isDown ? 'Downtime' : 'Error'}
                    </div>
                    {issue.error && (
                      <div className="text-muted-foreground truncate mt-0.5">
                        {issue.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  });

  DayHoverPanel.displayName = 'DayHoverPanel';

  // Animated loading component for timeline bars with shimmer effect
  const TimelineLoadingAnimation = React.memo(({ days }: { days: number }) => {
    return (
      <div className="flex h-full gap-1 relative overflow-hidden">
        {Array.from({ length: days }).map((_, idx) => (
          <div
            key={idx}
            className="flex-1 h-full rounded bg-muted/60 relative overflow-hidden"
          >
            <div 
              className="absolute inset-0 bg-gradient-to-r from-transparent via-muted/50 to-transparent animate-shimmer"
              style={{
                animationDelay: `${(idx % 5) * 0.2}s`,
              }}
            />
          </div>
        ))}
      </div>
    );
  });

  TimelineLoadingAnimation.displayName = 'TimelineLoadingAnimation';

  const TimelineRow = React.memo(({ check, timelineDays: days }: { check: Website; timelineDays: number }) => {
    const data = timelineData.get(check.id);
    const isLoading = loadingChecks.has(check.id);
    const [hoveredDay, setHoveredDay] = useState<number | null>(null);
    const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const timelineRef = useRef<HTMLDivElement>(null);

    // Memoize blocks computation - expensive operation
    const blocks = useMemo(() => {
      if (data) {
        return processHistoryToBlocks(data.history, days);
      }
      // Always return days blocks, even if no data (will show grey bars)
      const currentTime = Date.now();
      const startTime = getDayStart(currentTime - ((days - 1) * 24 * 60 * 60 * 1000));
      const emptyBlocks: StatusBlock[] = [];
      for (let dayOffset = 0; dayOffset < days; dayOffset++) {
        const dayStart = getDayStart(startTime + (dayOffset * 24 * 60 * 60 * 1000));
        const isLastDay = dayOffset === days - 1;
        emptyBlocks.push({
          start: dayStart,
          end: isLastDay ? currentTime : getDayEnd(dayStart),
          status: 'UNKNOWN',
        });
      }
      return emptyBlocks;
    }, [data, days]);

    const handleBarMouseEnter = (block: StatusBlock, event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHoverPosition({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
      setHoveredDay(block.start);
    };

    const handleBarMouseLeave = () => {
      setHoveredDay(null);
    };

    const hoveredIssues = hoveredDay && data 
      ? getIssuesForDay(data.history, hoveredDay)
      : [];

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium truncate">{check.name}</h3>
              {isLoading && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs text-muted-foreground">Loading...</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="relative" ref={timelineRef}>
          {/* Timeline bars */}
          <div className="relative h-10 rounded overflow-hidden bg-background/50 backdrop-blur-sm">
            {isLoading ? (
              <TimelineLoadingAnimation days={days} />
            ) : blocks.length > 0 ? (
              <div className="flex h-full gap-1">
                {blocks.map((block, idx) => {
                  return (
                    <div
                      key={idx}
                      className={cn("flex-1 h-full transition-opacity hover:opacity-80 rounded cursor-pointer", getStatusColor(block.status))}
                      onMouseEnter={(e) => handleBarMouseEnter(block, e)}
                      onMouseLeave={handleBarMouseLeave}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                {data?.error || 'No data available'}
              </div>
            )}
          </div>

          {/* Hover panel */}
          {hoveredDay !== null && (
            <DayHoverPanel
              dayStart={hoveredDay}
              issues={hoveredIssues}
              position={hoverPosition}
              isVisible={true}
            />
          )}

          {/* Time labels */}
          <div className="flex justify-between text-xs text-muted-foreground mt-3">
            <span>{days} days ago</span>
            <span>Today</span>
          </div>
        </div>
      </div>
    );
  });

  TimelineRow.displayName = 'TimelineRow';

  const GroupedTimeline = React.memo(({ folderPath, folderName, checks: folderChecks, timelineDays: days }: { folderPath: string; folderName: string; checks: Website[]; timelineDays: number }) => {
    const isExpanded = expandedSet.has(folderPath);
    const [hoveredDay, setHoveredDay] = useState<number | null>(null);
    const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const timelineRef = useRef<HTMLDivElement>(null);
    
    // Check if any check in this folder is loading
    const isLoading = folderChecks.some(check => loadingChecks.has(check.id));
    
    const allData = useMemo(() => 
      folderChecks.map(c => timelineData.get(c.id)).filter(Boolean) as TimelineData[],
      [folderChecks, timelineData]
    );
    
    // Memoize expensive block processing
    const allBlocks = useMemo(() => 
      allData.flatMap(d => processHistoryToBlocks(d.history, days)),
      [allData, days]
    );

    const handleBarMouseEnter = (block: StatusBlock, event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHoverPosition({
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
      setHoveredDay(block.start);
    };

    const handleBarMouseLeave = () => {
      setHoveredDay(null);
    };

    // Memoize aggregated blocks computation
    const aggregatedBlocks = useMemo(() => {
      // Aggregate blocks for grouped view - one bar per day, showing worst status across all checks
      // Always create exactly days blocks
      const dayMap = new Map<number, { status: StatusBlock['status'], responseTime?: number, responseTimeCount: number }>();
      
      for (const block of allBlocks) {
        const dayStart = getDayStart(block.start);
        const existing = dayMap.get(dayStart);
        
        if (!existing) {
          dayMap.set(dayStart, {
            status: block.status,
            responseTime: block.responseTime,
            responseTimeCount: block.responseTime !== undefined ? 1 : 0,
          });
        } else {
          // Use worst status (DOWN > ERROR > UP > UNKNOWN)
          if (block.status === 'DOWN') {
            existing.status = 'DOWN';
          } else if (block.status === 'ERROR' && existing.status !== 'DOWN') {
            existing.status = 'ERROR';
          } else if (block.status === 'UP' && existing.status === 'UNKNOWN') {
            existing.status = 'UP';
          }
          
          // Average response time across all checks
          if (block.responseTime !== undefined) {
            if (existing.responseTime !== undefined) {
              existing.responseTime = (existing.responseTime * existing.responseTimeCount + block.responseTime) / (existing.responseTimeCount + 1);
              existing.responseTimeCount++;
            } else {
              existing.responseTime = block.responseTime;
              existing.responseTimeCount = 1;
            }
          }
        }
      }

      const blocks: StatusBlock[] = [];
      const currentTime = Date.now();
      const startTime = getDayStart(currentTime - ((days - 1) * 24 * 60 * 60 * 1000));
      
      // Always create exactly days blocks (one per day)
      for (let dayOffset = 0; dayOffset < days; dayOffset++) {
        const dayStart = getDayStart(startTime + (dayOffset * 24 * 60 * 60 * 1000));
        // For the last day (today), use current time instead of end of day
        const isLastDay = dayOffset === days - 1;
        const dayEnd = isLastDay ? currentTime : getDayEnd(dayStart);
        const dayData = dayMap.get(dayStart);
        
        blocks.push({
          start: dayStart,
          end: dayEnd,
          status: dayData?.status || 'UNKNOWN', // Grey if no data
          responseTime: dayData?.responseTime,
        });
      }

      // Blocks are already in chronological order
      return blocks;
    }, [allBlocks, days]);

    // Aggregate issues from all checks for the hovered day
    const hoveredIssues = hoveredDay 
      ? allData.flatMap(d => getIssuesForDay(d.history, hoveredDay))
      : [];

    return (
      <div className="space-y-2">
        <button
          onClick={() => toggleFolder(folderPath)}
          className="flex items-center gap-2 w-full text-left hover:bg-accent/50 rounded-lg p-2 transition-colors cursor-pointer"
        >
          {isExpanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{folderName}</h3>
              <Badge variant="outline">{folderChecks.length} check{folderChecks.length === 1 ? '' : 's'}</Badge>
              {isLoading && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs text-muted-foreground">Loading...</span>
                </div>
              )}
            </div>
          </div>
        </button>

        {/* Grouped timeline - only show when collapsed */}
        {!isExpanded && (
          <div className="relative ml-6" ref={timelineRef}>
            <div className="relative h-8 rounded overflow-hidden bg-background/50 backdrop-blur-sm">
              {isLoading ? (
                <TimelineLoadingAnimation days={days} />
              ) : aggregatedBlocks.length > 0 ? (
                <>
                  <div className="flex h-full gap-0.5">
                    {aggregatedBlocks.map((block, idx) => {
                      return (
                        <div
                          key={idx}
                          className={cn("flex-1 h-full transition-opacity hover:opacity-80 rounded cursor-pointer", getStatusColor(block.status))}
                          onMouseEnter={(e) => handleBarMouseEnter(block, e)}
                          onMouseLeave={handleBarMouseLeave}
                        />
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  No data available
                </div>
              )}
            </div>

            {/* Hover panel */}
            {hoveredDay !== null && (
              <DayHoverPanel
                dayStart={hoveredDay}
                issues={hoveredIssues}
                position={hoverPosition}
                isVisible={true}
              />
            )}

            {/* Time labels */}
            <div className="flex justify-between text-xs text-muted-foreground mt-3">
              <span>{days} days ago</span>
              <span>Today</span>
            </div>
          </div>
        )}

        {/* Expanded individual timelines */}
        {isExpanded && (
          <div className="ml-6 space-y-4 mt-4">
            {folderChecks.map((check) => (
              <TimelineRow key={check.id} check={check} timelineDays={timelineDays} />
            ))}
          </div>
        )}
      </div>
    );
  });

  GroupedTimeline.displayName = 'GroupedTimeline';

  if (checks.length === 0) {
    return (
      <Card className="h-full">
        <CardContent className="flex items-center justify-center h-full text-muted-foreground">
          No checks yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Timeline view */}
      <ScrollArea className="flex-1">
        <div className="space-y-6 p-1">
          {folderChecks.length > 0 ? (
            <>
              {/* Show grouped folders first */}
              {Array.from(checksByFolder.entries())
                .filter(([folder]) => folder !== "__ungrouped__")
                .map(([folder, folderChecks]) => (
                  <GroupedTimeline
                    key={folder}
                    folderPath={folder}
                    folderName={folder.split("/").pop() || folder}
                    checks={folderChecks}
                    timelineDays={timelineDays}
                  />
                ))}
              
              {/* Show ungrouped checks */}
              {checksByFolder.get("__ungrouped__")?.map((check) => (
                <TimelineRow key={check.id} check={check} timelineDays={timelineDays} />
              ))}
            </>
          ) : (
            <Card>
              <CardContent className="flex items-center justify-center py-8 text-muted-foreground">
                No checks in this folder.
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

