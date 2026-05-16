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

// ── Tunables ─────────────────────────────────────────────────────────────
const AUTH_DEADLINE_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 60_000; // close if no frame from client in this long
const REFRESH_LEAD_MS = 30_000;  // send auth-refresh 30s before exp
const MAX_CONNS_PER_USER = 10;
const MAX_INBOUND_MSG_BYTES = 16 * 1024; // any frame > 16KB is malicious/buggy

// Per-IP connection rate limiting (separate budget from HTTP rate limit so
// they don't starve each other). Sliding-window 1-min budget.
const CONN_RATE_WINDOW_MS = 60_000;
const CONN_RATE_MAX_PER_IP = 60;

// ── Protocol types ───────────────────────────────────────────────────────
// Mirrored in src/lib/ws-protocol.ts when the frontend hook lands (Phase 4).
// Any change here is a protocol-version bump.
type ClientMessage =
  | { type: 'auth'; token: string }
  // `since` is reserved for Phase 3 replay. Accepted now so the wire shape
  // is stable across phases; ignored until replay buffer ships.
  | { type: 'auth'; token: string; since: number };

type ServerMessage =
  | { type: 'auth-ok'; uid: string; expMs: number }
  | { type: 'auth-refresh' }
  | { type: 'error'; code: string; message?: string };

// ── DI surface ───────────────────────────────────────────────────────────
// runner.ts supplies verifyIdToken so this file has no firebase-admin
// dependency of its own — keeps the module testable and isolated from the
// admin SDK's init order.
export interface VerifiedToken {
  uid: string;
  /** Unix seconds (Firebase native). Converted to ms internally. */
  exp: number;
}
export type VerifyIdToken = (token: string) => Promise<VerifiedToken>;

export interface AttachOptions {
  verifyIdToken: VerifyIdToken;
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
const userConnections = new Map<string, Set<Conn>>();
const allConns = new Set<Conn>();

let totalAccepted = 0;
let totalAuthed = 0;
let totalAuthFailed = 0;
let totalAuthTimeout = 0;
let totalUserCapHits = 0;
let totalIpRateLimited = 0;
let totalRefreshSent = 0;
let totalIdleClosed = 0;
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
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket may have been torn down between the readyState check and send
    // — close handler will run and clean up.
  }
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
  msg: { token: string },
  verifyIdToken: VerifyIdToken,
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
}

export function attachWsServer(httpServer: HttpServer, opts: AttachOptions): void {
  if (wss) return;
  const { verifyIdToken } = opts;
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
        handleAuthMessage(conn, parsed, verifyIdToken).catch((err) => {
          console.error('[ws] handleAuthMessage threw:', err);
          closeConn(conn, 1011, 'internal-error');
        });
        return;
      }

      // No app messages exist for clients to send yet. Anything else is a
      // protocol violation in Phase 2; future phases may relax this.
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
  };
}
