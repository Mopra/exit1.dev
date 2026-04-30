import { Check, ChevronDown, ChevronRight, GripVertical, Minus } from "lucide-react";
import { TableCell, TableRow } from "../ui";
import { cn } from "@/lib/utils";
import React from "react";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { FOLDER_COLORS, type FolderColorValue } from "../../lib/folder-utils";

// Per-color row styles using the predefined --folder-* tokens. Tailwind can
// only see classes that appear as complete strings, so we build the lookup
// statically here rather than interpolating `bg-${color}-500/10`.
const FOLDER_ROW_STYLES: Record<
  Exclude<FolderColorValue, "default">,
  { bg: string; hoverBg: string; borderL: string; text: string }
> = {
  blue: {
    bg: "bg-folder-blue/10",
    hoverBg: "hover:bg-folder-blue/15",
    borderL: "border-l-4 border-l-folder-blue/60",
    text: "text-folder-blue",
  },
  emerald: {
    bg: "bg-folder-emerald/10",
    hoverBg: "hover:bg-folder-emerald/15",
    borderL: "border-l-4 border-l-folder-emerald/60",
    text: "text-folder-emerald",
  },
  amber: {
    bg: "bg-folder-amber/10",
    hoverBg: "hover:bg-folder-amber/15",
    borderL: "border-l-4 border-l-folder-amber/60",
    text: "text-folder-amber",
  },
  rose: {
    bg: "bg-folder-rose/10",
    hoverBg: "hover:bg-folder-rose/15",
    borderL: "border-l-4 border-l-folder-rose/60",
    text: "text-folder-rose",
  },
  violet: {
    bg: "bg-folder-violet/10",
    hoverBg: "hover:bg-folder-violet/15",
    borderL: "border-l-4 border-l-folder-violet/60",
    text: "text-folder-violet",
  },
  slate: {
    bg: "bg-folder-slate/10",
    hoverBg: "hover:bg-folder-slate/15",
    borderL: "border-l-4 border-l-folder-slate/60",
    text: "text-folder-slate",
  },
};

function isKnownFolderColor(value: string): value is Exclude<FolderColorValue, "default"> {
  return FOLDER_COLORS.some((c) => c.value === value && c.value !== "default");
}

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
  const rowStyle = color && isKnownFolderColor(color) ? FOLDER_ROW_STYLES[color] : null;
  return (
    <TableRow
      ref={rowRef}
      style={style}
      className={cn(
        rowStyle ? cn(rowStyle.bg, rowStyle.hoverBg, rowStyle.borderL) : "bg-muted/40 hover:bg-muted/60",
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
              <span className={cn("font-medium", rowStyle ? rowStyle.text : "text-foreground")}>
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
