import { Check, ChevronDown, ChevronRight, Minus } from "lucide-react";
import { TableCell, TableRow } from "../ui";
import { cn } from "@/lib/utils";
import React from "react";

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
}: FolderGroupHeaderRowProps) {
  return (
    <TableRow
      className={cn(
        "bg-muted/40 hover:bg-muted/60",
        color && `bg-${color}-500/10 hover:bg-${color}-500/15 border-l-4 border-l-${color}-400/60`,
        className
      )}
    >
      <TableCell colSpan={colSpan} className="px-4 py-2">
        <div className="w-full flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
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
