/**
 * WebSocket server — Phase 1 stub.
 *
 * Attaches to the existing http.Server's `upgrade` event, scoped strictly to
 * URL `/ws`. The handler accepts the connection and closes it cleanly after
 * 5s. No auth, no broadcast, no app behavior yet — that lands in Phase 2/3.
 *
 * Purpose at this phase: validate the TLS + Caddy + upgrade path end-to-end
 * (`wscat -c wss://live-eu.exit1.dev/ws` should connect and close cleanly)
 * without exposing any business logic.
 *
 * The /ws path scope is critical: any upgrade request to another URL is
 * destroyed at the socket level so misrouted clients don't hang and so we
 * don't accidentally hijack a future HTTP upgrade for some other endpoint.
 */
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';

const STUB_CLOSE_AFTER_MS = 5_000;

let wss: WebSocketServer | null = null;
let totalConnections = 0;
let activeConnections = 0;
let rejectedUpgrades = 0;

export function attachWsServer(httpServer: HttpServer): void {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    // Strict path match. Reject anything else so misrouted upgrades fail fast
    // instead of hanging or being silently accepted by another future handler.
    if (url !== '/ws' && !url.startsWith('/ws?')) {
      rejectedUpgrades++;
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    totalConnections++;
    activeConnections++;
    const closeTimer = setTimeout(() => {
      try {
        ws.close(1000, 'phase-1-stub');
      } catch {
        // socket may already be closing — ignore
      }
    }, STUB_CLOSE_AFTER_MS);
    ws.on('close', () => {
      clearTimeout(closeTimer);
      activeConnections--;
    });
    ws.on('error', () => {
      // No-op. The 'close' handler runs after 'error' and handles cleanup.
    });
  });
}

export interface WsStats {
  active: number;
  totalAccepted: number;
  rejectedUpgrades: number;
}

export function getWsStats(): WsStats {
  return {
    active: activeConnections,
    totalAccepted: totalConnections,
    rejectedUpgrades,
  };
}
