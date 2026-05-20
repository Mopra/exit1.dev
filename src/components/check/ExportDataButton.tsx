import * as React from 'react';
import { Download } from 'lucide-react';
import {
  Button,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import type { ChartPoint, StateSegment } from '@/lib/ws-protocol';
import type { Website } from '@/types';

type Format = 'csv' | 'json';

// Range presets, in ms. -1 means "all buffered". Anything larger than
// the active buffer is clamped at fetch time, so the user just sees what
// they actually have.
const RANGE_OPTIONS: Array<{ label: string; value: string; ms: number }> = [
  { label: 'Last 5 minutes', value: '300000', ms: 5 * 60_000 },
  { label: 'Last 15 minutes', value: '900000', ms: 15 * 60_000 },
  { label: 'Last 1 hour', value: '3600000', ms: 60 * 60_000 },
  { label: 'Last 6 hours', value: '21600000', ms: 6 * 60 * 60_000 },
  { label: 'Last 24 hours', value: '86400000', ms: 24 * 60 * 60_000 },
  { label: 'All buffered', value: 'all', ms: -1 },
];

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sanitizeFilenamePart(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'check';
}

function buildCsv(points: ChartPoint[]): string {
  const header = [
    'timestamp',
    'epoch_ms',
    'status',
    'response_ms',
    'status_code',
    'dns_ms',
    'connect_ms',
    'tls_ms',
    'ttfb_ms',
  ];
  const lines: string[] = [header.join(',')];
  for (const p of points) {
    lines.push(
      [
        csvEscape(isoTime(p.t)),
        csvEscape(p.t),
        csvEscape(p.st),
        csvEscape(p.rt ?? ''),
        csvEscape(p.sc ?? ''),
        csvEscape(p.dn ?? ''),
        csvEscape(p.cn ?? ''),
        csvEscape(p.tl ?? ''),
        csvEscape(p.ft ?? ''),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function buildJson(
  check: Website,
  points: ChartPoint[],
  segments: StateSegment[],
  rangeLabel: string,
  fromMs: number | null,
  toMs: number,
): string {
  const payload = {
    check: {
      id: check.id,
      name: check.name,
      url: check.url,
      type: check.type,
      region: check.checkRegion ?? null,
    },
    exportedAt: isoTime(Date.now()),
    range: {
      label: rangeLabel,
      from: fromMs !== null ? isoTime(fromMs) : null,
      to: isoTime(toMs),
    },
    points: points.map((p) => ({
      timestamp: isoTime(p.t),
      epochMs: p.t,
      status: p.st,
      responseMs: p.rt,
      statusCode: p.sc ?? null,
      dnsMs: p.dn ?? null,
      connectMs: p.cn ?? null,
      tlsMs: p.tl ?? null,
      ttfbMs: p.ft ?? null,
    })),
    segments: segments.map((s) => ({
      kind: s.k,
      start: isoTime(s.s),
      end: s.e !== null ? isoTime(s.e) : null,
      startEpochMs: s.s,
      endEpochMs: s.e,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function triggerDownload(filename: string, mime: string, body: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Safari has time to read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface ExportDataButtonProps {
  check: Website;
  points: ChartPoint[];
  segments: StateSegment[];
  /** Active buffer in ms — drives the "available" hint next to the range. */
  bufferMs: number;
}

export const ExportDataButton: React.FC<ExportDataButtonProps> = ({
  check,
  points,
  segments,
  bufferMs,
}) => {
  const [open, setOpen] = React.useState(false);
  const [format, setFormat] = React.useState<Format>('csv');
  const [rangeValue, setRangeValue] = React.useState<string>('all');

  const handleExport = React.useCallback(() => {
    const range = RANGE_OPTIONS.find((r) => r.value === rangeValue) ?? RANGE_OPTIONS[RANGE_OPTIONS.length - 1];
    const now = Date.now();
    const cutoff = range.ms < 0 ? null : now - range.ms;

    const filteredPoints = cutoff === null ? points : points.filter((p) => p.t >= cutoff);
    const filteredSegments =
      cutoff === null
        ? segments
        : segments.filter((s) => (s.e ?? now) >= cutoff);

    const sortedPoints = [...filteredPoints].sort((a, b) => a.t - b.t);

    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const rangeSlug = range.value === 'all' ? 'all' : range.label.toLowerCase().replace(/\s+/g, '');
    const namePart = sanitizeFilenamePart(check.name || check.id);

    if (format === 'csv') {
      const body = buildCsv(sortedPoints);
      triggerDownload(`${namePart}-${rangeSlug}-${stamp}.csv`, 'text/csv;charset=utf-8', body);
    } else {
      const body = buildJson(check, sortedPoints, filteredSegments, range.label, cutoff, now);
      triggerDownload(`${namePart}-${rangeSlug}-${stamp}.json`, 'application/json', body);
    }
    setOpen(false);
  }, [check, points, segments, format, rangeValue]);

  const bufferLabel = React.useMemo(() => {
    if (bufferMs >= 24 * 60 * 60_000) return `${Math.round(bufferMs / (24 * 60 * 60_000))}d`;
    if (bufferMs >= 60 * 60_000) return `${Math.round(bufferMs / (60 * 60_000))}h`;
    if (bufferMs >= 60_000) return `${Math.round(bufferMs / 60_000)}m`;
    return `${Math.round(bufferMs / 1000)}s`;
  }, [bufferMs]);

  const disabled = points.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          disabled={disabled}
          aria-label="Export probe data"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <div className="text-sm font-medium">Export probe data</div>
            <div className="text-[11px] text-muted-foreground">
              Exports the currently buffered window (last {bufferLabel}).
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">Format</Label>
            <RadioGroup
              value={format}
              onValueChange={(v) => setFormat(v as Format)}
              className="grid grid-cols-2 gap-2"
            >
              <label
                htmlFor="export-fmt-csv"
                className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5 text-xs cursor-pointer hover:bg-accent/40"
              >
                <RadioGroupItem id="export-fmt-csv" value="csv" />
                CSV
              </label>
              <label
                htmlFor="export-fmt-json"
                className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5 text-xs cursor-pointer hover:bg-accent/40"
              >
                <RadioGroupItem id="export-fmt-json" value="json" />
                JSON
              </label>
            </RadioGroup>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">Range</Label>
            <Select value={rangeValue} onValueChange={setRangeValue}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-[10px] text-muted-foreground/80">
              Ranges larger than the buffer ({bufferLabel}) export only what's loaded.
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={handleExport}
            disabled={disabled}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
