import React from 'react';
import EmptyState from '../ui/EmptyState';
import { Button } from '../ui/button';
import { List, Plus, Search, Settings } from 'lucide-react';

interface LogsEmptyStateProps {
  variant: 'no-website' | 'no-logs' | 'no-results';
  onSelectWebsite?: () => void;
  onClearFilters?: () => void;
  onAddWebsite?: () => void;
}

export const LogsEmptyState: React.FC<LogsEmptyStateProps> = ({
  variant,
  onSelectWebsite,
  onClearFilters,
  onAddWebsite
}) => {
  switch (variant) {
    case 'no-website':
      return (
        <div className="flex flex-col items-center justify-center h-64 space-y-6">
          <EmptyState
            variant="empty"
            icon={List}
            title="Select a Website"
            description="Choose a website from the dropdown above to view its logs from BigQuery"
          />
          <div className="flex flex-col sm:flex-row gap-3">
            {onSelectWebsite && (
              <Button onClick={onSelectWebsite} variant="outline">
                <Search className="w-4 h-4 mr-2" />
                Browse Websites
              </Button>
            )}
            {onAddWebsite && (
              <Button onClick={onAddWebsite}>
                <Plus className="w-4 h-4 mr-2" />
                Add Website
              </Button>
            )}
          </div>
        </div>
      );

    case 'no-logs':
      return (
        <div className="flex flex-col items-center justify-center h-64 space-y-6">
          <EmptyState
            variant="empty"
            icon={List}
            title="No Logs Found"
            description="This website doesn't have any logs in BigQuery for the selected time range"
          />
          <div className="flex flex-col sm:flex-row gap-3">
            {onClearFilters && (
              <Button onClick={onClearFilters} variant="outline">
                <Settings className="w-4 h-4 mr-2" />
                Adjust Filters
              </Button>
            )}
          </div>
        </div>
      );

    case 'no-results':
      return (
        <div className="flex flex-col items-center justify-center h-64 space-y-6">
          <EmptyState
            variant="empty"
            icon={Search}
            title="No Results Found"
            description="Try adjusting your search terms or filters to find what you're looking for"
          />
          <div className="flex flex-col sm:flex-row gap-3">
            {onClearFilters && (
              <Button onClick={onClearFilters} variant="outline">
                <Settings className="w-4 h-4 mr-2" />
                Adjust Filters
              </Button>
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
};
