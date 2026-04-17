import React from "react";
import { Check, GripVertical } from "lucide-react";
import type { Website } from "../../types";
import { cn } from "../../lib/utils";
import { getTypeIcon } from "../../lib/check-utils";
import { useMobile } from "../../hooks/useMobile";

export interface CheckTileProps {
  check: Website;
  isSelected: boolean;
  onSelect: (id: string, event?: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  className?: string;
}

export const CheckTile: React.FC<CheckTileProps> = React.memo(function CheckTile({
  check,
  isSelected,
  onSelect,
  draggable = false,
  onDragStart,
  onDragEnd,
  className,
}) {
  const isMobile = useMobile(640);

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all select-none",
        "bg-background/50 hover:bg-muted/50",
        isSelected && "bg-primary/5 border-primary/30 ring-1 ring-primary/20",
        !isSelected && "border-border/50",
        "cursor-pointer",
        isMobile && "active:scale-[0.98]",
        className
      )}
      draggable={draggable && !isMobile}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        onSelect(check.id, e);
      }}
    >
      {/* Checkbox — desktop: visible on hover or when selected; mobile: visible when selected */}
      <button
        type="button"
        className={cn(
          "shrink-0 size-5 rounded border-2 flex items-center justify-center transition-all",
          isSelected
            ? "bg-primary border-primary text-primary-foreground"
            : "border-muted-foreground/30 hover:border-primary/50",
          isSelected
            ? "opacity-100"
            : isMobile
              ? "opacity-0"
              : "opacity-0 group-hover:opacity-100"
        )}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(check.id, e);
        }}
        tabIndex={-1}
      >
        {isSelected && <Check className="size-3" strokeWidth={3} />}
      </button>

      {/* Type icon */}
      <div className="shrink-0">
        {getTypeIcon(check.type, "size-4 text-muted-foreground")}
      </div>

      {/* Name + URL */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{check.name}</div>
        <div className="text-xs text-muted-foreground truncate">{check.url}</div>
      </div>

      {/* Drag handle — desktop only, hover */}
      {draggable && !isMobile && (
        <div
          className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
});
