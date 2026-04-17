import { Check, ChevronDown, ChevronRight, GripVertical, Minus } from "lucide-react";
import { TableCell, TableRow } from "../ui";
import { cn } from "@/lib/utils";
import React from "react";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";

type FolderGroupHeaderRowProps = {
  colSpan: number;
  label: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  color?: string;
  className?: string;
  /** Optional actions rendered between the label and count */
  actions?: React.ReactNode;
  /** Whether all checks in this folder are selected */
  selected?: boolean;
  /** Whether some (but not all) checks in this folder are selected */
  indeterminate?: boolean;
  /** Called when the folder selection checkbox is clicked */
  onSelect?: () => void;
  /** Ref set by parent (e.g. from useDroppable or useSortable) */
  rowRef?: React.Ref<HTMLTableRowElement>;
  /** Inline style applied to the row (for drag transforms) */
  style?: React.CSSProperties;
  /** Highlight the row as an active drop target */
  isOver?: boolean;
  /** Visually dim the row while it's being dragged */
  isDragging?: boolean;
  /** Listeners that initiate a drag when attached to an element */
  dragListeners?: SyntheticListenerMap;
  /** Accessibility / drag attributes from useSortable */
  dragAttributes?: Record<string, any>;
};

export function FolderGroupHeaderRow({
  colSpan,
  label,
  count,
  isCollapsed,
  onToggle,
  color,
  className,
  actions,
  selected,
  indeterminate,
  onSelect,
  rowRef,
  style,
  isOver,
  isDragging,
  dragListeners,
  dragAttributes,
}: FolderGroupHeaderRowProps) {
  const hasDragHandle = !!dragListeners;
  return (
    <TableRow
      ref={rowRef}
      style={style}
      className={cn(
        "bg-muted/40 hover:bg-muted/60",
        color && `bg-${color}-500/10 hover:bg-${color}-500/15 border-l-4 border-l-${color}-400/60`,
        isOver && "ring-2 ring-primary/60 bg-primary/10",
        isDragging && "opacity-40",
        className
      )}
    >
      <TableCell colSpan={colSpan} className="px-4 py-2">
        <div className="w-full flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {hasDragHandle && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
                aria-label="Drag folder"
                {...dragAttributes}
                {...dragListeners}
                onClick={(e) => e.stopPropagation()}
              >
                <GripVertical className="w-4 h-4" />
              </button>
            )}
            {onSelect && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onSelect(); }}
                className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selected || indeterminate ? 'border bg-background' : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                title={selected ? 'Deselect folder' : 'Select folder'}
              >
                {selected && <Check className="w-2.5 h-2.5 text-white" />}
                {indeterminate && <Minus className="w-2.5 h-2.5 text-white" />}
              </button>
            )}
            <button
              type="button"
              onClick={onToggle}
              className="flex items-center gap-2 cursor-pointer"
              aria-label={`Toggle ${label}`}
            >
              {isCollapsed ? (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
              <span className={cn("font-medium", color ? `text-${color}-200` : "text-foreground")}>
                {label}
              </span>
            </button>
          </div>
          {actions && (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              {actions}
            </div>
          )}
          <span className="text-xs font-mono text-muted-foreground ml-auto">{count}</span>
        </div>
      </TableCell>
    </TableRow>
  );
}
