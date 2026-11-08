import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import * as Recharts from 'recharts';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, Mail } from 'lucide-react';
import {
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { InsufficientDataPill, SlaStatusPill } from '@/components/sla/SlaStatusPill';
import { ErrorBudgetBar } from '@/components/sla/ErrorBudgetBar';
import {
  SLA_EXCLUSION_LABEL,
  budgetExhaustedDay,
  excludedMs,
  formatAvailability,
  formatDateTimeInZone,
  formatDayInZone,
  formatDayKey,
  formatSlaDuration,
  formatTarget,
  formatUtc,
  periodLabel,
} from '@/lib/sla';
import { cn } from '@/lib/utils';
import type { SlaCheckResult, SlaPeriod, SlaReport } from '@/types';

const cardClass = 'bg-card border-0 shadow-lg';

/** One month of an SLA report: headline, stats, daily chart, checks, incidents, exclusions. */
export function SlaPeriodView({ report, period, isCurrent }: { report: SlaReport; period: SlaPeriod; isCurrent: boolean }) {
  const tz = period.timezone;
  const o = period.overall;
  const target = period.targetPercent;
  const open = period.status === 'open';
  const exhaustedDay = open ? budgetExhaustedDay(period) : null;
  const delta = o.availability === null ? null : o.availability * 100 - target;
  const longest = period.checks.reduce((m, c) => Math.max(m, c.longestIncidentMs || 0), 0);
  const names = React.useMemo(() => new Map(period.checks.map((c) => [c.checkId, c.name])), [period.checks]);
  const budgetLeft = Math.max(0, o.projectedBudgetMs - o.downMs);

  return (
    <div className="space-y-6">
      {/* Headline */}
      <Card className={cardClass}>
        <CardContent className="p-5 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <SlaStatusPill status={o.status} />
                {o.insufficientData && <InsufficientDataPill />}
                <span className="text-xs text-muted-foreground">
                  {open
                    ? `${periodLabel(period.period)} so far · data through ${formatDateTimeInZone(period.dataThrough, tz)}`
                    : `${periodLabel(period.period)} · final`}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span
                  className={cn(
                    'font-mono text-5xl sm:text-6xl font-semibold tracking-tight tabular-nums',
                    o.availability === null && 'text-muted-foreground text-4xl sm:text-4xl',
                    o.status === 'breached' && 'text-destructive',
                  )}
                >
                  {formatAvailability(o.availability)}
                </span>
                <span className="text-sm text-muted-foreground">
                  target {formatTarget(target)}
                  {delta !== null && (
                    <span className={cn('ml-2 font-mono tabular-nums', delta >= 0 ? 'text-success' : 'text-destructive')}>
                      {delta >= 0 ? '+' : ''}{delta.toFixed(3)} pts
                    </span>
                  )}
                </span>
              </div>
            </div>
            <div className="w-full lg:max-w-sm space-y-2">
              <ErrorBudgetBar used={o.budgetUsed} />
              <p className="text-xs text-muted-foreground">
                {formatSlaDuration(o.downMs)} down of {formatSlaDuration(o.projectedBudgetMs)} allowed
                {open ? ' this month (projected)' : ''}.
                {open && o.downMs < o.projectedBudgetMs && ` ${formatSlaDuration(budgetLeft)} left.`}
              </p>
            </div>
          </div>
          {period.sentRecord && (
            <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
              <Mail className="size-3.5 shrink-0" />
              <span>
                Emailed {formatDayInZone(period.sentRecord.sentAt, period.sentRecord.timezone)}
                {period.sentRecord.recipients ? ` to ${period.sentRecord.recipients} ${period.sentRecord.recipients === 1 ? 'recipient' : 'recipients'}` : ''}:
                {' '}{formatAvailability(period.sentRecord.availability)}
                {period.sentRecord.timezone !== tz ? ` (counted in ${period.sentRecord.timezone})` : ''}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {exhaustedDay && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <AlertTriangle className="size-4 mt-0.5 shrink-0 text-destructive" />
          <p>
            <span className="font-medium text-destructive">Budget used up on {formatDayKey(exhaustedDay)}.</span>{' '}
            <span className="text-muted-foreground">This month cannot meet {formatTarget(target)} any more.</span>
          </p>
        </div>
      )}
      {!exhaustedDay && open && o.status === 'at_risk' && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="size-4 mt-0.5 shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-warning">At risk.</span> At this pace the month ends below {formatTarget(target)}.
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat label="Downtime" value={formatSlaDuration(o.downMs)} hint="Confirmed outages only" />
        <Stat
          label="Incidents"
          value={String(period.incidentsTotal)}
          hint={period.incidentsTotal > 0 ? `Longest ${formatSlaDuration(longest)}` : 'None this month'}
        />
        <Stat
          label="Error budget"
          value={formatSlaDuration(o.projectedBudgetMs)}
          hint={o.downMs > o.projectedBudgetMs ? `Over by ${formatSlaDuration(o.downMs - o.projectedBudgetMs)}` : `${formatSlaDuration(budgetLeft)} left`}
          tone={o.budgetUsed >= 1 ? 'destructive' : o.budgetUsed >= 0.75 ? 'warning' : undefined}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Stat
                label="Coverage"
                value={`${Math.floor(o.coverage * 1000) / 10}%`}
                hint={`${formatSlaDuration(excludedMs(o))} excluded`}
                tone={o.insufficientData ? 'warning' : undefined}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            <div className="space-y-0.5">
              <div>Maintenance: {formatSlaDuration(o.maintenanceMs)}</div>
              <div>Blocked probes: {formatSlaDuration(o.blockedMs)}{period.countBlockedAsDown ? ' (counted as down)' : ''}</div>
              <div>No data: {formatSlaDuration(o.noDataMs)}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>

      <DailyChart period={period} isCurrent={isCurrent} />

      <ChecksTable period={period} />

      <IncidentLog period={period} names={names} />

      <Exclusions period={period} names={names} />

      <p className="text-xs text-muted-foreground px-1">
        Availability = up time / (up + down time). Only confirmed outages count as down. Maintenance, blocked probes and
        unmonitored time are excluded{report.countBlockedAsDown ? ', except blocked probes, which this report counts as down' : ''}.{' '}
        <a href="https://docs.exit1.dev/analytics/sla-reports" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
          How SLA reports are counted
        </a>
      </p>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' | 'destructive' }) {
  return (
    <Card className={cn(cardClass, 'h-full')}>
      <CardContent className="p-4 sm:p-5 space-y-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            'font-mono text-xl sm:text-2xl font-semibold tabular-nums',
            tone === 'warning' && 'text-warning',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {value}
        </div>
        {hint && <div className="text-xs text-muted-foreground truncate">{hint}</div>}
      </CardContent>
    </Card>
  );
}

const chartConfig = {
  downMin: { label: 'Down', color: 'var(--destructive)' },
} satisfies ChartConfig;

function DailyChart({ period, isCurrent }: { period: SlaPeriod; isCurrent: boolean }) {
  const data = React.useMemo(
    () =>
      (period.daily ?? []).map((d) => ({
        day: d.day,
        label: String(Number(d.day.slice(8, 10))),
        downMin: Math.round((d.downMs / 60000) * 10) / 10,
        downMs: d.downMs,
        excludedMs: d.excludedMs,
        upMs: d.upMs,
      })),
    [period.daily],
  );
  const anyDown = data.some((d) => d.downMs > 0);

  return (
    <Card className={cardClass}>
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Downtime per day</h3>
          <span className="text-xs text-muted-foreground">Confirmed outages, in local days. Hover a day for excluded time.</span>
        </div>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No daily data yet.</p>
        ) : (
          <div className="relative">
            <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
              <Recharts.BarChart data={data} margin={{ left: 0, right: 0, top: 8, bottom: 0 }} barCategoryGap={2}>
                <Recharts.CartesianGrid vertical={false} strokeDasharray="3 3" strokeOpacity={0.2} />
                <Recharts.XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={8} />
                <Recharts.YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} width={36} tickFormatter={(v: number) => `${v}m`} allowDecimals={false} />
                <ChartTooltip
                  cursor={{ fillOpacity: 0.08 }}
                  content={({ active, payload }) => {
                    const p = active && payload?.[0]?.payload as (typeof data)[number] | undefined;
                    if (!p) return null;
                    return (
                      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md space-y-0.5">
                        <div className="font-medium">{formatDayKey(p.day)}</div>
                        <div>Down: {formatSlaDuration(p.downMs)}</div>
                        <div className="text-muted-foreground">Excluded: {formatSlaDuration(p.excludedMs)}</div>
                      </div>
                    );
                  }}
                />
                <Recharts.Bar dataKey="downMin" fill="var(--color-downMin)" radius={[2, 2, 0, 0]} maxBarSize={28} />
              </Recharts.BarChart>
            </ChartContainer>
            {!anyDown && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
                  No downtime {isCurrent ? 'so far this month' : 'this month'}
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type SortKey = 'name' | 'availability' | 'downMs' | 'incidents' | 'longestIncidentMs' | 'excluded' | 'status';

const STATUS_RANK: Record<string, number> = { breached: 0, at_risk: 1, no_data: 2, on_track: 3, met: 4 };

function sortValue(c: SlaCheckResult, key: SortKey): number | string {
  switch (key) {
    case 'name': return c.name.toLowerCase();
    case 'availability': return c.availability ?? 0;
    case 'excluded': return excludedMs(c);
    case 'status': return STATUS_RANK[c.status] ?? 9;
    default: return c[key] ?? 0;
  }
}

function ChecksTable({ period }: { period: SlaPeriod }) {
  const navigate = useNavigate();
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'availability', dir: 1 });
  const rows = React.useMemo(() => {
    const out = [...period.checks];
    out.sort((a, b) => {
      // Checks with no measured time go last, whichever way the table is sorted.
      const na = a.availability === null ? 1 : 0;
      const nb = b.availability === null ? 1 : 0;
      if (na !== nb) return na - nb;
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * sort.dir || a.name.localeCompare(b.name);
    });
    return out;
  }, [period.checks, sort]);

  const head = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className}>
      <button
        type="button"
        className={cn('inline-flex items-center gap-1 cursor-pointer hover:text-foreground', sort.key === key && 'text-foreground')}
        onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : key === 'availability' || key === 'status' ? 1 : -1 }))}
      >
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );

  return (
    <Card className={cardClass}>
      <CardContent className="p-0">
        <div className="px-5 sm:px-6 pt-5 sm:pt-6 pb-3">
          <h3 className="text-sm font-semibold">Checks</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Click a check to open it in Reports.</p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {head('name', 'Check', 'pl-5 sm:pl-6')}
                {head('availability', 'Availability', 'text-right')}
                {head('downMs', 'Downtime', 'text-right')}
                {head('incidents', 'Incidents', 'text-right hidden md:table-cell')}
                {head('longestIncidentMs', 'Longest', 'text-right hidden md:table-cell')}
                {head('excluded', 'Excluded', 'text-right hidden lg:table-cell')}
                {head('status', 'Status', 'pr-5 sm:pr-6')}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.checkId}
                  className={cn(!c.deleted && 'cursor-pointer')}
                  onClick={() => !c.deleted && navigate(`/reports?check=${encodeURIComponent(c.checkId)}`)}
                >
                  <TableCell className="pl-5 sm:pl-6 max-w-[260px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={cn('truncate font-medium', c.deleted && 'text-muted-foreground')}>{c.name}</span>
                      {!c.deleted && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
                    </div>
                    {c.url && <div className="truncate text-xs text-muted-foreground">{c.url}</div>}
                  </TableCell>
                  <TableCell className={cn('text-right font-mono tabular-nums', c.status === 'breached' && 'text-destructive')}>
                    {formatAvailability(c.availability)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatSlaDuration(c.downMs)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums hidden md:table-cell">{c.incidents}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums hidden md:table-cell">
                    {c.longestIncidentMs ? formatSlaDuration(c.longestIncidentMs) : '-'}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums hidden lg:table-cell text-muted-foreground">
                    {formatSlaDuration(excludedMs(c))}
                  </TableCell>
                  <TableCell className="pr-5 sm:pr-6">
                    <div className="flex items-center gap-1.5">
                      <SlaStatusPill status={c.status} size="sm" />
                      {c.insufficientData && c.status !== 'no_data' && <InsufficientDataPill />}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function IncidentLog({ period, names }: { period: SlaPeriod; names: Map<string, string> }) {
  const tz = period.timezone;
  const rows = React.useMemo(() => [...period.incidents].sort((a, b) => b.startMs - a.startMs), [period.incidents]);

  return (
    <Card className={cardClass}>
      <CardContent className="p-0">
        <div className="px-5 sm:px-6 pt-5 sm:pt-6 pb-3">
          <h3 className="text-sm font-semibold">Incidents</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Confirmed outages, in {tz}. Hover a time for UTC.
            {period.incidentsTotal > period.incidents.length && ` Showing the ${period.incidents.length} longest of ${period.incidentsTotal}.`}
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 sm:px-6 pb-6 text-sm text-muted-foreground">No confirmed outages.</p>
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5 sm:pl-6">Check</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead className="text-right pr-5 sm:pr-6">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => (
                  <TableRow key={`${i.checkId}-${i.startMs}`}>
                    <TableCell className="pl-5 sm:pl-6 max-w-[220px] truncate">{names.get(i.checkId) ?? 'Deleted check'}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums" title={formatUtc(i.startMs)}>
                      {formatDateTimeInZone(i.startMs, tz)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums" title={i.endMs ? formatUtc(i.endMs) : undefined}>
                      {i.endMs ? formatDateTimeInZone(i.endMs, tz) : <span className="font-sans font-medium text-destructive">Ongoing</span>}
                    </TableCell>
                    <TableCell className="text-right pr-5 sm:pr-6 font-mono tabular-nums">{formatSlaDuration(i.durationMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Exclusions({ period, names }: { period: SlaPeriod; names: Map<string, string> }) {
  const tz = period.timezone;
  const total = period.exclusionsTotal ?? period.exclusions.length;
  if (total === 0) return null;
  const rows = [...period.exclusions].sort((a, b) => b.startMs - a.startMs);

  return (
    <Collapsible>
      <Card className={cardClass}>
        <CardContent className="p-0">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-5 sm:px-6 py-5 text-left cursor-pointer">
            <div>
              <h3 className="text-sm font-semibold">Exclusions</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {total} {total === 1 ? 'period' : 'periods'} left out of the calculation: maintenance, blocked probes and time with no data.
              </p>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto border-t border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-5 sm:pl-6">Check</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead className="text-right pr-5 sm:pr-6">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow key={`${e.checkId}-${e.state}-${e.startMs}`}>
                      <TableCell className="pl-5 sm:pl-6 max-w-[220px] truncate">{names.get(e.checkId) ?? 'Deleted check'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{SLA_EXCLUSION_LABEL[e.state] ?? e.state}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums" title={formatUtc(e.startMs)}>
                        {formatDateTimeInZone(e.startMs, tz)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums" title={formatUtc(e.endMs)}>
                        {formatDateTimeInZone(e.endMs, tz)}
                      </TableCell>
                      <TableCell className="text-right pr-5 sm:pr-6 font-mono tabular-nums">{formatSlaDuration(e.endMs - e.startMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {total > rows.length && (
                <p className="px-5 sm:px-6 py-3 text-xs text-muted-foreground">Showing the {rows.length} longest of {total}.</p>
              )}
            </div>
          </CollapsibleContent>
        </CardContent>
      </Card>
    </Collapsible>
  );
}
