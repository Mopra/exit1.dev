import React, { useRef, useEffect, useMemo } from 'react';
import { ExternalLink, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pageItems, actionItems, iconMap } from '@/lib/search-data';
import type { SearchItem } from '@/lib/search-data';
import type { SearchResults } from '@/hooks/useGlobalSearch';

interface SearchPaletteProps {
  query: string;
  results: SearchResults;
  recents: SearchItem[];
  hasMoreRecents: boolean;
  showAllRecents: boolean;
  onToggleShowAllRecents: () => void;
  onClearRecents: () => void;
  onSelect: (item: SearchItem) => void;
  onClose: () => void;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

const QUICK_LINK_IDS = ['page-checks', 'page-reports', 'page-logs'];

interface SectionProps {
  label: string;
  items: SearchItem[];
  activeIndex: number;
  globalOffset: number;
  onSelect: (item: SearchItem) => void;
  onHover: (index: number) => void;
  suffix?: React.ReactNode;
}

interface ActionsRowProps {
  items: SearchItem[];
  activeIndex: number;
  globalOffset: number;
  onSelect: (item: SearchItem) => void;
  onHover: (index: number) => void;
}

function ActionsRow({ items, activeIndex, globalOffset, onSelect, onHover }: ActionsRowProps) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label="Actions" className="border-b border-border last:border-b-0">
      <div className="px-4 py-2">
        <span className="text-sm font-semibold">Actions</span>
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-3">
        {items.map((item, i) => {
          const globalIdx = globalOffset + i;
          const isActive = globalIdx === activeIndex;
          const Icon = iconMap[item.iconName] ?? iconMap.Globe;
          return (
            <button
              key={item.id}
              id={`search-result-${globalIdx}`}
              role="option"
              aria-selected={isActive}
              className={cn(
                'flex items-center gap-1.5 rounded-md border border-border/40 px-2.5 py-1.5 text-xs font-medium cursor-pointer transition-colors',
                isActive ? 'bg-muted border-border' : 'hover:bg-muted'
              )}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(globalIdx)}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Section({ label, items, activeIndex, globalOffset, onSelect, onHover, suffix }: SectionProps) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label={label} className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-sm font-semibold">{label}</span>
        {suffix}
      </div>
      {items.map((item, i) => {
        const globalIdx = globalOffset + i;
        const isActive = globalIdx === activeIndex;
        const Icon = iconMap[item.iconName] ?? iconMap.Globe;
        return (
          <button
            key={item.id}
            id={`search-result-${globalIdx}`}
            role="option"
            aria-selected={isActive}
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-left text-sm cursor-pointer transition-colors',
              isActive ? 'bg-muted' : 'hover:bg-muted'
            )}
            onClick={() => onSelect(item)}
            onMouseEnter={() => onHover(globalIdx)}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{item.name}</div>
              {item.description && (
                <div className="truncate text-xs text-muted-foreground">{item.description}</div>
              )}
            </div>
            {item.external && (
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            )}
            {item.category === 'recent' && (
              <Clock className="size-3 shrink-0 text-muted-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SearchPalette(props: SearchPaletteProps) {
  const {
    query,
    results,
    recents,
    hasMoreRecents,
    showAllRecents,
    onToggleShowAllRecents,
    onClearRecents,
    onSelect,
    activeIndex,
    onActiveIndexChange,
  } = props;

  const listRef = useRef<HTMLDivElement>(null);
  const lastChangeSourceRef = useRef<'keyboard' | 'mouse'>('keyboard');

  const handleHover = (index: number) => {
    lastChangeSourceRef.current = 'mouse';
    onActiveIndexChange(index);
  };

  // Scroll active item into view — but only for keyboard changes, so mouse
  // hover (triggered by wheel-scrolling content under the cursor) doesn't
  // snap the scroll back.
  useEffect(() => {
    if (lastChangeSourceRef.current === 'mouse') {
      lastChangeSourceRef.current = 'keyboard';
      return;
    }
    const el = document.getElementById(`search-result-${activeIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const hasQuery = query.trim().length > 0;

  if (hasQuery) {
    if (results.total === 0) {
      return (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No results for &ldquo;{query}&rdquo;
        </div>
      );
    }

    let offset = 0;
    const sections: React.ReactNode[] = [];

    if (results.recents.length > 0) {
      sections.push(
        <Section key="recents" label="Recent" items={results.recents} activeIndex={activeIndex} globalOffset={offset} onSelect={onSelect} onHover={handleHover} />
      );
      offset += results.recents.length;
    }
    if (results.actions.length > 0) {
      sections.push(
        <ActionsRow key="actions" items={results.actions} activeIndex={activeIndex} globalOffset={offset} onSelect={onSelect} onHover={handleHover} />
      );
      offset += results.actions.length;
    }
    if (results.pages.length > 0) {
      sections.push(
        <Section key="pages" label="Pages" items={results.pages} activeIndex={activeIndex} globalOffset={offset} onSelect={onSelect} onHover={handleHover} />
      );
      offset += results.pages.length;
    }
    if (results.checks.length > 0) {
      sections.push(
        <Section key="checks" label="Checks" items={results.checks} activeIndex={activeIndex} globalOffset={offset} onSelect={onSelect} onHover={handleHover} />
      );
      offset += results.checks.length;
    }
    if (results.docs.length > 0) {
      sections.push(
        <Section key="docs" label="Docs" items={results.docs} activeIndex={activeIndex} globalOffset={offset} onSelect={onSelect} onHover={handleHover} />
      );
    }

    return (
      <div ref={listRef} role="listbox" className="max-h-[400px] overflow-y-auto">
        {sections}
      </div>
    );
  }

  // Quick links for empty state
  const quickLinks = useMemo(
    () => pageItems.filter((p) => QUICK_LINK_IDS.includes(p.id)),
    []
  );

  // Empty state: recents + actions + quick links
  let emptyOffset = 0;
  return (
    <div ref={listRef} role="listbox" className="max-h-80 overflow-y-auto py-1">
      {recents.length > 0 && (
        <>
          <Section
            label="Recent"
            items={recents}
            activeIndex={activeIndex}
            globalOffset={emptyOffset}
            onSelect={onSelect}
            onHover={handleHover}
            suffix={
              <button
                onClick={onClearRecents}
                className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              >
                Clear
              </button>
            }
          />
          {hasMoreRecents && (
            <button
              onClick={onToggleShowAllRecents}
              className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer text-left border-b border-border"
            >
              {showAllRecents ? 'Show less' : 'Show more'}
            </button>
          )}
          {(() => { emptyOffset += recents.length; return null; })()}
        </>
      )}
      <ActionsRow
        items={actionItems}
        activeIndex={activeIndex}
        globalOffset={emptyOffset}
        onSelect={onSelect}
        onHover={handleHover}
      />
      {(() => { emptyOffset += actionItems.length; return null; })()}
      <Section
        label="Quick Links"
        items={quickLinks}
        activeIndex={activeIndex}
        globalOffset={emptyOffset}
        onSelect={onSelect}
        onHover={handleHover}
      />
    </div>
  );
}
