import React from 'react';
import { Search, CalendarDays, Clock, Download, Folder } from 'lucide-react';
import { type DateRange } from "react-day-picker"

import { Button, TimeRangeSelector, Input, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './index';
import { DateRangeCalendar } from './DateRangeCalendar';
import type { TimeRange } from './TimeRangeSelector';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { getFolderGroupClasses, normalizeFolder } from '../../lib/folder-utils';
import { getTypeIcon } from '../../lib/check-utils';

interface FilterBarProps {
  // Time range
  timeRange: TimeRange | string;
  onTimeRangeChange: (range: TimeRange | string) => void;
  timeRangeOptions?: (TimeRange | string)[];
  disableTimeRangeToggle?: boolean;
  customStartDate?: string;
  customEndDate?: string;
  onCustomStartDateChange?: (date: string) => void;
  onCustomEndDateChange?: (date: string) => void;
  // Date range for calendar
  dateRange?: DateRange;
  onDateRangeChange?: (range: DateRange | undefined) => void;
  maxDateRangeDays?: number;
  
  // Search
  searchTerm: string;
  onSearchChange: (term: string) => void;
  searchPlaceholder?: string;
  hideSearch?: boolean;
  
  // Status filter
  statusFilter: string;
  onStatusChange: (status: string) => void;
  statusOptions?: { value: string; label: string }[];
  hideStatus?: boolean;
  
  // Website filter
  websiteFilter: string;
  onWebsiteChange: (website: string) => void;
  websiteOptions?: { value: string; label: string; folder?: string | null; type?: string; url?: string }[];
  includeAllWebsitesOption?: boolean;
  websitePlaceholder?: string;
  
  // Actions
  onRefresh?: () => void;
  onExport?: () => void;
  loading?: boolean;
  canExport?: boolean;
  
  // Layout
  variant?: 'compact' | 'full';
  // stacked renders one control per row with full width
  layout?: 'inline' | 'stacked';
  // control stacked rows order
  stackedOrder?: Array<'website' | 'timeRange' | 'dateRange' | 'search' | 'status' | 'actions'>;
  className?: string;
}

const FilterBar: React.FC<FilterBarProps> = ({
  timeRange,
  onTimeRangeChange,
  timeRangeOptions,
  disableTimeRangeToggle = false,
  customStartDate = '',
  customEndDate = '',
  onCustomStartDateChange,
  onCustomEndDateChange,
  dateRange,
  onDateRangeChange,
  maxDateRangeDays,
  searchTerm,
  onSearchChange,
  searchPlaceholder = "Search...",
  hideSearch = false,
  statusFilter,
  onStatusChange,
  statusOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'online', label: 'Online' },
    { value: 'offline', label: 'Offline' },
    { value: 'unknown', label: 'Unknown' }
  ],
  hideStatus = false,
  websiteFilter,
  onWebsiteChange,
  websiteOptions = [],
  includeAllWebsitesOption = true,
  websitePlaceholder = 'Select website',
  onRefresh,
  onExport,
  loading = false,
  canExport = false,
  variant = 'full',
  layout = 'inline',
  stackedOrder,
  className = ''
}) => {
  const isStacked = layout === 'stacked';

  // Folder colors are persisted by the Checks page in localStorage. Reading the
  // same key keeps the dropdown in sync with the visual grouping users see there.
  const [folderColors] = useLocalStorage<Record<string, string>>('checks-folder-view-colors-v1', {});

  // In-dropdown search state. Resets every time the dropdown closes so it
  // doesn't carry over to the next open.
  const [websiteSearchOpen, setWebsiteSearchOpen] = React.useState(false);
  const [websiteSearch, setWebsiteSearch] = React.useState('');
  const websiteSearchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!websiteSearchOpen) {
      setWebsiteSearch('');
      return;
    }
    // Radix Select moves focus to a list item on open AND every time the items
    // re-render — keystrokes shrink the list, which steals focus from the
    // input. Re-focus on the next frame whenever the open state or search term
    // changes so typing stays uninterrupted.
    const input = websiteSearchInputRef.current;
    if (!input) return;
    const id = requestAnimationFrame(() => {
      if (document.activeElement !== input) {
        const len = input.value.length;
        input.focus({ preventScroll: true });
        input.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [websiteSearchOpen, websiteSearch]);

  const filteredWebsiteOptions = React.useMemo(() => {
    const term = websiteSearch.trim().toLowerCase();
    if (!term) return websiteOptions;
    return websiteOptions.filter((o) => {
      const haystack = [o.label, o.folder, o.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [websiteOptions, websiteSearch]);

  const groupedWebsiteOptions = React.useMemo(() => {
    const hasAnyFolder = filteredWebsiteOptions.some((o) => (o.folder ?? '').trim().length > 0);
    if (!hasAnyFolder) return null;
    const groups = new Map<string, typeof filteredWebsiteOptions>();
    for (const opt of filteredWebsiteOptions) {
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
      options: groups.get(key)!
    }));
  }, [filteredWebsiteOptions]);

  const renderWebsiteOption = (option: { value: string; label: string; type?: string }) => (
    <SelectItem key={option.value} value={option.value} className="cursor-pointer">
      <span className="flex items-center gap-2">
        {getTypeIcon(option.type, 'size-3.5 shrink-0 text-muted-foreground')}
        <span className="truncate">{option.label}</span>
      </span>
    </SelectItem>
  );

  const renderWebsiteItems = () => {
    if (!groupedWebsiteOptions) {
      return filteredWebsiteOptions.map(renderWebsiteOption);
    }
    return groupedWebsiteOptions.map((group) => {
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
          {group.options.map(renderWebsiteOption)}
        </SelectGroup>
      );
    });
  };

  // Search input rendered as the first child of SelectContent. Radix Select
  // intercepts keystrokes for typeahead, so we stop propagation and prevent the
  // viewport from auto-focusing the first item, which would steal focus.
  const renderWebsiteSearch = () => (
    <div
      className="sticky top-0 z-10 -mx-1 -mt-1 mb-1 border-b border-border/60 bg-popover/95 backdrop-blur p-2"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={websiteSearchInputRef}
          type="text"
          value={websiteSearch}
          onChange={(e) => setWebsiteSearch(e.target.value)}
          onKeyDown={(e) => {
            // Don't let Radix's typeahead/navigation eat the keys, except Esc
            // which should still close the popover.
            if (e.key !== 'Escape') {
              e.stopPropagation();
            }
          }}
          placeholder="Search checks..."
          aria-label="Search checks"
          className="border-input placeholder:text-muted-foreground dark:bg-input/30 flex h-8 w-full rounded-md border bg-transparent pl-8 pr-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
      </div>
    </div>
  );

  const renderWebsiteEmpty = () => (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      No checks match "{websiteSearch}"
    </div>
  );
  // Build row blocks for reuse and ordering in stacked mode
  const rowBlocks: Record<string, React.ReactNode> = {
    timeRange: (
      <div className={isStacked ? 'w-full' : 'flex items-center justify-between'}>
        <div className={isStacked ? 'w-full' : 'flex items-center gap-4'}>
          <TimeRangeSelector
            value={timeRange}
            onChange={onTimeRangeChange}
            variant={variant}
            options={timeRangeOptions}
            disabled={disableTimeRangeToggle}
            className={isStacked ? 'w-full justify-between' : ''}
          />
        </div>
      </div>
    ),
    dateRange: (
      <>
        {variant === 'full' && onDateRangeChange && (
          <div className={isStacked ? 'w-full' : ''}>
            <DateRangeCalendar
              dateRange={dateRange}
              onDateRangeChange={onDateRangeChange}
              className={isStacked ? 'w-full' : 'w-72'}
              placeholder="Select date range"
              maxRangeDays={maxDateRangeDays}
            />
          </div>
        )}
        {variant === 'full' && !onDateRangeChange && (onCustomStartDateChange || onCustomEndDateChange) && (
          <div className={isStacked ? 'w-full flex items-center gap-2' : 'flex items-center gap-2'}>
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <Input
              type="date"
              value={customStartDate}
              onChange={(e) => onCustomStartDateChange?.(e.target.value)}
              className={isStacked ? 'w-full' : 'w-32'}
              placeholder="Start date"
            />
            <span className="text-muted-foreground">to</span>
            <Input
              type="date"
              value={customEndDate}
              onChange={(e) => onCustomEndDateChange?.(e.target.value)}
              className={isStacked ? 'w-full' : 'w-32'}
              placeholder="End date"
            />
          </div>
        )}
      </>
    ),
    search: hideSearch ? null : (
      <div className={isStacked ? 'relative w-full' : 'relative'}>
        <Search 
          className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" 
        />
        <Input
          type="text"
          placeholder={searchPlaceholder}
          aria-label="Search"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className={`${isStacked ? 'w-full' : 'min-w-[240px]'} pl-10`}
        />
      </div>
    ),
    status: hideStatus ? null : (
      <div className={isStacked ? 'w-full' : 'flex items-center gap-3'}>
        <Select value={statusFilter} onValueChange={onStatusChange}>
          <SelectTrigger className={`${isStacked ? 'w-full cursor-pointer' : 'w-[180px] cursor-pointer'}`} aria-label="Status">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ),
    website: (
      <>
        {websiteOptions.length > 0 && (
          <div className={isStacked ? 'w-full' : 'flex items-center gap-3'}>
            <Select value={websiteFilter} onValueChange={onWebsiteChange} open={websiteSearchOpen} onOpenChange={setWebsiteSearchOpen}>
              <SelectTrigger className={`${isStacked ? 'w-full cursor-pointer' : 'w-[220px] cursor-pointer'}`} aria-label="Website">
                <SelectValue placeholder={websitePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {renderWebsiteSearch()}
                {includeAllWebsitesOption && !websiteSearch && (
                  <SelectItem value="all" className="cursor-pointer">All Websites</SelectItem>
                )}
                {filteredWebsiteOptions.length === 0 ? renderWebsiteEmpty() : renderWebsiteItems()}
              </SelectContent>
            </Select>
          </div>
        )}
      </>
    ),
    actions: (
      <>
        {(onRefresh || onExport) && (
          <div className={isStacked ? 'flex items-center justify-end gap-3 w-full' : 'flex items-center gap-3'}>
            {onRefresh && (
              <Button
                onClick={onRefresh}
                disabled={loading}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 cursor-pointer"
              >
                <Clock className="w-4 h-4" />
                {loading ? 'Refreshing...' : 'Refresh'}
              </Button>
            )}
            
            {onExport && (
              <Button
                onClick={onExport}
                disabled={!canExport}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                Export
              </Button>
            )}
          </div>
        )}
      </>
    )
  };

  const defaultStackedOrder: Array<'website' | 'timeRange' | 'dateRange' | 'search' | 'status' | 'actions'> = [
    'website', 'timeRange', 'dateRange', 'status', 'search', 'actions'
  ];
  const order = isStacked ? (stackedOrder || defaultStackedOrder) : defaultStackedOrder;

  return (
    <div className={`space-y-4 ${className}`}>
      {isStacked ? (
        order
          .filter((key) => {
            if (key === 'search' && hideSearch) return false;
            if (key === 'status' && hideStatus) return false;
            return true;
          })
          .map((key) => (
            <div key={key}>{rowBlocks[key]}</div>
          ))
      ) : (
        <>
          {/* Inline layout keeps original grouping */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Time Range */}
              <TimeRangeSelector
                value={timeRange}
                onChange={onTimeRangeChange}
                variant={variant}
                options={timeRangeOptions}
                disabled={disableTimeRangeToggle}
              />
              {/* Date Range (calendar or legacy) */}
              {variant === 'full' && onDateRangeChange && (
                <DateRangeCalendar
                  dateRange={dateRange}
                  onDateRangeChange={onDateRangeChange}
                  className="w-72"
                  placeholder="Select date range"
                  maxRangeDays={maxDateRangeDays}
                />
              )}
              {variant === 'full' && !onDateRangeChange && (onCustomStartDateChange || onCustomEndDateChange) && (
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-muted-foreground" />
                  <Input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => onCustomStartDateChange?.(e.target.value)}
                    className="w-32"
                    placeholder="Start date"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => onCustomEndDateChange?.(e.target.value)}
                    className="w-32"
                    placeholder="End date"
                  />
                </div>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-4 flex-wrap justify-between">
            {/* Left side - Search and Filters */}
            <div className="flex items-center gap-4 flex-wrap">
              {/* Search */}
              {!hideSearch && (
                <div className="relative">
                  <Search 
                    className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" 
                  />
                  <Input
                    type="text"
                    placeholder={searchPlaceholder}
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="min-w-[240px] pl-10"
                  />
                </div>
              )}
              {/* Status Filter */}
              {!hideStatus && (
                <div className="flex items-center gap-3">
                  <Select value={statusFilter} onValueChange={onStatusChange}>
                    <SelectTrigger className="w-[180px] cursor-pointer">
                      <SelectValue placeholder="All Statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* Website Filter */}
              {websiteOptions.length > 0 && (
                <div className="flex items-center gap-3">
                  <Select value={websiteFilter} onValueChange={onWebsiteChange} open={websiteSearchOpen} onOpenChange={setWebsiteSearchOpen}>
                    <SelectTrigger className="w-[220px] cursor-pointer" aria-label="Website">
                      <SelectValue placeholder={websitePlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {renderWebsiteSearch()}
                      {includeAllWebsitesOption && !websiteSearch && (
                        <SelectItem value="all" className="cursor-pointer">All Websites</SelectItem>
                      )}
                      {filteredWebsiteOptions.length === 0 ? renderWebsiteEmpty() : renderWebsiteItems()}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            {/* Right side - Action Buttons */}
            {(onRefresh || onExport) && (
              <div className="flex items-center gap-3">
                {onRefresh && (
                  <Button
                    onClick={onRefresh}
                    disabled={loading}
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <Clock className="w-4 h-4" />
                    {loading ? 'Refreshing...' : 'Refresh'}
                  </Button>
                )}
                {onExport && (
                  <Button
                    onClick={onExport}
                    disabled={!canExport}
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    Export
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default FilterBar; 