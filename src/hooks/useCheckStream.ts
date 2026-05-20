/**
 * useCheckStream — Phase 5: WebSocket is authoritative for live fields.
 *
 * Opens one WS per region the user has checks in. Maintains a per-check
 * WS overlay (the last-known live-field state for each check) and merges
 * it on top of the Firestore `checks` array to produce `effectiveChecks`
 * that consumers render against.
 *
 * Region state machine with hysteresis:
 *   - `connecting` / `authing` — initial open, no overlay trusted yet for
 *     this region (consumers fall back to Firestore until auth-ok).
 *   - `live` — auth-ok received; overlay is current and authoritative.
 *   - `reconnecting` — WS dropped; the overlay's last-known values stay
 *     trusted for FALLBACK_HYSTERESIS_MS so a 1–3s flap doesn't bounce
 *     the displayed values between WS-fresh and Firestore-stale.
 *   - `fallback` — disconnected longer than the hysteresis window; the
 *     overlay is considered stale and consumers render from Firestore
 *     until WS reconnects.
 *   - `idle` — no endpoint configured for this region; render Firestore.
 *
 * Reconnect path is unchanged from Phase 4: exponential backoff to 30s,
 * 4401 forces token refresh, snapshot replays on reconnect via `since`.
 *
 * Kill switch: WS_PRIMARY_ENABLED. Set false to short-circuit the merge
 * and return raw Firestore checks. The hook still opens connections and
 * feeds shadow telemetry so we keep the data flowing for diagnosis even
 * when rendering reverts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { auth } from '../firebase';
import type { Website } from '../types';
import {
  LIVE_FIELD_NAMES,
  type ChartPoint,
  type LiveCheck,
  type LiveFields,
  type ServerMessage,
  type StateSegment,
} from '../lib/ws-protocol';
import { getWsEndpoint } from '../lib/ws-endpoints';
import { recordFirestoreArrival, recordWsArrival } from '../lib/ws-shadow-telemetry';

type CheckRegion = NonNullable<Website['checkRegion']>;

export type RegionWsState =
  | 'idle'
  | 'connecting'
  | 'authing'
  | 'live'
  | 'reconnecting'
  | 'fallback';

export interface RegionStatus {
  region: CheckRegion;
  state: RegionWsState;
  attempts: number;
  lastAuthedAt: number;
  lastUpdateAt: number;
  updatesReceived: number;
  /** When the current fallback engaged (epoch ms). 0 if not in fallback. */
  fallbackSince: number;
}

