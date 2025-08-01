import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faSort, 
  faSortAlphaDown, 
  faEllipsisV,
  faCheck,
  faQuestionCircle,
  faPlus,
  faTrash
} from '@fortawesome/pro-regular-svg-icons';
import { IconButton, Button, Modal, Input, Label } from './index';
import { theme, typography } from '../../config/theme';
import { highlightText } from '../../utils/formatters.tsx';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  sortKey?: string;
  width?: string;
  hidden?: boolean;
  render: (item: T, index: number) => React.ReactNode;
}

export interface DataTableAction<T> {
  key: string;
  label: string;
  icon: any;
  onClick: (item: T) => void;
  disabled?: (item: T) => boolean;
  variant?: 'default' | 'danger' | 'warning' | 'success';
  className?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  actions?: DataTableAction<T>[];
  onEdit?: (item: T) => void;
  onDelete?: (item: T) => void;
  onBulkDelete?: (items: T[]) => void;
  onToggleStatus?: (item: T, disabled: boolean) => void;
  onBulkToggleStatus?: (items: T[], disabled: boolean) => void;
  searchQuery?: string;
  emptyState?: {
    icon?: any;
    title: string;
    description: string;
    action?: {
      label: string;
      onClick: () => void;
    };
  };
  getItemId: (item: T) => string;
  getItemName: (item: T) => string;
  isItemDisabled?: (item: T) => boolean;
  highlightText?: (text: string, query: string) => React.ReactNode;
  disableBulkSelection?: boolean;
  disableActions?: boolean;
}

type SortOption = 'custom' | string;

