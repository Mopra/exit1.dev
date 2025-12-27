import React, { useCallback, useMemo, useState, useEffect } from "react";
import {
  Badge,
  Button,
  GlowCard,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../ui";
import type { Website, CheckHistory } from "../../types";
import { cn } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { apiClient } from "../../api/client";
import { CheckFolderSidebar } from "./CheckFolderSidebar";
import {
  ChevronRight,
  Globe,
  History,
  Activity,
  Calendar,
  Menu,
} from "lucide-react";

// Hook to get responsive timeline days based on screen size
function useTimelineDays() {
  const [days, setDays] = useState(() => {
    if (typeof window === 'undefined') return 90;
    if (window.innerWidth >= 1024) return 90;
    if (window.innerWidth >= 768) return 60;
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

function splitFolderPath(folder: string): string[] {
  return folder.split("/").map((p) => p.trim()).filter(Boolean);
}

function getChecksInFolder(checks: Website[], currentPath: FolderKey): Website[] {
  if (currentPath === "__all__") return checks;
  const normalized = normalizeFolder(currentPath);
  if (!normalized) return checks.filter(c => !normalizeFolder(c.folder));

  return checks.filter((c) => {
    const f = normalizeFolder(c.folder);
    if (!f) return false;
    return f === normalized || f.startsWith(normalized + "/");
  });
}

type TimelineData = {
  check: Website;
  history: CheckHistory[];
  loading: boolean;
  error?: string;
};

// Minimal history type for caching (only essential fields)
type MinimalHistory = {
  id: string;
  timestamp: number;
  status: 'online' | 'offline' | 'unknown';
  responseTime?: number;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  error?: string;
};

type CachedTimelineData = {
  history: MinimalHistory[] | CheckHistory[];
  timestamp: number;
  timelineDays: number;
};

// Cache configuration
const TIMELINE_CACHE_PREFIX = 'exit1_timeline_';
const MAX_CACHED_ENTRIES = 2000;

const minimizeHistory = (history: CheckHistory[]): MinimalHistory[] => {
  return history.slice(0, MAX_CACHED_ENTRIES).map(entry => ({
    id: entry.id,
    timestamp: entry.timestamp,
    status: entry.status,
    responseTime: entry.responseTime,
    detailedStatus: entry.detailedStatus,
    error: entry.error,
  }));
};

const expandHistory = (minimal: MinimalHistory[], websiteId: string, userId: string): CheckHistory[] => {
  return minimal.map(entry => ({
    id: entry.id,
    websiteId,
    userId,
    timestamp: entry.timestamp,
    status: entry.status,
    responseTime: entry.responseTime,
    detailedStatus: entry.detailedStatus,
    error: entry.error,
  }));
};

const getCacheKey = (checkId: string, timelineDays: number) =>
  `${TIMELINE_CACHE_PREFIX}${checkId}_${timelineDays}`;

const getCachedTimeline = (checkId: string, timelineDays: number, websiteId: string, userId: string): CheckHistory[] | null => {
  if (typeof window === 'undefined') return null;
  try {
    const cacheKey = getCacheKey(checkId, timelineDays);
    const cached = localStorage.getItem(cacheKey);
    if (!cached) return null;

    const data: CachedTimelineData = JSON.parse(cached);
    if (data.timelineDays === timelineDays) {
      if (Array.isArray(data.history) && data.history.length > 0) {
        if ('websiteId' in data.history[0]) {
          return data.history as CheckHistory[];
        } else {
          return expandHistory(data.history as MinimalHistory[], websiteId, userId);
        }
      }
      return [];
    }
    localStorage.removeItem(cacheKey);
    return null;
  } catch (error) {
    return null;
  }
};

const setCachedTimeline = (checkId: string, timelineDays: number, history: CheckHistory[]): void => {
  if (typeof window === 'undefined') return;
  const limitedHistory = history.slice(0, MAX_CACHED_ENTRIES);
  const minimalHistory = minimizeHistory(limitedHistory);

  try {
    const cacheKey = getCacheKey(checkId, timelineDays);
    const data: CachedTimelineData = {
      history: minimalHistory,
      timestamp: Date.now(),
      timelineDays,
    };
    localStorage.setItem(cacheKey, JSON.stringify(data));
  } catch (error) {
    // ignore
  }
};

type StatusBlock = {
  start: number;
  end: number;
  hasIssues: boolean;
  responseTime?: number;
};

function getStatusColor(hasIssues: boolean): string {
  return hasIssues ? 'bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.4)]' : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.2)]';
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
  const dayMap = new Map<number, CheckHistory[]>();

  for (const entry of history) {
    const dayStart = getDayStart(entry.timestamp);
    if (!dayMap.has(dayStart)) {
      dayMap.set(dayStart, []);
    }
    dayMap.get(dayStart)!.push(entry);
  }

  const startTime = getDayStart(now - ((timelineDays - 1) * 24 * 60 * 60 * 1000));

  for (let dayOffset = 0; dayOffset < timelineDays; dayOffset++) {
    const dayStart = getDayStart(startTime + (dayOffset * 24 * 60 * 60 * 1000));
    const isLastDay = dayOffset === timelineDays - 1;
    const dayEnd = isLastDay ? now : getDayEnd(dayStart);
    const dayEntries = dayMap.get(dayStart) || [];

    let hasIssues = false;
    let avgResponseTime: number | undefined;
    let totalResponseTime = 0;
    let responseTimeCount = 0;

    if (dayEntries.length > 0) {
      for (const entry of dayEntries) {
        const status = getStatusFromHistory(entry);
        if (status === 'DOWN' || status === 'ERROR') {
          hasIssues = true;
        }
        if (entry.responseTime !== undefined) {
          totalResponseTime += entry.responseTime;
          responseTimeCount++;
        }
      }
      if (responseTimeCount > 0) {
        avgResponseTime = totalResponseTime / responseTimeCount;
      }
    }

    blocks.push({
      start: dayStart,
      end: dayEnd,
      hasIssues,
      responseTime: avgResponseTime,
    });
  }

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

function getAllEntriesForDay(history: CheckHistory[], dayStart: number): CheckHistory[] {
  return history.filter(entry => {
    const entryDayStart = getDayStart(entry.timestamp);
    return entryDayStart === dayStart;
  });
}



export interface CheckTimelineViewProps {
  checks: Website[];
}

export default function CheckTimelineView({
  checks,
}: CheckTimelineViewProps) {
  const timelineDays = useTimelineDays();
  const [selectedFolder, setSelectedFolder] = useLocalStorage<FolderKey>("checks-timeline-selected-v3", "__all__");
  const [collapsedFolders, setCollapsedFolders] = useLocalStorage<string[]>("checks-timeline-collapsed-v3", []);
  const [folderColors] = useLocalStorage<Record<string, string>>("checks-folder-view-colors-v1", {});
  const [timelineData, setTimelineData] = useState<Map<string, TimelineData>>(new Map());
  const [loadingChecks, setLoadingChecks] = useState<Set<string>>(new Set());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const checksMap = useMemo(() => {
    const map = new Map<string, Website>();
    checks.forEach(check => map.set(check.id, check));
    return map;
  }, [checks]);

  const folderChecks = useMemo(() => getChecksInFolder(checks, selectedFolder), [checks, selectedFolder]);

  const selectedFolderPath = useMemo(() => {
    if (selectedFolder === "__all__") return null;
    return normalizeFolder(selectedFolder);
  }, [selectedFolder]);

  const folderColorOptions = [
    { label: "Default", value: "default", bg: "bg-blue-500", text: "text-blue-500", border: "border-blue-500/20", hoverBorder: "group-hover:border-blue-500/40", lightBg: "bg-blue-500/10", fill: "fill-blue-500/40" },
    { label: "Emerald", value: "emerald", bg: "bg-emerald-500", text: "text-emerald-500", border: "border-emerald-500/20", hoverBorder: "group-hover:border-emerald-500/40", lightBg: "bg-emerald-500/10", fill: "fill-emerald-500/40" },
    { label: "Amber", value: "amber", bg: "bg-amber-500", text: "text-amber-500", border: "border-amber-500/20", hoverBorder: "group-hover:border-amber-500/40", lightBg: "bg-amber-500/10", fill: "fill-amber-500/40" },
    { label: "Rose", value: "rose", bg: "bg-rose-500", text: "text-rose-500", border: "border-rose-500/20", hoverBorder: "group-hover:border-rose-500/40", lightBg: "bg-rose-500/10", fill: "fill-rose-500/40" },
    { label: "Violet", value: "violet", bg: "bg-violet-500", text: "text-violet-500", border: "border-violet-500/20", hoverBorder: "group-hover:border-violet-500/40", lightBg: "bg-violet-500/10", fill: "fill-violet-500/40" },
    { label: "Slate", value: "slate", bg: "bg-slate-500", text: "text-slate-500", border: "border-slate-500/20", hoverBorder: "group-hover:border-slate-500/40", lightBg: "bg-slate-500/10", fill: "fill-slate-500/40" },
  ];

  const getFolderTheme = useCallback((path: string, count: number) => {
    const custom = folderColors[path];
    const color = (custom && custom !== "default") ? custom : (count === 0 ? "slate" : "blue");

    const theme = folderColorOptions.find(o => o.value === color) || folderColorOptions[0]!;

    // Override for empty folders that are NOT custom colored
    if (!custom || custom === "default") {
      if (count === 0) {
        return {
          ...folderColorOptions.find(o => o.value === "slate")!,
          text: "text-muted-foreground/60",
          fill: "fill-muted-foreground/10",
          lightBg: "bg-slate-500/5",
          border: "border-slate-500/10",
          hoverBorder: "group-hover:border-slate-500/30"
        };
      }
    }

    return theme;
  }, [folderColors]);

  const toggleFolderCollapse = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return [...next];
    });
  }, [setCollapsedFolders]);

  const fetchCheckHistory = useCallback(async (checkId: string, useCache: boolean = true) => {
    if (useCache) {
      const check = checksMap.get(checkId);
      if (check) {
        const cachedHistory = getCachedTimeline(checkId, timelineDays, check.id, check.userId || '');
        if (cachedHistory) {
          return { checkId, data: { check, history: cachedHistory, loading: false } };
        }
      }
    }

    const endDate = Date.now();
    const startDate = endDate - (timelineDays * 24 * 60 * 60 * 1000);

    try {
      const response = await apiClient.getCheckHistoryDailySummary(checkId, startDate, endDate);
      if (response.success && response.data) {
        const historyData = response.data.data || [];
        setCachedTimeline(checkId, timelineDays, historyData as CheckHistory[]);
        return {
          checkId,
          data: { check: checksMap.get(checkId)!, history: historyData as CheckHistory[], loading: false }
        };
      }
    } catch (error: any) {
      // ignore
    }

    return {
      checkId,
      data: { check: checksMap.get(checkId)!, history: [], loading: false, error: 'Failed' }
    };
  }, [checksMap, timelineDays]);

  useEffect(() => {
    const checksToFetch = folderChecks.filter(
      check => !timelineData.has(check.id) && !loadingChecks.has(check.id)
    );

    if (checksToFetch.length === 0) return;

    setLoadingChecks((prev) => {
      const next = new Set(prev);
      checksToFetch.forEach(check => next.add(check.id));
      return next;
    });

    Promise.all(checksToFetch.map(check => fetchCheckHistory(check.id, true)))
      .then(results => {
        setTimelineData((prev) => {
          const next = new Map(prev);
          results.forEach(({ checkId, data }) => {
            next.set(checkId, data as TimelineData);
          });
          return next;
        });
      })
      .finally(() => {
        setLoadingChecks((prev) => {
          const next = new Set(prev);
          checksToFetch.forEach(check => next.delete(check.id));
          return next;
        });
      });
  }, [folderChecks, timelineData, loadingChecks, fetchCheckHistory]);

  const DayHoverPanel = React.memo(({
    dayStart,
    issues,
    allEntries,
    position,
    isVisible
  }: {
    dayStart: number;
    issues: CheckHistory[];
    allEntries: CheckHistory[];
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

    const totalChecks = allEntries.length;
    const successfulChecks = allEntries.filter(entry => {
      const status = getStatusFromHistory(entry);
      return status === 'UP';
    }).length;

    return (
      <div
        className={cn(
          "fixed z-[9999] p-4 rounded-xl shadow-2xl border min-w-[280px] max-w-[320px] pointer-events-none backdrop-blur-xl bg-sky-50/95 dark:bg-sky-950/40 border-sky-200/60 dark:border-sky-800/60",
        )}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          transform: 'translate(-50%, -100%)',
          marginTop: '-8px',
        }}
      >
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-sky-200/50 dark:border-sky-800/50">
          <Calendar className="size-3.5 text-sky-600 dark:text-sky-400" />
          <div className="text-sm font-semibold text-foreground">{formattedDate}</div>
        </div>

        {totalChecks > 0 && (
          <div className="mb-3 pb-2 border-b border-sky-200/50 dark:border-sky-800/50">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Total checks</span>
              <span className="font-mono font-semibold text-foreground">{totalChecks}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
              <span>Successful</span>
              <span className="font-mono font-semibold text-emerald-500">{successfulChecks}</span>
            </div>
          </div>
        )}

        {issues.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-emerald-500 font-medium">
            <div className="size-2 rounded-full bg-emerald-500" />
            No incidents
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Incidents</div>
            <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
              {issues.map((issue, idx) => {
                const issueTime = new Date(issue.timestamp).toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit'
                });
                const isDown = getStatusFromHistory(issue) === 'DOWN';
                return (
                  <div key={idx} className="flex items-start gap-3 text-xs p-2 rounded-lg bg-muted/50 border border-border/30">
                    <div className={cn(
                      "size-2 rounded-full mt-1.5 flex-shrink-0 shadow-lg",
                      isDown ? "bg-destructive shadow-red-500/20" : "bg-amber-500 shadow-amber-500/20"
                    )} />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold flex items-center justify-between">
                        <span>{isDown ? 'Offline' : 'Reachable/Error'}</span>
                        <span className="text-[10px] text-muted-foreground">{issueTime}</span>
                      </div>
                      {issue.error && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{issue.error}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  });

  const TimelineLoadingAnimation = React.memo(({ days }: { days: number }) => (
    <div className="flex h-full gap-1 p-1">
      {Array.from({ length: days }).map((_, idx) => (
        <div key={idx} className="flex-1 h-full rounded-sm bg-muted/30 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-muted/40 to-transparent animate-shimmer" style={{ animationDelay: `${(idx % 8) * 0.15}s` }} />
        </div>
      ))}
    </div>
  ));

  const TimelineRow = React.memo(({ check, timelineDays: days }: { check: Website; timelineDays: number }) => {
    const data = timelineData.get(check.id);
    const isLoading = loadingChecks.has(check.id);
    const [hoveredDay, setHoveredDay] = useState<number | null>(null);
    const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    const blocks = useMemo(() => {
      if (data) return processHistoryToBlocks(data.history, days);
      const startTime = getDayStart(Date.now() - ((days - 1) * 24 * 60 * 60 * 1000));
      return Array.from({ length: days }).map((_, idx) => ({
        start: getDayStart(startTime + (idx * 24 * 60 * 60 * 1000)),
        end: 0,
        hasIssues: false,
        responseTime: undefined,
      }));
    }, [data, days]);

    const uptimePct = useMemo(() => {
      if (!data) return "100.0";
      const problemDays = blocks.filter(b => b.hasIssues).length;
      return (((days - problemDays) / days) * 100).toFixed(1);
    }, [blocks, days, data]);

    const avgLatency = useMemo(() => {
      if (!data) return null;
      const responseTimes = blocks.filter(b => b.responseTime !== undefined).map(b => b.responseTime!);
      if (responseTimes.length === 0) return null;
      const avg = responseTimes.reduce((sum, rt) => sum + rt, 0) / responseTimes.length;
      return Math.round(avg);
    }, [blocks, data]);

    const handleBarMouseEnter = (block: StatusBlock, event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHoverPosition({ 
        x: rect.left + rect.width / 2, 
        y: rect.top 
      });
      setHoveredDay(block.start);
    };

    const handleBarMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHoverPosition({ 
        x: rect.left + rect.width / 2, 
        y: rect.top 
      });
    };

    return (
      <GlowCard className="overflow-hidden border-border/50 bg-background/50 hover:bg-background/80 transition-all duration-300">
        <div className="p-4 sm:p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className={cn(
                "size-10 rounded-xl flex items-center justify-center border shadow-sm transition-transform group-hover:scale-105",
                check.status === 'online' ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500" : "bg-destructive/10 border-destructive/20 text-destructive"
              )}>
                <Globe className="size-5" />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground truncate flex items-center gap-2">
                  {check.name}
                  {isLoading && <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-bold animate-pulse">SYNCING</Badge>}
                </h3>
                <p className="text-[11px] text-muted-foreground font-mono truncate opacity-70">{check.url}</p>
              </div>
            </div>

            <div className="hidden sm:flex items-center gap-4 text-right shrink-0">
              <div>
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5 opacity-50">Uptime ({days}d)</div>
                <Badge variant="outline" className={cn(
                  "font-mono border-transparent bg-background/50",
                  parseFloat(uptimePct) > 99 ? "text-emerald-500" : "text-amber-500"
                )}>{uptimePct}%</Badge>
              </div>
              <div>
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5 opacity-50">Avg Latency</div>
                <div className="text-sm font-mono font-bold">{avgLatency ?? '--'}ms</div>
              </div>
            </div>
          </div>

          <div className="relative">
            <div className="relative h-12 rounded-lg overflow-hidden bg-muted/20 p-1">
              {isLoading ? (
                <TimelineLoadingAnimation days={days} />
              ) : (
                <div className="flex h-full gap-0.5">
                  {blocks.map((block, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "flex-1 h-full transition-all duration-200 hover:scale-y-110 hover:z-10 rounded-[2px] cursor-pointer",
                        getStatusColor(block.hasIssues)
                      )}
                      onMouseEnter={(e) => handleBarMouseEnter(block, e)}
                      onMouseMove={handleBarMouseMove}
                      onMouseLeave={() => setHoveredDay(null)}
                    />
                  ))}
                </div>
              )}
            </div>

            {hoveredDay !== null && (
              <DayHoverPanel
                dayStart={hoveredDay}
                issues={data ? getIssuesForDay(data.history, hoveredDay) : []}
                allEntries={data ? getAllEntriesForDay(data.history, hoveredDay) : []}
                position={hoverPosition}
                isVisible={true}
              />
            )}

            <div className="flex justify-between text-[10px] font-bold text-muted-foreground/40 uppercase tracking-[0.2em] mt-2 px-1">
              <span className="flex items-center gap-1.5 opacity-60"><History className="size-3" /> {days} days ago</span>
              <span className="flex items-center gap-1.5">Today <Activity className="size-3 text-emerald-500" /></span>
            </div>
          </div>
        </div>
      </GlowCard>
    );
  });



  const breadcrumbs = useMemo(() => {
    if (selectedFolder === "__all__") return [{ label: "Timeline", path: "__all__" }];
    const parts = splitFolderPath(selectedFolder);
    const crumbs = [{ label: "Timeline", path: "__all__" }];
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      crumbs.push({ label: part, path: currentPath });
    }
    return crumbs;
  }, [selectedFolder]);

  return (
    <div className="h-auto min-h-[600px] grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-0 min-w-0 max-w-full rounded-xl border border-border shadow-2xl bg-background/50 backdrop-blur-sm">
      <CheckFolderSidebar
        checks={checks}
        selectedFolder={selectedFolder}
        collapsedFolders={collapsedFolders}
        onSelectFolder={(folder) => {
          setSelectedFolder(folder);
          setMobileSidebarOpen(false);
        }}
        onToggleCollapse={toggleFolderCollapse}
        allLabel="Global Activity"
        sectionLabel="Directory Layout"
        headerLabel="Navigation"
      />

      {/* Main Content Area */}
      <main className="flex flex-col min-w-0 max-w-full bg-background">
        {/* Modern Header */}
        <header className={cn(
          "h-14 border-b transition-colors duration-300 flex items-center justify-between px-4 gap-4 flex-shrink-0 rounded-t-xl lg:rounded-tl-none lg:rounded-tr-xl",
          selectedFolderPath
            ? cn(getFolderTheme(selectedFolderPath, folderChecks.length).lightBg, getFolderTheme(selectedFolderPath, folderChecks.length).border)
            : "bg-background/20 border-border/50 backdrop-blur-md"
        )}>
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* Mobile Menu Button */}
            <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden shrink-0 size-9 rounded-xl">
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="p-0 w-[280px] bg-background/95 backdrop-blur-xl">
                <SheetHeader className="p-6 border-b border-border/50">
                  <SheetTitle className="text-left flex items-center gap-2">
                    <Activity className="size-5 text-primary" />
                    Timeline Navigation
                  </SheetTitle>
                </SheetHeader>
                <CheckFolderSidebar
                  checks={checks}
                  selectedFolder={selectedFolder}
                  collapsedFolders={collapsedFolders}
                  onSelectFolder={(folder) => {
                    setSelectedFolder(folder);
                    setMobileSidebarOpen(false);
                  }}
                  onToggleCollapse={toggleFolderCollapse}
                  allLabel="Global Activity"
                  sectionLabel="Directory Layout"
                  headerLabel="Navigation"
                  mobile={true}
                />
              </SheetContent>
            </Sheet>

            <div className={cn(
              "flex items-center h-8 px-2 rounded-lg border transition-colors overflow-hidden min-w-0",
              selectedFolderPath
                ? cn("bg-background/40", getFolderTheme(selectedFolderPath, folderChecks.length).border.replace("border-", "border-"))
                : "bg-muted/40 border-border/50"
            )}>
              {breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb.path}>
                  {idx > 0 && <ChevronRight className="size-3 text-muted-foreground/50 mx-1 shrink-0" />}
                  <button
                    type="button"
                    onClick={() => setSelectedFolder(crumb.path)}
                    className={cn(
                      "text-xs font-medium truncate transition-colors min-w-0",
                      idx === breadcrumbs.length - 1
                        ? selectedFolderPath
                          ? getFolderTheme(selectedFolderPath, folderChecks.length).text
                          : "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {crumb.label === "Timeline" ? "Timeline" : crumb.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="text-xs font-mono text-muted-foreground px-2 py-1 bg-muted rounded hidden md:block">
              {folderChecks.length} {folderChecks.length === 1 ? 'item' : 'items'}
            </div>
          </div>
        </header>

        {/* Content Area */}
        <ScrollArea className="flex-1">
          <div className="p-4 sm:p-6 space-y-6">
            {folderChecks.length > 0 ? (
              <div className="grid grid-cols-1 gap-6">
                {folderChecks.map((check) => (
                  <TimelineRow key={check.id} check={check} timelineDays={timelineDays} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-32 text-center animate-in fade-in duration-700">
                <div className="size-20 rounded-3xl bg-muted/30 border border-border/50 flex items-center justify-center mb-6 shadow-xl relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <Activity className="size-10 text-muted-foreground/40 group-hover:text-primary/40 transition-colors" />
                </div>
                <h2 className="text-xl font-bold mb-2">No active surveillance</h2>
                <p className="text-muted-foreground text-sm max-w-[280px] leading-relaxed font-medium">
                  We found no checks in this segment. Select a different group or add a new tracking target.
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
