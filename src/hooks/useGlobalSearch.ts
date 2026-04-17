import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Fuse from 'fuse.js';
import { useNavigate, useLocation } from 'react-router-dom';
import { type SearchItem, pageItems, docItems, actionItems, fuseOptions } from '@/lib/search-data';
import type { Website } from '@/types';

const RECENT_KEY = 'exit1:recent-pages';
const MAX_RECENTS = 20;
const DEFAULT_VISIBLE_RECENTS = 3;

// --- Recent pages (localStorage) ---

function loadRecents(): SearchItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SearchItem[];
  } catch {
    return [];
  }
}

function saveRecents(items: SearchItem[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// --- Convert checks to SearchItems ---

function checksToSearchItems(checks: Website[]): SearchItem[] {
  return checks.map((check) => ({
    id: `check-${check.id}`,
    name: check.name,
    description: check.url,
    path: '/checks',
    iconName: 'Globe' as const,
    keywords: [check.url, check.type ?? 'website'],
    category: 'check' as const,
  }));
}

// --- Grouped results type ---

export interface SearchResults {
  actions: SearchItem[];
  pages: SearchItem[];
  checks: SearchItem[];
  docs: SearchItem[];
  recents: SearchItem[];
  total: number;
}

const emptyResults: SearchResults = { actions: [], pages: [], checks: [], docs: [], recents: [], total: 0 };

// --- Hook ---

export function useGlobalSearch(
  checks: Website[],
  options: { isAdmin: boolean; isPaid: boolean }
) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<SearchItem[]>(loadRecents);
  const [showAllRecents, setShowAllRecents] = useState(false);

  // Filter pages by role
  const filteredPages = useMemo(() => {
    return pageItems.filter((item) => {
      if (item.adminOnly && !options.isAdmin) return false;
      if (item.paidOnly && !options.isPaid && !options.isAdmin) return false;
      return true;
    });
  }, [options.isAdmin, options.isPaid]);

  // Build fuse instances
  const pageFuse = useMemo(() => new Fuse(filteredPages, fuseOptions), [filteredPages]);
  const docFuse = useMemo(() => new Fuse(docItems, fuseOptions), []);
  const actionFuse = useMemo(() => new Fuse(actionItems, fuseOptions), []);
  const checkItems = useMemo(() => checksToSearchItems(checks), [checks]);
  const checkFuse = useMemo(() => new Fuse(checkItems, fuseOptions), [checkItems]);
  const recentFuse = useMemo(() => new Fuse(recents, fuseOptions), [recents]);

  // Search
  const results: SearchResults = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return emptyResults;

    const actionResults = actionFuse.search(trimmed, { limit: 3 }).map((r) => r.item);
    const pageResults = pageFuse.search(trimmed, { limit: 5 }).map((r) => r.item);
    const checkResults = checkFuse.search(trimmed, { limit: 5 }).map((r) => r.item);
    const docResults = docFuse.search(trimmed, { limit: 5 }).map((r) => r.item);
    const recentResults = recentFuse.search(trimmed, { limit: 5 }).map((r) => r.item);

    return {
      actions: actionResults,
      pages: pageResults,
      checks: checkResults,
      docs: docResults,
      recents: recentResults,
      total: actionResults.length + pageResults.length + checkResults.length + docResults.length + recentResults.length,
    };
  }, [query, actionFuse, pageFuse, checkFuse, docFuse, recentFuse]);

  // Visible recents for empty-state — memoized so the reference is stable
  // across renders when inputs haven't changed (a fresh slice each render
  // caused an effect in GlobalSearch to reset activeIndex, which snapped
  // the scroll position back to the top while scrolling).
  const visibleRecents = useMemo(
    () => (showAllRecents ? recents : recents.slice(0, DEFAULT_VISIBLE_RECENTS)),
    [recents, showAllRecents]
  );
  const hasMoreRecents = recents.length > DEFAULT_VISIBLE_RECENTS;

  // Add to recents — skip actions (they're shortcuts, not destinations)
  const addRecent = useCallback((item: SearchItem) => {
    if (item.category === 'action') return;
    setRecents((prev) => {
      const filtered = prev.filter((r) => r.path !== item.path);
      const updated = [{ ...item, category: 'recent' as const }, ...filtered].slice(0, MAX_RECENTS);
      saveRecents(updated);
      return updated;
    });
  }, []);

  // Clear recents
  const clearRecents = useCallback(() => {
    setRecents([]);
    saveRecents([]);
    setShowAllRecents(false);
  }, []);

  // Navigate to result
  const navigateTo = useCallback(
    (item: SearchItem) => {
      addRecent(item);
      if (item.external) {
        window.open(item.path, '_blank', 'noopener,noreferrer');
      } else if (item.actionIntent) {
        navigate(item.path, { state: { intent: item.actionIntent } });
      } else {
        navigate(item.path);
      }
    },
    [navigate, addRecent]
  );

  // Track page visits for recents
  const prevPathRef = useRef(location.pathname);
  useEffect(() => {
    const currentPath = location.pathname;
    if (currentPath === prevPathRef.current) return;
    prevPathRef.current = currentPath;

    const matchingPage = filteredPages.find((p) => p.path === currentPath);
    if (matchingPage) {
      addRecent(matchingPage);
    }
  }, [location.pathname, filteredPages, addRecent]);

  return {
    query,
    setQuery,
    results,
    recents: visibleRecents,
    hasMoreRecents,
    showAllRecents,
    setShowAllRecents,
    clearRecents,
    navigateTo,
  };
}
