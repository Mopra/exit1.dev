import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Calendar } from '../ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Wrench, CalendarIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { format } from 'date-fns';
import type { Website } from '../../types';

type MaintenanceTab = 'now' | 'scheduled' | 'recurring';

export interface MaintenanceDialogResult {
  mode: MaintenanceTab;
  duration?: number;
  reason?: string;
  startTime?: number;
  daysOfWeek?: number[];
  startTimeMinutes?: number;
  durationMinutes?: number;
  timezone?: string;
}

const NOW_DURATION_PRESETS = [
  { label: '5m', value: 300000 },
  { label: '15m', value: 900000 },
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
] as const;

const EXTENDED_DURATION_PRESETS = [
  { label: '5m', value: 300000 },
  { label: '15m', value: 900000 },
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
  { label: '2h', value: 7200000 },
  { label: '4h', value: 14400000 },
] as const;

const RECURRING_DURATION_PRESETS = [
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '4h', minutes: 240 },
] as const;

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const TAB_OPTIONS: { value: MaintenanceTab; label: string }[] = [
  { value: 'now', label: 'Now' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'recurring', label: 'Recurring' },
];

function getNextFullHour(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getTomorrow(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

interface MaintenanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: MaintenanceDialogResult) => void | Promise<void>;
  checkName?: string;
  loading?: boolean;
  existingRecurring?: Website['maintenanceRecurring'];
  defaultTab?: MaintenanceTab;
}

