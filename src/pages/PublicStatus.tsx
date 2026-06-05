import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { Bell, BellOff, CheckCircle, Download, Edit, ExternalLink, Maximize, Minimize, RefreshCw, Share2, Shield, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Skeleton,
} from '../components/ui';
import PixelCard from '../components/PixelCard';
import { PageContainer, PageHeader } from '../components/layout';
import { CustomLayoutEditor, WidgetGrid } from '../components/status';
import { toast } from 'sonner';
import { copyToClipboard } from '../utils/clipboard';
import { db } from '../firebase';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { apiClient } from '../api/client';
import type { StatusPage, StatusPageLayout, CustomLayoutConfig, Website } from '../types';
import { format } from 'date-fns';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useChecks } from '../hooks/useChecks';
import { getFolderGroupClasses } from '../lib/folder-utils';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  uptimePercentage: number;
  lastChecked: number;
  responseTime?: number | null;
  status: string;
  createdAt?: number;
  folder?: string | null;
}

type HeartbeatStatus = 'online' | 'offline' | 'unknown';

type HeartbeatDay = {
  day: number;
  status: HeartbeatStatus;
  totalChecks: number;
  issueCount: number;
  onlineChecks: number;
  offlineChecks: number;
};

const HEARTBEAT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAVICON_PATH = '/e_.svg';
const FAVICON_MARKER_ID = 'exit1-down-marker';

const getHealthLabel = (status?: string) => {
  switch (status) {
    case 'online':
    case 'UP':
      return 'Online';
    case 'offline':
    case 'DOWN':
      return 'Offline';
    case 'REACHABLE_WITH_ERROR':
      return 'Degraded';
    case 'REDIRECT':
      return 'Redirect';
    case 'disabled':
      return 'Paused';
    case 'unknown':
    default:
      return 'Unknown';
  }
};

const getHealthTone = (status?: string) => {
  switch (status) {
    case 'online':
    case 'UP':
      return 'bg-success';
    case 'offline':
    case 'DOWN':
      return 'bg-destructive';
    case 'REACHABLE_WITH_ERROR':
      return 'bg-warning';
    case 'REDIRECT':
      return 'bg-primary';
    case 'disabled':
      return 'bg-warning/70';
    case 'unknown':
    default:
      return 'bg-muted-foreground/40';
  }
};

const getHeartbeatTone = (status: HeartbeatStatus) => {
  switch (status) {
    case 'online':
      return 'bg-success';
    case 'offline':
      return 'bg-destructive';
    case 'unknown':
    default:
      // Faint neutral fill for no-data days — keeps the bar strip calm
      // instead of dotting it with visible grey markers.
      return 'bg-muted';
  }
};

// Status shown as a chip (tinted background + semantic text), the recognised
// status-page convention — replaces the old round indicator dot.
const getHealthChipClasses = (status?: string) => {
  switch (status) {
    case 'online':
    case 'UP':
      return 'bg-success/10 text-success';
    case 'offline':
    case 'DOWN':
      return 'bg-destructive/10 text-destructive';
    case 'REACHABLE_WITH_ERROR':
      return 'bg-warning/10 text-warning';
    case 'REDIRECT':
      return 'bg-primary/10 text-primary';
    case 'disabled':
      return 'bg-warning/10 text-warning';
    case 'unknown':
    default:
      return 'bg-muted text-muted-foreground';
  }
};

const getHeartbeatLabel = (status: HeartbeatStatus) => {
  switch (status) {
    case 'online':
      return 'Healthy';
    case 'offline':
      return 'Issues';
    case 'unknown':
    default:
      return 'No data';
  }
};

const formatRelativeTime = (timestamp: number, now: number) => {
  const diff = Math.max(0, now - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// Window uptime % from heartbeat days. Prefers probe counts; falls back to
// day-status granularity. Returns null when there's no usable signal.
const computeWindowUptime = (days: HeartbeatDay[]): number | null => {
  let online = 0;
  let offline = 0;
  for (const day of days) {
    online += day.onlineChecks || 0;
    offline += day.offlineChecks || 0;
  }
  if (online + offline > 0) return (online / (online + offline)) * 100;
  const known = days.filter((d) => d.status !== 'unknown');
  if (known.length === 0) return null;
  const onlineDays = days.filter((d) => d.status === 'online').length;
  return (onlineDays / known.length) * 100;
};

const formatUptime = (value: number | null) => {
  if (value === null) return null;
  return value >= 100 ? '100' : value.toFixed(2);
};

const getDayStart = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const buildFallbackHeartbeat = (endDate: number): HeartbeatDay[] => {
  const start = getDayStart(endDate - ((HEARTBEAT_DAYS - 1) * DAY_MS));
  return Array.from({ length: HEARTBEAT_DAYS }, (_, index) => {
    const day = start + (index * DAY_MS);
    return {
      day,
      status: 'unknown',
      totalChecks: 0,
      issueCount: 0,
      onlineChecks: 0,
      offlineChecks: 0,
    };
  });
};

const getFaviconLink = () => {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
};

const buildFaviconDataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

const buildDownFaviconSvg = (svg: string) => {
  if (svg.includes(FAVICON_MARKER_ID)) {
    return svg;
  }
  // Inlined SVG can't reference CSS variables (browsers render the favicon
  // outside the document tree), so resolve --favicon-offline at runtime.
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue('--favicon-offline')
    .trim() || 'oklch(0.628 0.258 27)';
  return svg.replace(
    '</svg>',
    `  <circle id="${FAVICON_MARKER_ID}" cx="50" cy="14" r="20" fill="${resolved}" stroke="#ffffff" stroke-width="4">\n` +
      `    <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" />\n` +
      `  </circle>\n</svg>`
  );
};

const normalizeFolder = (folder?: string | null) => {
  const raw = (folder ?? '').trim();
  return raw.length > 0 ? raw : null;
};

const getFolderColor = (colors: Record<string, string>, folder?: string | null) => {
  const raw = (folder ?? '').trim();
  if (!raw) return undefined;
  const cleaned = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\s+/g, ' ').trim();
  const trimmedSlashes = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmedSlashes) return undefined;
  const color = colors[trimmedSlashes];
  return color && color !== 'default' ? color : undefined;
};

