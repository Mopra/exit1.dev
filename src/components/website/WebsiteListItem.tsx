import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { IconButton, Badge, Button } from '../ui';
import type { Website } from '../../types';
import { theme, typography } from '../../config/theme';

interface WebsiteListItemProps {
  website: Website;
  index: number;
  isDragging: boolean;
  isDragOver: boolean;
  onUpdate: (id: string, name: string, url: string) => void;
  onDelete: (id: string) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onDragStart?: (index: number) => void;
  onDragOver?: (e: React.DragEvent, index: number) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent, index: number) => void;
  onDragEnd?: () => void;
  dragDisabled?: boolean;
}

const WebsiteListItem: React.FC<WebsiteListItemProps> = React.memo(({ 
  website, 
  index,
  isDragging,
  isDragOver,
  onUpdate, 
  onDelete, 
  onCheckNow,
  onToggleStatus,
  onDragStart,
  onDragOver: handleDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  dragDisabled = false
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [editName, setEditName] = useState(website.name);
  const [editUrl, setEditUrl] = useState(website.url);
  const [showMenu, setShowMenu] = useState(false);
  const nameRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const formatLastChecked = useCallback((timestamp?: number) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    return date.toLocaleString();
  }, []);

  const handleNameSave = useCallback(() => {
    if (nameRef.current) {
      const content = nameRef.current.textContent?.replace('→ ', '') || '';
      if (content.trim() && content.trim() !== website.name) {
        onUpdate(website.id, content.trim(), website.url);
      }
    }
    setIsEditingName(false);
  }, [website.id, website.name, website.url, onUpdate]);

  const handleUrlSave = useCallback(() => {
    if (urlRef.current) {
      const content = urlRef.current.textContent || '';
      if (content.trim() && content.trim() !== website.url) {
        onUpdate(website.id, website.name, content.trim());
      }
    }
    setIsEditingUrl(false);
  }, [website.id, website.name, website.url, onUpdate]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNameSave();
    } else if (e.key === 'Escape') {
      if (nameRef.current) {
        nameRef.current.textContent = `→ ${website.name}`;
      }
      setIsEditingName(false);
    }
  }, [handleNameSave, website.name]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlSave();
    } else if (e.key === 'Escape') {
      if (urlRef.current) {
        urlRef.current.textContent = website.url;
      }
      setIsEditingUrl(false);
    }
  }, [handleUrlSave, website.url]);

  const handleNameClick = useCallback(() => {
    setIsEditingName(true);
    setEditName(website.name);
  }, [website.name]);

  const handleUrlClick = useCallback(() => {
    setIsEditingUrl(true);
    setEditUrl(website.url);
  }, [website.url]);

  // Handle input changes without causing re-renders
  const handleNameInput = useCallback(() => {
    // Don't update state on every keystroke to prevent cursor jumping
    // The contentEditable element will maintain its own content
  }, []);

  const handleUrlInput = useCallback(() => {
    // Don't update state on every keystroke to prevent cursor jumping
    // The contentEditable element will maintain its own content
  }, []);

  const handleDelete = useCallback(() => {
    onDelete(website.id);
    setShowMenu(false);
  }, [onDelete, website.id]);

  const handleCheckNow = useCallback(() => {
    onCheckNow(website.id);
    setShowMenu(false);
  }, [onCheckNow, website.id]);

  const handleToggleStatus = useCallback(() => {
    onToggleStatus(website.id, !website.disabled);
    setShowMenu(false);
  }, [onToggleStatus, website.id, website.disabled]);

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowMenu(false);
    }
  }, []);

  // Focus contenteditable elements when they become editable
  useEffect(() => {
    if (isEditingName && nameRef.current) {
      nameRef.current.focus();
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(nameRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingUrl && urlRef.current) {
      urlRef.current.focus();
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(urlRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [isEditingUrl]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  return (
    <li 
      className={`relative flex flex-col md:flex-row md:items-center justify-between px-4 sm:px-6 py-8 sm:py-6 border-b ${theme.colors.border.secondary} last:border-b-0 ${theme.colors.background.card} transition-all duration-200 ${
        isDragging ? 'opacity-50 scale-95 rotate-1 shadow-lg' : ''
      } ${isDragOver ? `${theme.colors.background.card} ${theme.colors.border.primary} border-l-4` : ''}`}
      role="listitem"
      aria-labelledby={`website-${website.id}-name`}
      draggable={!dragDisabled}
      onDragStart={onDragStart ? () => onDragStart(index) : undefined}
      onDragOver={handleDragOver ? (e) => handleDragOver(e, index) : undefined}
      onDragLeave={onDragLeave || undefined}
      onDrop={onDrop ? (e) => onDrop(e, index) : undefined}
      onDragEnd={onDragEnd || undefined}
    >
      {/* Drag Handle */}
      <div 
        className={`hidden md:flex items-center justify-center w-8 h-8 mr-3 sm:mr-3 rounded transition-all duration-200 group ${
          dragDisabled 
            ? `cursor-default ${theme.colors.text.muted}` 
            : `cursor-grab active:cursor-grabbing ${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.card}`
        }`}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={dragDisabled ? 'Drag disabled - change to custom order' : `Drag to reorder ${website.name}`}
        title={dragDisabled ? 'Drag disabled - change to custom order' : 'Drag to reorder'}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            // Focus the list item to enable keyboard navigation
            e.currentTarget.parentElement?.focus();
          }
        }}
      >
        <FontAwesomeIcon 
          icon={['fas', 'bars']} 
          className={`w-4 h-4 transition-transform duration-200 ${
            dragDisabled ? '' : 'group-hover:scale-110'
          }`} 
        />
      </div>
      
      <div className="flex-1">
        <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-3">
          <div
            className={`uppercase tracking-widest ${typography.fontFamily.mono} ${theme.colors.text.primary} text-xl min-h-[1.5rem] flex items-center cursor-text`}
          >
            {isEditingName ? (
              <div
                ref={nameRef}
                contentEditable
                suppressContentEditableWarning
                onBlur={handleNameSave}
                onKeyDown={handleNameKeyDown}
                onInput={handleNameInput}
                className={`bg-transparent border-none focus:outline-none cursor-text focus:ring-2 focus:ring-white/50 focus:ring-inset ${theme.colors.text.primary} ${typography.fontFamily.mono} uppercase tracking-widest py-2 pl-2 pr-2 text-xl flex justify-start ${theme.colors.background.card}`}
                role="textbox"
                aria-label="Edit website name"
                aria-describedby={`website-${website.id}-edit-help`}
              >
                → {editName}
              </div>
            ) : (
              <Button
                id={`website-${website.id}-name`}
                variant="ghost"
                onClick={handleNameClick}
                aria-label={`Edit name: ${website.name}`}
                className="bg-transparent !cursor-text text-xl py-2 pl-2 pr-0 justify-start"
              >
                → {website.name}
              </Button>
            )}
          </div>
          {(isEditingName || isEditingUrl) && (
            <div 
              id={`website-${website.id}-edit-help`}
              className="sr-only"
              role="status"
              aria-live="polite"
            >
              Press Enter to save, Escape to cancel
            </div>
          )}
        </div>
        <div className={`w-full overflow-hidden flex items-center gap-2 sm:gap-3 mb-4 sm:mb-3`}>
          <div className={`${theme.colors.text.primary} ${typography.fontFamily.mono} min-h-[1.25rem] flex items-center uppercase cursor-text`}>
            {isEditingUrl ? (
              <div
                ref={urlRef}
                contentEditable
                suppressContentEditableWarning
                onBlur={handleUrlSave}
                onKeyDown={handleUrlKeyDown}
                onInput={handleUrlInput}
                className={`bg-transparent border-none focus:outline-none underline cursor-text focus:ring-2 focus:ring-white/50 focus:ring-inset ${theme.colors.text.primary} ${typography.fontFamily.mono} text-sm uppercase tracking-widest py-2 pl-2 pr-2 ${theme.colors.background.card} text-left flex justify-start items-center`}
                role="textbox"
                aria-label="Edit website URL"
                aria-describedby={`website-${website.id}-edit-help`}
              >
                {editUrl}
              </div>
            ) : (
              <Button 
                variant="ghost"
                onClick={handleUrlClick}
                aria-label={`Edit URL: ${website.url}`}
                className="bg-transparent underline !cursor-text py-2 pl-2 pr-0 justify-start text-left flex items-center"
              >
                {website.url}
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-0 px-4">
          <div className={`text-xs ${typography.fontFamily.mono} ${theme.colors.text.secondary} cursor-text`}>
            <span>Last checked: {formatLastChecked(website.lastChecked)}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 mt-6 sm:mt-4 md:mt-0 px-4 md:px-0">
        <div className="flex items-center gap-2 sm:gap-3">
          {website.disabled && (
            <Badge
              variant="default"
              size="md"
              className="bg-gray-600 text-gray-300"
              role="status"
              aria-label="Website disabled"
            >
              Disabled
            </Badge>
          )}
          <Badge
            variant={website.status === 'online' ? 'success' : website.status === 'offline' ? 'error' : 'default'}
            size="md"
            className={`${website.disabled ? 'opacity-50' : ''}`}
            role="status"
            aria-label={`Website status: ${website.status || 'unknown'}`}
          >
            {website.status || 'unknown'}
          </Badge>
        </div>
        {website.disabled && website.disabledReason && (
          <div className={`text-xs ${typography.fontFamily.mono} ${theme.colors.text.muted} italic text-right`}>
            {website.disabledReason}
          </div>
        )}
      </div>
      
      {/* Three-dot menu */}
      <div className="absolute top-4 right-4" ref={menuRef}>
        <IconButton
          icon={<FontAwesomeIcon icon={['fas', 'ellipsis']} className="w-5 h-5 cursor-pointer" />}
          variant="ghost"
          size="sm"
          onClick={() => setShowMenu(!showMenu)}
          onKeyDown={handleMenuKeyDown}
          aria-label="More options"
          aria-expanded={showMenu}
          aria-haspopup="menu"
        />
        
        {showMenu && (
          <div 
            className={`absolute right-0 top-8 ${theme.colors.background.modal} ${theme.colors.border.primary} z-10 min-w-[140px] rounded-xl`}
            role="menu"
            aria-label="Website actions"
          >
            {[
              { label: 'Check now', onClick: handleCheckNow, className: 'rounded-t-xl' },
              { label: website.disabled ? 'Enable' : 'Disable', onClick: handleToggleStatus },
              { label: 'Delete', onClick: handleDelete, className: 'rounded-b-xl' }
            ].map((item) => (
              <Button
                key={item.label}
                variant="ghost"
                onClick={item.onClick}
                role="menuitem"
                tabIndex={0}
                className={`w-full text-left px-4 py-2 ${theme.colors.background.card} focus:${theme.colors.button.primary.background} focus:text-black ${item.className || ''}`}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
});

WebsiteListItem.displayName = 'WebsiteListItem';

export default WebsiteListItem; 