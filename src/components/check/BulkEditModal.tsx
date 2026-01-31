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
import { Checkbox } from '../ui/checkbox';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { CHECK_INTERVALS } from '../ui/CheckIntervalSelector';
import { Input } from '../ui/input';

export interface BulkEditSettings {
  checkFrequency?: number;
  immediateRecheckEnabled?: boolean;
  downConfirmationAttempts?: number;
  expectedStatusCodes?: number[];
}

interface BulkEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  onApply: (settings: BulkEditSettings) => Promise<void>;
  minIntervalSeconds?: number;
}

export function BulkEditModal({
  open,
  onOpenChange,
  selectedCount,
  onApply,
  minIntervalSeconds = 120,
}: BulkEditModalProps) {
  // Track which fields should be updated
  const [updateInterval, setUpdateInterval] = useState(false);
  const [updateRecheck, setUpdateRecheck] = useState(false);
  const [updateRetries, setUpdateRetries] = useState(false);
  const [updateStatusCodes, setUpdateStatusCodes] = useState(false);

  // Field values
  const [interval, setInterval] = useState(300); // 5 minutes default
  const [recheckEnabled, setRecheckEnabled] = useState(true);
  const [retries, setRetries] = useState(4);
  const [statusCodesInput, setStatusCodesInput] = useState('200, 201, 204, 301, 302');

  const [loading, setLoading] = useState(false);

  // Filter intervals based on tier
  const availableIntervals = CHECK_INTERVALS.filter(
    (i) => i.value >= minIntervalSeconds
  );

  const handleApply = async () => {
    const settings: BulkEditSettings = {};

    if (updateInterval) {
      settings.checkFrequency = interval;
    }
    if (updateRecheck) {
      settings.immediateRecheckEnabled = recheckEnabled;
    }
    if (updateRetries) {
      settings.downConfirmationAttempts = retries;
    }
    if (updateStatusCodes) {
      const codes = statusCodesInput
        .split(/[,\s]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n >= 100 && n <= 599);
      if (codes.length > 0) {
        settings.expectedStatusCodes = codes;
      }
    }

    // Only apply if at least one setting is selected
    if (Object.keys(settings).length === 0) {
      return;
    }

    setLoading(true);
    try {
      await onApply(settings);
      onOpenChange(false);
      // Reset form
      setUpdateInterval(false);
      setUpdateRecheck(false);
      setUpdateRetries(false);
      setUpdateStatusCodes(false);
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = updateInterval || updateRecheck || updateRetries || updateStatusCodes;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Bulk Edit</DialogTitle>
          <DialogDescription>
            Update {selectedCount} check{selectedCount !== 1 ? 's' : ''}. Only checked options will be applied.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Check Interval */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-interval"
                checked={updateInterval}
                onCheckedChange={(checked) => setUpdateInterval(checked === true)}
              />
              <Label htmlFor="update-interval" className="cursor-pointer">
                Check Interval
              </Label>
            </div>
            {updateInterval && (
              <div className="ml-6">
                <Select
                  value={interval.toString()}
                  onValueChange={(v) => setInterval(parseInt(v, 10))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableIntervals.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Re-check on failure */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-recheck"
                checked={updateRecheck}
                onCheckedChange={(checked) => setUpdateRecheck(checked === true)}
              />
              <Label htmlFor="update-recheck" className="cursor-pointer">
                Re-check on Failure
              </Label>
            </div>
            {updateRecheck && (
              <div className="ml-6 flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">
                  Auto re-check after 30s
                </span>
                <Switch
                  checked={recheckEnabled}
                  onCheckedChange={setRecheckEnabled}
                />
              </div>
            )}
          </div>

          {/* Retries before offline */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-retries"
                checked={updateRetries}
                onCheckedChange={(checked) => setUpdateRetries(checked === true)}
              />
              <Label htmlFor="update-retries" className="cursor-pointer">
                Retries Before Offline
              </Label>
            </div>
            {updateRetries && (
              <div className="ml-6 flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={99}
                  value={retries}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 1 && val <= 99) {
                      setRetries(val);
                    }
                  }}
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">failures</span>
              </div>
            )}
          </div>

          {/* Expected Status Codes */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-status-codes"
                checked={updateStatusCodes}
                onCheckedChange={(checked) => setUpdateStatusCodes(checked === true)}
              />
              <Label htmlFor="update-status-codes" className="cursor-pointer">
                Expected Status Codes
              </Label>
            </div>
            {updateStatusCodes && (
              <div className="ml-6">
                <Input
                  value={statusCodesInput}
                  onChange={(e) => setStatusCodesInput(e.target.value)}
                  placeholder="200, 201, 204, 301, 302"
                  className="font-mono text-sm"
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            onClick={handleApply}
            disabled={!hasChanges || loading}
            className="cursor-pointer"
          >
            {loading ? 'Applying...' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