const normalizeBrandColor = (value?: string | null) => {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(trimmed)) {
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  }
  return trimmed;
};

const getStatusLayoutConfig = (layout?: StatusPageLayout) => {
  switch (layout) {
    case 'grid-3':
      return {
        gridClassName: 'grid gap-4 md:grid-cols-3',
        wrapperClassName: 'w-full',
        isCustom: false,
      };
    case 'single-5xl':
      return {
        gridClassName: 'grid gap-4 grid-cols-1',
        wrapperClassName: 'w-full max-w-5xl mx-auto',
        isCustom: false,
      };
    case 'custom':
      return {
        gridClassName: '',
        wrapperClassName: 'w-full',
        isCustom: true,
      };
    case 'grid-2':
    default:
      return {
        gridClassName: 'grid gap-4 md:grid-cols-2',
        wrapperClassName: 'w-full',
        isCustom: false,
      };
  }
};

const PublicStatus: React.FC = () => {
  const { checkId } = useParams<{ checkId: string }>();
  const { userId, isSignedIn } = useAuth();
  const [mode, setMode] = useState<'status' | 'certificate' | null>(null);
  const [statusPage, setStatusPage] = useState<StatusPage | null>(null);
  const [statusPageError, setStatusPageError] = useState<string | null>(null);
  const [statusDocLoading, setStatusDocLoading] = useState(true);
  const [statusChecks, setStatusChecks] = useState<BadgeData[]>([]);
  const [statusChecksLoading, setStatusChecksLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<number | null>(null);
  const [timeUntilNext, setTimeUntilNext] = useState<number | null>(null);
  const [heartbeatMap, setHeartbeatMap] = useState<Record<string, HeartbeatDay[]>>({});
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);
  const [heartbeatRange, setHeartbeatRange] = useState<{ startDate: number; endDate: number } | null>(null);
  const [faviconSvg, setFaviconSvg] = useState<string | null>(null);
  const [faviconUrl, setFaviconUrl] = useState<string>(FAVICON_PATH);
  const [defaultTitle, setDefaultTitle] = useState<string>(() => document.title);
  const [soundEnabled, setSoundEnabled] = useLocalStorage<boolean>('status-page-sound-enabled-v1', false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const prevHasDownRef = useRef(false);
  const soundIntervalRef = useRef<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(!!document.fullscreenElement);
  const [folderColors] = useLocalStorage<Record<string, string>>('checks-folder-view-colors-v1', {});
  const [editMode, setEditMode] = useState(false);

  // Owner detection for custom layout editing
  const isOwner = useMemo(() => {
    if (!isSignedIn || !userId || !statusPage) return false;
    return statusPage.userId === userId;
  }, [isSignedIn, userId, statusPage]);

  const canEdit = isOwner && statusPage?.layout === 'custom';

  // History window the viewer is looking at (7 / 30 / 90 days). Defaults to a
  // shorter span on small screens so the bars stay legible.
  const [historyDays, setHistoryDays] = useState<number>(() =>
    typeof window !== 'undefined' && window.innerWidth < 640 ? 30 : HEARTBEAT_DAYS
  );
  // Shared hover tooltip for the uptime bars (one floating node, not 90×N DOM nodes).
  const [barTip, setBarTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  // Fetch full check data for owners (needed for map widget with geo data)
  const ownerLog = React.useCallback(() => {}, []);
  const { checks: ownerChecks } = useChecks(isOwner && userId ? userId : null, ownerLog);

  // Filter owner checks to only those in this status page and convert to Website[] for map widget
  // Include checks matched by explicit checkIds AND by folderPaths (via statusChecks from backend).
  const fullChecks = useMemo((): Website[] => {
    if (!isOwner || !statusPage || !ownerChecks.length) return [];
    const includedIds = new Set<string>(statusPage.checkIds || []);
    for (const c of statusChecks) includedIds.add(c.checkId);
    return ownerChecks.filter((check) => includedIds.has(check.id));
  }, [isOwner, statusPage, ownerChecks, statusChecks]);

  const [badgeData, setBadgeData] = useState<BadgeData | null>(null);
  const [badgeLoading, setBadgeLoading] = useState(true);
  const [badgeError, setBadgeError] = useState<string | null>(null);
  const certificateRef = useRef<HTMLDivElement>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const checkIdsKey = `${statusPage?.checkIds?.join('|') ?? ''}::${statusPage?.folderPaths?.join('|') ?? ''}`;
  const fallbackHeartbeat = React.useMemo(
    () => buildFallbackHeartbeat(heartbeatRange?.endDate ?? Date.now()),
    [heartbeatRange?.endDate]
  );
  const brandColor = normalizeBrandColor(statusPage?.branding?.brandColor);
  const accentColor = normalizeBrandColor(statusPage?.branding?.accentColor);
  const brandLogoUrl = statusPage?.branding?.logoUrl?.trim() || null;
  const fontKey = statusPage?.branding?.font ?? null;
  const fontFamily =
    fontKey === 'serif'
      ? 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif'
      : fontKey === 'mono'
      ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      : undefined; // 'system' or null → inherit site default
  const brandStyle: React.CSSProperties | undefined =
    brandColor || accentColor || fontFamily
      ? ({
          ...(brandColor ? { ['--status-brand' as string]: brandColor } : {}),
          ...(accentColor ? { ['--status-accent' as string]: accentColor } : {}),
          ...(fontFamily ? { fontFamily } : {}),
        } as React.CSSProperties)
      : undefined;
  const groupedChecks = React.useMemo(() => {
    if (!statusPage?.groupByFolder) return null;
    const map = new Map<string, BadgeData[]>();
    for (const check of statusChecks) {
      const key = normalizeFolder(check.folder) ?? '__unsorted__';
      const list = map.get(key) ?? [];
      list.push(check);
      map.set(key, list);
    }

    const keys = Array.from(map.keys());
    keys.sort((a, b) => {
      if (a === '__unsorted__') return -1;
      if (b === '__unsorted__') return 1;
      return a.localeCompare(b);
    });

    return keys.map((key) => ({
      key,
      label: key === '__unsorted__' ? 'Unsorted' : key,
      checks: map.get(key) ?? [],
    }));
  }, [statusChecks, statusPage?.groupByFolder]);

  const playAlertSound = React.useCallback(() => {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextConstructor();
    }

    const context = audioContextRef.current;
    if (context.state === 'suspended') {
      context.resume();
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 120;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 1.4);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 1.6);
  }, []);

  const startAlertLoop = React.useCallback(() => {
    if (soundIntervalRef.current !== null) {
      window.clearInterval(soundIntervalRef.current);
      soundIntervalRef.current = null;
    }

    playAlertSound();
    soundIntervalRef.current = window.setInterval(() => {
      playAlertSound();
    }, 1200);

    window.setTimeout(() => {
      if (soundIntervalRef.current !== null) {
        window.clearInterval(soundIntervalRef.current);
        soundIntervalRef.current = null;
      }
    }, 10000);
  }, [playAlertSound]);

  const statusPageId = checkId ?? null;

  useEffect(() => {
    if (!statusPageId) {
      setMode('certificate');
      setStatusDocLoading(false);
      return;
    }

    setStatusDocLoading(true);
    setStatusPage(null);
    setStatusPageError(null);

    const docRef = doc(db, 'status_pages', statusPageId);
    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setMode('status');
          setStatusPage({ id: snapshot.id, ...(snapshot.data() as Omit<StatusPage, 'id'>) });
          setBadgeData(null);
          setBadgeError(null);
        } else {
          setMode('certificate');
        }
        setStatusDocLoading(false);
      },
      (error) => {
        if ((error as { code?: string })?.code === 'permission-denied') {
          setMode('status');
          setStatusPageError('This status page is private.');
        } else {
          setMode('certificate');
        }
        setStatusDocLoading(false);
      }
    );

    return () => unsubscribe();
  }, [statusPageId]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!defaultTitle) {
      setDefaultTitle(document.title);
    }
  }, [defaultTitle]);

  useEffect(() => {
    if (mode !== 'status') return;

    let isActive = true;
    const customFavicon = statusPage?.branding?.faviconUrl?.trim();
    const nextFaviconUrl = customFavicon && customFavicon.length > 0 ? customFavicon : FAVICON_PATH;
    setFaviconUrl(nextFaviconUrl);

    const shouldFetchSvg =
      nextFaviconUrl.endsWith('.svg') || nextFaviconUrl.startsWith('data:image/svg+xml');

    if (shouldFetchSvg) {
      fetch(nextFaviconUrl)
        .then((response) => response.text())
        .then((svg) => {
          if (isActive) {
            setFaviconSvg(svg);
          }
        })
        .catch((error) => {
          console.error('Failed to load favicon SVG:', error);
          if (isActive) {
            setFaviconSvg(null);
          }
        });
    } else {
      setFaviconSvg(null);
    }

    return () => {
      isActive = false;
    };
  }, [mode, statusPage?.branding?.faviconUrl]);

  const REFRESH_INTERVAL = 60000; // 60 seconds
  const HEARTBEAT_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

  const loadStatuses = React.useCallback(async (isManualRefresh = false) => {
    if (!statusPage) return;
    
    // Only show full loading state on initial load (when no data exists)
    const isInitialLoad = statusChecks.length === 0;
    
    if (isInitialLoad) {
      setStatusChecksLoading(true);
    } else if (isManualRefresh) {
      setIsRefreshing(true);
    }
    
    try {
      const result = await apiClient.getStatusPageSnapshot(statusPage.id);
      if (result.success && result.data?.checks) {
        setStatusChecks(result.data.checks);
        setLastUpdateTime(Date.now());
        if (isManualRefresh) {
          toast.success('Status updated');
        }
      } else {
        setStatusChecks([]);
      }
    } catch (error) {
      console.error('Failed to refresh status checks:', error);
      if (isManualRefresh) {
        toast.error('Failed to refresh status data');
      }
    } finally {
      if (isInitialLoad) {
        setStatusChecksLoading(false);
      } else if (isManualRefresh) {
        setIsRefreshing(false);
      }
    }
  }, [statusPage, statusChecks.length]);

  const loadHeartbeat = React.useCallback(async () => {
    if (!statusPage) return;

    setHeartbeatLoading(true);
    try {
      const result = await apiClient.getStatusPageHeartbeat(statusPage.id);
      if (result.success && result.data?.heartbeat) {
        const nextMap: Record<string, HeartbeatDay[]> = {};
        result.data.heartbeat.forEach((entry) => {
          nextMap[entry.checkId] = Array.isArray(entry.days)
            ? entry.days.map((day) => ({
                ...day,
                onlineChecks: typeof day.onlineChecks === 'number' ? day.onlineChecks : 0,
                offlineChecks: typeof day.offlineChecks === 'number' ? day.offlineChecks : 0,
                status: (day.status === 'online' || day.status === 'offline' || day.status === 'unknown'
                  ? day.status
                  : day.status === 'UP' || day.status === 'DOWN'
                  ? (day.status === 'UP' ? 'online' : 'offline')
                  : 'unknown') as HeartbeatStatus,
              }))
            : [];
        });
        setHeartbeatMap(nextMap);
        if (typeof result.data.startDate === 'number' && typeof result.data.endDate === 'number') {
          setHeartbeatRange({ startDate: result.data.startDate, endDate: result.data.endDate });
        }
      }
    } catch (error) {
      console.error('Failed to load heartbeat data:', error);
    } finally {
      setHeartbeatLoading(false);
    }
  }, [statusPage]);

  const isPageDisabled = statusPage?.enabled === false;

  useEffect(() => {
    if (mode !== 'status' || statusPageError || !statusPage || isPageDisabled) return;

    const checkIds = statusPage.checkIds ?? [];
    const folderPaths = statusPage.folderPaths ?? [];
    if (checkIds.length === 0 && folderPaths.length === 0) {
      setStatusChecks([]);
      setStatusChecksLoading(false);
      return;
    }

    loadStatuses();
    const interval = setInterval(loadStatuses, REFRESH_INTERVAL);

    return () => {
      clearInterval(interval);
    };
  }, [mode, statusPageError, checkIdsKey, statusPage, loadStatuses, isPageDisabled]);

  useEffect(() => {
    if (mode !== 'status' || statusPageError || !statusPage || isPageDisabled) return;

    const checkIds = statusPage.checkIds ?? [];
    const folderPaths = statusPage.folderPaths ?? [];
    if (checkIds.length === 0 && folderPaths.length === 0) {
      setHeartbeatMap({});
      setHeartbeatLoading(false);
      return;
    }

    loadHeartbeat();
    const interval = setInterval(loadHeartbeat, HEARTBEAT_REFRESH_INTERVAL);

    return () => {
      clearInterval(interval);
    };
  }, [mode, statusPageError, checkIdsKey, statusPage, loadHeartbeat, isPageDisabled]);

  const hasDownChecks = React.useMemo(
    () => statusChecks.some((check) => check.status === 'offline' || check.status === 'DOWN'),
    [statusChecks]
  );

  useEffect(() => {
    if (mode !== 'status') return;

    if (soundEnabled && hasDownChecks && !prevHasDownRef.current) {
      startAlertLoop();
    }

    prevHasDownRef.current = hasDownChecks;
  }, [mode, soundEnabled, hasDownChecks, startAlertLoop]);

  useEffect(() => {
    if (mode !== 'status' || !soundEnabled || !hasDownChecks) {
      if (soundIntervalRef.current !== null) {
        window.clearInterval(soundIntervalRef.current);
        soundIntervalRef.current = null;
      }
    }
  }, [mode, soundEnabled, hasDownChecks]);

  useEffect(() => {
    if (mode !== 'status') return;

    const link = getFaviconLink();
    let interval: number | null = null;

    if (faviconSvg) {
      const downHref = buildFaviconDataUrl(buildDownFaviconSvg(faviconSvg));
      if (hasDownChecks) {
        let showDown = true;
        link.href = downHref;
        interval = window.setInterval(() => {
          showDown = !showDown;
          link.href = showDown ? downHref : faviconUrl;
        }, 700);
      } else {
        link.href = faviconUrl;
      }
    } else {
      link.href = faviconUrl;
    }

    return () => {
      if (interval !== null) {
        window.clearInterval(interval);
      }
      link.href = FAVICON_PATH;
    };
  }, [mode, faviconSvg, faviconUrl, hasDownChecks]);

  useEffect(() => {
    return () => {
      if (soundIntervalRef.current !== null) {
        window.clearInterval(soundIntervalRef.current);
        soundIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (mode !== 'status') return;

    const offlineCheck = statusChecks.find(
      (check) => check.status === 'offline' || check.status === 'DOWN'
    );
    if (offlineCheck) {
      document.title = `${offlineCheck.name} OFFLINE`;
    } else {
      document.title = statusPage?.name ?? defaultTitle;
    }

    return () => {
      document.title = defaultTitle;
    };
  }, [mode, statusChecks, statusPage?.name, defaultTitle]);

  // Calculate next update time and countdown
  useEffect(() => {
    if (lastUpdateTime === null) {
      setTimeUntilNext(null);
      return;
    }

    const updateTimes = () => {
      const next = lastUpdateTime + REFRESH_INTERVAL;
      const now = Date.now();
      const diff = Math.max(0, next - now);
      const seconds = Math.floor(diff / 1000);
      setTimeUntilNext(seconds);
    };

    updateTimes();
    const interval = setInterval(updateTimes, 1000);

    return () => clearInterval(interval);
  }, [lastUpdateTime]);

  useEffect(() => {
    if (mode !== 'certificate') return;

    // Trust certificates feature has been removed
    setBadgeError('Trust certificates are no longer available. Please use status pages instead.');
    setBadgeLoading(false);
  }, [mode]);

  const handleShare = async () => {
    const currentUrl = window.location.href;

    if (navigator.share) {
      try {
        await navigator.share({
          title: `${badgeData?.name} - Trust Certificate`,
          text: `Check out the trust certificate for ${badgeData?.name}`,
          url: currentUrl,
        });
        toast.success('Certificate shared successfully');
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Error sharing:', err);
        }
      }
    } else {
      const success = await copyToClipboard(currentUrl);
      if (success) {
        toast.success('Certificate link copied to clipboard');
      } else {
        toast.error('Failed to copy link to clipboard');
      }
    }
  };

  const handleDownload = async () => {
    if (!certificateRef.current || !badgeData) return;

    setIsDownloading(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const html2canvas = (await import('html2canvas-pro')).default;
      const pixelCardElement = certificateRef.current.firstElementChild as HTMLElement;
      if (!pixelCardElement) {
        throw new Error('Could not find PixelCard element');
      }

      const options: Parameters<typeof html2canvas>[1] = {
        useCORS: true,
        allowTaint: true,
        logging: false,
        scale: 3,
        width: pixelCardElement.offsetWidth,
        height: pixelCardElement.offsetHeight,
        windowWidth: pixelCardElement.scrollWidth,
        windowHeight: pixelCardElement.scrollHeight,
        backgroundColor: null,
        removeContainer: false,
        foreignObjectRendering: false,
        imageTimeout: 15000,
        onclone: (clonedDoc: Document) => {
          const clonedElement = clonedDoc.body.querySelector(`[style*="relative"]`) || clonedDoc.body.firstElementChild;
          if (clonedElement) {
            (clonedElement as HTMLElement).style.position = 'relative';
          }
        },
      };

      const canvas = await html2canvas(pixelCardElement, options);

      const link = document.createElement('a');
      link.download = `${badgeData.name.replace(/[^a-z0-9]/gi, '_')}_certificate.png`;
      link.href = canvas.toDataURL('image/png', 1.0);
      link.click();

      toast.success('Certificate downloaded successfully');
    } catch (err) {
      console.error('Error downloading certificate:', err);
      toast.error('Failed to download certificate');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleManualRefresh = React.useCallback(async () => {
    await loadStatuses(true);
  }, [loadStatuses]);

  const handleSaveCustomLayout = React.useCallback(async (newLayout: CustomLayoutConfig) => {
    if (!statusPage || !isOwner) return;

    try {
      await updateDoc(doc(db, 'status_pages', statusPage.id), {
        customLayout: newLayout,
        updatedAt: Date.now(),
      });
      toast.success('Layout saved');
      setEditMode(false);
    } catch (error) {
      console.error('[PublicStatus] Failed to save custom layout:', error);
      toast.error('Failed to save layout');
      throw error;
    }
  }, [statusPage, isOwner]);

  if (statusDocLoading && mode === null) {
    return (
      <PageContainer className="min-h-screen">
        <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
          <Skeleton className="h-12 w-48" />
        </div>
      </PageContainer>
    );
  }

  if (mode === 'status') {
    const title = statusPage?.name ?? 'Status Page';

    const formatCountdown = (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const refreshButtonStyle = brandColor
      ? ({ borderColor: 'var(--status-brand)', color: 'var(--status-brand)' } as React.CSSProperties)
      : undefined;

    const headerTitle = (
      <div className="flex items-center gap-3 min-w-0">
        {brandLogoUrl ? (
          <img
            src={brandLogoUrl}
            alt={`${title} logo`}
            className="h-8 w-auto max-w-[180px] object-contain"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        <span className="truncate" style={brandColor ? { color: 'var(--status-brand)' } : undefined}>
          {title}
        </span>
      </div>
    );

    const refreshActions = (
      <div className="flex items-center gap-3">
        {lastUpdateTime && (
          <span className="hidden sm:block text-xs text-muted-foreground">
            Updated {format(new Date(lastUpdateTime), 'h:mm:ss a')}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleManualRefresh}
          disabled={isRefreshing || statusChecksLoading}
          className="gap-2"
          style={refreshButtonStyle}
        >
          <RefreshCw className={`w-4 h-4 ${(isRefreshing || statusChecksLoading) ? 'animate-spin' : ''}`} />
          {timeUntilNext !== null ? (
            <span className="hidden sm:inline">Refresh in: {formatCountdown(timeUntilNext)}</span>
          ) : (
            <span className="hidden sm:inline">Refresh</span>
          )}
        </Button>
      </div>
    );

    const layoutConfig = getStatusLayoutConfig(statusPage?.layout);

    // Display toggles — undefined/null means ON (see StatusPageDisplay).
    const display = {
      showOverallStatus: statusPage?.display?.showOverallStatus !== false,
      showUptimeStats: statusPage?.display?.showUptimeStats !== false,
      showHistory: statusPage?.display?.showHistory !== false,
      showResponseTime: statusPage?.display?.showResponseTime !== false,
    };

    const now = Date.now();

    // Overall roll-up — the headline every status page leads with.
    const totalCount = statusChecks.length;
    const downCount = statusChecks.filter((c) => c.status === 'offline' || c.status === 'DOWN').length;
    const degradedCount = statusChecks.filter((c) => c.status === 'REACHABLE_WITH_ERROR').length;
    const operationalCount = Math.max(0, totalCount - downCount - degradedCount);
    const overall = downCount > 0 ? 'down' : degradedCount > 0 ? 'degraded' : 'operational';
    const overallMeta = {
      operational: { label: 'All systems operational', tone: 'bg-success' },
      degraded: { label: 'Some systems are degraded', tone: 'bg-warning' },
      down: {
        label: downCount >= totalCount ? 'Major outage in progress' : 'Partial outage in progress',
        tone: 'bg-destructive',
      },
    }[overall];

    // Aggregate uptime across all checks (server-computed per-check %).
    const uptimeValues = statusChecks
      .map((c) => c.uptimePercentage)
      .filter((v): v is number => typeof v === 'number' && v >= 0);
    const aggregateUptime = uptimeValues.length
      ? formatUptime(uptimeValues.reduce((a, b) => a + b, 0) / uptimeValues.length)
      : null;

    // Days since the most recent incident, derived from the heartbeat history.
    let lastIncidentDay: number | null = null;
    for (const days of Object.values(heartbeatMap)) {
      for (const day of days) {
        const isIssue = day.status === 'offline' || (day.offlineChecks ?? 0) > 0 || day.issueCount > 0;
        if (isIssue && (lastIncidentDay === null || day.day > lastIncidentDay)) {
          lastIncidentDay = day.day;
        }
      }
    }
    const incidentLabel = (() => {
      if (downCount > 0) return 'Ongoing';
      if (lastIncidentDay === null) return `None in ${HEARTBEAT_DAYS} days`;
      const daysSince = Math.max(0, Math.floor((getDayStart(now) - lastIncidentDay) / DAY_MS));
      if (daysSince === 0) return 'Today';
      if (daysSince === 1) return '1 day ago';
      return `${daysSince} days ago`;
    })();

    const relativeUpdated = lastUpdateTime ? formatRelativeTime(lastUpdateTime, now) : null;

    const showBanner =
      (display.showOverallStatus || display.showUptimeStats) &&
      !layoutConfig.isCustom &&
      !statusPageError &&
      !isPageDisabled &&
      totalCount > 0;

    const handleBarEnter = (event: React.MouseEvent, name: string, day: HeartbeatDay) => {
      const lines = [
        `${name} · ${format(new Date(day.day), 'MMM d, yyyy')}`,
        getHeartbeatLabel(day.status),
      ];
      if (day.issueCount > 0) {
        lines.push(`${day.issueCount} incident${day.issueCount === 1 ? '' : 's'}`);
      }
      setBarTip({ x: event.clientX, y: event.clientY, lines });
    };

    // One card renderer for both grouped and flat grids — flat surface, status
    // chip, and a vertical uptime bar strip (no round indicators).
    const renderCheckCard = (check: BadgeData) => {
      const heartbeatDays = heartbeatMap[check.checkId];
      const hasHeartbeat = Array.isArray(heartbeatDays) && heartbeatDays.length > 0;
      const fullSeries = hasHeartbeat ? heartbeatDays : fallbackHeartbeat;
      const daySeries = fullSeries.slice(-historyDays);
      const showPlaceholder = heartbeatLoading && !hasHeartbeat;
      const windowUptime = hasHeartbeat ? computeWindowUptime(daySeries) : null;
      const uptime =
        formatUptime(windowUptime) ??
        (typeof check.uptimePercentage === 'number' && check.uptimePercentage >= 0
          ? formatUptime(check.uptimePercentage)
          : null);

      return (
        <div
          key={check.checkId}
          className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-muted-foreground/20"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium text-foreground truncate">{check.name}</div>
              <div className="text-xs text-muted-foreground/80 break-all">{check.url}</div>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${getHealthChipClasses(check.status)}`}
            >
              <span className={`size-1.5 rounded-[2px] ${getHealthTone(check.status)}`} />
              {getHealthLabel(check.status)}
            </span>
          </div>

          {display.showHistory && (
            <div className="mt-5 space-y-2">
              <div className={`flex items-end gap-[3px] h-9 w-full ${showPlaceholder ? 'animate-pulse' : ''}`}>
                {daySeries.map((day, index) => (
                  <span
                    key={`${check.checkId}-${day.day}-${index}`}
                    className={`flex-1 min-w-[2px] h-full rounded-[2px] ${getHeartbeatTone(day.status)}`}
                    onMouseEnter={(event) => handleBarEnter(event, check.name, day)}
                    onMouseLeave={() => setBarTip(null)}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span>{historyDays} days ago</span>
                {uptime !== null && (
                  <span className="font-medium text-muted-foreground">{uptime}% uptime</span>
                )}
                <span>Today</span>
              </div>
            </div>
          )}

          {display.showResponseTime && (check.lastChecked > 0 || typeof check.responseTime === 'number') && (
            <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 text-[11px] text-muted-foreground/70">
              <span>
                {typeof check.responseTime === 'number' ? `${check.responseTime} ms` : '—'}
              </span>
              {check.lastChecked > 0 && <span>Checked {formatRelativeTime(check.lastChecked, now)}</span>}
            </div>
          )}
        </div>
      );
    };

    const overallBanner = showBanner ? (
      <div className="mb-6 overflow-hidden rounded-xl border border-border bg-card">
        {display.showOverallStatus && (
          <div className="flex items-center gap-4 px-5 py-4">
            <span className={`h-10 w-1 rounded-[2px] ${overallMeta.tone}`} />
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold tracking-tight text-foreground">
                {overallMeta.label}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {relativeUpdated ? `Updated ${relativeUpdated}` : 'Live monitoring'}
              </div>
            </div>
          </div>
        )}
        {display.showUptimeStats && (
          <div className="grid grid-cols-3 gap-px border-t border-border bg-border text-center">
            <div className="bg-card px-3 py-3">
              <div className="text-sm font-semibold text-foreground">
                {aggregateUptime !== null ? `${aggregateUptime}%` : '—'}
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Uptime · {HEARTBEAT_DAYS}d
              </div>
            </div>
            <div className="bg-card px-3 py-3">
              <div className="text-sm font-semibold text-foreground">{incidentLabel}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Last incident
              </div>
            </div>
            <div className="bg-card px-3 py-3">
              <div className="text-sm font-semibold text-foreground">
                {operationalCount}/{totalCount}
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Operational
              </div>
            </div>
          </div>
        )}
      </div>
    ) : null;

    // Viewer controls: period toggle + legend for the history bars.
    const historyControls =
      display.showHistory && !layoutConfig.isCustom && !statusPageError && !isPageDisabled && totalCount > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
            {[7, 30, HEARTBEAT_DAYS].map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setHistoryDays(days)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  historyDays === days
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {days === HEARTBEAT_DAYS ? '90d' : `${days}d`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {[
              { label: 'Operational', tone: 'bg-success' },
              { label: 'Down', tone: 'bg-destructive' },
              { label: 'No data', tone: 'bg-muted' },
            ].map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <span className={`size-2 rounded-[2px] ${item.tone}`} />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      ) : null;

    return (
      <div className="min-h-screen bg-background flex flex-col" style={brandStyle}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <PageContainer>
            <PageHeader
              title={headerTitle}
              actions={refreshActions}
            />
            <div className="flex-1 overflow-auto p-2 sm:p-4 md:p-6">
              <div className={layoutConfig.wrapperClassName}>
                {overallBanner}
                {historyControls}
                {statusPage?.enabled === false && statusPage?.disabledReason === 'plan_downgrade' ? (
                  <Card className="border-2 border-muted/40">
                    <CardContent className="p-4 sm:p-8 text-center space-y-2">
                      <div className="text-lg font-semibold">This status page is currently inactive.</div>
                      <div className="text-sm text-muted-foreground">
                        The owner needs to upgrade their plan to restore this status page.
                      </div>
                    </CardContent>
                  </Card>
                ) : statusPageError ? (
                  <Card className="border-2 border-destructive/40">
                    <CardContent className="p-4 sm:p-8 text-center space-y-2">
                      <div className="text-lg font-semibold">{statusPageError}</div>
                      <div className="text-sm text-muted-foreground">
                        Ask the owner to make it public or sign in with the right account.
                      </div>
                    </CardContent>
                  </Card>
                ) : statusChecksLoading && statusChecks.length === 0 ? (
                  <div className={layoutConfig.gridClassName}>
                    {Array.from({ length: 4 }).map((_, index) => (
                      <Card key={index}>
                        <CardContent className="p-6 space-y-3">
                          <Skeleton className="h-4 w-40" />
                          <Skeleton className="h-3 w-full" />
                          <Skeleton className="h-3 w-32" />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (statusPage?.checkIds?.length ?? 0) === 0 && (statusPage?.folderPaths?.length ?? 0) === 0 && !layoutConfig.isCustom ? (
                  <EmptyState
                    variant="empty"
                    title="No checks selected"
                    description="This status page has no checks yet. Add checks in the settings."
                  />
                ) : layoutConfig.isCustom ? (
                  editMode ? (
                    <CustomLayoutEditor
                      initialLayout={statusPage?.customLayout ?? null}
                      checks={statusChecks}
                      fullChecks={fullChecks}
                      heartbeatMap={heartbeatMap}
                      onSave={handleSaveCustomLayout}
                      onCancel={() => setEditMode(false)}
                    />
                  ) : (
                    <WidgetGrid
                      widgets={statusPage?.customLayout?.widgets ?? []}
                      checks={statusChecks}
                      fullChecks={fullChecks}
                      heartbeatMap={heartbeatMap}
                      editMode={false}
                      onConfigureWidget={() => {}}
                    />
                  )
                ) : (
                  statusPage?.groupByFolder && groupedChecks ? (
                    <div className="space-y-6">
                      {groupedChecks.map((group) => (
                        <div key={group.key} className="space-y-3">
                          {(() => {
                            const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(folderColors, group.key);
                            const groupClasses = getFolderGroupClasses(groupColor);
                            return (
                              <div
                                className={`grid grid-cols-[1fr_auto] items-center gap-4 ${groupClasses.container}`}
                              >
                                <span className={`text-xs font-mono uppercase tracking-wider ${groupClasses.label || 'text-muted-foreground'}`}>
                                  {group.label}
                                </span>
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 justify-self-end">
                                  {group.checks.length}
                                </Badge>
                              </div>
                            );
                          })()}
                          <div className={`${layoutConfig.gridClassName} transition-opacity ${isRefreshing ? 'opacity-75' : 'opacity-100'}`}>
                            {group.checks.map(renderCheckCard)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={`${layoutConfig.gridClassName} transition-opacity ${isRefreshing ? 'opacity-75' : 'opacity-100'}`}>
                      {statusChecks.map(renderCheckCard)}
                    </div>
                  )
                )}
              </div>
            </div>
          </PageContainer>
        </div>
        <footer className="border-t border-border/60 bg-background/95">
          <div className="mx-auto w-full px-4 sm:px-6 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-pressed={isFullscreen}
                  onClick={async () => {
                    if (!document.fullscreenElement) {
                      await document.documentElement.requestFullscreen();
                    } else {
                      await document.exitFullscreen();
                    }
                  }}
                  className="inline-flex items-center justify-center size-8 rounded-full bg-background text-foreground hover:bg-muted transition-colors"
                >
                  {isFullscreen ? (
                    <Minimize className="h-4 w-4" />
                  ) : (
                    <Maximize className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  aria-pressed={soundEnabled}
                  onClick={() => {
                    const next = !soundEnabled;
                    setSoundEnabled(next);
                    if (next && hasDownChecks) {
                      startAlertLoop();
                    }
                  }}
                  className="inline-flex items-center justify-center size-8 rounded-full bg-background text-foreground hover:bg-muted transition-colors"
                >
                  {soundEnabled ? (
                    <Bell className="h-4 w-4" />
                  ) : (
                    <BellOff className="h-4 w-4" />
                  )}
                </button>
                <span className="text-xs text-muted-foreground">
                  Alert sound {soundEnabled ? 'on' : 'off'}
                </span>
                {canEdit && (
                  <>
                    <div className="w-px h-4 bg-border mx-2" />
                    <button
                      type="button"
                      aria-pressed={editMode}
                      onClick={() => setEditMode(!editMode)}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors cursor-pointer ${
                        editMode
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background text-foreground hover:bg-muted'
                      }`}
                    >
                      <Edit className="h-4 w-4" />
                      <span className="text-xs font-medium">
                        {editMode ? 'Editing' : 'Edit Layout'}
                      </span>
                    </button>
                  </>
                )}
              </div>
              {statusPage?.showPoweredBy !== false && (
                <a
                  href="https://exit1.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>Powered by exit1.dev</span>
                  <img src="/e_.svg" alt="exit1.dev" className="size-6" />
                </a>
              )}
            </div>
          </div>
        </footer>
        {barTip && (
          <div
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-tight shadow-md"
            style={{ left: barTip.x, top: barTip.y - 8 }}
          >
            {barTip.lines.map((line, index) => (
              <div
                key={index}
                className={index === 0 ? 'font-medium text-foreground' : 'text-muted-foreground'}
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const isOnline = badgeData?.status === 'online' || badgeData?.status === 'UP' || badgeData?.status === 'REDIRECT';

  return (
    <PageContainer className="min-h-screen">
      <div className="flex-1 flex items-center justify-center p-4 sm:p-6 min-h-full">
        <div className="w-full max-w-2xl">
          {badgeLoading ? (
            <Card className="border-2">
              <CardContent className="p-12">
                <div className="text-center space-y-6">
                  <Skeleton className="h-12 w-48 mx-auto" />
                  <Skeleton className="h-32 w-32 mx-auto rounded-full" />
                  <Skeleton className="h-6 w-64 mx-auto" />
                </div>
              </CardContent>
            </Card>
          ) : badgeError ? (
            <Card className="border-2 border-destructive/50">
              <CardContent className="p-12">
                <div className="text-center space-y-4">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                    <XCircle className="h-8 w-8 text-destructive" />
                  </div>
                  <div>
                    <h2 className="text-xl sm:text-2xl font-semibold mb-2">{badgeError}</h2>
                    <p className="text-md text-muted-foreground">
                      This check may not exist or has been disabled
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : badgeData ? (
            <>
              <div ref={certificateRef}>
                <PixelCard
                  variant="blue"
                  className="w-full max-w-2xl min-h-[600px] aspect-auto border-2 shadow-lg bg-gradient-to-br from-primary/[0.02] via-transparent to-transparent border-primary/10"
                >
                  <CardContent className="p12 absolute inset-0 z-10 flex flex-col justify-center pointer-events-auto">
                    <div className="text-center space-y-4 w-full">
                      <div className="space-y-2">
                        <div className="flex items-center justify-center gap-2 text-md text-muted-foreground mb-4">
                          <Shield className="h-4 w-4" />
                          <span>Trust Certificate</span>
                        </div>
                        <h1 className="text-2xl sm:text-3xl font-bold break-words">{badgeData.name}</h1>
                        <a
                          href={badgeData.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-md text-muted-foreground hover:text-primary cursor-pointer transition-colors break-all"
                        >
                          <ExternalLink className="h-4 w-4 flex-shrink-0" />
                          {badgeData.url}
                        </a>
                      </div>

                      <div>
                        <Badge
                          variant={isOnline ? 'success' : 'error'}
                          className="gap-2 px-6 py-3 text-lg cursor-default"
                        >
                          {isOnline ? (
                            <>
                              <CheckCircle className="h-5 w-5" />
                              Online
                            </>
                          ) : (
                            <>
                              <XCircle className="h-5 w-5" />
                              Offline
                            </>
                          )}
                        </Badge>
                      </div>

                      <div className="py-4">
                        <div className="inline-flex items-center justify-center w-40 h-40 rounded-full border-8 border-primary/20 bg-primary/5">
                          <div className="text-center">
                            <div className="text-4xl font-bold">
                              {badgeData.uptimePercentage >= 100 ? '100' : badgeData.uptimePercentage.toFixed(1)}%
                            </div>
                            <div className="text-md text-muted-foreground mt-1">
                              {badgeData.createdAt ? (
                                <div className="flex flex-col items-center">
                                  <span>Uptime</span>
                                  <span className="text-xs opacity-80">
                                    since {new Date(badgeData.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                  </span>
                                </div>
                              ) : (
                                'All-time Uptime'
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {badgeData.lastChecked > 0 && (
                        <div className="text-md text-muted-foreground">
                          Last verified: {new Date(badgeData.lastChecked).toLocaleString()}
                        </div>
                      )}

                      <div className="pt-6 border-t">
                        <div className="flex items-center justify-center gap-2 text-md text-muted-foreground">
                          <Shield className="h-4 w-4" />
                          <span>Verified by</span>
                          <a
                            href="https://exit1.dev"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-foreground hover:text-primary cursor-pointer transition-colors"
                          >
                            exit1.dev
                          </a>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </PixelCard>
              </div>

              <div className="flex items-center justify-center gap-4 mt-6">
                <Button
                  variant="outline"
                  onClick={handleShare}
                  className="gap-2 cursor-pointer"
                >
                  <Share2 className="h-4 w-4" />
                  Share
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDownload}
                  disabled={isDownloading}
                  className="gap-2 cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  {isDownloading ? 'Downloading...' : 'Download'}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
};

export default PublicStatus;
