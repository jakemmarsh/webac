/**
 * RELEASE.gdle-30s-idle-drop — the session's network connection in a Web
 * Worker.
 *
 * Retail's network layer runs every frame regardless of what the renderer is
 * doing, so ACKs, NAKs and the ~3 s flow keepalive
 * (ClientConnection.FLOW_KEEPALIVE_INTERVAL_MS) never stop. Ours ran on the
 * page's main thread, and a long main-thread task (world entry: terrain, the
 * first object ring, shader links) stopped them all: 84 s under software
 * WebGL, long enough for ACE's 60 s session timeout and GDLE's 30 s idle
 * drop. `hostClientConnection` runs the unchanged ClientConnection inside a
 * worker; the page talks to it through NetWorkerClient (renderer), which
 * implements the same NetConnection surface. Incoming events queue on the
 * page while it is busy and are handled in order once it frees.
 */
import type { BridgeHealth, ConnectionEvent, ConnectionListener } from './ClientConnection.js';
import { createConnection } from './createConnection.js';
import type { GameMessageGroup } from './GameMessageGroup.js';
import type { LoginProfile } from './LoginProfile.js';
import type { NetDiagnostics } from './NetDiagnostics.js';

/** What the page uses of a session connection (ClientConnection or NetWorkerClient). */
export interface NetConnection {
  autoReconnect: boolean;
  datIterations: { portal: number; cell: number; language: number };
  loginProfile: LoginProfile;
  readonly isConnected: boolean;
  readonly bridgeUrl: string;
  setUrl(url: string): void;
  connect(account: string, password: string): void;
  disconnect(): void;
  sendMessage(messageBytes: Uint8Array, queue?: GameMessageGroup): void;
  sendCharacterLogOff(): void;
  /** Ask the bridge for the /routines token; answered by a 'routinesGrant' event. */
  requestRoutinesGrant(): void;
  /** A text frame to the bridge (the hosted connector's relay answers and state). */
  sendBridgeText(text: string): void;
  checkHealth(): Promise<BridgeHealth>;
  getLinkStatus(now?: number): { connected: boolean; secondsSinceLastPacket: number };
  getPacketLossPercentage(): number;
  /** OBS.dm-stall-diagnostics — the connection's sequencing state now (NetDiagnostics.ts). */
  getDiagnostics(now?: number): NetDiagnostics;
  on(listener: ConnectionListener): void;
  off(listener: ConnectionListener): void;
}

/** The worker's view of its connection, sent with every event and on a timer. */
export interface NetSnapshot {
  connected: boolean;
  link: { connected: boolean; secondsSinceLastPacket: number };
  /** Date.now() when `link` was sampled. */
  at: number;
  loss: number;
  /** OBS.dm-stall-diagnostics — the connection's diagnostics, sampled with `link`. */
  diag?: NetDiagnostics;
}

export type NetCommand =
  | { t: 'init'; url: string; loginProfile?: LoginProfile }
  | { t: 'set'; autoReconnect?: boolean; datIterations?: NetConnection['datIterations']; loginProfile?: LoginProfile }
  | { t: 'setUrl'; url: string }
  | { t: 'connect'; account: string; password: string }
  | { t: 'disconnect' }
  | { t: 'send'; bytes: Uint8Array; queue?: GameMessageGroup }
  | { t: 'logOff' }
  | { t: 'routines' }
  | { t: 'text'; text: string };

export type NetReply =
  | { t: 'event'; event: ConnectionEvent; snap: NetSnapshot }
  | { t: 'snap'; snap: NetSnapshot };

/** The side of a MessagePort / worker scope the host needs. */
export interface NetPort {
  postMessage(message: NetReply): void;
  addEventListener(type: 'message', listener: (ev: { data: NetCommand }) => void): void;
}

/** How often the worker refreshes the page's snapshot between events. */
export const NET_SNAPSHOT_INTERVAL_MS = 250;

/**
 * Run a ClientConnection behind `port` (a worker's `self`, or one end of a
 * MessageChannel in tests). Returns a stop function (clears the snapshot timer).
 */
export function hostClientConnection(port: NetPort): () => void {
  let conn: NetConnection | null = null;
  const snapshot = (): NetSnapshot => {
    const now = Date.now();
    return {
      connected: conn?.isConnected ?? false,
      link: conn ? conn.getLinkStatus(now) : { connected: false, secondsSinceLastPacket: 0 },
      at: now,
      loss: conn?.getPacketLossPercentage() ?? 0,
      ...(conn ? { diag: conn.getDiagnostics(now) } : {}),
    };
  };
  port.addEventListener('message', (ev) => {
    const cmd = ev.data;
    if (cmd.t === 'init') {
      conn = createConnection(cmd.url, cmd.loginProfile ? { loginProfile: cmd.loginProfile } : {});
      conn.on((event) => port.postMessage({ t: 'event', event, snap: snapshot() }));
      return;
    }
    if (!conn) return;
    switch (cmd.t) {
      case 'set':
        if (cmd.autoReconnect !== undefined) conn.autoReconnect = cmd.autoReconnect;
        if (cmd.datIterations) conn.datIterations = cmd.datIterations;
        if (cmd.loginProfile) conn.loginProfile = cmd.loginProfile;
        break;
      case 'setUrl': conn.setUrl(cmd.url); break;
      case 'connect': conn.connect(cmd.account, cmd.password); break;
      case 'disconnect': conn.disconnect(); break;
      case 'send': conn.sendMessage(cmd.bytes, cmd.queue); break;
      case 'logOff': conn.sendCharacterLogOff(); break;
      case 'routines': conn.requestRoutinesGrant(); break;
      case 'text': conn.sendBridgeText(cmd.text); break;
    }
    port.postMessage({ t: 'snap', snap: snapshot() });
  });
  const timer = setInterval(() => { if (conn) port.postMessage({ t: 'snap', snap: snapshot() }); }, NET_SNAPSHOT_INTERVAL_MS);
  return () => clearInterval(timer);
}