function DataTable<T>({
  data,
  columns,
  actions = [],
  onEdit,
  onDelete,
  onBulkDelete,
  onBulkToggleStatus,
  searchQuery = '',
  emptyState,
  getItemId,
  getItemName,
  isItemDisabled = () => false,
  disableBulkSelection = false,
  disableActions = false
}: DataTableProps<T>) {
  const [sortBy, setSortBy] = useState<SortOption>('custom');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editingItem, setEditingItem] = useState<T | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; url?: string }>({ name: '' });
  const [deletingItem, setDeletingItem] = useState<T | null>(null);
  
  // Multi-select state
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);

  // Sort data based on selected option
  const sortedData = React.useMemo(() => {
    const sorted = [...data];
    
    if (sortBy === 'custom') {
      return sorted;
    }
    
    // Find the column with the matching sort key
    const sortColumn = columns.find(col => col.sortKey === sortBy);
    if (!sortColumn) return sorted;
    
    // For now, we'll use a simple string comparison
    // In a real implementation, you might want to pass a sort function
    return sorted.sort((a, b) => {
      const aValue = getItemName(a).toLowerCase();
      const bValue = getItemName(b).toLowerCase();
      return aValue.localeCompare(bValue);
    });
  }, [data, sortBy, columns, getItemName]);

  const handleSortChange = useCallback((newSortBy: SortOption) => {
    setSortBy(newSortBy);
  }, []);

  // Calculate menu position to avoid overflow
  const calculateMenuPosition = useCallback((buttonElement: HTMLElement) => {
    const rect = buttonElement.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const menuHeight = 200;
    const menuWidth = 160;
    const gap = 4;
    
    const spaceBelow = viewportHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const spaceRight = viewportWidth - rect.right - gap;
    const spaceLeft = rect.left - gap;
    
    let verticalPosition: 'top' | 'bottom' = 'bottom';
    let horizontalPosition: 'left' | 'right' = 'left';
    
    if (spaceBelow < menuHeight && spaceAbove >= menuHeight) {
      verticalPosition = 'top';
    } else if (spaceBelow < menuHeight && spaceAbove < menuHeight) {
      verticalPosition = spaceAbove > spaceBelow ? 'top' : 'bottom';
    }
    
    if (spaceLeft < menuWidth && spaceRight >= menuWidth) {
      horizontalPosition = 'right';
    } else if (spaceLeft < menuWidth && spaceRight < menuWidth) {
      horizontalPosition = spaceRight > spaceLeft ? 'right' : 'left';
    }
    
    let x: number;
    let y: number;
    
    if (horizontalPosition === 'right') {
      x = rect.right + gap;
    } else {
      x = rect.left - menuWidth - gap;
    }
    
    if (verticalPosition === 'bottom') {
      y = rect.bottom + gap;
    } else {
      y = rect.top - menuHeight - gap;
    }
    
    const padding = 16;
    x = Math.max(padding, Math.min(x, viewportWidth - menuWidth - padding));
    y = Math.max(padding, Math.min(y, viewportHeight - menuHeight - padding));
    
    return { 
      position: { vertical: verticalPosition, horizontal: horizontalPosition },
      coords: { x, y }
    };
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openMenuId) {
        const target = event.target as Element;
        const isWithinActionMenu = target.closest('.action-menu');
        const isWithinMenu = target.closest('[data-menu="true"]');
        
        if (!isWithinActionMenu && !isWithinMenu) {
          setOpenMenuId(null);
        }
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);

  // Edit modal handlers
  const handleEditClick = (item: T) => {
    setEditingItem(item);
    setEditForm({ name: getItemName(item) });
    setOpenMenuId(null);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingItem && onEdit) {
      onEdit(editingItem);
      setEditingItem(null);
      setEditForm({ name: '' });
    }
  };

  const handleEditCancel = () => {
    setEditingItem(null);
    setEditForm({ name: '' });
  };

  // Delete confirmation handlers
  const handleDeleteClick = (item: T) => {
    setDeletingItem(item);
    setOpenMenuId(null);
  };

  const handleDeleteConfirm = () => {
    if (deletingItem && onDelete) {
      onDelete(deletingItem);
      setDeletingItem(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeletingItem(null);
  };

  // Multi-select handlers
  const handleSelectAll = useCallback(() => {
    if (selectAll) {
      setSelectedItems(new Set());
      setSelectAll(false);
    } else {
      setSelectedItems(new Set(sortedData.map(item => getItemId(item))));
      setSelectAll(true);
    }
  }, [selectAll, sortedData, getItemId]);

  const handleSelectItem = useCallback((itemId: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(itemId)) {
      newSelected.delete(itemId);
    } else {
      newSelected.add(itemId);
    }
    setSelectedItems(newSelected);
    setSelectAll(newSelected.size === sortedData.length);
  }, [selectedItems, sortedData.length]);

  const handleBulkDelete = useCallback(() => {
    setBulkDeleteModal(true);
  }, []);

  const handleBulkDeleteConfirm = useCallback(() => {
    if (onBulkDelete) {
      const selectedItemsList = sortedData.filter(item => selectedItems.has(getItemId(item)));
      onBulkDelete(selectedItemsList);
      setSelectedItems(new Set());
      setSelectAll(false);
      setBulkDeleteModal(false);
    }
  }, [onBulkDelete, selectedItems, sortedData, getItemId]);

  const handleBulkDeleteCancel = useCallback(() => {
    setBulkDeleteModal(false);
  }, []);

  const handleBulkToggleStatus = useCallback((disabled: boolean) => {
    if (onBulkToggleStatus) {
      const selectedItemsList = sortedData.filter(item => selectedItems.has(getItemId(item)));
      onBulkToggleStatus(selectedItemsList, disabled);
      setSelectedItems(new Set());
      setSelectAll(false);
    }
  }, [onBulkToggleStatus, selectedItems, sortedData, getItemId]);

  // Reset selection when data changes
  useEffect(() => {
    setSelectedItems(new Set());
    setSelectAll(false);
  }, [data]);

  const visibleColumns = columns.filter(col => !col.hidden);

  return (
    <div className="space-y-6">
      {/* Table */}
      <div className="overflow-hidden rounded-xl bg-gradient-to-br from-gray-950/80 to-black/90 backdrop-blur-sm border border-gray-800/50 shadow-md">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gradient-to-br from-black/85 to-gray-950/70 backdrop-blur-sm border-b border-gray-700/40">
              <tr>
                {!disableBulkSelection && (
                  <th className="px-2 sm:px-4 py-4 sm:py-6 text-left w-10 sm:w-12">
                    <div className="flex items-center justify-center">
                      <button
                        onClick={handleSelectAll}
                        className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectAll ? `${theme.colors.border.primary} ${theme.colors.background.primary}` : theme.colors.border.secondary} hover:${theme.colors.border.primary} cursor-pointer flex items-center justify-center`}
                        title={selectAll ? 'Deselect all' : 'Select all'}
                      >
                        {selectAll && (
                          <FontAwesomeIcon icon={faCheck} className="w-2.5 h-2.5 text-white" />
                        )}
                      </button>
                    </div>
                  </th>
                )}
                {visibleColumns.map((column) => (
                  <th 
                    key={column.key}
                    className={`px-4 sm:px-8 py-4 sm:py-6 text-left ${column.width || ''}`}
                  >
                    {column.sortable ? (
                      <button
                        onClick={() => handleSortChange(column.sortKey || column.key)}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors duration-150 cursor-pointer`}
                      >
                        {column.header}
                        <FontAwesomeIcon 
                          icon={sortBy === (column.sortKey || column.key) ? faSortAlphaDown : faSort} 
                          className="w-3 h-3" 
                        />
                      </button>
                    ) : (
                      <div className={`text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                        {column.header}
                      </div>
                    )}
                  </th>
                ))}
                {!disableActions && (
                  <th className="px-4 sm:px-8 py-4 sm:py-6 text-center w-12 sm:w-16">
                    <div className={`text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                      Actions
                    </div>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/30">
              {sortedData.map((item, index) => (
                <tr 
                  key={getItemId(item)}
                  className={`${theme.colors.background.tableRowHover} transition-colors duration-150 ${isItemDisabled(item) ? 'opacity-50' : ''}`}
                >
                  {!disableBulkSelection && (
                    <td className={`px-2 sm:px-4 py-4 sm:py-6 ${isItemDisabled(item) ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-center">
                        <button
                          onClick={() => handleSelectItem(getItemId(item))}
                          className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectedItems.has(getItemId(item)) ? `${theme.colors.border.primary} ${theme.colors.background.primary}` : theme.colors.border.secondary} hover:${theme.colors.border.primary} cursor-pointer flex items-center justify-center`}
                          title={selectedItems.has(getItemId(item)) ? 'Deselect' : 'Select'}
                        >
                          {selectedItems.has(getItemId(item)) && (
                            <FontAwesomeIcon icon={faCheck} className="w-2.5 h-2.5 text-white" />
                          )}
                        </button>
                      </div>
                    </td>
                  )}
                  {visibleColumns.map((column) => (
                    <td 
                      key={column.key}
                      className={`px-4 sm:px-8 py-4 sm:py-6 ${isItemDisabled(item) ? 'opacity-50' : ''} ${column.width || ''}`}
                    >
                      {column.render(item, index)}
                    </td>
                  ))}
                  {!disableActions && (
                    <td className="px-4 sm:px-8 py-4 sm:py-6">
                      <div className="flex items-center justify-center">
                        <div className="relative action-menu pointer-events-auto">
                          <IconButton
                            icon={<FontAwesomeIcon icon={faEllipsisV} className="w-4 h-4" />}
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              const newMenuId = openMenuId === getItemId(item) ? null : getItemId(item);
                              if (newMenuId) {
                                const result = calculateMenuPosition(e.currentTarget);
                                setMenuCoords(result.coords);
                              }
                              setOpenMenuId(newMenuId);
                            }}
                            aria-label="More actions"
                            aria-expanded={openMenuId === getItemId(item)}
                            aria-haspopup="menu"
                            className={`hover:${theme.colors.background.hover} pointer-events-auto p-2 sm:p-1`}
                          />
                        </div>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        {data.length === 0 && emptyState && (
          <div className="px-4 sm:px-8 py-8 sm:py-16 text-center">
            {searchQuery ? (
              // No search results
              <>
                <div className="mx-auto flex items-center justify-center h-12 sm:h-16 w-12 sm:w-16 rounded-full bg-gray-100 mb-4 sm:mb-6">
                  <FontAwesomeIcon icon={faQuestionCircle} className="h-6 sm:h-8 w-6 sm:w-8 text-gray-600" />
                </div>
                <div className={`text-lg sm:text-xl font-medium ${theme.colors.text.primary} mb-2 sm:mb-3`}>
                  No items found
                </div>
                <div className={`text-sm ${theme.colors.text.muted} mb-4 sm:mb-6 max-w-md mx-auto`}>
                  No items match your search for "{searchQuery}". Try adjusting your search terms.
                </div>
              </>
            ) : (
              // No items configured
              <>
                <div className="mx-auto flex items-center justify-center h-12 sm:h-16 w-12 sm:w-16 rounded-full bg-blue-100 mb-4 sm:mb-6">
                  <FontAwesomeIcon icon={emptyState.icon || faQuestionCircle} className="h-6 sm:h-8 w-6 sm:w-8 text-blue-600" />
                </div>
                <div className={`text-lg sm:text-xl font-medium ${theme.colors.text.primary} mb-2 sm:mb-3`}>
                  {emptyState.title}
                </div>
                <div className={`text-sm ${theme.colors.text.muted} mb-4 sm:mb-6 max-w-md mx-auto`}>
                  {emptyState.description}
                </div>
                {emptyState.action && (
                  <Button
                    onClick={emptyState.action.onClick}
                    variant="primary"
                    size="lg"
                    className="flex items-center gap-2"
                  >
                    <FontAwesomeIcon icon={faPlus} className="w-4 h-4" />
                    {emptyState.action.label}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {onEdit && (
        <Modal
          isOpen={!!editingItem}
          onClose={handleEditCancel}
          title="Edit Item"
          size="md"
        >
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Enter name"
                required
              />
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" className="flex-1">
                Update
              </Button>
              <Button type="button" variant="secondary" onClick={handleEditCancel} className="flex-1">
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Confirmation Modal */}
      {onDelete && (
        <Modal
          isOpen={!!deletingItem}
          onClose={handleDeleteCancel}
          title="Delete Item"
          size="md"
        >
          <div className="space-y-4">
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <FontAwesomeIcon icon={faTrash} className="h-6 w-6 text-red-600" />
              </div>
              <h3 className={`text-lg font-medium ${theme.colors.text.primary} mb-2`}>
                Delete "{deletingItem ? getItemName(deletingItem) : ''}"?
              </h3>
              <p className={`text-sm ${theme.colors.text.muted}`}>
                This action cannot be undone. The item will be permanently removed.
              </p>
            </div>

            <div className="flex gap-3 pt-4">
              <Button 
                onClick={handleDeleteConfirm}
                variant="danger"
                className="flex-1"
              >
                Delete
              </Button>
              <Button 
                onClick={handleDeleteCancel}
                variant="secondary"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {onBulkDelete && (
        <Modal
          isOpen={bulkDeleteModal}
          onClose={handleBulkDeleteCancel}
          title="Delete Multiple Items"
          size="md"
        >
          <div className="space-y-4">
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <FontAwesomeIcon icon={faTrash} className="h-6 w-6 text-red-600" />
              </div>
              <h3 className={`text-lg font-medium ${theme.colors.text.primary} mb-2`}>
                Delete {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''}?
              </h3>
              <p className={`text-sm ${theme.colors.text.muted}`}>
                This action cannot be undone. All selected items will be permanently removed.
              </p>
            </div>

            <div className="flex gap-3 pt-4">
              <Button 
                onClick={handleBulkDeleteConfirm}
                variant="danger"
                className="flex-1"
              >
                Delete {selectedItems.size} Item{selectedItems.size !== 1 ? 's' : ''}
              </Button>
              <Button 
                onClick={handleBulkDeleteCancel}
                variant="secondary"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Portal-based Action Menu */}
      {openMenuId && (() => {
        const item = data.find(i => getItemId(i) === openMenuId);
        if (!item) return null;
        
        return createPortal(
          <div 
            data-menu="true" 
            className={`fixed ${theme.colors.background.modal} border ${theme.colors.border.primary} rounded-lg z-[55] min-w-[160px] shadow-lg pointer-events-auto`}
            style={{
              left: `${menuCoords.x}px`,
              top: `${menuCoords.y}px`
            }}
          >
            <div className="py-1">
              {actions.map((action) => (
                <button
                  key={action.key}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!action.disabled || !action.disabled(item)) {
                      action.onClick(item);
                    }
                    setOpenMenuId(null);
                  }}
                  disabled={action.disabled ? action.disabled(item) : false}
                  className={`w-full text-left px-4 py-2 text-sm ${action.disabled && action.disabled(item) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${typography.fontFamily.mono} ${action.disabled && action.disabled(item) ? '' : `hover:${theme.colors.background.hover} ${theme.colors.text.primary}`} ${action.disabled && action.disabled(item) ? theme.colors.text.muted : ''} flex items-center gap-2 ${action.className || ''}`}
                >
                  <FontAwesomeIcon icon={action.icon} className="w-3 h-3" />
                  {action.label}
                </button>
              ))}
              {onEdit && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditClick(item);
                  }}
                  className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} ${theme.colors.text.primary} hover:text-blue-400 flex items-center gap-2`}
                >
                  <FontAwesomeIcon icon="edit" className="w-3 h-3" />
                  Edit
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteClick(item);
                  }}
                  className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} text-red-500 hover:text-red-400 flex items-center gap-2`}
                >
                  <FontAwesomeIcon icon={faTrash} className="w-3 h-3" />
                  Delete
                </button>
              )}
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Floating Bulk Actions Toolbar */}
      {selectedItems.size > 0 && (onBulkDelete || onBulkToggleStatus) && (
        <div className={`fixed bottom-20 sm:bottom-1 left-4 right-4 z-[35] flex flex-col sm:flex-row items-center justify-between p-4 sm:p-6 rounded-lg border shadow-lg backdrop-blur-xl ${theme.colors.border.secondary} ${theme.colors.background.modal} max-w-[95vw]`}>
          <div className="flex items-center gap-4 mb-3 sm:mb-0">
            <span className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.primary}`}>
              {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''} selected
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onBulkToggleStatus && (
              <>
                <Button
                  onClick={() => handleBulkToggleStatus(false)}
                  variant="secondary"
                  size="sm"
                  className="flex items-center gap-2"
                >
                  <FontAwesomeIcon icon="play" className="w-3 h-3" />
                  <span className="hidden sm:inline">Enable All</span>
                  <span className="sm:hidden">Enable</span>
                </Button>
                <Button
                  onClick={() => handleBulkToggleStatus(true)}
                  variant="secondary"
                  size="sm"
                  className="flex items-center gap-2"
                >
                  <FontAwesomeIcon icon="pause" className="w-3 h-3" />
                  <span className="hidden sm:inline">Disable All</span>
                  <span className="sm:hidden">Disable</span>
                </Button>
              </>
            )}
            {onBulkDelete && (
              <Button
                onClick={handleBulkDelete}
                variant="danger"
                size="sm"
                className="flex items-center gap-2"
              >
                <FontAwesomeIcon icon={faTrash} className="w-3 h-3" />
                <span className="hidden sm:inline">Delete All</span>
                <span className="sm:hidden">Delete</span>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable; 