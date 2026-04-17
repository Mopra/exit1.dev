import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { SearchPalette } from './SearchPalette';
import { useGlobalSearch, type SearchResults } from '@/hooks/useGlobalSearch';
import { pageItems, actionItems, type SearchItem } from '@/lib/search-data';
import type { Website } from '@/types';
import { cn } from '@/lib/utils';

interface GlobalSearchProps {
  checks: Website[];
  isAdmin: boolean;
  isPaid: boolean;
}

const QUICK_LINK_IDS = ['page-checks', 'page-reports', 'page-logs'];

function flattenResults(query: string, results: SearchResults, recents: SearchItem[]): SearchItem[] {
  if (query.trim()) {
    return [...results.recents, ...results.actions, ...results.pages, ...results.checks, ...results.docs];
  }
  const quickLinks = pageItems.filter((p) => QUICK_LINK_IDS.includes(p.id));
  return [...recents, ...actionItems, ...quickLinks];
}

export function GlobalSearch({ checks, isAdmin, isPaid }: GlobalSearchProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const {
    query,
    setQuery,
    results,
    recents,
    hasMoreRecents,
    showAllRecents,
    setShowAllRecents,
    clearRecents,
    navigateTo,
  } = useGlobalSearch(checks, { isAdmin, isPaid });

  const flatItems = flattenResults(query, results, recents);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [query, results, recents]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    setShowAllRecents(false);
    inputRef.current?.blur();
  }, [setQuery, setShowAllRecents]);

  // Ctrl+K / Cmd+K global shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const target = e.target as HTMLElement;
        if (
          target !== inputRef.current &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        if (open) {
          closeSearch();
        } else {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, closeSearch]);

  const handleSelect = useCallback(
    (item: SearchItem) => {
      navigateTo(item);
      closeSearch();
    },
    [navigateTo, closeSearch]
  );

  // Keyboard navigation inside the palette
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % Math.max(flatItems.length, 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + flatItems.length) % Math.max(flatItems.length, 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatItems[activeIndex]) {
            handleSelect(flatItems[activeIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          closeSearch();
          break;
      }
    },
    [flatItems, activeIndex, handleSelect, closeSearch]
  );

  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  return (
    <Popover open={open} onOpenChange={(isOpen) => { if (!isOpen) closeSearch(); }}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          className={cn(
            'relative flex items-center w-full max-w-xs sm:max-w-sm md:max-w-md',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2 w-full rounded-md border border-border/40 bg-background/40 px-2.5 h-8 text-sm cursor-text transition-colors',
              'hover:bg-background/60 hover:border-border/60',
              open && 'border-border/60 bg-background/60'
            )}
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            <Search className="size-3.5 text-muted-foreground/60 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!open) setOpen(true);
              }}
              onFocus={() => { if (!open) setOpen(true); }}
              onKeyDown={handleKeyDown}
              placeholder="Search or jump to..."
              className="hidden sm:block flex-1 bg-transparent outline-none placeholder:text-muted-foreground/40 text-sm min-w-0"
              role="combobox"
              aria-expanded={open}
              aria-controls="search-palette"
              aria-activedescendant={open ? `search-result-${activeIndex}` : undefined}
            />
            <kbd className="hidden md:inline-flex items-center gap-0.5 rounded border border-border/40 bg-background/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/50 select-none">
              {isMac ? '\u2318' : 'Ctrl+'}K
            </kbd>
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        id="search-palette"
        align="start"
        sideOffset={8}
        className="w-[var(--radix-popover-trigger-width)] min-w-[320px] max-w-[600px] p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onFocusOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <SearchPalette
          query={query}
          results={results}
          recents={recents}
          hasMoreRecents={hasMoreRecents}
          showAllRecents={showAllRecents}
          onToggleShowAllRecents={() => setShowAllRecents((v) => !v)}
          onClearRecents={clearRecents}
          onSelect={handleSelect}
          onClose={closeSearch}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
        />
      </PopoverContent>
    </Popover>
  );
}
