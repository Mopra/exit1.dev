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
  checkRegionOverride?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | null;
  timezone?: string | null;
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
  const [updateRegion, setUpdateRegion] = useState(false);
  const [updateTimezone, setUpdateTimezone] = useState(false);

  // Field values
  const [interval, setInterval] = useState(300); // 5 minutes default
  const [recheckEnabled, setRecheckEnabled] = useState(true);
  const [retries, setRetries] = useState(4);
  const [statusCodesInput, setStatusCodesInput] = useState('200, 201, 204, 301, 302');
  const [regionOverride, setRegionOverride] = useState<string>('auto');
  const [timezone, setTimezone] = useState<string>('_utc');

  const [loading, setLoading] = useState(false);

  // Filter intervals based on tier
  const availableIntervals = CHECK_INTERVALS.filter(
    (i) => i.value >= minIntervalSeconds
  );

  const handleApply = async () => {
    const settings: BulkEditSettings = {};

    if (updateInterval) {
      settings.checkFrequency = Math.round(interval / 60); // Convert seconds to minutes for storage
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
    if (updateRegion) {
      settings.checkRegionOverride = regionOverride === 'auto' ? null : regionOverride as BulkEditSettings['checkRegionOverride'];
    }
    if (updateTimezone) {
      settings.timezone = timezone === '_utc' ? null : timezone;
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
      setUpdateRegion(false);
      setUpdateTimezone(false);
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = updateInterval || updateRecheck || updateRetries || updateStatusCodes || updateRegion || updateTimezone;

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

          {/* Check Region */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-region"
                checked={updateRegion}
                onCheckedChange={(checked) => setUpdateRegion(checked === true)}
              />
              <Label htmlFor="update-region" className="cursor-pointer">
                Check Region
              </Label>
            </div>
            {updateRegion && (
              <div className="ml-6">
                <Select
                  value={regionOverride}
                  onValueChange={setRegionOverride}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (nearest to target)</SelectItem>
                    <SelectItem value="us-central1">US Central (Iowa)</SelectItem>
                    <SelectItem value="europe-west1">Europe West (Belgium)</SelectItem>
                    <SelectItem value="asia-southeast1">Asia Pacific (Singapore)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Notification Timezone */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-timezone"
                checked={updateTimezone}
                onCheckedChange={(checked) => setUpdateTimezone(checked === true)}
              />
              <Label htmlFor="update-timezone" className="cursor-pointer">
                Notification Timezone
              </Label>
            </div>
            {updateTimezone && (
              <div className="ml-6">
                <Select
                  value={timezone}
                  onValueChange={setTimezone}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_utc">UTC (default)</SelectItem>
                    <SelectItem value="America/New_York">Eastern Time (US)</SelectItem>
                    <SelectItem value="America/Chicago">Central Time (US)</SelectItem>
                    <SelectItem value="America/Denver">Mountain Time (US)</SelectItem>
                    <SelectItem value="America/Los_Angeles">Pacific Time (US)</SelectItem>
                    <SelectItem value="Europe/London">London (GMT/BST)</SelectItem>
                    <SelectItem value="Europe/Paris">Paris (CET)</SelectItem>
                    <SelectItem value="Europe/Berlin">Berlin (CET)</SelectItem>
                    <SelectItem value="Asia/Kolkata">India (IST)</SelectItem>
                    <SelectItem value="Asia/Singapore">Singapore (SGT)</SelectItem>
                    <SelectItem value="Asia/Tokyo">Tokyo (JST)</SelectItem>
                    <SelectItem value="Australia/Sydney">Sydney (AEST)</SelectItem>
                    <SelectItem value="Pacific/Auckland">Auckland (NZST)</SelectItem>
                  </SelectContent>
                </Select>
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
