import { ChevronDown, ChevronRight } from "lucide-react";
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
