import React, { useState, useCallback } from 'react';
import WebsiteListItem from './WebsiteListItem';
import type { Website } from '../../types';
import Button from '../ui/Button';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSort, faSortAlphaDown, faSortAlphaUp } from '@fortawesome/pro-regular-svg-icons';
import { theme, typography } from '../../config/theme';

interface WebsiteListProps {
  websites: Website[];
  onUpdate: (id: string, name: string, url: string) => void;
  onDelete: (id: string) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

type SortOption = 'custom' | 'name-asc' | 'name-desc' | 'url-asc' | 'url-desc' | 'status' | 'lastChecked' | 'createdAt';

const WebsiteList: React.FC<WebsiteListProps> = ({ websites, onUpdate, onDelete, onCheckNow, onToggleStatus, onReorder }) => {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('custom');
  const [showSortMenu, setShowSortMenu] = useState(false);

  // Sort websites based on selected option
  const sortedWebsites = React.useMemo(() => {
    const sorted = [...websites];
    
    switch (sortBy) {
      case 'custom':
        // Preserve the current order (respects drag & drop)
        return sorted.sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
      case 'name-asc':
        return sorted.sort((a, b) => a.name.localeCompare(b.name));
      case 'name-desc':
        return sorted.sort((a, b) => b.name.localeCompare(a.name));
      case 'url-asc':
        return sorted.sort((a, b) => a.url.localeCompare(b.url));
      case 'url-desc':
        return sorted.sort((a, b) => b.url.localeCompare(a.url));
      case 'status':
        return sorted.sort((a, b) => {
          const statusOrder = { 'online': 0, 'offline': 1, 'unknown': 2 };
          const aOrder = statusOrder[a.status || 'unknown'] ?? 2;
          const bOrder = statusOrder[b.status || 'unknown'] ?? 2;
          return aOrder - bOrder;
        });
      case 'lastChecked':
        return sorted.sort((a, b) => {
          const aTime = a.lastChecked || 0;
          const bTime = b.lastChecked || 0;
          return bTime - aTime; // Most recent first
        });
      case 'createdAt':
        return sorted.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      default:
        return sorted;
    }
  }, [websites, sortBy]);

  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index);
    }
  }, [draggedIndex]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== dropIndex) {
      onReorder(draggedIndex, dropIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, onReorder]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleSortChange = useCallback((option: SortOption) => {
    setSortBy(option);
    setShowSortMenu(false);
  }, []);

  // Close sort menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showSortMenu && !(event.target as Element).closest('.sort-menu-container')) {
        setShowSortMenu(false);
      }
    };

    if (showSortMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSortMenu]);

  const getSortIcon = () => {
    if (sortBy.includes('asc')) return faSortAlphaUp;
    if (sortBy.includes('desc')) return faSortAlphaDown;
    return faSort;
  };

  const sortOptions: Array<{ value: SortOption; label: string }> = [
    { value: 'custom', label: 'Custom Order (Drag & Drop)' },
    { value: 'name-asc', label: 'Name (A-Z)' },
    { value: 'name-desc', label: 'Name (Z-A)' },
    { value: 'url-asc', label: 'URL (A-Z)' },
    { value: 'url-desc', label: 'URL (Z-A)' },
    { value: 'status', label: 'Status (Online → Offline → Unknown)' },
    { value: 'lastChecked', label: 'Last Checked (Recent First)' },
    { value: 'createdAt', label: 'Date Added (Oldest First)' },
  ];

  const getSortLabel = () => {
    const option = sortOptions.find(opt => opt.value === sortBy);
    return option ? option.label.split(' (')[0] : 'Custom Order';
  };

  if (websites.length === 0) {
    return (
      <div className={`${typography.fontFamily.mono} ${theme.colors.text.primary} py-12 text-center`}>
        <div className="text-lg tracking-widest uppercase mb-2">No websites added yet.</div>
        <div className="text-sm opacity-80">→ Add your first website above</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-4 px-4">
      {/* Sort Controls */}
      <div className="flex justify-between items-center pb-4 sm:pb-0">
        <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
          {websites.length} website{websites.length !== 1 ? 's' : ''} monitored
        </div>
        
        <div className="relative sort-menu-container">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSortMenu(!showSortMenu)}
            className={`${typography.fontFamily.mono} ${theme.colors.text.primary} hover:${theme.colors.background.secondary}`}
          >
            <FontAwesomeIcon icon={getSortIcon()} className="w-4 h-4 mr-2" />
            Sort: {getSortLabel()}
          </Button>
          
          {showSortMenu && (
            <div className={`absolute right-0 top-full mt-1 ${theme.colors.background.modal} border ${theme.colors.border.console} rounded-lg z-10 min-w-[200px]`}>
              <div className="py-1">
                {sortOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleSortChange(option.value)}
                    className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} ${
                      sortBy === option.value ? `${theme.colors.text.primary} ${theme.colors.background.secondary}` : theme.colors.text.muted + ' ' + theme.colors.background.hover
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Websites List */}
      <ul className={`${typography.fontFamily.mono} ${theme.colors.text.primary} divide-y ${theme.colors.border.secondary} space-y-0`}>
        {sortedWebsites.map((website, index) => (
          <WebsiteListItem
            key={website.id}
            website={website}
            index={index}
            isDragging={draggedIndex === index}
            isDragOver={dragOverIndex === index}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onCheckNow={onCheckNow}
            onToggleStatus={onToggleStatus}
            onDragStart={sortBy === 'custom' ? handleDragStart : undefined}
            onDragOver={sortBy === 'custom' ? handleDragOver : undefined}
            onDragLeave={sortBy === 'custom' ? handleDragLeave : undefined}
            onDrop={sortBy === 'custom' ? handleDrop : undefined}
            onDragEnd={sortBy === 'custom' ? handleDragEnd : undefined}
            dragDisabled={sortBy !== 'custom'}
          />
        ))}
      </ul>
    </div>
  );
};

export default WebsiteList; 