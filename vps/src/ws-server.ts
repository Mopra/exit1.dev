/**
 * WebSocket server — Phase 2: auth + connection lifecycle.
 *
 * Lifecycle:
 *   1. Caddy/Traefik terminates TLS, forwards upgrade to localhost:3100/ws.
 *   2. Server accepts the upgrade. Socket enters AWAITING_AUTH state with a
 *      5s deadline.
 *   3. Client sends `{type:"auth", token}` where token is a Firebase ID
 *      token (~1h TTL). Server calls verifyIdToken; on success the socket
 *      is registered in the per-user connection map and replies with
 *      `{type:"auth-ok", uid}`. On failure it closes 4401.
 *   4. While AUTHED: server pings every 30s. If no pong (or any frame) for
 *      60s the socket is terminated. ~30s before the verified token's exp
 *      the server sends `{type:"auth-refresh"}`. Client responds by calling
 *      getIdToken(true) and sending a new `{type:"auth", token}`. If exp
 *      passes without a successful refresh the socket closes 4401.
 *
 * Phase 3 will hook broadcasts into the per-user connection map. Phase 4
 * is when the frontend hook actually consumes these messages.
 *
 * Close codes used here are in the WS app-specific range (4xxx):
 *   4401 — unauthorized (auth failed, token revoked/expired)
 *   4408 — auth window expired (no `auth` message within 5s)
 *   4429 — too many connections (per-user or per-IP cap)
 */
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import {
  LIVE_FIELD_NAMES,
  type ChartPoint,
  type ClientMessage,
  type LiveCheck,
  type LiveFields,
  type ServerMessage,
  type TransitionEntry,
} from './ws-protocol.js';

// ── Tunables ─────────────────────────────────────────────────────────────
const AUTH_DEADLINE_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 60_000; // close if no frame from client in this long
const REFRESH_LEAD_MS = 30_000;  // send auth-refresh 30s before exp
const MAX_CONNS_PER_USER = 10;
const MAX_INBOUND_MSG_BYTES = 16 * 1024; // any frame > 16KB is malicious/buggy

// Backpressure: close any socket whose outbound queue grows past this. A
// slow consumer must not be allowed to hold broadcast memory hostage — at
// 1KB/update × 10K active checks × N slow clients, we'd run out of heap
// fast. Plan target is 5MB.
const MAX_BUFFERED_BYTES = 5 * 1024 * 1024;

// Per-IP connection rate limiting (separate budget from HTTP rate limit so
// they don't starve each other). Sliding-window 1-min budget.
const CONN_RATE_WINDOW_MS = 60_000;
const CONN_RATE_MAX_PER_IP = 60;

// Ring buffer of recent broadcasts per check, used for catch-up replay on
// reconnect. 5 minutes is the plan's starting window — snapshot is the
// authoritative truth on reconnect, so the buffer just lets the UI show
// transitions that happened between disconnect and reconnect.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
// Worst-case bound on per-check ring length so a single thrashing check
// can't grow its buffer without limit if updates are emitted faster than
// the 1-per-tick assumption. At ~2-min check frequencies this is generous.
const REPLAY_MAX_ENTRIES_PER_CHECK = 64;

// ── DI surface ───────────────────────────────────────────────────────────
// runner.ts supplies verifyIdToken and getChecksForUser so this file has no
// firebase-admin or CheckSchedule dependency of its own — keeps the module
// testable and isolated from the admin SDK's init order.
export interface VerifiedToken {
  uid: string;
  /** Unix seconds (Firebase native). Converted to ms internally. */
  exp: number;
}
export type VerifyIdToken = (token: string) => Promise<VerifiedToken>;

/**
 * Pulls the user's checks out of the in-memory CheckSchedule. Returning
 * `LiveCheck[]` (not the full check object) keeps the snapshot path
 * inside the public protocol surface.
 */
export type GetChecksForUser = (userId: string) => LiveCheck[];

/** O(1) ownership check used by the `subscribe_history` handler. */
export type UserOwnsCheck = (userId: string, checkId: string) => boolean;

/** Returns the response-time history slice for a check within `windowMs`. */
export type GetTimeseriesWindow = (checkId: string, windowMs: number) => ChartPoint[];

