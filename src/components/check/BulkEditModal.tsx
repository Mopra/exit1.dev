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
import { Badge } from '../ui/badge';
import { X } from 'lucide-react';

export interface BulkEditSettings {
  checkFrequency?: number;
  immediateRecheckEnabled?: boolean;
  downConfirmationAttempts?: number;
  expectedStatusCodes?: number[];
  checkRegionOverride?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | null;
  timezone?: string | null;
  domainAlertThresholds?: number[];
}

interface BulkEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  onApply: (settings: BulkEditSettings) => Promise<void>;
  minIntervalSeconds?: number;
  isNano?: boolean;
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
  const [updateTimezone, setUpdateTimezone] = useState(false);
  const [updateDomainThresholds, setUpdateDomainThresholds] = useState(false);

  // Field values
  const [interval, setInterval] = useState(300); // 5 minutes default
  const [recheckEnabled, setRecheckEnabled] = useState(true);
  const [retries, setRetries] = useState<number | ''>(4);
  const [statusCodesInput, setStatusCodesInput] = useState('200, 201, 204, 301, 302');
  const [timezone, setTimezone] = useState<string>('_utc');
  const [domainThresholds, setDomainThresholds] = useState<number[]>([30, 14, 7, 1]);
  const [newThresholdInput, setNewThresholdInput] = useState('');

  const [loading, setLoading] = useState(false);

  // Filter intervals based on tier
  const availableIntervals = CHECK_INTERVALS.filter(
    (i) => i.value >= minIntervalSeconds
  );

  const handleApply = async () => {
    const settings: BulkEditSettings = {};

    if (updateInterval) {
      settings.checkFrequency = interval / 60; // Convert seconds to minutes (fractional for sub-minute intervals)
    }
    if (updateRecheck) {
      settings.immediateRecheckEnabled = recheckEnabled;
    }
    if (updateRetries) {
      if (typeof retries === 'number') settings.downConfirmationAttempts = retries;
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
    if (updateTimezone) {
      settings.timezone = timezone === '_utc' ? null : timezone;
    }
    if (updateDomainThresholds && domainThresholds.length > 0) {
      settings.domainAlertThresholds = domainThresholds;
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
      setUpdateTimezone(false);
      setUpdateDomainThresholds(false);
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = updateInterval || updateRecheck || updateRetries || updateStatusCodes || updateTimezone || updateDomainThresholds;

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
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={typeof retries === 'number' ? retries : ''}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    if (raw === '') {
                      setRetries('' as any);
                    } else {
                      const val = parseInt(raw, 10);
                      if (val >= 1 && val <= 99) {
                        setRetries(val);
                      }
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

          {/* Check Region - display only, single region */}

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

          {/* Domain Alert Thresholds */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="update-domain-thresholds"
                checked={updateDomainThresholds}
                onCheckedChange={(checked) => setUpdateDomainThresholds(checked === true)}
              />
              <Label htmlFor="update-domain-thresholds" className="cursor-pointer">
                Domain Alert Thresholds
              </Label>
            </div>
            {updateDomainThresholds && (
              <div className="ml-6 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {domainThresholds.map(threshold => (
                    <Badge
                      key={threshold}
                      variant="outline"
                      className="cursor-pointer hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive transition-colors text-xs"
                      onClick={() => setDomainThresholds(prev => prev.filter(t => t !== threshold))}
                    >
                      {threshold}d
                      <X className="h-3 w-3 ml-1" />
                    </Badge>
                  ))}
                  {domainThresholds.length === 0 && (
                    <span className="text-xs text-muted-foreground">No thresholds</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    placeholder="Days (1-365)"
                    value={newThresholdInput}
                    onChange={(e) => setNewThresholdInput(e.target.value)}
                    className="h-8 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const val = parseInt(newThresholdInput);
                        if (val >= 1 && val <= 365 && !domainThresholds.includes(val)) {
                          setDomainThresholds(prev => [...prev, val].sort((a, b) => b - a));
                          setNewThresholdInput('');
                        }
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    type="button"
                    onClick={() => {
                      const val = parseInt(newThresholdInput);
                      if (val >= 1 && val <= 365 && !domainThresholds.includes(val)) {
                        setDomainThresholds(prev => [...prev, val].sort((a, b) => b - a));
                        setNewThresholdInput('');
                      }
                    }}
                  >
                    Add
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: 'Standard', thresholds: [30, 14, 7, 1] },
                    { label: 'Extended', thresholds: [60, 30, 14, 7, 1] },
                    { label: 'Minimal', thresholds: [7, 1] },
                  ].map(preset => (
                    <Button
                      key={preset.label}
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2"
                      type="button"
                      onClick={() => setDomainThresholds([...preset.thresholds])}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Only applies to checks with Domain Intelligence enabled.
                </p>
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
