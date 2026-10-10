/**
 * RELEASE.gdle-30s-idle-drop — the page side of the worker-hosted session
 * connection (@ac/network NetWorker.ts). Same NetConnection surface as
 * ClientConnection; commands are posted to the worker, events come back in
 * order, and the synchronous getters (isConnected, link status, loss) read
 * the worker's latest snapshot.
 */
import {
  probeBridgeHealth, EOR_LOGIN_PROFILE,
  type BridgeHealth, type ConnectionEvent, type ConnectionListener, type GameMessageGroup, type LoginProfile,
  type NetCommand, type NetConnection, type NetReply, type NetSnapshot,
} from '@ac/network';

/** The page's end of the worker (a Worker, or a MessagePort in tests). */
export interface NetWorkerEndpoint {
  postMessage(message: NetCommand, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<NetReply>) => void): void;
}

export class NetWorkerClient implements NetConnection {
  private listeners: ConnectionListener[] = [];
  private snap: NetSnapshot = { connected: false, link: { connected: false, secondsSinceLastPacket: 0 }, at: 0, loss: 0 };
  private url: string;
  private _autoReconnect = true;
  private _datIterations = { portal: 0, cell: 0, language: 0 };
  private _loginProfile: LoginProfile;

  constructor(private readonly endpoint: NetWorkerEndpoint, url: string, opts: { loginProfile?: LoginProfile } = {}) {
    this.url = url;
    this._loginProfile = opts.loginProfile ?? EOR_LOGIN_PROFILE;
    endpoint.addEventListener('message', (ev) => this.receive(ev.data));
    this.post({ t: 'init', url, loginProfile: opts.loginProfile });
  }

  private post(cmd: NetCommand, transfer?: Transferable[]): void {
    this.endpoint.postMessage(cmd, transfer);
  }

  private receive(reply: NetReply): void {
    this.snap = reply.snap;
    if (reply.t !== 'event') return;
    for (const listener of this.listeners) {
      try {
        listener(reply.event as ConnectionEvent);
      } catch (err) {
        console.error(`[AC:EMIT] Listener error for ${reply.event.type}:`, err);
      }
    }
  }

  get autoReconnect(): boolean { return this._autoReconnect; }
  set autoReconnect(v: boolean) { this._autoReconnect = v; this.post({ t: 'set', autoReconnect: v }); }

  get datIterations(): NetConnection['datIterations'] { return this._datIterations; }
  set datIterations(v: NetConnection['datIterations']) { this._datIterations = v; this.post({ t: 'set', datIterations: { ...v } }); }

  get loginProfile(): LoginProfile { return this._loginProfile; }
  set loginProfile(v: LoginProfile) { this._loginProfile = v; this.post({ t: 'set', loginProfile: v }); }

  get isConnected(): boolean { return this.snap.connected; }
  get bridgeUrl(): string { return this.url; }

  setUrl(url: string): void { this.url = url; this.post({ t: 'setUrl', url }); }
  connect(account: string, password: string): void { this.post({ t: 'connect', account, password }); }

  disconnect(): void {
    // The page reads isConnected right after (logout, relaunch): false now,
    // as ClientConnection.disconnect() makes it synchronously.
    this.snap = { ...this.snap, connected: false, link: { connected: false, secondsSinceLastPacket: 0 } };
    this.post({ t: 'disconnect' });
  }

  sendMessage(messageBytes: Uint8Array, queue?: GameMessageGroup): void {
    // Copy only this view (a clone of a subarray would copy its whole buffer)
    // and hand the copy over without another clone.
    const bytes = messageBytes.slice();
    this.post({ t: 'send', bytes, queue }, [bytes.buffer]);
  }

  sendCharacterLogOff(): void { this.post({ t: 'logOff' }); }

  requestRoutinesGrant(): void { this.post({ t: 'routines' }); }

  sendBridgeText(text: string): void { this.post({ t: 'text', text }); }

  /** The bridge's text health probe needs no session: it runs on the page. */
  checkHealth(): Promise<BridgeHealth> { return probeBridgeHealth(this.url); }

  getLinkStatus(now: number = Date.now()): { connected: boolean; secondsSinceLastPacket: number } {
    const { link, at } = this.snap;
    if (!link.connected) return { connected: false, secondsSinceLastPacket: 0 };
    return { connected: true, secondsSinceLastPacket: link.secondsSinceLastPacket + Math.max(0, now - at) / 1000 };
  }

  getPacketLossPercentage(): number { return this.snap.loss; }

  on(listener: ConnectionListener): void { this.listeners.push(listener); }
  off(listener: ConnectionListener): void { this.listeners = this.listeners.filter(l => l !== listener); }
}

/**
 * The session connection for the page: the worker-hosted one, unless the
 * page asks for the in-thread connection (`?networker=0`, debugging and A/B)
 * or the browser cannot start a module worker.
 */
export function createNetConnection(
  url: string,
  opts: { loginProfile?: LoginProfile; search?: string; inThread: (url: string) => NetConnection },
): { connection: NetConnection; inWorker: boolean } {
  const params = new URLSearchParams(opts.search ?? '');
  if (params.get('networker') !== '0' && typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./net.worker.ts', import.meta.url), { type: 'module', name: 'acjs-net' });
      return { connection: new NetWorkerClient(worker, url, { loginProfile: opts.loginProfile }), inWorker: true };
    } catch (err) {
      console.warn('[AC] network worker unavailable — running the connection on the page:', err);
    }
  }
  return { connection: opts.inThread(url), inWorker: false };
}