/** Summary stats for /admin/ws-stats. */
export type GetTimeseriesStats = () => { checks: number; totalPoints: number; approxBytes: number };

export interface AttachOptions {
  verifyIdToken: VerifyIdToken;
  getChecksForUser: GetChecksForUser;
  userOwnsCheck: UserOwnsCheck;
  getTimeseriesWindow: GetTimeseriesWindow;
  getTimeseriesStats: GetTimeseriesStats;
}

// ── State ────────────────────────────────────────────────────────────────
type ConnState = 'awaiting-auth' | 'authed' | 'closing';

interface Conn {
  ws: WebSocket;
  ip: string;
  state: ConnState;
  uid: string | null;
  /** Token expiry in ms (epoch). 0 until authed. */
  tokenExpMs: number;
  /** Timer that fires on AUTH_DEADLINE_MS without an `auth` message. */
  authDeadlineTimer: NodeJS.Timeout | null;
  /** Timer that fires REFRESH_LEAD_MS before tokenExpMs. */
  refreshTimer: NodeJS.Timeout | null;
  /** Timer that fires at tokenExpMs — closes the socket if still authed. */
  expiryTimer: NodeJS.Timeout | null;
  /** Last time the client sent any frame (including pong). */
  lastSeenAt: number;
  /** Whether the server is awaiting a pong reply. */
  awaitingPong: boolean;
}

let wss: WebSocketServer | null = null;
let getChecksForUserCb: GetChecksForUser | null = null;
let getTimeseriesStatsCb: GetTimeseriesStats | null = null;
const userConnections = new Map<string, Set<Conn>>();
const allConns = new Set<Conn>();

/**
 * Per-check ring buffer of recent broadcasts. Entries are dropped lazily —
 * we only spend time pruning when a check is read for replay. This means
 * cold checks may hold a few stale entries until a new broadcast lands on
 * them, which is a tiny memory waste in exchange for zero CPU on the hot
 * broadcast path.
 *
 * Memory ceiling: REPLAY_MAX_ENTRIES_PER_CHECK × ~250B × N checks. With
 * ~10K checks/region and the per-check cap at 64, worst case is ~150MB
 * which we won't reach in practice (most checks have 1-2 entries in any
 * 5-min window).
 */
const replayBuffers = new Map<string, TransitionEntry[]>();

let totalAccepted = 0;
let totalAuthed = 0;
let totalAuthFailed = 0;
let totalAuthTimeout = 0;
let totalUserCapHits = 0;
let totalIpRateLimited = 0;
let totalRefreshSent = 0;
let totalIdleClosed = 0;
let totalBackpressureClosed = 0;
let totalBroadcastSent = 0;
let totalBroadcastBytes = 0;
let totalSnapshotChecksSent = 0;
let totalReplayEntriesSent = 0;
let totalHistoryRequests = 0;
let totalHistoryPointsSent = 0;
let totalHistoryNotOwner = 0;
let rejectedUpgrades = 0;

// Sliding-window per-IP rate limit. Keyed by remote IP.
const ipHitTimes = new Map<string, number[]>();
function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = ipHitTimes.get(ip);
  if (!arr) {
    ipHitTimes.set(ip, [now]);
    return false;
  }
  // Evict expired
  while (arr.length > 0 && arr[0] <= now - CONN_RATE_WINDOW_MS) arr.shift();
  if (arr.length >= CONN_RATE_MAX_PER_IP) return true;
  arr.push(now);
  return false;
}

// Periodic eviction so the map doesn't grow unboundedly over IPs that have
// gone quiet. Runs every 5 min and drops keys with empty arrays.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipHitTimes) {
    while (arr.length > 0 && arr[0] <= now - CONN_RATE_WINDOW_MS) arr.shift();
    if (arr.length === 0) ipHitTimes.delete(ip);
  }
}, 5 * 60 * 1000);

