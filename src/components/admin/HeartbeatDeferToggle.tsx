import React, { useState } from 'react';
import { Activity, ArrowDownToLine } from 'lucide-react';
import { toast } from 'sonner';
import {
  CardContent,
  CardHeader,
  CardTitle,
  GlowCard,
  Switch,
} from '@/components/ui';
import { apiClient } from '@/api/client';
import { useHeartbeatDefer } from '@/hooks/useHeartbeatDefer';

/**
 * Phase 7 admin control: toggles the heartbeat-defer flag in
 * `system_settings/heartbeat_defer`. Both VPSes listen via onSnapshot
 * and apply the change within seconds — no redeploy.
 *
 * Trade-off shown inline so an admin flipping the switch sees the
 * fallback-path impact before changing platform behavior. Disabling
 * drains the deferred buffer immediately on the VPS side; no stale
 * state lingers.
 */
export const HeartbeatDeferToggle: React.FC = () => {
  const { enabled, state, loading } = useHeartbeatDefer();
  const [pending, setPending] = useState(false);

  const handleToggle = async (next: boolean) => {
    if (pending) return;
    setPending(true);
    const result = await apiClient.toggleHeartbeatDefer(next);
    if (result.success) {
      toast.success(
        next ? 'Heartbeat-defer enabled' : 'Heartbeat-defer disabled — buffer draining',
      );
    } else {
      toast.error(result.error || 'Toggle failed');
    }
    setPending(false);
  };

  const status =
    loading ? 'Loading…'
    : enabled ? 'Enabled — heartbeats batched every 5 min'
    : 'Disabled — heartbeats write through the normal flush path';

  return (
    <GlowCard className="p-0 lg:col-span-2">
      <div className="m-1">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ArrowDownToLine className="h-4 w-4" />
              Heartbeat-defer (Phase 7)
            </CardTitle>
            <Switch
              checked={!!enabled}
              disabled={loading || pending}
              onCheckedChange={handleToggle}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{status}</p>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <p>
            When enabled, only state-transition updates (status, detailedStatus,
            disabled, maintenanceMode, lastError, or
            <code className="px-1"> consecutiveFailures</code> crossing zero)
            write to Firestore immediately. Heartbeats — same state, just
            <code className="px-1">lastChecked</code> moving — batch into a
            single write every 5 min per check.
          </p>
          <p>
            <strong className="text-foreground">Trade-off:</strong> in WS-fallback
            mode the dashboard's <code className="px-1">lastChecked</code> ages
            up to ~5 min stale instead of ~2s. Transitions still arrive
            immediately. The WS primary path is unaffected. Disabling drains
            the deferred buffer instantly — rollback has no lag.
          </p>
          {state?.updatedAt && (
            <p className="flex items-center gap-2 text-foreground/80">
              <Activity className="h-3 w-3" />
              Last toggled: {new Date(state.updatedAt).toLocaleString()}
              {state.updatedBy ? ` by ${state.updatedBy.slice(0, 12)}…` : ''}
            </p>
          )}
        </CardContent>
      </div>
    </GlowCard>
  );
};
