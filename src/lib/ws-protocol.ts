/**
 * WebSocket wire protocol — frontend side.
 *
 * MUST stay byte-identical with vps/src/ws-protocol.ts inside the SHARED
 * sentinel block. The contract test at scripts/check-ws-protocol.mjs runs
 * on every vps build (prebuild script) and fails the build if the shared
 * blocks diverge. Anything outside the sentinels is per-environment and
 * can differ.
 *
 * Why duplication instead of a shared package: the frontend bundles via
 * Vite (browser ESM) and the VPS runs as Node ESM under tsx/PM2. A shared
 * package adds tooling overhead for ~80 lines of type definitions. The
 * contract test makes the duplication safe.
 *
 * Any addition or removal in the shared block is a protocol version bump;
 * coordinate the frontend and VPS deploys accordingly.
 */

// ── SHARED START ─────────────────────────────────────────────────────────
// Everything between SHARED START and SHARED END must be byte-identical
// across vps/src/ws-protocol.ts and src/lib/ws-protocol.ts.

export const LIVE_FIELD_NAMES = [
  'status',
  'detailedStatus',
  'lastChecked',
  'nextCheckAt',
  'responseTime',
  'lastStatusCode',
  'consecutiveFailures',
  'consecutiveSuccesses',
  'lastError',
  'disabled',
  'maintenanceMode',
] as const;

export type LiveFieldName = typeof LIVE_FIELD_NAMES[number];

export type CheckStatus = 'online' | 'offline';
export type DetailedCheckStatus = 'UP' | 'DOWN' | 'REDIRECT' | 'REACHABLE_WITH_ERROR';

export interface LiveFields {
  status?: CheckStatus;
  detailedStatus?: DetailedCheckStatus;
  lastChecked?: number;
  nextCheckAt?: number;
  responseTime?: number;
  lastStatusCode?: number;
  consecutiveFailures?: number;
  consecutiveSuccesses?: number;
  lastError?: string | null;
  disabled?: boolean;
  maintenanceMode?: boolean;
}

export interface LiveCheck extends LiveFields {
  checkId: string;
}

export interface TransitionEntry {
  checkId: string;
  at: number;
  fields: LiveFields;
}

// Compact response-time chart point. ~30 B on the wire as JSON; ~100 B in
// V8 heap. Server keeps a 24h-window buffer per check; clients fetch a
// slice on chart open and append from the live `update` stream after.
export interface ChartPoint {
  /** ms timestamp (epoch). */
  t: number;
  /** response time ms, or null if the probe failed before getting a response. */
  rt: number | null;
  /** status code (HTTP / protocol), optional. */
  sc?: number;
  /** status at this point — drives marker coloring. */
  st: 'up' | 'down';
}

export type ClientMessage =
  | { type: 'auth'; token: string; since?: number }
  | { type: 'subscribe_history'; checkId: string; windowMs: number };

export type ServerMessage =
  | { type: 'auth-ok'; uid: string; expMs: number }
  | { type: 'auth-refresh' }
  | { type: 'snapshot'; checks: LiveCheck[] }
  | { type: 'update'; checkId: string; fields: LiveFields }
  | { type: 'replay'; transitions: TransitionEntry[] }
  | { type: 'history'; checkId: string; points: ChartPoint[] }
  // App-level liveness tick. Server emits one every ~25s once authed so
  // the client's staleness watchdog has a JS-visible "still alive" signal
  // independent of protocol-level ping/pong (which browsers never surface
  // to JS). Carries no payload — receipt alone is the signal.
  | { type: 'keepalive' }
  | { type: 'error'; code: string; message?: string };

// ── SHARED END ───────────────────────────────────────────────────────────