function clientIp(req: IncomingMessage): string {
  // Caddy/Traefik set X-Forwarded-For. Behind those proxies the socket-level
  // remoteAddress is the proxy itself, so we prefer the first XFF entry.
  // If somehow neither is present, fall back to the socket address; if even
  // that's missing we use 'unknown' so the rate-limit bucket still works.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    const payload = JSON.stringify(msg);
    ws.send(payload);
  } catch {
    // Socket may have been torn down between the readyState check and send
    // — close handler will run and clean up.
  }
}

/**
 * Check whether this connection's outbound buffer has grown past the
 * backpressure ceiling. If so, force-terminate the socket so it can't hold
 * memory hostage on the broadcast path. Called from the broadcast loop —
 * the auth path uses `send()` directly because those messages are tiny and
 * a backpressured socket there indicates a much deeper problem.
 */
function isBackpressured(conn: Conn): boolean {
  return conn.ws.bufferedAmount > MAX_BUFFERED_BYTES;
}

function clearTimers(conn: Conn): void {
  if (conn.authDeadlineTimer) {
    clearTimeout(conn.authDeadlineTimer);
    conn.authDeadlineTimer = null;
  }
  if (conn.refreshTimer) {
    clearTimeout(conn.refreshTimer);
    conn.refreshTimer = null;
  }
  if (conn.expiryTimer) {
    clearTimeout(conn.expiryTimer);
    conn.expiryTimer = null;
  }
}

function closeConn(conn: Conn, code: number, reason: string): void {
  if (conn.state === 'closing') return;
  conn.state = 'closing';
  clearTimers(conn);
  try {
    conn.ws.close(code, reason);
  } catch {
    // ignore — close handler still runs from the 'close' event
  }
}

function detachFromUser(conn: Conn): void {
  if (!conn.uid) return;
  const set = userConnections.get(conn.uid);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) userConnections.delete(conn.uid);
}

function scheduleTokenLifecycle(conn: Conn): void {
  // Refresh prompt fires REFRESH_LEAD_MS before exp. If the verified token
  // is already inside the lead window (rare, e.g. clock skew or a token
  // minted close to its exp) the timer fires immediately so we prompt
  // right away rather than waiting for the hard expiry.
  const now = Date.now();
  const leadAt = conn.tokenExpMs - REFRESH_LEAD_MS;
  const refreshDelay = Math.max(0, leadAt - now);
  conn.refreshTimer = setTimeout(() => {
    if (conn.state !== 'authed') return;
    totalRefreshSent++;
    send(conn.ws, { type: 'auth-refresh' });
  }, refreshDelay);

  // Hard expiry: close 4401 if the client never sent a fresh token by exp.
  const expiryDelay = Math.max(0, conn.tokenExpMs - now);
  conn.expiryTimer = setTimeout(() => {
    if (conn.state !== 'authed') return;
    closeConn(conn, 4401, 'token-expired');
  }, expiryDelay);
}

