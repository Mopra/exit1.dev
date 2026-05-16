/**
 * useCheckStream — opens one WebSocket per region the user has checks in.
 *
 * Phase 4 mounts this in shadow mode: the hook authenticates, receives
 * `snapshot`/`update`/`replay`/`auth-refresh` messages, and feeds each
 * `update` into the shadow telemetry recorder. It does NOT write to React
 * state or influence rendering. The dashboard continues to render from
 * Firestore `onSnapshot` exactly as before.
 *
 * Per-region connections are independent — one region's reconnect cycle
 * never touches another. The hook caps at MAX_REGIONS sockets per user.
 *
 * Reconnect: exponential backoff to 30s. Close code 4401 forces a token
 * refresh before the next attempt so we don't burn a connection on a
 * stale token.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { auth } from '../firebase';
import type { Website } from '../types';
import {
  LIVE_FIELD_NAMES,
  type LiveFields,
  type ServerMessage,
} from '../lib/ws-protocol';
import { getWsEndpoint } from '../lib/ws-endpoints';
import {
  canonicalLiveFields,
  recordFirestoreArrival,
  recordWsArrival,
} from '../lib/ws-shadow-telemetry';

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
  /** Last event timestamp received via WS — used as `since` on reconnect. */
  lastEventAt: number;
  torndown: boolean;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const MAX_REGIONS = 5;
const EMIT_THROTTLE_MS = 250;

export interface UseCheckStreamOptions {
  /** Killswitch — set false to disable the hook without unmounting it. */
  enabled?: boolean;
}

export interface UseCheckStreamResult {
  regions: RegionStatus[];
  /**
   * Aggregate state across regions: 'live' iff every connected region is
   * live; otherwise the most-degraded region's state. Used by the
   * indicator component in Phase 5.
   */
  aggregateState: RegionWsState;
}

