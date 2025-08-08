import React from 'react';
import { Search, CalendarDays, Clock, Download } from 'lucide-react';
import { type DateRange } from "react-day-picker"

import { Button, TimeRangeSelector, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './index';
import { DateRangeCalendar } from './DateRangeCalendar';
import type { TimeRange } from './TimeRangeSelector';

interface FilterBarProps {
  // Time range
  timeRange: TimeRange | string;
  onTimeRangeChange: (range: TimeRange | string) => void;
  customStartDate?: string;
  customEndDate?: string;
  onCustomStartDateChange?: (date: string) => void;
  onCustomEndDateChange?: (date: string) => void;
  // Date range for calendar
  dateRange?: DateRange;
  onDateRangeChange?: (range: DateRange | undefined) => void;
  
  // Search
  searchTerm: string;
  onSearchChange: (term: string) => void;
  searchPlaceholder?: string;
  
  // Status filter
  statusFilter: string;
  onStatusChange: (status: string) => void;
  statusOptions?: { value: string; label: string }[];
  
  // Website filter
  websiteFilter: string;
  onWebsiteChange: (website: string) => void;
  websiteOptions?: { value: string; label: string }[];
  
  // Actions
  onRefresh?: () => void;
  onExport?: () => void;
  loading?: boolean;
  canExport?: boolean;
  
  // Layout
  variant?: 'compact' | 'full';
  className?: string;
}

const FilterBar: React.FC<FilterBarProps> = ({
  timeRange,
  onTimeRangeChange,
  customStartDate = '',
  customEndDate = '',
  onCustomStartDateChange,
  onCustomEndDateChange,
  dateRange,
  onDateRangeChange,
  searchTerm,
  onSearchChange,
  searchPlaceholder = "Search...",
  statusFilter,
  onStatusChange,
  statusOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'online', label: 'Online' },
    { value: 'offline', label: 'Offline' },
    { value: 'unknown', label: 'Unknown' }
  ],
  websiteFilter,
  onWebsiteChange,
  websiteOptions = [],
  onRefresh,
  onExport,
  loading = false,
  canExport = false,
  variant = 'full',
  className = ''
}) => {
  return (
    <div className={`space-y-4 ${className}`}>
      {/* First Row - Time Range */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <TimeRangeSelector
            value={timeRange}
            onChange={onTimeRangeChange}
            variant={variant}
          />
          
          {/* Custom Date Range - Only show in full variant */}
          {variant === 'full' && onDateRangeChange && (
            <DateRangeCalendar
              dateRange={dateRange}
              onDateRangeChange={onDateRangeChange}
              className="w-72"
              placeholder="Select date range"
            />
          )}
          
          {/* Legacy Date Inputs - fallback when DateRangeCalendar is not used */}
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
      
      {/* Second Row - Search, Filters, and Actions */}
      <div className="flex items-center gap-4 flex-wrap justify-between">
        {/* Left side - Search and Filters */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Search */}
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
          
          {/* Status Filter */}
          <div className="flex items-center gap-3">
            <Select value={statusFilter} onValueChange={onStatusChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          {/* Website Filter */}
          {websiteOptions.length > 0 && (
            <div className="flex items-center gap-3">
              <Select value={websiteFilter} onValueChange={onWebsiteChange}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All Websites" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Websites</SelectItem>
                  {websiteOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
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
                className="flex items-center gap-2"
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
                className="flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Export
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default FilterBar; 