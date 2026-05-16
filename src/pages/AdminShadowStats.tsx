import React, { useEffect, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useAdmin } from '@/hooks/useAdmin';
import { useChecks } from '@/hooks/useChecks';
import { useCheckStream, type RegionStatus } from '@/hooks/useCheckStream';
import {
  getShadowSnapshot,
  resetShadowTelemetry,
  type ShadowSnapshot,
} from '@/lib/ws-shadow-telemetry';
import { PageHeader, PageContainer } from '@/components/layout';
import { Button, GlowCard, Badge } from '@/components/ui';
import { Activity, RefreshCcw, Shield, Wifi, WifiOff } from 'lucide-react';

/**
 * Phase 4 — shadow-mode visibility into the WS pipeline.
 *
 * Shows per-region connection state, telemetry counters comparing WS vs
 * Firestore arrivals through the convergence-window logic, and the
 * mismatch rate. Bake target: <0.1% sustained for 24h before promoting
 * WS to primary in Phase 5.
 *
 * The hook is mounted here so admins can watch counters without needing
 * Checks open in another tab — but the same hook is also mounted on
 * Checks.tsx where most data accumulates in normal use. The two mounts
 * each open their own per-region socket (server caps at 10/user, so an
 * admin with 2 regions and 2 tabs still has 8 slots of headroom).
 */