async function handleAuthMessage(
  conn: Conn,
  msg: { token: string; since?: number },
  verifyIdToken: VerifyIdToken,
  getChecksForUser: GetChecksForUser,
): Promise<void> {
  let verified: VerifiedToken;
  try {
    verified = await verifyIdToken(msg.token);
  } catch (err) {
    totalAuthFailed++;
    const reason = err instanceof Error ? err.message.slice(0, 60) : 'verify-failed';
    send(conn.ws, { type: 'error', code: 'invalid_token', message: reason });
    closeConn(conn, 4401, 'invalid-token');
    return;
  }

  // The verified token might have already expired between mint and our
  // verification (very rare — the SDK would normally reject it, but
  // defense in depth). Treat as a failure rather than a silent acceptance.
  const expMs = verified.exp * 1000;
  if (expMs <= Date.now()) {
    totalAuthFailed++;
    closeConn(conn, 4401, 'token-already-expired');
    return;
  }

  // If this is a re-auth on an existing connection (token refresh), the
  // uid must match the originally authed uid. A different uid arriving
  // mid-connection is a protocol violation — we don't allow re-binding
  // the socket to a new user.
  if (conn.uid && conn.uid !== verified.uid) {
    totalAuthFailed++;
    send(conn.ws, { type: 'error', code: 'uid_mismatch' });
    closeConn(conn, 4401, 'uid-mismatch');
    return;
  }

  // First-time auth: enforce per-user cap before registering.
  if (!conn.uid) {
    const existing = userConnections.get(verified.uid);
    if (existing && existing.size >= MAX_CONNS_PER_USER) {
      totalUserCapHits++;
      send(conn.ws, { type: 'error', code: 'user_cap' });
      closeConn(conn, 4429, 'user-conn-cap');
      return;
    }
  }

  // Promote to authed.
  if (conn.authDeadlineTimer) {
    clearTimeout(conn.authDeadlineTimer);
    conn.authDeadlineTimer = null;
  }
  // Replace lifecycle timers — a refresh-auth resets both the refresh
  // prompt and the hard expiry to track the new token's exp.
  if (conn.refreshTimer) {
    clearTimeout(conn.refreshTimer);
    conn.refreshTimer = null;
  }
  if (conn.expiryTimer) {
    clearTimeout(conn.expiryTimer);
    conn.expiryTimer = null;
  }

  const isFirstAuth = !conn.uid;
  conn.uid = verified.uid;
  conn.tokenExpMs = expMs;
  conn.state = 'authed';

  if (isFirstAuth) {
    totalAuthed++;
    let set = userConnections.get(verified.uid);
    if (!set) {
      set = new Set<Conn>();
      userConnections.set(verified.uid, set);
    }
    set.add(conn);
  }

  scheduleTokenLifecycle(conn);
  send(conn.ws, { type: 'auth-ok', uid: verified.uid, expMs });

  // First-auth: send a snapshot of the user's checks so the client renders
  // immediately without a Firestore round-trip. Re-auth (token refresh) does
  // NOT re-send the snapshot — the client already has fresh state from the
  // running stream, and a duplicate snapshot would just churn the UI.
  if (isFirstAuth) {
    sendSnapshot(conn, verified.uid, getChecksForUser);
    // Replay catches the gap between the client's `since` and now. The
    // snapshot above is authoritative for current state; replay is purely
    // for surfacing transitions that happened while disconnected.
    if (typeof msg.since === 'number' && msg.since > 0) {
      sendReplay(conn, verified.uid, msg.since, getChecksForUser);
    }
  }
}

function sendSnapshot(
  conn: Conn,
  uid: string,
  getChecksForUser: GetChecksForUser,
): void {
  let checks: LiveCheck[];
  try {
    checks = getChecksForUser(uid);
  } catch (err) {
    console.error('[ws] getChecksForUser threw for snapshot:', err);
    return;
  }
  totalSnapshotChecksSent += checks.length;
  send(conn.ws, { type: 'snapshot', checks });
}

function sendReplay(
  conn: Conn,
  uid: string,
  since: number,
  getChecksForUser: GetChecksForUser,
): void {
  // Cap how far back a client can request to bound work — anything older
  // than the replay window can't be answered anyway, so we clamp rather
  // than scanning the buffer for entries we know we don't have.
  const effectiveSince = Math.max(since, Date.now() - REPLAY_WINDOW_MS);

  const owned = getChecksForUser(uid);
  if (owned.length === 0) {
    send(conn.ws, { type: 'replay', transitions: [] });
    return;
  }

  const now = Date.now();
  const cutoff = now - REPLAY_WINDOW_MS;
  const transitions: TransitionEntry[] = [];
  for (const check of owned) {
    const buf = replayBuffers.get(check.checkId);
    if (!buf) continue;
    // Lazy prune — keeps cold-buffer memory bounded without paying on the
    // hot broadcast path.
    while (buf.length > 0 && buf[0].at < cutoff) buf.shift();
    if (buf.length === 0) {
      replayBuffers.delete(check.checkId);
      continue;
    }
    for (const entry of buf) {
      if (entry.at > effectiveSince) transitions.push(entry);
    }
  }
  // Stable chronological order across all checks so the client can apply
  // transitions in the order they occurred without per-check sorting.
  transitions.sort((a, b) => a.at - b.at);
  totalReplayEntriesSent += transitions.length;
  send(conn.ws, { type: 'replay', transitions });
}

