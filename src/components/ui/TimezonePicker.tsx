import { useMemo, useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { cn } from '../../lib/utils';
import { allTimeZones } from '../../lib/timezones';

const TONES = {
  warning: {
    link: 'text-warning hover:text-warning/80',
    selected: 'bg-warning/10 text-warning font-semibold',
  },
  primary: {
    link: 'text-primary hover:text-primary/80',
    selected: 'bg-primary/10 text-primary font-semibold',
  },
} as const;

interface TimezonePickerProps {
  value: string;
  onChange: (tz: string) => void;
  /** Accent for the Change link and the selected row. */
  tone?: keyof typeof TONES;
  disabled?: boolean;
  className?: string;
}

/**
 * Shows the chosen IANA zone with a Change link that opens a searchable list
 * of every zone the browser supports. Used by the maintenance dialog and the
 * SLA report editor.
 */
export function TimezonePicker({ value, onChange, tone = 'primary', disabled = false, className }: TimezonePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const zones = useMemo(() => allTimeZones(), []);

  const filtered = useMemo(() => {
    if (!search) return zones;
    const q = search.toLowerCase();
    return zones.filter((tz) => tz.toLowerCase().includes(q));
  }, [zones, search]);

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  const t = TONES[tone];

  if (!open) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <span className="text-sm font-mono text-foreground">{value}</span>
        {!disabled && (
          <button type="button" onClick={() => setOpen(true)} className={cn('text-xs cursor-pointer underline', t.link)}>
            Change
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search timezones..."
          className="font-mono text-sm flex-1"
          autoFocus
        />
        <Button type="button" variant="ghost" size="sm" className="cursor-pointer text-xs shrink-0" onClick={close}>
          Cancel
        </Button>
      </div>
      <div className="max-h-48 overflow-y-auto rounded border bg-background">
        {filtered.map((tz) => (
          <button
            key={tz}
            type="button"
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs font-mono cursor-pointer hover:bg-accent transition-colors',
              tz === value && t.selected,
            )}
            onClick={() => {
              onChange(tz);
              close();
            }}
          >
            {tz}
          </button>
        ))}
      </div>
    </div>
  );
}
