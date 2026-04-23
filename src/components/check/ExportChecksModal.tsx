import { useCallback, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Download, Loader2 } from "lucide-react";

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
} from "@/components/ui";
import { DateRangeCalendar } from "@/components/ui/DateRangeCalendar";

/**
 * CSV columns the export supports. Order mirrors the server's `CSV_COLUMNS`
 * in `functions/src/csv-export.ts` — changing one requires changing the other.
 */
const EXPORT_COLUMNS: { key: string; label: string; always?: boolean }[] = [
  { key: "name", label: "Name", always: true },
  { key: "url", label: "URL", always: true },
  { key: "type", label: "Type" },
  { key: "http_method", label: "HTTP method" },
  { key: "expected_status_codes", label: "Expected status codes" },
  { key: "check_frequency", label: "Check frequency (min)" },
  { key: "down_confirmation_attempts", label: "Down-confirmation attempts" },
  { key: "cache_control_no_cache", label: "Cache-Control: no-cache" },
  { key: "request_headers", label: "Request headers" },
  { key: "request_body", label: "Request body" },
  { key: "response_contains_text", label: "Response contains text" },
  { key: "response_json_path", label: "Response JSONPath" },
  { key: "response_expected_value", label: "Response expected value" },
  { key: "redirect_expected_target", label: "Redirect target" },
  { key: "redirect_match_mode", label: "Redirect match mode" },
];

const DEFAULT_SELECTED_COLUMNS = new Set(EXPORT_COLUMNS.map((c) => c.key));

/** Hard server-side cap on the history date window (see `MAX_HISTORY_WINDOW_DAYS`). */
const MAX_HISTORY_WINDOW_DAYS = 90;

export interface ExportSubmitParams {
  columns: string[];
  includeHistory: boolean;
  startDate?: number;
  endDate?: number;
}

interface ExportChecksModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: ExportSubmitParams) => Promise<void>;
  checkCount: number;
  isSubmitting: boolean;
}

export function ExportChecksModal({
  open,
  onOpenChange,
  onSubmit,
  checkCount,
  isSubmitting,
}: ExportChecksModalProps) {
  const [selected, setSelected] = useState<Set<string>>(DEFAULT_SELECTED_COLUMNS);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const to = new Date();
    to.setHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    return { from, to };
  });

  const toggleColumn = useCallback((key: string) => {
    setSelected((prev) => {
      const col = EXPORT_COLUMNS.find((c) => c.key === key);
      if (col?.always) return prev;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(EXPORT_COLUMNS.map((c) => c.key)));
  }, []);

  const selectRequiredOnly = useCallback(() => {
    setSelected(new Set(EXPORT_COLUMNS.filter((c) => c.always).map((c) => c.key)));
  }, []);

  const canSubmit = useMemo(() => {
    if (selected.size === 0) return false;
    if (includeHistory) {
      if (!dateRange?.from || !dateRange.to) return false;
    }
    return true;
  }, [selected.size, includeHistory, dateRange]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    // Preserve the server-side column order.
    const columns = EXPORT_COLUMNS.filter((c) => selected.has(c.key)).map((c) => c.key);
    const params: ExportSubmitParams = { columns, includeHistory };
    if (includeHistory && dateRange?.from && dateRange.to) {
      // Start of `from`, end of `to` (UTC).
      const start = new Date(dateRange.from);
      start.setHours(0, 0, 0, 0);
      const end = new Date(dateRange.to);
      end.setHours(23, 59, 59, 999);
      params.startDate = start.getTime();
      params.endDate = end.getTime();
    }
    await onSubmit(params);
  }, [canSubmit, selected, includeHistory, dateRange, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export checks</DialogTitle>
          <DialogDescription>
            {checkCount === 0
              ? "No checks to export."
              : `Download ${checkCount} check${checkCount === 1 ? "" : "s"} as a CSV. The file can be re-imported via Bulk Import.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Columns</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={selectAll}
                  disabled={isSubmitting}
                  className="h-7 px-2 text-xs"
                >
                  All
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={selectRequiredOnly}
                  disabled={isSubmitting}
                  className="h-7 px-2 text-xs"
                >
                  Required only
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
              {EXPORT_COLUMNS.map((col) => {
                const checked = selected.has(col.key);
                const id = `export-col-${col.key}`;
                return (
                  <label
                    key={col.key}
                    htmlFor={id}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={() => toggleColumn(col.key)}
                      disabled={col.always || isSubmitting}
                    />
                    <span className={col.always ? "text-muted-foreground" : ""}>
                      {col.label}
                      {col.always && (
                        <span className="ml-1 text-xs">(required)</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="export-include-history" className="text-sm font-medium cursor-pointer">
                  Include check history
                </Label>
                <span className="text-xs text-muted-foreground">
                  Adds a second CSV of individual check runs in the window. Bundled as a zip.
                </span>
              </div>
              <Switch
                id="export-include-history"
                checked={includeHistory}
                onCheckedChange={setIncludeHistory}
                disabled={isSubmitting}
              />
            </div>

            {includeHistory && (
              <div className="flex flex-col gap-2 pt-1">
                <Label className="text-xs text-muted-foreground">Date range (max {MAX_HISTORY_WINDOW_DAYS} days)</Label>
                <DateRangeCalendar
                  dateRange={dateRange}
                  onDateRangeChange={setDateRange}
                  maxRangeDays={MAX_HISTORY_WINDOW_DAYS}
                />
                <p className="text-xs text-muted-foreground">
                  Up to 500,000 rows per export. Beyond that the export is truncated (oldest rows first).
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting || checkCount === 0}
            className="gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Exporting…
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
