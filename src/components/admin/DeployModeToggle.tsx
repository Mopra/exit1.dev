import React, { useState } from 'react';
import { useDeployMode } from '@/hooks/useDeployMode';
import { apiClient } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

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
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={`Deploy Mode ON (${timeRemaining}m)`}
            onClick={handleDisable}
            disabled={loading}
            className="border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning"
          >
            <Rocket className="h-4 w-4 animate-pulse drop-shadow-[0_0_6px_var(--warning)]" />
            <span className="truncate">Deploy Mode ON ({timeRemaining}m)</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              tooltip="Deploy Mode"
              className="opacity-70 hover:opacity-100"
            >
              <Rocket className="h-4 w-4 drop-shadow-[0_0_6px_var(--primary)] text-primary" />
              <span className="truncate">Deploy Mode</span>
            </SidebarMenuButton>
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
                className="w-full bg-warning hover:bg-warning/90 text-warning-foreground"
                size="sm"
              >
                {loading ? 'Activating...' : 'Activate Deploy Mode'}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
