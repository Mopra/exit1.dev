import React from 'react';
import { Search, Folder } from 'lucide-react';

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './Select';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { getFolderGroupClasses, normalizeFolder } from '../../lib/folder-utils';
import { getTypeIcon } from '../../lib/check-utils';

export type CheckSelectOption = {
  value: string;
  label: string;
  folder?: string | null;
  type?: string;
  url?: string;
};

interface CheckSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: CheckSelectOption[];
  placeholder?: string;
  includeAllOption?: boolean;
  allOptionLabel?: string;
  ariaLabel?: string;
  triggerClassName?: string;
  className?: string;
}

/**
 * Searchable check selector. Same UX as the website dropdown in
 * FilterBar — extracted so it can be embedded in page headers
 * (CheckDetails) without dragging in the rest of the filter row.
 */
export const CheckSelect: React.FC<CheckSelectProps> = ({
  value,
  onValueChange,
  options,
  placeholder = 'Select check',
  includeAllOption = false,
  allOptionLabel = 'All Websites',
  ariaLabel = 'Check',
  triggerClassName = 'w-[220px] cursor-pointer',
  className,
}) => {
  // Folder colors are persisted by the Checks page in localStorage.
  // Reading the same key keeps the dropdown's grouping visuals in sync.
  const [folderColors] = useLocalStorage<Record<string, string>>('checks-folder-view-colors-v1', {});

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      return;
    }
    // Radix Select moves focus to a list item on open AND every time the
    // items re-render. Re-focus on the next frame so typing isn't broken.
    const input = inputRef.current;
    if (!input) return;
    const id = requestAnimationFrame(() => {
      if (document.activeElement !== input) {
        const len = input.value.length;
        input.focus({ preventScroll: true });
        input.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [open, search]);

  const filteredOptions = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return options;
    return options.filter((o) => {
      const haystack = [o.label, o.folder, o.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [options, search]);

  const groupedOptions = React.useMemo(() => {
    const hasAnyFolder = filteredOptions.some((o) => (o.folder ?? '').trim().length > 0);
    if (!hasAnyFolder) return null;
    const groups = new Map<string, typeof filteredOptions>();
    for (const opt of filteredOptions) {
      const key = (opt.folder ?? '').trim() || '__unsorted__';
      const existing = groups.get(key);
      if (existing) existing.push(opt);
      else groups.set(key, [opt]);
    }
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      if (a === '__unsorted__') return 1;
      if (b === '__unsorted__') return -1;
      return a.localeCompare(b);
    });
    return sortedKeys.map((key) => ({
      key,
      label: key === '__unsorted__' ? 'Unsorted' : key,
      options: groups.get(key)!,
    }));
  }, [filteredOptions]);

  const renderOption = (option: CheckSelectOption) => (
    <SelectItem key={option.value} value={option.value} className="cursor-pointer">
      <span className="flex items-center gap-2">
        {getTypeIcon(option.type, 'size-3.5 shrink-0 text-muted-foreground')}
        <span className="truncate">{option.label}</span>
      </span>
    </SelectItem>
  );

  const renderItems = () => {
    if (!groupedOptions) {
      return filteredOptions.map(renderOption);
    }
    return groupedOptions.map((group) => {
      const folderKey = group.key === '__unsorted__' ? null : normalizeFolder(group.key);
      const rawColor = folderKey ? folderColors[folderKey] : undefined;
      const groupColor = rawColor && rawColor !== 'default' ? rawColor : undefined;
      const groupClasses = getFolderGroupClasses(groupColor);
      return (
        <SelectGroup key={group.label}>
          <SelectLabel
            className={`mx-1 mt-2 mb-1 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider ${groupClasses.container || 'px-2 py-1'} ${groupClasses.label || 'text-muted-foreground/80'}`}
          >
            <Folder className="size-3 shrink-0" />
            <span className="truncate">{group.label}</span>
          </SelectLabel>
          {group.options.map(renderOption)}
        </SelectGroup>
      );
    });
  };

  if (options.length === 0) return null;

  return (
    <div className={className}>
      <Select value={value} onValueChange={onValueChange} open={open} onOpenChange={setOpen}>
        <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <div
            className="sticky top-0 z-10 -mx-1 -mt-1 mb-1 border-b border-border/60 bg-popover/95 backdrop-blur p-2"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  // Let Esc close the popover but block typeahead/nav
                  // keys so they don't steal focus from the input.
                  if (e.key !== 'Escape') e.stopPropagation();
                }}
                placeholder="Search checks..."
                aria-label="Search checks"
                className="border-input placeholder:text-muted-foreground dark:bg-input/30 flex h-8 w-full rounded-md border bg-transparent pl-8 pr-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              />
            </div>
          </div>
          {includeAllOption && !search && (
            <SelectItem value="all" className="cursor-pointer">{allOptionLabel}</SelectItem>
          )}
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No checks match "{search}"
            </div>
          ) : (
            renderItems()
          )}
        </SelectContent>
      </Select>
    </div>
  );
};

export default CheckSelect;
