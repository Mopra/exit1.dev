import React from 'react';
import { Type } from 'lucide-react';
import { GlowCard } from '../ui';
import type { CustomLayoutWidget, TextWidgetSize } from '../../types';

interface TextWidgetProps {
  widget: CustomLayoutWidget;
  editMode: boolean;
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
}) => {
  const hasContent = widget.textContent && widget.textContent.trim().length > 0;

  if (!hasContent && !editMode) {
    return null;
  }

  if (!hasContent) {
    return (
      <GlowCard className="p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        <Type className="w-8 h-8 text-muted-foreground/50" />
        <div className="text-sm text-muted-foreground text-center">
          No text entered
        </div>
        {editMode && (
          <span className="text-xs text-primary">Click to add text</span>
        )}
      </GlowCard>
    );
  }

  return (
    <GlowCard className="p-5 h-full flex flex-col min-w-0">
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <div className={`text-foreground whitespace-pre-wrap break-words text-center w-full ${getTextSizeClasses(widget.textSize)}`}>
          {widget.textContent}
        </div>
      </div>
    </GlowCard>
  );
};