export function useCheckStream(
  checks: Website[],
  { enabled = true }: UseCheckStreamOptions = {},
): UseCheckStreamResult {
  const [statuses, setStatuses] = useState<RegionStatus[]>([]);
  const connsRef = useRef<Map<CheckRegion, RegionConn>>(new Map());
  // Per-check Firestore hash, persisted across renders. The first observation
  // of a check seeds the hash but doesn't record a "Firestore-only" telemetry
  // event — we'd be measuring page-load, not a real broadcast race. Only
  // subsequent hash changes are recorded.
  const fsHashRef = useRef<Map<string, string>>(new Map());

  // Stable key for the WS effect — `checks` reference changes on every
  // Firestore snapshot delivery, but the *set* of regions rarely does.
  // Without this, every status tick would tear down all sockets and
  // recreate them, which manifests as a flood of ws connections in the
  // network tab and unauthenticated re-connects against the per-IP limit.
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
        });
      }
      out.sort((a, b) => a.region.localeCompare(b.region));
      setStatuses(out);
    };

    const throttledEmit = (conn: RegionConn): void => {
      if (conn.emitThrottleTimer) return;
      conn.emitThrottleTimer = setTimeout(() => {
        conn.emitThrottleTimer = null;
        emit();
      }, EMIT_THROTTLE_MS);
    };

    const scheduleReconnect = (conn: RegionConn): void => {
      if (conn.torndown) return;
      conn.attempts++;
      conn.state = 'reconnecting';
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
        // Force a close so the standard reconnect path takes over with a
        // freshly-fetched token.
        try { conn.ws?.close(4401, 'refresh-failed'); } catch { /* ignore */ }
      }
    };

    const handleServerMessage = (conn: RegionConn, msg: ServerMessage): void => {
      switch (msg.type) {
        case 'auth-ok':
          conn.state = 'live';
          conn.attempts = 0;
          conn.lastAuthedAt = Date.now();
          emit();
          return;
        case 'auth-refresh':
          void refreshAuthInPlace(conn);
          return;
        case 'snapshot': {
          // Phase 4 shadow mode: snapshot is observed but not consumed for
          // render state. We credit the WS arrivals into telemetry so the
          // mismatch math reflects reality on reconnect.
          for (const check of msg.checks) {
            const { checkId } = check;
            const fields: LiveFields = {};
            const fieldsBag = fields as unknown as Record<string, unknown>;
            const raw = check as unknown as Record<string, unknown>;
            for (const key of LIVE_FIELD_NAMES) {
              if (raw[key] !== undefined) fieldsBag[key] = raw[key];
            }
            recordWsArrival(conn.region, checkId, fields);
          }
          conn.lastUpdateAt = Date.now();
          conn.lastEventAt = Date.now();
          return;
        }
        case 'update':
          recordWsArrival(conn.region, msg.checkId, msg.fields);
          conn.lastUpdateAt = Date.now();
          conn.lastEventAt = Date.now();
          conn.updatesReceived++;
          throttledEmit(conn);
          return;
        case 'replay':
          for (const entry of msg.transitions) {
            recordWsArrival(conn.region, entry.checkId, entry.fields);
            if (entry.at > conn.lastEventAt) conn.lastEventAt = entry.at;
          }
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
          // Auth not ready yet. Sit in idle; the hook re-mounts when checks
          // change post-auth so we'll get another shot at opening then.
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

      conn.state = 'connecting';
      emit();

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
        conn.state = 'authing';
        emit();
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
        // 4401 — server rejected the token. Force-refresh before next attempt
        // so we don't waste the backoff window on a token we know is stale.
        if (event.code === 4401) {
          auth.currentUser?.getIdToken(true).catch(() => { /* ignore */ });
        }
        scheduleReconnect(conn);
      });

      ws.addEventListener('error', () => {
        // 'close' fires after 'error' in browsers; let close handle the
        // reconnect bookkeeping.
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
        lastEventAt: 0,
        torndown: false,
      };
      conns.set(region, conn);
      void openConnection(conn);
    }

    emit();

    return () => {
      for (const conn of conns.values()) teardownConn(conn);
      conns.clear();
      emit();
    };
    // Deps intentionally use regionsKey (the *set* of regions) instead of
    // the checks array. The Firestore-side shadow feed below is the path
    // that needs to react to every check change.
  }, [enabled, regionsKey]);

  // ── Firestore-side shadow feed ────────────────────────────────────────
  // Independent of the WS connection effect so a WS reconnect doesn't reset
  // the hash state. Records a Firestore arrival whenever a check's live
  // fields change vs the previously-observed hash. First observation is
  // seed-only (no record) — that prevents page-load from looking like a
  // burst of one-sided Firestore arrivals.
  useEffect(() => {
    if (!enabled) return;
    const hashes = fsHashRef.current;
    const seenIds = new Set<string>();
    for (const check of checks) {
      if (!check.id || !check.checkRegion) continue;
      seenIds.add(check.id);
      const fields: LiveFields = {};
      const fieldsBag = fields as unknown as Record<string, unknown>;
      const raw = check as unknown as Record<string, unknown>;
      for (const key of LIVE_FIELD_NAMES) {
        if (raw[key] !== undefined) fieldsBag[key] = raw[key];
      }
      const nextHash = canonicalLiveFields(fields);
      const prevHash = hashes.get(check.id);
      hashes.set(check.id, nextHash);
      if (prevHash === undefined) continue; // seed only
      if (prevHash === nextHash) continue;
      recordFirestoreArrival(check.checkRegion, check.id, fields);
    }
    // GC: forget hashes for checks that no longer appear so the map doesn't
    // grow indefinitely as users add/delete checks across sessions.
    if (hashes.size > seenIds.size) {
      for (const id of hashes.keys()) {
        if (!seenIds.has(id)) hashes.delete(id);
      }
    }
  }, [enabled, checks]);

  return {
    regions: statuses,
    aggregateState: deriveAggregate(statuses),
  };
}

function deriveAggregate(statuses: RegionStatus[]): RegionWsState {
  if (statuses.length === 0) return 'idle';
  for (const s of statuses) {
    if (s.state === 'fallback') return 'fallback';
  }
  for (const s of statuses) {
    if (s.state !== 'live') return s.state;
  }
  return 'live';
}