const AdminShadowStats: React.FC = () => {
  const { user } = useUser();
  const { isAdmin, loading: adminLoading } = useAdmin();
  const { checks } = useChecks(user?.id ?? null, () => {});
  const { regions, aggregateState } = useCheckStream(checks);

  const [snapshot, setSnapshot] = useState<ShadowSnapshot>(() => getShadowSnapshot());
  // Poll the telemetry getter — counters are mutated imperatively inside
  // the telemetry module, so we can't subscribe. 1s tick is fast enough to
  // feel live and slow enough to be cheap.
  useEffect(() => {
    const t = setInterval(() => setSnapshot(getShadowSnapshot()), 1_000);
    return () => clearInterval(t);
  }, []);

  if (adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-full max-w-md p-6 bg-card border rounded-lg">
            <div className="text-center space-y-4">
              <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h2 className="text-2xl font-semibold">Access Denied</h2>
                <p className="text-muted-foreground mt-2">
                  You don't have permission to access this page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }

  const mismatchPct = (snapshot.mismatchRate * 100).toFixed(3);
  const bakeMetOk = snapshot.totalClassified > 0 && snapshot.mismatchRate < 0.001;

  return (
    <PageContainer>
      <PageHeader
        title="WS Shadow Stats"
        description="Convergence telemetry comparing WS-streamed updates to Firestore. Bake target: <0.1% mismatch sustained 24h before Phase 5 cutover."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6">
        <KpiBlock
          label="Aggregate WS state"
          value={aggregateState}
          icon={aggregateState === 'live' ? Wifi : WifiOff}
          tone={aggregateState === 'live' ? 'ok' : aggregateState === 'fallback' ? 'bad' : 'warn'}
        />
        <KpiBlock
          label="Mismatch rate"
          value={snapshot.totalClassified === 0 ? '—' : `${mismatchPct}%`}
          sub={`${snapshot.totalClassified.toLocaleString()} classified`}
          icon={Activity}
          tone={snapshot.totalClassified === 0 ? 'idle' : bakeMetOk ? 'ok' : 'bad'}
        />
        <KpiBlock
          label="Pending compares"
          value={snapshot.pendingChecks}
          sub="checks awaiting convergence window"
          icon={Activity}
          tone="idle"
        />
      </div>

      <GlowCard className="p-0 mt-6">
        <div className="m-1 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Regions</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetShadowTelemetry();
                setSnapshot(getShadowSnapshot());
              }}
            >
              <RefreshCcw className="h-3.5 w-3.5 mr-2" />
              Reset counters
            </Button>
          </div>
          {regions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No regions in your check list. Open Checks in another tab to drive traffic.
            </p>
          ) : (
            <div className="space-y-2">
              {regions.map(r => <RegionRow key={r.region} status={r} />)}
            </div>
          )}
        </div>
      </GlowCard>

      <GlowCard className="p-0 mt-6">
        <div className="m-1 p-5">
          <h3 className="font-semibold mb-3">Per-region telemetry</h3>
          {snapshot.perRegion.length === 0 ? (
            <p className="text-sm text-muted-foreground">No telemetry yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5">Region</th>
                    <th className="px-2 py-1.5">Converged</th>
                    <th className="px-2 py-1.5">WS-only</th>
                    <th className="px-2 py-1.5">FS-only</th>
                    <th className="px-2 py-1.5">Hash diverged</th>
                    <th className="px-2 py-1.5">WS trans / arr</th>
                    <th className="px-2 py-1.5">FS trans / arr</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.perRegion.map(r => (
                    <tr key={r.region} className="border-t border-border">
                      <td className="px-2 py-1.5 font-mono">{r.region}</td>
                      <td className="px-2 py-1.5">{r.converged.toLocaleString()}</td>
                      <td className="px-2 py-1.5">{r.wsOnly.toLocaleString()}</td>
                      <td className="px-2 py-1.5">{r.firestoreOnly.toLocaleString()}</td>
                      <td className="px-2 py-1.5">{r.hashDiverged.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        <span className="text-foreground">{r.wsTransitions.toLocaleString()}</span>
                        {' / '}
                        {r.wsArrivals.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        <span className="text-foreground">{r.fsTransitions.toLocaleString()}</span>
                        {' / '}
                        {r.fsArrivals.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </GlowCard>

      <p className="text-xs text-muted-foreground mt-6 max-w-3xl">
        <strong>Reading these numbers:</strong> the convergence math only
        runs on <em>state transitions</em> — changes to status,
        detailedStatus, disabled, maintenanceMode, or lastError. The
        continuous-valued fields (lastChecked, responseTime, etc.) are
        excluded because WS will always observe them ~1.5–3s before
        Firestore, and counting that as mismatch makes the bake target
        unreachable. "WS trans / arr" shows transitions over total arrivals
        — most arrivals are heartbeats with no transition; the
        transitions-count is what the mismatch math runs against.
      </p>
    </PageContainer>
  );
};

interface KpiBlockProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  tone: 'ok' | 'warn' | 'bad' | 'idle';
}

const KpiBlock: React.FC<KpiBlockProps> = ({ label, value, sub, icon: Icon, tone }) => {
  // Tailwind class names are static strings so the build picks them up. A
  // lookup map beats template-string concat which Tailwind doesn't see.
  const toneClass = {
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    bad: 'text-rose-400',
    idle: 'text-muted-foreground',
  }[tone];
  return (
    <GlowCard className="p-0">
      <div className="m-1 p-5">
        <div className="flex items-center justify-between mb-2 text-xs uppercase tracking-wider text-muted-foreground">
          {label}
          <Icon className={`h-4 w-4 ${toneClass}`} />
        </div>
        <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </div>
    </GlowCard>
  );
};

const RegionRow: React.FC<{ status: RegionStatus }> = ({ status }) => {
  const tone =
    status.state === 'live' ? 'ok'
    : status.state === 'fallback' ? 'bad'
    : 'warn';
  const toneClass = {
    ok: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    bad: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  }[tone];
  const lastUpdate = status.lastUpdateAt
    ? new Date(status.lastUpdateAt).toLocaleTimeString()
    : 'never';
  return (
    <div className="flex items-center justify-between gap-4 p-3 rounded-md border border-border">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm">{status.region}</span>
        <Badge className={`text-xs ${toneClass}`}>{status.state}</Badge>
      </div>
      <div className="text-xs text-muted-foreground flex gap-4">
        <span>updates: {status.updatesReceived.toLocaleString()}</span>
        <span>attempts: {status.attempts}</span>
        <span>last: {lastUpdate}</span>
      </div>
    </div>
  );
};

export default AdminShadowStats;
