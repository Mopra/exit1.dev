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
  'dnsMs',
  'connectMs',
  'tlsMs',
  'ttfbMs',
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
  // Phase timings — only HTTP probes (website / rest_endpoint / redirect)
  // populate these. Carried on every probe broadcast so the chart's
  // appended-while-live points get the same phase breakdown as the
  // initial history replay's points.
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
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
//
// Phase fields (dn/cn/tl/ft) are only present for HTTP-flavoured probes
// (website / rest_endpoint / redirect). TCP/UDP/ICMP/DNS/heartbeat probes
// emit a ChartPoint without them. Keys are kept to 1-2 chars to hold the
// per-point wire+heap budget — ~16 extra bytes per HTTP point, ~12 KB
// extra in memory for a 24h buffer at 2-min cadence.
export interface ChartPoint {
  /** ms timestamp (epoch). */
  t: number;
  /** response time ms, or null if the probe failed before getting a response. */
  rt: number | null;
  /** status code (HTTP / protocol), optional. */
  sc?: number;
  /** status at this point — drives marker coloring. */
  st: 'up' | 'down';
  /** DNS resolution ms (HTTP probes only). */
  dn?: number;
  /** TCP connect ms (HTTP probes only). */
  cn?: number;
  /** TLS handshake ms (HTTPS probes only). */
  tl?: number;
  /** Time-to-first-byte ms (HTTP probes only). */
  ft?: number;
}

// Time-range tag for non-running check states (maintenance, disabled).
// Per-check, independent of region — both are check-level toggles. Used
// for shading bands on the chart so the user can see why the line went
// flat or absent during a window. `e: null` means the segment is still
// open; the server re-broadcasts the same segment with `e` filled in
// when it closes. Clients match by (k, s).
export type CheckStateKind = 'maintenance' | 'disabled';
export interface StateSegment {
  /** kind — drives band color. */
  k: CheckStateKind;
  /** start ms epoch. */
  s: number;
  /** end ms epoch, or null while still active. */
  e: number | null;
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
  | { type: 'history'; checkId: string; points: ChartPoint[]; segments: StateSegment[] }
  // State-segment event. Fired on open (e=null) and on close (same
  // segment with e set). Clients dedupe by (checkId, k, s) and merge in.
  | { type: 'state'; checkId: string; segment: StateSegment }
  // App-level liveness tick. Server emits one every ~25s once authed so
  // the client's staleness watchdog has a JS-visible "still alive" signal
  // independent of protocol-level ping/pong (which browsers never surface
  // to JS). Carries no payload — receipt alone is the signal.
  | { type: 'keepalive' }
  | { type: 'error'; code: string; message?: string };

// ── SHARED END ───────────────────────────────────────────────────────────