interface RegionConn {
  region: CheckRegion;
  ws: WebSocket | null;
  state: RegionWsState;
  attempts: number;
  lastAuthedAt: number;
  lastUpdateAt: number;
  updatesReceived: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  emitThrottleTimer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  fallbackSince: number;
  /** Last event timestamp received via WS — used as `since` on reconnect. */
  lastEventAt: number;
  /**
   * Local timestamp of the last server frame received (ANY message —
   * keepalive, update, snapshot, auth-ok, etc.). Drives the staleness
   * watchdog: protocol-level ping/pong is invisible to browser JS, so a
   * half-open socket (NAT timeout, laptop sleep, ISP blip) sits at
   * readyState=OPEN forever from JS's perspective. The watchdog force-
   * closes the socket if no frame has arrived in `STALE_THRESHOLD_MS`,
   * which routes through the existing `close` → `scheduleReconnect` path.
   */
  lastFrameAt: number;
  torndown: boolean;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const MAX_REGIONS = 5;
const EMIT_THROTTLE_MS = 250;

/**
 * After WS disconnect, how long the overlay's last-known values stay
 * trusted before consumers flip to Firestore. The plan calls out 8s
 * specifically as the threshold that debounces a normal 1–3s reconnect
 * without users seeing fallback values flash through.
 */
const FALLBACK_HYSTERESIS_MS = 8_000;

/**
 * Staleness watchdog: if no server frame has arrived in this long while
 * the socket is supposedly OPEN, treat it as zombie and force-close it
 * (the existing close handler then schedules a reconnect). Server sends
 * an app-level `keepalive` every ~30s, so 75s allows for one missed
 * keepalive plus a generous network burp before we declare the socket
 * dead.
 */
const STALE_THRESHOLD_MS = 75_000;
const STALE_CHECK_INTERVAL_MS = 15_000;

/**
 * Kill switch for Phase 5. When false, effectiveChecks === checks (the
 * raw Firestore list), and the hook degrades to Phase 4 shadow-mode
 * behavior. Connections + telemetry continue running so an instant
 * re-enable doesn't require reconnecting everything.
 */
const WS_PRIMARY_ENABLED = true;

export interface UseCheckStreamOptions {
  /** Killswitch — set false to disable the hook entirely. */
  enabled?: boolean;
}

export interface UseCheckStreamResult {
  /** Checks with WS live-field overlay applied region-by-region. */
  effectiveChecks: Website[];
  regions: RegionStatus[];
  /**
   * Aggregate state across regions: 'live' iff every region is live;
   * otherwise the most-degraded region's state. Used by the connection
   * indicator and the fallback banner.
   */
  aggregateState: RegionWsState;
  /**
   * Region currently in fallback, if any, plus the timestamp the
   * fallback engaged. Used by the banner that appears after 10s of
   * accumulated fallback to surface user-visible degradation.
   */
  fallbackRegion: { region: CheckRegion; since: number } | null;
  /**
   * live-charts.md Phase 1: response-time history per check, populated by
   * `subscribeHistory()` + live `update` messages. Only checks the caller
   * has subscribed to are tracked here. Internally backed by a ref +
   * version counter, so consumers should read it inside a render scope
   * and not memoize across renders.
   */
  historyByCheckId: Map<string, ChartPoint[]>;
  /**
   * State-segment timeline per check (maintenance / disabled bands).
   * Populated alongside `historyByCheckId` by `subscribeHistory()` +
   * live `state` events. Same ref-plus-version pattern as history —
   * shares the same version counter so a single render handles both.
   */
  segmentsByCheckId: Map<string, StateSegment[]>;
  /**
   * Ask the server for the last `windowMs` of response-time history for
   * `checkId`, sent over the WS for `region`. Returns true if the message
   * was sent (region's connection is open + authed), false if not — the
   * caller can retry after `regions` flips that region to `'live'`.
   */
  subscribeHistory: (checkId: string, region: CheckRegion, windowMs: number) => boolean;
  /**
   * Drop the in-memory history buffer for `checkId`. Live `update`
   * messages for that checkId stop appending until a new
   * `subscribeHistory()` call seeds a fresh entry. Call on unmount of any
   * page that subscribed, otherwise per-check buffers leak across
   * navigations.
   */
  unsubscribeHistory: (checkId: string) => void;
}

export function useCheckStream(
  checks: Website[],
  { enabled = true }: UseCheckStreamOptions = {},
): UseCheckStreamResult {
  const [statuses, setStatuses] = useState<RegionStatus[]>([]);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const connsRef = useRef<Map<CheckRegion, RegionConn>>(new Map());
  // Mutable per-check overlay map. Writes happen on every WS message;
  // re-renders are driven by an incrementing version counter so we don't
  // pay a full Map copy per message. The useMemo over effectiveChecks
  // reads this ref directly, which is safe because the version dep
  // forces the memo to recompute when overlay content changes.
  const overlayRef = useRef<Map<string, LiveFields>>(new Map());
  const overlayThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-check response-time history. Populated by `subscribeHistory()` +
  // append-on-update. Keyed by checkId. Same ref-plus-version pattern as
  // overlayRef so streaming appends don't allocate a fresh Map per point.
  const historyRef = useRef<Map<string, ChartPoint[]>>(new Map());
  const historyThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-check state-segment timeline (maintenance / disabled). Same
  // ref-plus-version model as history, on the same throttle/version
  // counter — segments are a sibling of points on the same chart, and
  // a unified bump avoids two re-renders for events that always arrive
  // together (history) or back-to-back (state on transition + update).
  const segmentsRef = useRef<Map<string, StateSegment[]>>(new Map());
  // Remember the original (region, windowMs) for each active subscription
  // so we can re-emit `subscribe_history` whenever a WS reconnects. Live
  // `state` events delivered while the client was disconnected are lost
  // otherwise — the snapshot path covers live overlay fields but doesn't
  // re-deliver segment opens/closes that happened in the gap.
  const subscriptionsRef = useRef<Map<string, { region: CheckRegion; windowMs: number }>>(new Map());

  const regionsKey = useMemo(() => {
    const set = new Set<CheckRegion>();
    for (const c of checks) {
      if (c.checkRegion && getWsEndpoint(c.checkRegion) !== null) {
        set.add(c.checkRegion);
      }
    }
    return Array.from(set).sort().slice(0, MAX_REGIONS).join('|');
  }, [checks]);

  useEffect(() => {
    if (!enabled) return;

    const conns = connsRef.current;

    const emit = (): void => {
      const out: RegionStatus[] = [];
      for (const conn of conns.values()) {
        out.push({
          region: conn.region,
          state: conn.state,
          attempts: conn.attempts,
          lastAuthedAt: conn.lastAuthedAt,
          lastUpdateAt: conn.lastUpdateAt,
          updatesReceived: conn.updatesReceived,
          fallbackSince: conn.fallbackSince,
        });
      }
      out.sort((a, b) => a.region.localeCompare(b.region));
      setStatuses(out);
    };

    const throttledStatusEmit = (conn: RegionConn): void => {
      if (conn.emitThrottleTimer) return;
      conn.emitThrottleTimer = setTimeout(() => {
        conn.emitThrottleTimer = null;
        emit();
      }, EMIT_THROTTLE_MS);
    };

    const scheduleOverlayEmit = (): void => {
      if (overlayThrottleRef.current) return;
      overlayThrottleRef.current = setTimeout(() => {
        overlayThrottleRef.current = null;
        // Bump version — useMemo on effectiveChecks recomputes against
        // overlayRef.current. We never copy the overlay itself; the
        // version increments are the cheap signal.
        setOverlayVersion(v => v + 1);
      }, EMIT_THROTTLE_MS);
    };

    const scheduleHistoryEmit = (): void => {
      if (historyThrottleRef.current) return;
      historyThrottleRef.current = setTimeout(() => {
        historyThrottleRef.current = null;
        setHistoryVersion(v => v + 1);
      }, EMIT_THROTTLE_MS);
    };

    /**
     * If `historyRef` has an entry for this check (i.e. the caller has
     * subscribed to its history), derive a ChartPoint from the live delta
     * and append. `lastChecked` is the sole trigger — edits don't carry
     * it, so they're naturally filtered out.
     *
     * status-buffer only sends fields that CHANGED since the last broadcast,
     * so for a stable check status/responseTime/lastStatusCode are absent
     * from almost every delta. We fall back to the merged overlay (which
     * `mergeIntoOverlay` updated above, before this call) so every probe
     * produces a point with the last-known values.
     */
    const appendHistoryFromDelta = (checkId: string, delta: LiveFields): void => {
      const buf = historyRef.current.get(checkId);
      if (!buf) return;
      if (delta.lastChecked == null) return;
      const merged = overlayRef.current.get(checkId);
      const status = delta.status ?? merged?.status;
      if (status !== 'online' && status !== 'offline') return;
      // Defensive dedup — runner can re-emit the same lastChecked on a
      // rapid edit + probe overlap. Cheap O(1) tail check.
      if (buf.length > 0 && buf[buf.length - 1].t === delta.lastChecked) return;
      const responseTime =
        typeof delta.responseTime === 'number'
          ? delta.responseTime
          : typeof merged?.responseTime === 'number'
            ? merged.responseTime
            : null;
      const statusCode =
        typeof delta.lastStatusCode === 'number'
          ? delta.lastStatusCode
          : typeof merged?.lastStatusCode === 'number'
            ? merged.lastStatusCode
            : undefined;
      // Phase timings are point-in-time per-probe values — do NOT fall
      // back to the overlay's cached value. A partial-failure HTTP probe
      // (e.g. TLS handshake failed) won't emit the absent phases; if we
      // fell back we'd mislabel the failed probe with the last
      // successful probe's TLS time. Matches the runner's pickMs().
      const pickMs = (key: 'dnsMs' | 'connectMs' | 'tlsMs' | 'ttfbMs'): number | undefined => {
        const fresh = delta[key];
        return typeof fresh === 'number' ? fresh : undefined;
      };
      const dn = pickMs('dnsMs');
      const cn = pickMs('connectMs');
      const tl = pickMs('tlsMs');
      const ft = pickMs('ttfbMs');
      const point: ChartPoint = {
        t: delta.lastChecked,
        rt: responseTime,
        st: status === 'online' ? 'up' : 'down',
      };
      if (typeof statusCode === 'number') point.sc = statusCode;
      if (dn !== undefined) point.dn = dn;
      if (cn !== undefined) point.cn = cn;
      if (tl !== undefined) point.tl = tl;
      if (ft !== undefined) point.ft = ft;
      // Replace the array, don't mutate it. LiveChart's data useMemo
      // depends on `points` by reference — an in-place push leaves the
      // chart frozen because React sees the same array. The 24h front
      // trim is folded in by skipping over any stale prefix.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let startIdx = 0;
      while (startIdx < buf.length && buf[startIdx].t < cutoff) startIdx++;
      const next = startIdx > 0 ? buf.slice(startIdx) : buf.slice();
      next.push(point);
      historyRef.current.set(checkId, next);
      scheduleHistoryEmit();
    };

    const mergeIntoOverlay = (checkId: string, delta: LiveFields): void => {
      const prev = overlayRef.current.get(checkId);
      // The accumulator merges deltas so consumers always see the most
      // recent known value per field even when a single broadcast only
      // carries a subset of fields.
      const merged = prev ? { ...prev, ...delta } : { ...delta };
      overlayRef.current.set(checkId, merged);
    };

    const armFallbackTimer = (conn: RegionConn): void => {
      if (conn.fallbackTimer) return;
      conn.fallbackTimer = setTimeout(() => {
        conn.fallbackTimer = null;
        if (conn.state === 'live') return; // we re-authed in the window
        conn.state = 'fallback';
        conn.fallbackSince = Date.now();
        emit();
      }, FALLBACK_HYSTERESIS_MS);
    };

    const clearFallbackTimer = (conn: RegionConn): void => {
      if (conn.fallbackTimer) {
        clearTimeout(conn.fallbackTimer);
        conn.fallbackTimer = null;
      }
    };

    const scheduleReconnect = (conn: RegionConn): void => {
      if (conn.torndown) return;
      conn.attempts++;
      // Transition to 'reconnecting' (not 'fallback') first — the
      // overlay's last-known values stay trusted through the hysteresis
      // window so a normal 1–3s flap doesn't flash the UI to Firestore.
      // Only the fallback timer flips us to 'fallback' after 8s.
      if (conn.state !== 'fallback') conn.state = 'reconnecting';
      armFallbackTimer(conn);
      emit();
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * Math.pow(2, Math.min(conn.attempts - 1, 6)),
      );
      conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        void openConnection(conn);
      }, delay);
    };

