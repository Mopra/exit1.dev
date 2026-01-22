import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Bell, BellOff, CheckCircle, Download, ExternalLink, Maximize, Minimize, RefreshCw, Share2, Shield, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  GlowCard,
  Skeleton,
} from '../components/ui';
import PixelCard from '../components/PixelCard';
import { PageContainer, PageHeader } from '../components/layout';
import { toast } from 'sonner';
import { copyToClipboard } from '../utils/clipboard';
import { FEATURES } from '../config/features';
import { db } from '../firebase';
import { collection, doc, getDocs, limit, onSnapshot, query, where } from 'firebase/firestore';
import { apiClient } from '../api/client';
import type { StatusPage, StatusPageLayout } from '../types';
import { format } from 'date-fns';
import { useLocalStorage } from '../hooks/useLocalStorage';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  uptimePercentage: number;
  lastChecked: number;
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
};

const STATUS_API_URL = 'https://badgedata-xq5qkyhwba-uc.a.run.app';
const HEARTBEAT_DAYS = 30;
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
      return 'bg-emerald-500';
    case 'offline':
    case 'DOWN':
      return 'bg-destructive';
    case 'REACHABLE_WITH_ERROR':
      return 'bg-amber-500';
    case 'REDIRECT':
      return 'bg-sky-500';
    case 'disabled':
      return 'bg-amber-400';
    case 'unknown':
    default:
      return 'bg-muted-foreground/40';
  }
};

const getHealthSurface = (status?: string) => {
  switch (status) {
    case 'online':
    case 'UP':
      return 'bg-emerald-500/3';
    case 'offline':
    case 'DOWN':
      return 'bg-destructive/3';
    case 'REACHABLE_WITH_ERROR':
      return 'bg-amber-500/3';
    case 'REDIRECT':
      return 'bg-sky-500/3';
    case 'disabled':
      return 'bg-amber-400/3';
    case 'unknown':
    default:
      return 'bg-muted/10';
  }
};

const getHeartbeatTone = (status: HeartbeatStatus) => {
  switch (status) {
    case 'online':
      return 'bg-emerald-500';
    case 'offline':
      return 'bg-destructive';
    case 'unknown':
    default:
      return 'bg-muted-foreground/40';
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
  return svg.replace(
    '</svg>',
    `  <circle id="${FAVICON_MARKER_ID}" cx="50" cy="14" r="20" fill="#ef4444" stroke="#ffffff" stroke-width="4">\n` +
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
      };
    case 'single-5xl':
      return {
        gridClassName: 'grid gap-4 grid-cols-1',
        wrapperClassName: 'w-full max-w-5xl mx-auto',
      };
    case 'grid-2':
    default:
      return {
        gridClassName: 'grid gap-4 md:grid-cols-2',
        wrapperClassName: 'w-full',
      };
  }
};

type PublicStatusProps = {
  customDomain?: string | null;
};

