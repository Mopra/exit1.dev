import React, { useState } from 'react';
import { ChevronUp, Plus } from 'lucide-react';
import {
  Button,
  ConfirmationModal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  glassClasses,
} from '../ui';
import type { WidgetType } from '../../types';
import { WIDGET_TYPES } from './WidgetEditChrome';

interface WidgetToolbarProps {
  onAddWidget: (type: WidgetType) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  hasUnsavedChanges?: boolean;
}

export const WidgetToolbar: React.FC<WidgetToolbarProps> = ({
  onAddWidget,
  onSave,
  onCancel,
  saving = false,
  hasUnsavedChanges = false,
}) => {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const handleCancel = () => {
    if (hasUnsavedChanges) setConfirmCancel(true);
    else onCancel();
  };

  return (
    <div className={`fixed bottom-0 left-0 right-0 z-[50] ${glassClasses} border-t`}>
      <div className="px-4 py-4 sm:px-6 max-w-screen-xl mx-auto">
        <div className="flex items-center justify-between gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Plus className="w-4 h-4" />
                Add widget
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-72">
              {WIDGET_TYPES.map(({ type, label, description, icon: Icon }) => (
                <DropdownMenuItem
                  key={type}
                  onSelect={() => onAddWidget(type)}
                  className="items-start gap-3 py-2 cursor-pointer"
                >
                  <Icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{label}</span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {hasUnsavedChanges && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                Unsaved changes
              </span>
            )}
            <Button variant="ghost" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={saving || !hasUnsavedChanges}>
              {saving ? 'Saving...' : 'Save Layout'}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmationModal
        isOpen={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          onCancel();
        }}
        title="Discard layout changes?"
        message="Your changes to this layout have not been saved."
        confirmText="Discard"
        cancelText="Keep editing"
        variant="warning"
      />
    </div>
  );
};
