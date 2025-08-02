import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faSearch,
  faCalendar,
  faClock,
  faDownload
} from '@fortawesome/free-solid-svg-icons';

import { Button, TimeRangeSelector, Input, Select } from './index';
import type { TimeRange } from './TimeRangeSelector';

interface FilterBarProps {
  // Time range
  timeRange: TimeRange | string;
  onTimeRangeChange: (range: TimeRange | string) => void;
  customStartDate?: string;
  customEndDate?: string;
  onCustomStartDateChange?: (date: string) => void;
  onCustomEndDateChange?: (date: string) => void;
  
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
    <div className={`space-y-6 ${className}`}>
      {/* First Row - Date Filters */}
      <div className="space-y-4">
        {/* Date Selection Header */}
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faCalendar} className="w-4 h-4 text-neutral-400" />
          <span className="text-sm font-medium text-neutral-300">Date Range</span>
          <span className="text-xs text-neutral-500">(choose one option)</span>
        </div>
        
        {/* Date Selection Options */}
        <div className="flex items-start gap-6 flex-wrap">
          {/* Option 1: Predefined Time Ranges */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
              <span className="text-xs text-neutral-400 uppercase tracking-wide">Quick Select</span>
            </div>
            <TimeRangeSelector
              value={timeRange}
              onChange={onTimeRangeChange}
              variant={variant}
            />
          </div>
          
          {/* Option 2: Custom Date Range */}
          {onCustomStartDateChange && onCustomEndDateChange && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span className="text-xs text-neutral-400 uppercase tracking-wide">Custom Range</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => onCustomStartDateChange(e.target.value)}
                    id="start-date-input"
                    placeholder="Start date"
                    rightIcon={
                      <button
                        type="button"
                        onClick={() => (document.getElementById('start-date-input') as HTMLInputElement)?.showPicker?.()}
                        className="w-6 h-6 flex items-center justify-center text-neutral-300 hover:text-neutral-100 transition-colors cursor-pointer"
                      >
                        <FontAwesomeIcon icon={faCalendar} className="w-4 h-4" />
                      </button>
                    }
                  />
                </div>
                <span className="text-sm text-neutral-400">to</span>
                <div className="relative">
                  <Input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => onCustomEndDateChange(e.target.value)}
                    id="end-date-input"
                    placeholder="End date"
                    rightIcon={
                      <button
                        type="button"
                        onClick={() => (document.getElementById('end-date-input') as HTMLInputElement)?.showPicker?.()}
                        className="w-6 h-6 flex items-center justify-center text-neutral-300 hover:text-neutral-100 transition-colors cursor-pointer"
                      >
                        <FontAwesomeIcon icon={faCalendar} className="w-4 h-4" />
                      </button>
                    }
                  />
                </div>
              </div>
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
            <Input
              type="text"
              placeholder={searchPlaceholder}
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="min-w-[240px]"
              leftIcon={
                <FontAwesomeIcon 
                  icon={faSearch} 
                  className="w-4 h-4 text-neutral-300 pointer-events-none" 
                />
              }
            />
          </div>
          
          {/* Status Filter */}
          <div className="flex items-center gap-3">
            <Select
              value={statusFilter}
              onChange={(e) => onStatusChange(e.target.value)}
              options={statusOptions}
            />
          </div>
          
          {/* Website Filter */}
          {websiteOptions.length > 0 && (
            <div className="flex items-center gap-3">
              <Select
                value={websiteFilter}
                onChange={(e) => onWebsiteChange(e.target.value)}
                options={[
                  { value: '', label: 'All Websites' },
                  ...websiteOptions
                ]}
              />
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
                variant="gradient"
                size="sm"
                className="flex items-center gap-2"
              >
                <FontAwesomeIcon icon={faClock} className="w-4 h-4" />
                {loading ? 'Refreshing...' : 'Refresh'}
              </Button>
            )}
            
            {onExport && (
              <Button
                onClick={onExport}
                disabled={!canExport}
                variant="gradient"
                size="sm"
                className="flex items-center gap-2"
              >
                <FontAwesomeIcon icon={faDownload} className="w-4 h-4" />
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