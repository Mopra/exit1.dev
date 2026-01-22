import { ChevronDown, ChevronRight } from "lucide-react";
import { TableCell, TableRow } from "../ui";
import { cn } from "@/lib/utils";

type FolderGroupHeaderRowProps = {
  colSpan: number;
  label: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  color?: string;
  className?: string;
};

export function FolderGroupHeaderRow({
  colSpan,
  label,
  count,
  isCollapsed,
  onToggle,
  color,
  className,
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
        <button
          type="button"
          onClick={onToggle}
          className="w-full flex items-center justify-between gap-3 cursor-pointer"
          aria-label={`Toggle ${label}`}
        >
          <span className="flex items-center gap-2">
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
            <span className={cn("font-medium", color ? `text-${color}-200` : "text-foreground")}>
              {label}
            </span>
          </span>
          <span className="text-xs font-mono text-muted-foreground">{count}</span>
        </button>
      </TableCell>
    </TableRow>
  );
}