export function MaintenanceDialog({
  open,
  onOpenChange,
  onConfirm,
  checkName,
  loading = false,
  existingRecurring,
  defaultTab,
}: MaintenanceDialogProps) {
  // Tab state
  const [activeTab, setActiveTab] = useState<MaintenanceTab>(defaultTab || 'now');

  // Now tab state
  const [nowDuration, setNowDuration] = useState<number>(1800000);
  const [nowReason, setNowReason] = useState('');

  // Scheduled tab state
  const [schedDate, setSchedDate] = useState<Date | undefined>(getTomorrow());
  const [schedTime, setSchedTime] = useState(getNextFullHour());
  const [schedDuration, setSchedDuration] = useState<number>(3600000);
  const [schedReason, setSchedReason] = useState('');
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Recurring tab state
  const [recurDays, setRecurDays] = useState<number[]>(existingRecurring?.daysOfWeek ?? []);
  const [recurTime, setRecurTime] = useState(() => {
    if (existingRecurring) {
      const h = Math.floor(existingRecurring.startTimeMinutes / 60);
      const m = existingRecurring.startTimeMinutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    return '03:00';
  });
  const [recurDurationMin, setRecurDurationMin] = useState<number>(existingRecurring?.durationMinutes ?? 60);
  const [recurReason, setRecurReason] = useState(existingRecurring?.reason ?? '');
  const detectedTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [recurTimezone, setRecurTimezone] = useState(existingRecurring?.timezone ?? detectedTz);
  const [showTzPicker, setShowTzPicker] = useState(false);
  const [tzSearch, setTzSearch] = useState('');

  const allTimezones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf('timeZone') as string[];
    } catch {
      return [detectedTz];
    }
  }, [detectedTz]);

  const filteredTimezones = useMemo(() => {
    if (!tzSearch) return allTimezones;
    const q = tzSearch.toLowerCase();
    return allTimezones.filter(tz => tz.toLowerCase().includes(q));
  }, [allTimezones, tzSearch]);

  const resetState = () => {
    setActiveTab(defaultTab || 'now');
    setNowDuration(1800000);
    setNowReason('');
    setSchedDate(getTomorrow());
    setSchedTime(getNextFullHour());
    setSchedDuration(3600000);
    setSchedReason('');
    setRecurDays(existingRecurring?.daysOfWeek ?? []);
    setRecurTime(existingRecurring ? `${String(Math.floor(existingRecurring.startTimeMinutes / 60)).padStart(2, '0')}:${String(existingRecurring.startTimeMinutes % 60).padStart(2, '0')}` : '03:00');
    setRecurDurationMin(existingRecurring?.durationMinutes ?? 60);
    setRecurReason(existingRecurring?.reason ?? '');
    setRecurTimezone(existingRecurring?.timezone ?? detectedTz);
    setShowTzPicker(false);
    setTzSearch('');
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetState();
    onOpenChange(nextOpen);
  };

  const toggleDay = (day: number) => {
    setRecurDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort());
  };

  const handleConfirm = async () => {
    if (activeTab === 'now') {
      await onConfirm({ mode: 'now', duration: nowDuration, reason: nowReason.trim() || undefined });
    } else if (activeTab === 'scheduled') {
      if (!schedDate) return;
      const [h, m] = schedTime.split(':').map(Number);
      const start = new Date(schedDate);
      start.setHours(h, m, 0, 0);
      await onConfirm({ mode: 'scheduled', startTime: start.getTime(), duration: schedDuration, reason: schedReason.trim() || undefined });
    } else if (activeTab === 'recurring') {
      if (recurDays.length === 0) return;
      const [h, m] = recurTime.split(':').map(Number);
      await onConfirm({
        mode: 'recurring',
        daysOfWeek: recurDays,
        startTimeMinutes: h * 60 + m,
        durationMinutes: recurDurationMin,
        timezone: recurTimezone,
        reason: recurReason.trim() || undefined,
      });
    }
    resetState();
  };

  const isValid = activeTab === 'now'
    || (activeTab === 'scheduled' && schedDate)
    || (activeTab === 'recurring' && recurDays.length > 0);

  const confirmLabel = activeTab === 'now'
    ? (loading ? 'Entering...' : 'Enter Maintenance')
    : activeTab === 'scheduled'
      ? (loading ? 'Scheduling...' : 'Schedule')
      : (loading ? 'Saving...' : (existingRecurring ? 'Update Recurring' : 'Set Recurring'));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-500" />
            Maintenance Window
          </DialogTitle>
          <DialogDescription>
            {checkName
              ? `Configure maintenance for "${checkName}".`
              : 'Configure maintenance for selected checks.'}{' '}
            Alerts will be suppressed and downtime will not be recorded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Tab selector */}
          <div className="flex gap-1.5">
            {TAB_OPTIONS.map((tab) => (
              <Button
                key={tab.value}
                type="button"
                variant={activeTab === tab.value ? 'default' : 'outline'}
                size="sm"
                className={cn(
                  'flex-1 cursor-pointer font-mono text-xs',
                  activeTab === tab.value && 'bg-amber-500 hover:bg-amber-600 text-white'
                )}
                onClick={() => setActiveTab(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          {/* Now tab */}
          {activeTab === 'now' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Duration</Label>
                <div className="flex gap-2">
                  {NOW_DURATION_PRESETS.map((preset) => (
                    <Button
                      key={preset.value}
                      type="button"
                      variant={nowDuration === preset.value ? 'default' : 'outline'}
                      size="sm"
                      className={cn(
                        'flex-1 cursor-pointer font-mono',
                        nowDuration === preset.value && 'bg-amber-500 hover:bg-amber-600 text-white'
                      )}
                      onClick={() => setNowDuration(preset.value)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Reason <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input value={nowReason} onChange={(e) => setNowReason(e.target.value)} placeholder="e.g. Server upgrade, DNS migration" maxLength={200} className="font-mono text-sm" />
              </div>
            </div>
          )}

          {/* Scheduled tab */}
          {activeTab === 'scheduled' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Date</Label>
                <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn('w-full justify-start text-left font-mono cursor-pointer', !schedDate && 'text-muted-foreground')}>
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {schedDate ? format(schedDate, 'PPP') : 'Pick a date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={schedDate}
                      onSelect={(date) => { setSchedDate(date); setCalendarOpen(false); }}
                      disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Time</Label>
                <Input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="font-mono text-sm" />
                <p className="text-xs text-muted-foreground font-mono">{detectedTz}</p>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Duration</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {EXTENDED_DURATION_PRESETS.map((preset) => (
                    <Button
                      key={preset.value}
                      type="button"
                      variant={schedDuration === preset.value ? 'default' : 'outline'}
                      size="sm"
                      className={cn(
                        'flex-1 min-w-[48px] cursor-pointer font-mono',
                        schedDuration === preset.value && 'bg-amber-500 hover:bg-amber-600 text-white'
                      )}
                      onClick={() => setSchedDuration(preset.value)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Reason <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input value={schedReason} onChange={(e) => setSchedReason(e.target.value)} placeholder="e.g. Server upgrade, DNS migration" maxLength={200} className="font-mono text-sm" />
              </div>
            </div>
          )}

          {/* Recurring tab */}
          {activeTab === 'recurring' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Days</Label>
                <div className="flex gap-1.5">
                  {DAY_LABELS.map((label, i) => (
                    <button
                      key={i}
                      type="button"
                      className={cn(
                        'w-9 h-9 rounded-full text-xs font-mono font-medium border cursor-pointer transition-colors',
                        recurDays.includes(i)
                          ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
                          : 'bg-background text-muted-foreground border-border hover:bg-accent'
                      )}
                      onClick={() => toggleDay(i)}
                      title={DAY_NAMES[i]}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {recurDays.length > 0 && (
                  <p className="text-xs text-muted-foreground font-mono">
                    {recurDays.map(d => DAY_NAMES[d]).join(', ')}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Time</Label>
                <Input type="time" value={recurTime} onChange={(e) => setRecurTime(e.target.value)} className="font-mono text-sm" />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Duration</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {RECURRING_DURATION_PRESETS.map((preset) => (
                    <Button
                      key={preset.minutes}
                      type="button"
                      variant={recurDurationMin === preset.minutes ? 'default' : 'outline'}
                      size="sm"
                      className={cn(
                        'flex-1 min-w-[48px] cursor-pointer font-mono',
                        recurDurationMin === preset.minutes && 'bg-amber-500 hover:bg-amber-600 text-white'
                      )}
                      onClick={() => setRecurDurationMin(preset.minutes)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Timezone</Label>
                {!showTzPicker ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-foreground">{recurTimezone}</span>
                    <button type="button" onClick={() => setShowTzPicker(true)} className="text-xs text-amber-500 hover:text-amber-600 cursor-pointer underline">
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={tzSearch}
                        onChange={(e) => setTzSearch(e.target.value)}
                        placeholder="Search timezones..."
                        className="font-mono text-sm flex-1"
                        autoFocus
                      />
                      <Button type="button" variant="ghost" size="sm" className="cursor-pointer text-xs shrink-0" onClick={() => { setShowTzPicker(false); setTzSearch(''); }}>
                        Cancel
                      </Button>
                    </div>
                    <div className="max-h-48 overflow-y-auto rounded border bg-background">
                      {filteredTimezones.map(tz => (
                        <button
                          key={tz}
                          type="button"
                          className={cn(
                            'w-full text-left px-3 py-1.5 text-xs font-mono cursor-pointer hover:bg-accent transition-colors',
                            tz === recurTimezone && 'bg-amber-500/10 text-amber-600 font-semibold'
                          )}
                          onClick={() => { setRecurTimezone(tz); setShowTzPicker(false); setTzSearch(''); }}
                        >
                          {tz}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Reason <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input value={recurReason} onChange={(e) => setRecurReason(e.target.value)} placeholder="e.g. Weekly deploy window" maxLength={200} className="font-mono text-sm" />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={loading} className="cursor-pointer">
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !isValid}
            className="cursor-pointer bg-amber-500 hover:bg-amber-600 text-white"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