function handleSubscribeHistory(
  conn: Conn,
  msg: { checkId: string; windowMs: number },
  userOwnsCheck: UserOwnsCheck,
  getTimeseriesWindow: GetTimeseriesWindow,
): void {
  if (conn.state !== 'authed' || !conn.uid) return;
  totalHistoryRequests++;

  if (!userOwnsCheck(conn.uid, msg.checkId)) {
    totalHistoryNotOwner++;
    // Soft error — an honest client racing a stale checkId (e.g. just
    // deleted, or never owned) shouldn't be disconnected.
    send(conn.ws, { type: 'error', code: 'not_owner' });
    return;
  }

  // window() clamps internally, so any positive number works here.
  const points = getTimeseriesWindow(msg.checkId, msg.windowMs);
  totalHistoryPointsSent += points.length;
  send(conn.ws, { type: 'history', checkId: msg.checkId, points });
}

export function attachWsServer(httpServer: HttpServer, opts: AttachOptions): void {
  if (wss) return;
  const { verifyIdToken, getChecksForUser, userOwnsCheck, getTimeseriesWindow, getTimeseriesStats } = opts;
  getChecksForUserCb = getChecksForUser;
  getTimeseriesStatsCb = getTimeseriesStats;
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_MSG_BYTES });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (url !== '/ws' && !url.startsWith('/ws?')) {
      rejectedUpgrades++;
      socket.destroy();
      return;
    }

    const ip = clientIp(req);
    if (isIpRateLimited(ip)) {
      totalIpRateLimited++;
      // We're pre-upgrade — emit a 429 over the raw socket and close.
      // Browsers surface this as a connection failure; wscat shows the body.
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\n' +
        'Retry-After: 60\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n'
      );
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req, ip);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, ip: string) => {
    totalAccepted++;
    const conn: Conn = {
      ws,
      ip,
      state: 'awaiting-auth',
      uid: null,
      tokenExpMs: 0,
      authDeadlineTimer: null,
      refreshTimer: null,
      expiryTimer: null,
      lastSeenAt: Date.now(),
      awaitingPong: false,
    };
    allConns.add(conn);

    conn.authDeadlineTimer = setTimeout(() => {
      if (conn.state !== 'awaiting-auth') return;
      totalAuthTimeout++;
      send(ws, { type: 'error', code: 'auth_required' });
      closeConn(conn, 4408, 'auth-deadline');
    }, AUTH_DEADLINE_MS);

    ws.on('message', (raw: RawData) => {
      conn.lastSeenAt = Date.now();
      conn.awaitingPong = false;

      // Defensive payload bounding — wss.maxPayload already enforces this
      // at the protocol layer, but Buffer.byteLength avoids a JSON parse
      // on a payload we're going to reject anyway.
      const text = raw.toString('utf8');
      if (text.length > MAX_INBOUND_MSG_BYTES) {
        send(ws, { type: 'error', code: 'payload_too_large' });
        closeConn(conn, 1009, 'payload-too-large');
        return;
      }

      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(text) as ClientMessage;
      } catch {
        send(ws, { type: 'error', code: 'bad_json' });
        closeConn(conn, 1003, 'bad-json');
        return;
      }

      if (parsed?.type === 'auth' && typeof parsed.token === 'string') {
        // Don't await — we want the message handler to return promptly.
        // Auth failures inside handleAuthMessage close the socket; success
        // updates conn.state. No concurrent auth handling needed because
        // a single client only sends one auth at a time, and an attacker
        // spamming auth gets caught by the per-IP rate limit at upgrade
        // time and the per-message length cap.
        const since = typeof parsed.since === 'number' && parsed.since > 0 ? parsed.since : undefined;
        handleAuthMessage(conn, { token: parsed.token, since }, verifyIdToken, getChecksForUser).catch((err) => {
          console.error('[ws] handleAuthMessage threw:', err);
          closeConn(conn, 1011, 'internal-error');
        });
        return;
      }

      if (
        parsed?.type === 'subscribe_history' &&
        typeof parsed.checkId === 'string' &&
        typeof parsed.windowMs === 'number'
      ) {
        handleSubscribeHistory(
          conn,
          { checkId: parsed.checkId, windowMs: parsed.windowMs },
          userOwnsCheck,
          getTimeseriesWindow,
        );
        return;
      }

      // Anything else is a protocol violation; future phases may relax this.
      send(ws, { type: 'error', code: 'unknown_message' });
      closeConn(conn, 1003, 'unknown-message');
    });

    ws.on('pong', () => {
      conn.lastSeenAt = Date.now();
      conn.awaitingPong = false;
    });

    ws.on('close', () => {
      clearTimers(conn);
      detachFromUser(conn);
      allConns.delete(conn);
    });

    ws.on('error', () => {
      // 'close' fires after 'error'; cleanup happens there. Swallow to
      // prevent unhandledError from killing the process on socket-level
      // races we can't act on.
    });
  });
}

