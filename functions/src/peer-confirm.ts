// Phase 2 multi-region peer confirmation: caller-side helper.
//
// When the primary VPS observes a check failure, it calls the peer's
// /api/peer-confirm endpoint to ask "do you also see this as offline?"
// and uses the answer to gate the failure-counter increment.
//
// Safety contract (load-bearing):
//   • Never throws. All exceptions become { reachable: false, ... }.
//   • Bounded by PEER_CONFIRM_TIMEOUT_MS — a slow peer cannot stack up
//     primary work.
//   • Per-peer in-process circuit breaker fast-fails after consecutive
//     errors so a sustained outage doesn't burn 5s per probe.
//   • No retry. The next probe is the retry — retrying within a probe
//     just doubles the budget for no information gain.
//
// Logs: info on circuit state changes, debug on individual calls.
// Never warn — peer-unreachable is an expected steady-state in some
// failure modes (deploys, transient network blips), and a warn flood
// would drown the real signal.

import { logger } from 'firebase-functions/v2';
import { CONFIG } from './config.js';
import { VPS_MANUAL_CHECK_SECRET } from './env.js';
import { peerRegionFor, type CheckRegion } from './check-region.js';
import { getPeerSettings } from './peer-settings.js';
import type { Website } from './types.js';
import type { CheckType } from './check-helpers.js';

export type PeerConfirmResult = {
  reachable: boolean;
  region: CheckRegion | null;
  status: 'online' | 'offline' | null;
  responseTime: number | null;
  statusCode: number | null;
  checkedAt: number | null;
  error: string | null;
};

type CircuitState = 'closed' | 'open' | 'half_open';

type CircuitEntry = {
  state: CircuitState;
  consecutiveErrors: number;
  openedAt: number;
};

const circuits = new Map<CheckRegion, CircuitEntry>();

function getCircuit(peer: CheckRegion): CircuitEntry {
  let c = circuits.get(peer);
  if (!c) {
    c = { state: 'closed', consecutiveErrors: 0, openedAt: 0 };
    circuits.set(peer, c);
  }
  return c;
}

function setCircuitState(peer: CheckRegion, c: CircuitEntry, next: CircuitState): void {
  if (c.state === next) return;
  const previous = c.state;
  c.state = next;
  logger.info(`[peer-confirm] circuit ${peer}: ${previous} -> ${next}`);
}

// Eligibility for peer confirmation. Single source of truth — every caller
// must go through this. Structural exclusions are evaluated synchronously;
// the global flag is awaited (cached on the runner for 30s).
export async function isPeerEnabledForCheck(
  check: Website,
  primaryRegion: CheckRegion,
): Promise<boolean> {
  // Structural exclusions — never peer-confirm these:
  if (check.type === 'heartbeat') return false;          // peer cannot receive the ping
  if (peerRegionFor(primaryRegion) === null) return false; // legacy regions
  if (check.peerConfirmDisabled === true) return false;  // per-check escape hatch

  // Configuration gate — single source of truth:
  const settings = await getPeerSettings();
  return settings.enabled === true;
}

// Exposed for /health surfacing in the runner. Read-only snapshot.
export function getPeerCircuitSnapshot(): Record<string, { state: CircuitState; consecutiveErrors: number }> {
  const out: Record<string, { state: CircuitState; consecutiveErrors: number }> = {};
  for (const [region, c] of circuits) {
    out[region] = { state: c.state, consecutiveErrors: c.consecutiveErrors };
  }
  return out;
}

function unreachable(peer: CheckRegion | null, error: string): PeerConfirmResult {
  return {
    reachable: false,
    region: peer,
    status: null,
    responseTime: null,
    statusCode: null,
    checkedAt: null,
    error,
  };
}

function getPeerSecret(): string | undefined {
  try {
    return VPS_MANUAL_CHECK_SECRET.value();
  } catch {
    return process.env.VPS_MANUAL_CHECK_SECRET;
  }
}

export async function callPeerConfirm(
  check: Website,
  peerRegion: CheckRegion,
  checkType: CheckType,
  originRegion: CheckRegion,
): Promise<PeerConfirmResult> {
  const peerUrl = CONFIG.VPS_REGION_URLS[peerRegion];
  if (!peerUrl) {
    return unreachable(peerRegion, 'peer_url_not_configured');
  }

  const secret = getPeerSecret();
  if (!secret) {
    return unreachable(peerRegion, 'peer_secret_not_configured');
  }

  // Circuit breaker
  const circuit = getCircuit(peerRegion);
  const now = Date.now();
  if (circuit.state === 'open') {
    if (now - circuit.openedAt >= CONFIG.PEER_CONFIRM_CIRCUIT_COOLDOWN_MS) {
      setCircuitState(peerRegion, circuit, 'half_open');
    } else {
      return unreachable(peerRegion, 'circuit_open');
    }
  }

  const startedAt = Date.now();
  try {
    const resp = await fetch(`${peerUrl}/api/peer-confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: JSON.stringify({
        checkId: check.id,
        website: check,
        checkType,
        originRegion,
      }),
      signal: AbortSignal.timeout(CONFIG.PEER_CONFIRM_TIMEOUT_MS),
    });

    if (resp.status === 429 || resp.status === 503) {
      // Treated as unreachable — peer is up but explicitly declining.
      // Doesn't count toward circuit-breaker errors: the peer told us it's
      // overloaded or paused, not that the link is broken.
      const text = await resp.text().catch(() => '');
      const reason = resp.status === 429 ? 'peer_rate_limited' : 'peer_self_disabled';
      logger.debug(`[peer-confirm] ${peerRegion} ${reason} body=${text.slice(0, 200)}`);
      return unreachable(peerRegion, reason);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`peer_http_${resp.status}:${text.slice(0, 120)}`);
    }

    const body = (await resp.json()) as {
      region?: string;
      status?: 'online' | 'offline';
      responseTime?: number;
      statusCode?: number | null;
      checkedAt?: number;
      error?: string;
    };

    if (body.status !== 'online' && body.status !== 'offline') {
      throw new Error('peer_returned_invalid_status');
    }

    // Success: reset circuit
    if (circuit.state === 'half_open' || circuit.consecutiveErrors > 0) {
      circuit.consecutiveErrors = 0;
      setCircuitState(peerRegion, circuit, 'closed');
    }

    logger.debug(
      `[peer-confirm] ${peerRegion} ${body.status} for ${check.id} in ${Date.now() - startedAt}ms`,
    );

    return {
      reachable: true,
      region: peerRegion,
      status: body.status,
      responseTime: typeof body.responseTime === 'number' ? body.responseTime : null,
      statusCode: typeof body.statusCode === 'number' ? body.statusCode : null,
      checkedAt: typeof body.checkedAt === 'number' ? body.checkedAt : Date.now(),
      error: typeof body.error === 'string' ? body.error.slice(0, 500) : null,
    };
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err);

    circuit.consecutiveErrors++;
    if (
      circuit.state !== 'open' &&
      circuit.consecutiveErrors >= CONFIG.PEER_CONFIRM_CIRCUIT_THRESHOLD
    ) {
      circuit.openedAt = Date.now();
      setCircuitState(peerRegion, circuit, 'open');
    } else if (circuit.state === 'half_open') {
      // Half-open probe failed — re-open immediately
      circuit.openedAt = Date.now();
      setCircuitState(peerRegion, circuit, 'open');
    }

    logger.debug(`[peer-confirm] ${peerRegion} call failed: ${errStr}`);
    return unreachable(peerRegion, errStr.slice(0, 200));
  }
}
