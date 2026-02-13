import { useState } from 'react';
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
import { Wrench } from 'lucide-react';
import { cn } from '../../lib/utils';

const DURATION_PRESETS = [
  { label: '5m', value: 300000 },
  { label: '15m', value: 900000 },
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
] as const;

interface MaintenanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (duration: number, reason?: string) => void | Promise<void>;
  checkName?: string;
  loading?: boolean;
}

export function MaintenanceDialog({
  open,
  onOpenChange,
  onConfirm,
  checkName,
  loading = false,
}: MaintenanceDialogProps) {
  const [duration, setDuration] = useState<number>(1800000); // default 30m
  const [reason, setReason] = useState('');

  // Reset state when dialog opens/closes
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setDuration(1800000);
      setReason('');
    }
    onOpenChange(nextOpen);
  };

  const handleConfirm = async () => {
    await onConfirm(duration, reason.trim() || undefined);
    setReason('');
    setDuration(1800000);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-500" />
            Enter Maintenance
          </DialogTitle>
          <DialogDescription>
            {checkName
              ? `Put "${checkName}" into maintenance mode.`
              : 'Put selected checks into maintenance mode.'}{' '}
            Alerts will be suppressed and downtime will not be recorded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Duration</Label>
            <div className="flex gap-2">
              {DURATION_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant={duration === preset.value ? 'default' : 'outline'}
                  size="sm"
                  className={cn(
                    'flex-1 cursor-pointer font-mono',
                    duration === preset.value && 'bg-amber-500 hover:bg-amber-600 text-white'
                  )}
                  onClick={() => setDuration(preset.value)}
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
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Server upgrade, DNS migration"
              maxLength={200}
              className="font-mono text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
            className="cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading}
            className="cursor-pointer bg-amber-500 hover:bg-amber-600 text-white"
          >
            {loading ? 'Entering...' : 'Enter Maintenance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