    const refreshAuthInPlace = async (conn: RegionConn): Promise<void> => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
      try {
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken(true);
        conn.ws.send(JSON.stringify({ type: 'auth', token }));
      } catch (err) {
        console.warn(`[useCheckStream] ${conn.region}: refreshAuthInPlace failed`, err);
        try { conn.ws?.close(4401, 'refresh-failed'); } catch { /* ignore */ }
      }
    };

    const handleServerMessage = (conn: RegionConn, msg: ServerMessage): void => {
      // Bump on every frame — this is the watchdog's "still alive" signal.
      // Must run before the switch so even unrecognized future message
      // types keep the watchdog quiet.
      conn.lastFrameAt = Date.now();
      switch (msg.type) {
        case 'auth-ok':
          // Snapshot is on its way. Cancel any pending fallback flip —
          // we're authed, the overlay will be fresh momentarily.
          clearFallbackTimer(conn);
          conn.state = 'live';
          conn.attempts = 0;
          conn.lastAuthedAt = Date.now();
          conn.fallbackSince = 0;
          // Re-subscribe to every history+segments stream the caller had
          // open on this region. Without this, a maintenance/disabled
          // segment that closed while we were disconnected stays visible
          // forever — the snapshot path only refreshes scalar live fields
          // (`disabled`, `maintenanceMode`) and never translates back into
          // segment closes. The fresh `history` payload is authoritative
          // for both points and segments and overwrites the stale state.
          for (const [checkId, sub] of subscriptionsRef.current) {
            if (sub.region !== conn.region) continue;
            try {
              conn.ws?.send(JSON.stringify({
                type: 'subscribe_history',
                checkId,
                windowMs: sub.windowMs,
              }));
            } catch (err) {
              console.warn(`[useCheckStream] ${conn.region}: re-subscribe failed for ${checkId}`, err);
            }
          }
          emit();
          return;
        case 'auth-refresh':
          void refreshAuthInPlace(conn);
          return;
        case 'snapshot': {
          // Phase 5: snapshot IS the canonical fresh-overlay payload.
          // Merging each LiveCheck into the overlay map gives consumers
          // immediate access to authoritative state for every check in
          // this region.
          for (const check of msg.checks) {
            const { checkId } = check;
            const fields: LiveFields = {};
            const fieldsBag = fields as unknown as Record<string, unknown>;
            const raw = check as unknown as Record<string, unknown>;
            for (const key of LIVE_FIELD_NAMES) {
              if (raw[key] !== undefined) fieldsBag[key] = raw[key];
            }
            mergeIntoOverlay(checkId, fields);
            recordWsArrival(conn.region, checkId, fields);
            // No history append on snapshot — snapshot LiveCheck doesn't
            // carry a fresh probe boundary; the next `update` will.
          }
          conn.lastUpdateAt = Date.now();
          conn.lastEventAt = Date.now();
          scheduleOverlayEmit();
          return;
        }
        case 'update':
          mergeIntoOverlay(msg.checkId, msg.fields);
          recordWsArrival(conn.region, msg.checkId, msg.fields);
          appendHistoryFromDelta(msg.checkId, msg.fields);
          conn.lastUpdateAt = Date.now();
          conn.lastEventAt = Date.now();
          conn.updatesReceived++;
          throttledStatusEmit(conn);
          scheduleOverlayEmit();
          return;
        case 'replay':
          for (const entry of msg.transitions) {
            mergeIntoOverlay(entry.checkId, entry.fields);
            recordWsArrival(conn.region, entry.checkId, entry.fields);
            appendHistoryFromDelta(entry.checkId, entry.fields);
            if (entry.at > conn.lastEventAt) conn.lastEventAt = entry.at;
          }
          scheduleOverlayEmit();
          return;
        case 'history':
          // Server response to our subscribe_history. Backfill replaces
          // whatever we had — server is authoritative for the historical
          // window. `segments` is part of the same payload so the chart
          // gets a coherent (points, segments) snapshot in one frame.
          historyRef.current.set(msg.checkId, msg.points.slice());
          segmentsRef.current.set(
            msg.checkId,
            Array.isArray(msg.segments) ? msg.segments.slice() : [],
          );
          scheduleHistoryEmit();
          return;
        case 'state': {
          // Live segment open or close. Match by (k, s) so a close-event
          // updates the existing entry's `e` rather than appending a
          // duplicate. We only track segments for checks the caller
          // subscribed to — silently drop events for unsubscribed ones.
          const existing = segmentsRef.current.get(msg.checkId);
          if (!existing) return;
          const seg = msg.segment;
          const idx = existing.findIndex(s => s.k === seg.k && s.s === seg.s);
          let next: StateSegment[];
          if (idx >= 0) {
            // Mutate via copy so the LiveChart memo (which depends on
            // segments by ref) sees a fresh array.
            next = existing.slice();
            next[idx] = { ...next[idx], e: seg.e };
          } else {
            next = existing.slice();
            // Keep sorted by start asc — matches the server-side ordering.
            let ins = next.length;
            while (ins > 0 && next[ins - 1].s > seg.s) ins--;
            next.splice(ins, 0, { k: seg.k, s: seg.s, e: seg.e });
          }
          segmentsRef.current.set(msg.checkId, next);
          scheduleHistoryEmit();
          return;
        }
        case 'keepalive':
          // App-level liveness tick from server. The lastFrameAt bump
          // above is the entire effect — keeps the staleness watchdog
          // from firing on a connection that's healthy but quiet.
          return;
        case 'error':
          console.warn(`[useCheckStream] ${conn.region} server error:`, msg.code, msg.message);
          return;
      }
    };

    const openConnection = async (conn: RegionConn): Promise<void> => {
      if (conn.torndown) return;
      const url = getWsEndpoint(conn.region);
      if (!url) {
        conn.state = 'idle';
        emit();
        return;
      }

      let token: string;
      try {
        const user = auth.currentUser;
        if (!user) {
          conn.state = 'idle';
          emit();
          return;
        }
        token = await user.getIdToken();
      } catch (err) {
        console.warn(`[useCheckStream] ${conn.region}: getIdToken failed`, err);
        scheduleReconnect(conn);
        return;
      }

      // Only step backwards to 'connecting' if we haven't already flipped
      // to fallback — a fallback-to-connecting display would imply data
      // is fresh again before we've actually authed.
      if (conn.state !== 'fallback') {
        conn.state = 'connecting';
        emit();
      }

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.warn(`[useCheckStream] ${conn.region}: WebSocket ctor threw`, err);
        scheduleReconnect(conn);
        return;
      }
      conn.ws = ws;

      ws.addEventListener('open', () => {
        if (conn.torndown) {
          try { ws.close(1000, 'torndown'); } catch { /* ignore */ }
          return;
        }
        // Seed the watchdog timestamp. Without this, a slow auth-ok
        // (e.g. cold-start verifyIdToken) could let the watchdog flag a
        // freshly-opened socket as stale before the first frame arrives.
        conn.lastFrameAt = Date.now();
        if (conn.state !== 'fallback') {
          conn.state = 'authing';
          emit();
        }
        const authMsg = conn.lastEventAt > 0
          ? { type: 'auth' as const, token, since: conn.lastEventAt }
          : { type: 'auth' as const, token };
        try {
          ws.send(JSON.stringify(authMsg));
        } catch (err) {
          console.warn(`[useCheckStream] ${conn.region}: send(auth) failed`, err);
        }
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handleServerMessage(conn, parsed);
      });

      ws.addEventListener('close', (event) => {
        conn.ws = null;
        if (conn.torndown) return;
        if (event.code === 4401) {
          auth.currentUser?.getIdToken(true).catch(() => { /* ignore */ });
        }
        scheduleReconnect(conn);
      });

      ws.addEventListener('error', () => {
        // 'close' fires after 'error'; cleanup happens there.
      });
    };

    const teardownConn = (conn: RegionConn): void => {
      conn.torndown = true;
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      if (conn.emitThrottleTimer) {
        clearTimeout(conn.emitThrottleTimer);
        conn.emitThrottleTimer = null;
      }
      if (conn.fallbackTimer) {
        clearTimeout(conn.fallbackTimer);
        conn.fallbackTimer = null;
      }
      if (conn.ws) {
        try { conn.ws.close(1000, 'unmount'); } catch { /* ignore */ }
        conn.ws = null;
      }
    };

    const desiredRegions = (regionsKey ? regionsKey.split('|') : []) as CheckRegion[];
    const desiredSet = new Set(desiredRegions);

    for (const [region, conn] of conns) {
      if (!desiredSet.has(region)) {
        teardownConn(conn);
        conns.delete(region);
      }
    }

    for (const region of desiredRegions) {
      if (conns.has(region)) continue;
      const conn: RegionConn = {
        region,
        ws: null,
        state: 'idle',
        attempts: 0,
        lastAuthedAt: 0,
        lastUpdateAt: 0,
        updatesReceived: 0,
        reconnectTimer: null,
        emitThrottleTimer: null,
        fallbackTimer: null,
        fallbackSince: 0,
        lastEventAt: 0,
        lastFrameAt: 0,
        torndown: false,
      };
      conns.set(region, conn);
      void openConnection(conn);
    }

    emit();

    // Staleness watchdog. Browser JS never sees protocol-level ping/pong,
    // so a zombie WebSocket (NAT timeout, laptop sleep, ISP burp) sits at
    // readyState=OPEN with no surface signal of being dead. We pair this
    // with the server's app-level `keepalive` frames: receiving one bumps
    // `lastFrameAt`; if none has arrived in STALE_THRESHOLD_MS we treat
    // the socket as dead and force-close it. The `close` listener then
    // routes through the normal reconnect path.
    const staleTimer = setInterval(() => {
      const now = Date.now();
      for (const conn of conns.values()) {
        if (conn.torndown) continue;
        if (!conn.ws) continue;
        if (conn.ws.readyState !== WebSocket.OPEN) continue;
        if (conn.lastFrameAt === 0) continue;
        if (now - conn.lastFrameAt < STALE_THRESHOLD_MS) continue;
        // Force-close. 4000 is an app-defined "zombie" code; the close
        // handler treats it like any other unexpected close and reconnects.
        try {
          conn.ws.close(4000, 'stale-no-frames');
        } catch {
          /* ignore — close handler will still fire from socket teardown */
        }
      }
    }, STALE_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(staleTimer);
      for (const conn of conns.values()) teardownConn(conn);
      conns.clear();
      if (overlayThrottleRef.current) {
        clearTimeout(overlayThrottleRef.current);
        overlayThrottleRef.current = null;
      }
      if (historyThrottleRef.current) {
        clearTimeout(historyThrottleRef.current);
        historyThrottleRef.current = null;
      }
      emit();
    };
  }, [enabled, regionsKey]);

  // ── Firestore-side shadow feed (unchanged from Phase 4) ───────────────
  useEffect(() => {
    if (!enabled) return;
    for (const check of checks) {
      if (!check.id || !check.checkRegion) continue;
      const fields: LiveFields = {};
      const fieldsBag = fields as unknown as Record<string, unknown>;
      const raw = check as unknown as Record<string, unknown>;
      for (const key of LIVE_FIELD_NAMES) {
        if (raw[key] !== undefined) fieldsBag[key] = raw[key];
      }
      recordFirestoreArrival(check.checkRegion, check.id, fields);
    }
  }, [enabled, checks]);

  const aggregateState = useMemo(() => deriveAggregate(statuses), [statuses]);

  // Fallback banner trigger: surface the first region currently in
  // fallback, with the timestamp it engaged. The 10s threshold for the
  // visible banner is enforced by the consumer (the banner component
  // compares Date.now() - since against 10_000ms) so this hook stays
  // pure-data.
  const fallbackRegion = useMemo(() => {
    for (const s of statuses) {
      if (s.state === 'fallback') {
        return { region: s.region, since: s.fallbackSince };
      }
    }
    return null;
  }, [statuses]);

  // Per-region "trust the overlay?" decision. We trust it during
  // connecting/authing/live/reconnecting; we explicitly distrust it in
  // fallback/idle. The reconnecting case is the hysteresis: even though
  // WS is down, the last-known overlay is at most ~8s stale and that's
  // better than the Firestore lag.
  const trustedRegions = useMemo(() => {
    const set = new Set<CheckRegion>();
    for (const s of statuses) {
      if (s.state === 'fallback' || s.state === 'idle') continue;
      // 'connecting' before first auth has no overlay data to trust;
      // mergeWithOverlay handles that by returning the raw check when
      // overlay is empty. We include it so the moment a snapshot lands
      // the overlay starts winning without a state-emit race.
      set.add(s.region);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses]);

  const effectiveChecks = useMemo(() => {
    if (!WS_PRIMARY_ENABLED || !enabled) return checks;
    if (trustedRegions.size === 0) return checks;
    const overlay = overlayRef.current;
    let mutated = false;
    const out: Website[] = new Array(checks.length);
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i];
      const fields = check.id ? overlay.get(check.id) : undefined;
      // Only apply overlay when the check's region is trusted AND we
      // actually have overlay data for it. Otherwise pass through the
      // Firestore record unchanged so first-load and idle regions stay
      // visible.
      if (
        fields &&
        check.checkRegion &&
        trustedRegions.has(check.checkRegion)
      ) {
        const overlaid = applyOverlay(check, fields);
        out[i] = overlaid;
        // applyOverlay returns the original ref when every overlay
        // field already matches the check — only flip `mutated` when
        // we actually got a fresh object, otherwise downstream memos
        // see needless identity churn on every WS tick.
        if (overlaid !== check) mutated = true;
      } else {
        out[i] = check;
      }
    }
    // If no overlay actually applied this pass, return the original
    // reference so downstream memos see referential equality.
    return mutated ? out : checks;
    // overlayVersion is the throttled "overlay has new data" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, trustedRegions, overlayVersion, enabled]);

  // Expose history map (read-only contract — version bumps gate when
  // consumers re-render). We hand back the live ref so streaming appends
  // are visible without copying.
  const historyByCheckId = useMemo(
    () => historyRef.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion],
  );
  const segmentsByCheckId = useMemo(
    () => segmentsRef.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion],
  );

  /**
   * Subscribe to the last `windowMs` of history for `checkId` on the WS
   * for `region`. If the conn isn't authed yet, returns false — the
   * caller can retry once `regions` flips the region to `'live'`.
   *
   * We also seed an empty buffer immediately so subsequent live `update`
   * messages start appending right away, even if the `history` response
   * lands later. The `history` handler overwrites with the server slice.
   */
  const subscribeHistory = useCallback(
    (checkId: string, region: CheckRegion, windowMs: number): boolean => {
      const conn = connsRef.current.get(region);
      if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN || conn.state !== 'live') {
        return false;
      }
      if (!historyRef.current.has(checkId)) {
        historyRef.current.set(checkId, []);
      }
      if (!segmentsRef.current.has(checkId)) {
        // Seed an empty segments array so live `state` events for this
        // check start landing in the ref before the `history` response
        // arrives. Without this, an open segment broadcast between the
        // subscribe send and the history reply would be silently dropped.
        segmentsRef.current.set(checkId, []);
      }
      // Record so `auth-ok` on the next reconnect can re-emit and rebuild
      // the (points, segments) snapshot. Latest call wins — if the caller
      // changes windowMs, the next reconnect uses the new value.
      subscriptionsRef.current.set(checkId, { region, windowMs });
      try {
        conn.ws.send(JSON.stringify({ type: 'subscribe_history', checkId, windowMs }));
        return true;
      } catch (err) {
        console.warn(`[useCheckStream] ${region}: subscribe_history send failed`, err);
        return false;
      }
    },
    [],
  );

  const unsubscribeHistory = useCallback((checkId: string): void => {
    const hadHistory = historyRef.current.delete(checkId);
    const hadSegments = segmentsRef.current.delete(checkId);
    subscriptionsRef.current.delete(checkId);
    if (hadHistory || hadSegments) {
      // Bump the version so consumers observing historyByCheckId /
      // segmentsByCheckId re-render and drop the now-empty entries.
      setHistoryVersion(v => v + 1);
    }
  }, []);

  return {
    effectiveChecks,
    regions: statuses,
    aggregateState,
    fallbackRegion,
    historyByCheckId,
    segmentsByCheckId,
    subscribeHistory,
    unsubscribeHistory,
  };
}

