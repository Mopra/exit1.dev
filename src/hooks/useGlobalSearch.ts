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

export type ResultCategory = 'recents' | 'actions' | 'pages' | 'checks' | 'docs';

export interface RankedSection {
  category: ResultCategory;
  items: SearchItem[];
}

export interface SearchResults {
  actions: SearchItem[];
  pages: SearchItem[];
  checks: SearchItem[];
  docs: SearchItem[];
  recents: SearchItem[];
  total: number;
  /** Non-empty sections ordered by best match score (best first) */
  orderedSections: RankedSection[];
}

const emptyResults: SearchResults = { actions: [], pages: [], checks: [], docs: [], recents: [], total: 0, orderedSections: [] };

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

    const actionRaw = actionFuse.search(trimmed, { limit: 3 });
    const pageRaw = pageFuse.search(trimmed, { limit: 5 });
    const checkRaw = checkFuse.search(trimmed, { limit: 5 });
    const docRaw = docFuse.search(trimmed, { limit: 5 });
    const recentRaw = recentFuse.search(trimmed, { limit: 5 });

    // Dedupe: if an item is already surfaced under Recents, hide the duplicate
    // in Pages/Checks/Docs so the same row doesn't appear twice.
    const recentPaths = new Set(recentRaw.map((r) => r.item.path));
    type Res = { item: SearchItem; score?: number };
    const notRecent = <T extends Res>(rs: T[]): T[] => rs.filter((r) => !recentPaths.has(r.item.path));

    const pageDeduped = notRecent(pageRaw);
    const checkDeduped = notRecent(checkRaw);
    const docDeduped = notRecent(docRaw);

    // Fuse.js scores: 0 = perfect, 1 = worst. Use the top hit per bucket.
    const bestScore = (rs: Res[]) => rs[0]?.score ?? Infinity;

    const buckets: Array<{ category: ResultCategory; raw: Res[] }> = [
      { category: 'recents', raw: recentRaw },
      { category: 'actions', raw: actionRaw },
      { category: 'pages', raw: pageDeduped },
      { category: 'checks', raw: checkDeduped },
      { category: 'docs', raw: docDeduped },
    ];

    const orderedSections: RankedSection[] = buckets
      .filter((b) => b.raw.length > 0)
      .sort((a, b) => bestScore(a.raw) - bestScore(b.raw))
      .map((b) => ({ category: b.category, items: b.raw.map((r) => r.item) }));

    const actionResults = actionRaw.map((r) => r.item);
    const pageResults = pageDeduped.map((r) => r.item);
    const checkResults = checkDeduped.map((r) => r.item);
    const docResults = docDeduped.map((r) => r.item);
    const recentResults = recentRaw.map((r) => r.item);

    return {
      actions: actionResults,
      pages: pageResults,
      checks: checkResults,
      docs: docResults,
      recents: recentResults,
      total: actionResults.length + pageResults.length + checkResults.length + docResults.length + recentResults.length,
      orderedSections,
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
