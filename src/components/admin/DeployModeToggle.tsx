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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export const DeployModeToggle: React.FC = () => {
  const { isDeployMode, timeRemaining } = useDeployMode();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      setConfirmOpen(false);
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
            className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
          >
            <Rocket className="h-4 w-4 animate-pulse text-destructive! drop-shadow-[0_0_6px_var(--destructive)]" />
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
              className="text-destructive hover:text-destructive"
            >
              <Rocket className="h-4 w-4 text-destructive! drop-shadow-[0_0_6px_var(--destructive)]" />
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
                onClick={() => setConfirmOpen(true)}
                disabled={loading}
                className="w-full bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                size="sm"
              >
                Activate Deploy Mode
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate Deploy Mode?</AlertDialogTitle>
            <AlertDialogDescription>
              This will pause all checks and alerts for {duration} minute{duration === '1' ? '' : 's'}.
              {reason ? ` Reason: "${reason}".` : ''} It will auto-expire when the timer ends.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleEnable();
              }}
              disabled={loading}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {loading ? 'Activating...' : 'Yes, activate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarMenu>
  );
};