const PublicStatus: React.FC<PublicStatusProps> = ({ customDomain }) => {
  const { checkId } = useParams<{ checkId: string }>();
  const resolvedCustomDomain = customDomain ?? (typeof window !== 'undefined' ? window.location.hostname : null);
  const isCustomDomainRoute = Boolean(resolvedCustomDomain && !checkId);
  const [mode, setMode] = useState<'status' | 'badge' | null>(null);
  const [statusPage, setStatusPage] = useState<StatusPage | null>(null);
  const [statusPageError, setStatusPageError] = useState<string | null>(null);
  const [statusDocLoading, setStatusDocLoading] = useState(true);
  const [customDomainId, setCustomDomainId] = useState<string | null>(null);
  const [customDomainLookupLoading, setCustomDomainLookupLoading] = useState(false);
  const [customDomainLookupError, setCustomDomainLookupError] = useState<string | null>(null);
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

  const [badgeData, setBadgeData] = useState<BadgeData | null>(null);
  const [badgeLoading, setBadgeLoading] = useState(true);
  const [badgeError, setBadgeError] = useState<string | null>(null);
  const certificateRef = useRef<HTMLDivElement>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const checkIdsKey = statusPage?.checkIds?.join('|') ?? '';
  const fallbackHeartbeat = React.useMemo(
    () => buildFallbackHeartbeat(heartbeatRange?.endDate ?? Date.now()),
    [heartbeatRange?.endDate]
  );
  const brandColor = normalizeBrandColor(statusPage?.branding?.brandColor);
  const brandLogoUrl = statusPage?.branding?.logoUrl?.trim() || null;
  const brandStyle = brandColor ? ({ '--status-brand': brandColor } as React.CSSProperties) : undefined;
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

  useEffect(() => {
    if (!isCustomDomainRoute || !resolvedCustomDomain) {
      setCustomDomainId(null);
      setCustomDomainLookupLoading(false);
      setCustomDomainLookupError(null);
      return;
    }

    let isActive = true;
    setCustomDomainLookupLoading(true);
    setCustomDomainLookupError(null);

    const lookup = async () => {
      try {
        const lookupQuery = query(
          collection(db, 'status_pages'),
          where('customDomain.hostname', '==', resolvedCustomDomain),
          where('visibility', '==', 'public'),
          limit(1)
        );
        const snapshot = await getDocs(lookupQuery);
        if (!isActive) return;
        if (snapshot.empty) {
          setCustomDomainId(null);
          setCustomDomainLookupError('No public status page is mapped to this domain.');
        } else {
          setCustomDomainId(snapshot.docs[0].id);
        }
      } catch (error) {
        console.error('[PublicStatus] Failed custom domain lookup:', error);
        if (isActive) {
          setCustomDomainLookupError('Unable to load this status page.');
        }
      } finally {
        if (isActive) {
          setCustomDomainLookupLoading(false);
        }
      }
    };

    void lookup();

    return () => {
      isActive = false;
    };
  }, [isCustomDomainRoute, resolvedCustomDomain]);

  const statusPageId = checkId ?? customDomainId;

  useEffect(() => {
    if (!statusPageId) {
      if (isCustomDomainRoute) {
        setMode('status');
        setStatusDocLoading(customDomainLookupLoading);
        setStatusPage(null);
        if (customDomainLookupLoading) {
          setStatusPageError(null);
        } else {
          setStatusPageError(customDomainLookupError ?? 'No status page found for this domain.');
        }
      } else {
        setMode('badge');
        setStatusDocLoading(false);
      }
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
        } else if (isCustomDomainRoute) {
          setMode('status');
          setStatusPageError('No public status page is mapped to this domain.');
        } else {
          setMode('badge');
        }
        setStatusDocLoading(false);
      },
      (error) => {
        if ((error as { code?: string })?.code === 'permission-denied') {
          setMode('status');
          setStatusPageError('This status page is private.');
        } else if (isCustomDomainRoute) {
          setMode('status');
          setStatusPageError('Unable to load this status page.');
        } else {
          setMode('badge');
        }
        setStatusDocLoading(false);
      }
    );

    return () => unsubscribe();
  }, [statusPageId, isCustomDomainRoute, customDomainLookupLoading, customDomainLookupError]);

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

  useEffect(() => {
    if (mode !== 'status' || statusPageError || !statusPage) return;

    const checkIds = statusPage.checkIds ?? [];
    if (checkIds.length === 0) {
      setStatusChecks([]);
      setStatusChecksLoading(false);
      return;
    }

    loadStatuses();
    const interval = setInterval(loadStatuses, REFRESH_INTERVAL);

    return () => {
      clearInterval(interval);
    };
  }, [mode, statusPageError, checkIdsKey, statusPage, loadStatuses]);

  useEffect(() => {
    if (mode !== 'status' || statusPageError || !statusPage) return;

    const checkIds = statusPage.checkIds ?? [];
    if (checkIds.length === 0) {
      setHeartbeatMap({});
      setHeartbeatLoading(false);
      return;
    }

    loadHeartbeat();
    const interval = setInterval(loadHeartbeat, HEARTBEAT_REFRESH_INTERVAL);

    return () => {
      clearInterval(interval);
    };
  }, [mode, statusPageError, checkIdsKey, statusPage, loadHeartbeat]);

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
    if (mode !== 'badge') return;

    if (!FEATURES.embeddableBadges) {
      setBadgeError('Embeddable badges are temporarily disabled.');
      setBadgeLoading(false);
      return;
    }

    const fetchData = async () => {
      if (!checkId) {
        setBadgeError('Invalid check ID');
        setBadgeLoading(false);
        return;
      }

      try {
        const response = await fetch(
          `${STATUS_API_URL}?checkId=${encodeURIComponent(checkId)}`
        );

        if (!response.ok) {
          if (response.status === 404) {
            setBadgeError('Check not found');
          } else {
            setBadgeError('Failed to load status');
          }
          setBadgeLoading(false);
          return;
        }

        const result = await response.json();

        if (result.success && result.data) {
          setBadgeData(result.data);
        } else {
          setBadgeError('Invalid response from server');
        }
      } catch (err) {
        console.error('Error fetching badge data:', err);
        setBadgeError('Failed to load status');
      } finally {
        setBadgeLoading(false);
      }
    };

    setBadgeLoading(true);
    setBadgeError(null);
    fetchData();
  }, [mode, checkId]);

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

    return (
      <div className="min-h-screen bg-background flex flex-col" style={brandStyle}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <PageContainer>
            <PageHeader
              title={headerTitle}
              actions={refreshActions}
            />
            <div className="flex-1 overflow-auto p-4 sm:p-6">
              <div className={layoutConfig.wrapperClassName}>
                {statusPageError ? (
                  <Card className="border-2 border-destructive/40">
                    <CardContent className="p-8 text-center space-y-2">
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
                ) : (statusPage?.checkIds?.length ?? 0) === 0 ? (
                  <EmptyState
                    variant="empty"
                    title="No checks selected"
                    description="This status page has no checks yet. Add checks in the settings."
                  />
                ) : (
                  statusPage?.groupByFolder && groupedChecks ? (
                    <div className="space-y-6">
                      {groupedChecks.map((group) => (
                        <div key={group.key} className="space-y-3">
                          {(() => {
                            const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(folderColors, group.key);
                            return (
                              <div
                                className={`grid grid-cols-[1fr_auto] items-center gap-4 ${groupColor ? `rounded-md border border-${groupColor}-400/30 bg-${groupColor}-500/10 px-2 py-1` : ''}`}
                              >
                                <span className={`text-xs font-mono uppercase tracking-wider ${groupColor ? `text-${groupColor}-200` : 'text-muted-foreground'}`}>
                                  {group.label}
                                </span>
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 justify-self-end">
                                  {group.checks.length}
                                </Badge>
                              </div>
                            );
                          })()}
                          <div className={`${layoutConfig.gridClassName} transition-opacity ${isRefreshing ? 'opacity-75' : 'opacity-100'}`}>
                            {group.checks.map((check) => {
                              const heartbeatDays = heartbeatMap[check.checkId];
                              const hasHeartbeat = Array.isArray(heartbeatDays) && heartbeatDays.length > 0;
                              const daySeries = hasHeartbeat ? heartbeatDays : fallbackHeartbeat;
                              const showPlaceholder = heartbeatLoading && !hasHeartbeat;

                              return (
                                <GlowCard
                                  key={check.checkId}
                                  className={`p-5 space-y-4 ${getHealthSurface(check.status)}`}
                                >
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 space-y-1">
                                      <div className="text-sm font-semibold text-foreground truncate">
                                        {check.name}
                                      </div>
                                      <div className="text-xs text-muted-foreground break-all">
                                        {check.url}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className={`h-2.5 w-2.5 rounded-full ${getHealthTone(check.status)}`} />
                                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {getHealthLabel(check.status)}
                                      </span>
                                    </div>
                                  </div>
                                  <div className={`grid grid-cols-[repeat(30,minmax(0,1fr))] gap-1 w-full ${showPlaceholder ? 'animate-pulse' : ''}`}>
                                    {daySeries.map((day, index) => (
                                      <span
                                        key={`${check.checkId}-${day.day}-${index}`}
                                        className={`aspect-square w-full rounded-full ${getHeartbeatTone(day.status)}`}
                                        title={`${format(new Date(day.day), 'MMM d')} - ${getHeartbeatLabel(day.status)}`}
                                      />
                                    ))}
                                  </div>
                                </GlowCard>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={`${layoutConfig.gridClassName} transition-opacity ${isRefreshing ? 'opacity-75' : 'opacity-100'}`}>
                      {statusChecks.map((check) => {
                        const heartbeatDays = heartbeatMap[check.checkId];
                        const hasHeartbeat = Array.isArray(heartbeatDays) && heartbeatDays.length > 0;
                        const daySeries = hasHeartbeat ? heartbeatDays : fallbackHeartbeat;
                        const showPlaceholder = heartbeatLoading && !hasHeartbeat;

                        return (
                          <GlowCard
                            key={check.checkId}
                            className={`p-5 space-y-4 ${getHealthSurface(check.status)}`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0 space-y-1">
                                <div className="text-sm font-semibold text-foreground truncate">
                                  {check.name}
                                </div>
                                <div className="text-xs text-muted-foreground break-all">
                                  {check.url}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`h-2.5 w-2.5 rounded-full ${getHealthTone(check.status)}`} />
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {getHealthLabel(check.status)}
                                </span>
                              </div>
                            </div>
                            <div className={`grid grid-cols-[repeat(30,minmax(0,1fr))] gap-1 w-full ${showPlaceholder ? 'animate-pulse' : ''}`}>
                              {daySeries.map((day, index) => (
                                <span
                                  key={`${check.checkId}-${day.day}-${index}`}
                                  className={`aspect-square w-full rounded-full ${getHeartbeatTone(day.status)}`}
                                  title={`${format(new Date(day.day), 'MMM d')} - ${getHeartbeatLabel(day.status)}`}
                                />
                              ))}
                            </div>
                          </GlowCard>
                        );
                      })}
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
              </div>
              <a
                href="https://exit1.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>Created in exit1.dev</span>
                <img src="/e_.svg" alt="Exit1.dev Logo" className="size-6" />
              </a>
            </div>
          </div>
        </footer>
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
                    <h2 className="text-2xl font-semibold mb-2">{badgeError}</h2>
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
                        <h1 className="text-3xl font-bold break-words">{badgeData.name}</h1>
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
