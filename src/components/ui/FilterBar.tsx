import React from 'react';
import { Search, CalendarDays, Clock, Download } from 'lucide-react';
import { type DateRange } from "react-day-picker"

import { Button, TimeRangeSelector, Input, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './index';
import { DateRangeCalendar } from './DateRangeCalendar';
import type { TimeRange } from './TimeRangeSelector';

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
  websiteOptions?: { value: string; label: string; folder?: string | null }[];
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

  const groupedWebsiteOptions = React.useMemo(() => {
    const hasAnyFolder = websiteOptions.some((o) => (o.folder ?? '').trim().length > 0);
    if (!hasAnyFolder) return null;
    const groups = new Map<string, typeof websiteOptions>();
    for (const opt of websiteOptions) {
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
      label: key === '__unsorted__' ? 'Unsorted' : key,
      options: groups.get(key)!
    }));
  }, [websiteOptions]);

  const renderWebsiteItems = () => {
    if (!groupedWebsiteOptions) {
      return websiteOptions.map((option) => (
        <SelectItem key={option.value} value={option.value} className="cursor-pointer">
          {option.label}
        </SelectItem>
      ));
    }
    return groupedWebsiteOptions.map((group) => (
      <SelectGroup key={group.label}>
        <SelectLabel className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/80 px-2 pt-2 pb-1">
          {group.label}
        </SelectLabel>
        {group.options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="cursor-pointer">
            {option.label}
          </SelectItem>
        ))}
      </SelectGroup>
    ));
  };
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
            <Select value={websiteFilter} onValueChange={onWebsiteChange}>
              <SelectTrigger className={`${isStacked ? 'w-full cursor-pointer' : 'w-[180px] cursor-pointer'}`} aria-label="Website">
                <SelectValue placeholder={websitePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {includeAllWebsitesOption && (
                  <SelectItem value="all" className="cursor-pointer">All Websites</SelectItem>
                )}
                {renderWebsiteItems()}
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
                  <Select value={websiteFilter} onValueChange={onWebsiteChange}>
                    <SelectTrigger className="w-[180px] cursor-pointer">
                      <SelectValue placeholder={websitePlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {includeAllWebsitesOption && (
                        <SelectItem value="all" className="cursor-pointer">All Websites</SelectItem>
                      )}
                      {websiteOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                          {option.label}
                        </SelectItem>
                      ))}
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