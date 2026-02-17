import React, { useState } from 'react';
import { useDeployMode } from '@/hooks/useDeployMode';
import { apiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export const DeployModeToggle: React.FC = () => {
  const { isDeployMode, timeRemaining } = useDeployMode();
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState('30');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const handleEnable = async () => {
    setLoading(true);
    const result = await apiClient.enableDeployMode({
      durationMinutes: parseInt(duration),
      reason: reason || undefined,
    });
    if (result.success) {
      toast.success(`Deploy mode activated for ${duration} minutes`);
      setOpen(false);
      setReason('');
    } else {
      toast.error(result.error || 'Failed to enable deploy mode');
    }
    setLoading(false);
  };

  const handleDisable = async () => {
    setLoading(true);
    const result = await apiClient.disableDeployMode();
    if (result.success) {
      toast.success('Deploy mode disabled. Monitoring resumed.');
    } else {
      toast.error(result.error || 'Failed to disable deploy mode');
    }
    setLoading(false);
  };

  if (isDeployMode) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handleDisable}
        disabled={loading}
        className={cn(
          "w-full justify-start gap-2 border-amber-500/40",
          "bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
        )}
      >
        <Rocket className="h-4 w-4 animate-pulse" />
        <span className="truncate">Deploy Mode ON ({timeRemaining}m)</span>
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 opacity-70 hover:opacity-100"
        >
          <Rocket className="h-4 w-4" />
          <span className="truncate">Deploy Mode</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" side="right">
        <div className="space-y-3">
          <h4 className="font-medium text-sm">Activate Deploy Mode</h4>
          <p className="text-xs text-muted-foreground">
            Pauses all checks and alerts. Auto-expires after the selected duration.
          </p>
          <div className="space-y-2">
            <Label className="text-xs">Duration</Label>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="120">2 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Reason (optional)</Label>
            <Input
              placeholder="e.g., VPS deployment"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="text-sm"
            />
          </div>
          <Button
            onClick={handleEnable}
            disabled={loading}
            className="w-full bg-amber-600 hover:bg-amber-700 text-white"
            size="sm"
          >
            {loading ? 'Activating...' : 'Activate Deploy Mode'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
