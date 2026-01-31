import React from 'react';
import { GripVertical, Settings, Type } from 'lucide-react';
import { GlowCard } from '../ui';
import type { CustomLayoutWidget, TextWidgetSize } from '../../types';

interface TextWidgetProps {
  widget: CustomLayoutWidget;
  editMode: boolean;
  onConfigure: (widgetId: string) => void;
}

const getTextSizeClasses = (size: TextWidgetSize = 'medium'): string => {
  switch (size) {
    case 'small':
      return 'text-sm';
    case 'large':
      return 'text-2xl font-semibold';
    case 'medium':
    default:
      return 'text-base';
  }
};

export const TextWidget: React.FC<TextWidgetProps> = ({
  widget,
  editMode,
  onConfigure,
}) => {
  const hasContent = widget.textContent && widget.textContent.trim().length > 0;

  if (!hasContent && !editMode) {
    return null;
  }

  if (!hasContent) {
    return (
      <GlowCard className="group p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        {editMode && (
          <>
            <div className="drag-handle absolute top-1 left-1 p-2 cursor-grab active:cursor-grabbing rounded hover:bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity">
              <GripVertical className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="absolute bottom-2 right-2 pointer-events-none">
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/50">
                <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </>
        )}
        <Type className="w-8 h-8 text-muted-foreground/50" />
        <div className="text-sm text-muted-foreground text-center">
          No text entered
        </div>
        {editMode && (
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="text-xs text-primary hover:underline cursor-pointer"
          >
            Configure widget
          </button>
        )}
      </GlowCard>
    );
  }

  return (
    <GlowCard className="group p-5 h-full flex flex-col min-w-0">
      {editMode && (
        <>
          <div className="drag-handle absolute top-2 left-2 p-1.5 cursor-grab active:cursor-grabbing rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical className="w-4 h-4 text-muted-foreground" />
          </div>
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-10 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Configure widget"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/60">
              <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </>
      )}

      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <div className={`text-foreground whitespace-pre-wrap break-words text-center w-full ${getTextSizeClasses(widget.textSize)}`}>
          {widget.textContent}
        </div>
      </div>
    </GlowCard>
  );
};