// Periodic heartbeat sweep. A single shared timer is cheaper than per-socket
// timers when there are many connections and gives the sweep loop natural
// jitter resistance — a 30s+ sweep window guarantees we send a ping in
// [PING_INTERVAL_MS, 2*PING_INTERVAL_MS) at worst case.
setInterval(() => {
  const now = Date.now();
  for (const conn of allConns) {
    if (conn.state !== 'authed' && conn.state !== 'awaiting-auth') continue;
    const idleFor = now - conn.lastSeenAt;
    if (idleFor >= PONG_DEADLINE_MS) {
      totalIdleClosed++;
      try {
        conn.ws.terminate();
      } catch {
        /* ignore */
      }
      continue;
    }
    if (conn.state === 'authed' && idleFor >= PING_INTERVAL_MS && !conn.awaitingPong) {
      conn.awaitingPong = true;
      try {
        conn.ws.ping();
      } catch {
        /* ignore — close handler will fire on the next tick */
      }
    }
  }
}, PING_INTERVAL_MS / 2);

// ── Stats exported to /health ────────────────────────────────────────────
export interface WsStats {
  activeAuthed: number;
  activeAwaitingAuth: number;
  uniqueUsers: number;
  totalAccepted: number;
  totalAuthed: number;
  totalAuthFailed: number;
  totalAuthTimeout: number;
  totalUserCapHits: number;
  totalIpRateLimited: number;
  totalRefreshSent: number;
  totalIdleClosed: number;
  rejectedUpgrades: number;
  totalHistoryRequests: number;
  totalHistoryNotOwner: number;
}

export function getWsStats(): WsStats {
  let authed = 0;
  let awaitingAuth = 0;
  for (const conn of allConns) {
    if (conn.state === 'authed') authed++;
    else if (conn.state === 'awaiting-auth') awaitingAuth++;
  }
  return {
    activeAuthed: authed,
    activeAwaitingAuth: awaitingAuth,
    uniqueUsers: userConnections.size,
    totalAccepted,
    totalAuthed,
    totalAuthFailed,
    totalAuthTimeout,
    totalUserCapHits,
    totalIpRateLimited,
    totalRefreshSent,
    totalIdleClosed,
    rejectedUpgrades,
    totalHistoryRequests,
    totalHistoryNotOwner,
  };
}

// ── Broadcast (called from runner's status-update hook) ──────────────────

/**
 * Fan-out an update to every authed connection owned by `ownerUserId`, and
 * append the entry to that check's replay buffer so reconnecting clients
 * can catch up the transition.
 *
 * `fields` is the same partial the status buffer hook receives — only what
 * changed in this tick. Clients overlay on top of their current state.
 *
 * Returns the number of sockets the message was sent to (0 is normal when
 * the owner isn't connected, or when a check fires while every tab is
 * backgrounded and closed).
 */