function applyOverlay(check: Website, overlay: LiveFields): Website {
  // Bail before allocating a new object when the overlay's fields all
  // already match what's on the check — typical once Firestore has
  // caught up with the WS broadcast (every ~5–10s on most cadences).
  // Returning the original ref lets downstream memos and React.memo
  // boundaries short-circuit instead of re-rendering on every WS tick.
  const checkBag = check as unknown as Record<string, unknown>;
  const overlayBag = overlay as unknown as Record<string, unknown>;
  let changed = false;
  for (const key of LIVE_FIELD_NAMES) {
    const v = overlayBag[key];
    if (v === undefined) continue;
    if (checkBag[key] !== v) {
      changed = true;
      break;
    }
  }
  if (!changed) return check;
  const merged = { ...check } as Website & Record<string, unknown>;
  const bag = merged as Record<string, unknown>;
  for (const key of LIVE_FIELD_NAMES) {
    const v = overlayBag[key];
    if (v !== undefined) bag[key] = v;
  }
  return merged;
}

function deriveAggregate(statuses: RegionStatus[]): RegionWsState {
  if (statuses.length === 0) return 'idle';
  // Worst-case roll-up. Fallback dominates (visible degradation),
  // followed by any non-live state. All-live aggregates to live.
  let anyFallback = false;
  let firstNonLive: RegionWsState | null = null;
  for (const s of statuses) {
    if (s.state === 'fallback') anyFallback = true;
    if (s.state !== 'live' && firstNonLive === null) firstNonLive = s.state;
  }
  if (anyFallback) return 'fallback';
  if (firstNonLive !== null) return firstNonLive;
  return 'live';
}

// LiveCheck import exists so the protocol module is reachable from this
// file's type-only consumers; without an explicit reference, tsc strips it
// from the emit and a downstream `import('./useCheckStream').LiveCheck`
// reference would 404. (No runtime use.)
void (null as unknown as LiveCheck);