export function broadcastUpdate(
  checkId: string,
  ownerUserId: string,
  fields: LiveFields,
): number {
  // Skip empty deltas — the hook fires for any field-set including ones that
  // contain only non-live fields (e.g. ssl cert). Cheap early-out.
  let hasField = false;
  for (const k of LIVE_FIELD_NAMES) {
    if (fields[k] !== undefined) { hasField = true; break; }
  }
  if (!hasField) return 0;

  // Append to ring buffer. We push first regardless of whether anyone is
  // currently connected — a client may reconnect in the next 5 min and want
  // the transition replayed.
  const at = Date.now();
  let buf = replayBuffers.get(checkId);
  if (!buf) {
    buf = [];
    replayBuffers.set(checkId, buf);
  }
  buf.push({ checkId, at, fields });
  // Eager cap on per-check entries — separate from time-based pruning so a
  // single thrashing check can't bloat memory inside a single replay window.
  if (buf.length > REPLAY_MAX_ENTRIES_PER_CHECK) {
    buf.splice(0, buf.length - REPLAY_MAX_ENTRIES_PER_CHECK);
  }

  const conns = userConnections.get(ownerUserId);
  if (!conns || conns.size === 0) return 0;

  const payload = JSON.stringify({ type: 'update', checkId, fields } satisfies ServerMessage);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  let delivered = 0;

  for (const conn of conns) {
    if (conn.state !== 'authed') continue;
    if (conn.ws.readyState !== WebSocket.OPEN) continue;
    if (isBackpressured(conn)) {
      // Slow consumer — terminate so it stops accruing memory. Close handler
      // will detach it from userConnections.
      totalBackpressureClosed++;
      closeConn(conn, 1013, 'backpressure');
      continue;
    }
    try {
      conn.ws.send(payload);
      delivered++;
    } catch {
      // Socket likely closing — let the close handler clean up.
    }
  }

  if (delivered > 0) {
    totalBroadcastSent += delivered;
    totalBroadcastBytes += payloadBytes * delivered;
  }
  return delivered;
}

// ── Deep stats (admin endpoint) ──────────────────────────────────────────

export interface DeepWsStats extends WsStats {
  totalBackpressureClosed: number;
  totalBroadcastSent: number;
  totalBroadcastBytes: number;
  totalSnapshotChecksSent: number;
  totalReplayEntriesSent: number;
  totalHistoryPointsSent: number;
  /** Connection count per uid (sample, capped to avoid huge payloads). */
  perUser: Array<{ uid: string; conns: number }>;
  replayBufferDepth: number;
  ipBuckets: number;
  /** Live-chart timeseries memory pressure across all checks on this VPS. */
  timeseries: { checks: number; totalPoints: number; approxBytes: number };
}

const MAX_PER_USER_REPORT = 50;

export function getDeepWsStats(): DeepWsStats {
  const base = getWsStats();
  const perUser: Array<{ uid: string; conns: number }> = [];
  for (const [uid, conns] of userConnections) {
    perUser.push({ uid, conns: conns.size });
    if (perUser.length >= MAX_PER_USER_REPORT) break;
  }
  // Sort descending by connection count so the largest are first when
  // truncated — most useful for spotting outliers in an incident.
  perUser.sort((a, b) => b.conns - a.conns);

  let replayDepth = 0;
  for (const buf of replayBuffers.values()) replayDepth += buf.length;

  return {
    ...base,
    totalBackpressureClosed,
    totalBroadcastSent,
    totalBroadcastBytes,
    totalSnapshotChecksSent,
    totalReplayEntriesSent,
    totalHistoryPointsSent,
    perUser,
    replayBufferDepth: replayDepth,
    ipBuckets: ipHitTimes.size,
    timeseries: getTimeseriesStatsCb
      ? getTimeseriesStatsCb()
      : { checks: 0, totalPoints: 0, approxBytes: 0 },
  };
}

// Replay buffer maintenance: periodically drop checks whose entire buffer
// has aged out. Lazy pruning during replay handles most of this; this is
// the safety net for checks that go quiet and never get touched again.
setInterval(() => {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  for (const [checkId, buf] of replayBuffers) {
    while (buf.length > 0 && buf[0].at < cutoff) buf.shift();
    if (buf.length === 0) replayBuffers.delete(checkId);
  }
}, REPLAY_WINDOW_MS);

// Silence the linter — getChecksForUserCb is captured for future helpers
// (e.g. an admin "send snapshot now" tool) but unused outside the closure
// path inside attachWsServer. Keeping the reference makes the wiring
// explicit and prevents getChecksForUser from being mistakenly torn down
// during HMR / re-attach in tests.
void getChecksForUserCb;
