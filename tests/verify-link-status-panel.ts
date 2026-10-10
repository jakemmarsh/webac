/**
 * GAP.indicator-bar-interactive (Link Status part) — the retail Link Status
 * panel (gmLinkStatusUI, element class 0x1000001d, LayoutDesc 0x2100001d,
 * root element 0x10000167 = InputAction 0x10000009 "Show/Hide Link Status
 * Panel").
 *
 * Ground truth (reference/client-eol, build ac1_sep13):
 *   gmLinkStatusUI::Update @ 004aaea0 — body = ID_LinkStatus_Info +
 *     _Colors + _Disconnect + _PacketLoss (%PACKET_LOSS%, precision 2) +
 *     _Ping (%PING% = round trip × 1000, precision 0; "????" while <= 0);
 *     then CM_Character::Event_RequestPing when m_bPleaseRequestPing is set
 *     or 120 s (0x405e000000000000) passed since the last request.
 *   ListenToElementMessage @ 004ab0b0 — shown: flag + Update() now.
 *   ListenToGlobalMessage @ 004ab110 — tick: Update() at most every 5 s
 *     (0x4014000000000000).
 *   RecvNotice_Ping @ 004ab150 — store the round trip; if visible set the
 *     flag (`mov byte [ecx+0x20],1` = m_bPleaseRequestPing @ +0x618) and
 *     Update() when the 5 s gate is open.
 *   CLinkStatusAverages::GetAveragePacketLoss @ 00546610 — 2 × (NAKed +
 *     retransmitted) / (received + sent) over CAverager<ushort,40> rings,
 *     fed per 2 s heartbeat (ClientNet::ProcessConnection @ 00545450).
 *
 * Every test drives the real shipped modules: the text builder, the network
 * LinkStatusAverages + ClientConnection (FakeWebSocket), and the real GameUI
 * in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acStringHash, registerStringTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import {
  buildLinkStatusPanelText, formatStringInfoFloat, linkStatusPanelTitle,
  LINK_STATUS_STRING_IDS, LINK_STATUS_PING_UNKNOWN,
} from '@ac/renderer/ui/LinkStatusPanelText.js';
import {
  ClientConnection, LinkStatusAverages, LINK_STATUS_AVERAGER_SAMPLES,
  PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE,
  writePacketHeader, readPacketHeader, GameMessageGroup,
} from '@ac/network';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const LANG_DAT = resolve(__dirname, '..', 'dat/client_local_English.dat');

const EXPECTED_BODY = (loss: string, ping: string) =>
  'The Link Indicator shows the current status of your connection to the game servers.' +
  '\n\nGREEN = your link is good.\nYELLOW = no packets for at least 5 sec.\nRED = no packets for at least 20 sec.' +
  '\n\nIf approximately forty seconds pass without receiving a packet, you will be disconnected from the server.' +
  `\n\n\nPacket loss for the last 10 sec: ${loss}%` +
  `\n\nRoundtrip Ping time to Server: ${ping} ms\n(Includes Internet latency)`;

// ─── String ids + text builder ─────────────────────────────────────────────

describe('Link Status panel text (gmLinkStatusUI::Update)', () => {
  it('the ID_LinkStatus_* tokens hash to the StringTable 0x23000001 entry ids', () => {
    expect(LINK_STATUS_STRING_IDS.info).toBe(224604031);
    expect(LINK_STATUS_STRING_IDS.colors).toBe(59747315);
    expect(LINK_STATUS_STRING_IDS.disconnect).toBe(88608900);
    expect(LINK_STATUS_STRING_IDS.packetLoss).toBe(212712083);
    expect(LINK_STATUS_STRING_IDS.ping).toBe(224691703);
    expect(acStringHash('ID_LinkStatus_Ping')).toBe(LINK_STATUS_STRING_IDS.ping);
  });

  it('shows "????" until a ping round trip has been measured (m_pingRoundTripTime starts at -1.0)', () => {
    expect(buildLinkStatusPanelText({ packetLoss: 0, pingRoundTripSeconds: -1 }))
      .toBe(EXPECTED_BODY('0.00', LINK_STATUS_PING_UNKNOWN));
    expect(buildLinkStatusPanelText({ packetLoss: 0, pingRoundTripSeconds: 0 }))
      .toContain('Server: ???? ms');
  });

  it('ping = round trip × 1000 at precision 0; loss at precision 2 (truncating NumToString)', () => {
    expect(buildLinkStatusPanelText({ packetLoss: 0.0833, pingRoundTripSeconds: 0.0427 }))
      .toBe(EXPECTED_BODY('0.08', '42'));
    expect(formatStringInfoFloat(1234.9, 0)).toBe('1,234');
    expect(formatStringInfoFloat(0.29, 2)).toBe('0.29');
    expect(formatStringInfoFloat(2, 2)).toBe('2.00');
  });

  it('the title is the layout\'s p23 string "Link Status"', () => {
    expect(linkStatusPanelTitle()).toBe('Link Status');
  });
});

// ─── Packet loss: CLinkStatusAverages ──────────────────────────────────────

describe('LinkStatusAverages (CLinkStatusAverages / LinkStatusHolder packet loss)', () => {
  it('GetAveragePacketLoss = 2 × (NAKed + retransmitted) / (received + sent); 0 with no traffic', () => {
    const a = new LinkStatusAverages();
    expect(a.getAveragePacketLoss()).toBe(0);
    a.addSnapshot({ nPktsSent: 30, nPktsRetransmitted: 3, nPktsReceived: 70, nPktsNAKed: 0 });
    expect(a.getAveragePacketLoss()).toBeCloseTo(2 * 3 / 100, 12);
  });

  it('keeps only the last 40 heartbeats (CAverager<unsigned short, 40>)', () => {
    const a = new LinkStatusAverages();
    a.addSnapshot({ nPktsSent: 50, nPktsRetransmitted: 50, nPktsReceived: 50, nPktsNAKed: 0 });
    for (let i = 0; i < LINK_STATUS_AVERAGER_SAMPLES - 1; i++) {
      a.addSnapshot({ nPktsSent: 10, nPktsRetransmitted: 0, nPktsReceived: 10, nPktsNAKed: 0 });
    }
    expect(a.getAveragePacketLoss()).toBeGreaterThan(0);
    a.addSnapshot({ nPktsSent: 10, nPktsRetransmitted: 0, nPktsReceived: 10, nPktsNAKed: 0 });
    expect(a.getAveragePacketLoss()).toBe(0); // the lossy sample fell out of the ring
  });

  it('heartbeat folds the running counters in every 2 s and publishes the value', () => {
    const a = new LinkStatusAverages();
    expect(a.heartbeat(0)).toBe(false); // arms the clock
    a.countSent(8); a.countReceived(12); a.countRetransmitted(1);
    expect(a.heartbeat(1999)).toBe(false);
    expect(a.getPacketLossPercentage()).toBe(0);
    expect(a.heartbeat(2000)).toBe(true);
    expect(a.getPacketLossPercentage()).toBe(Math.fround(2 * 1 / 20));
  });
});

// ─── ClientConnection feeds the counters ──────────────────────────────────

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice());
  }
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  receive(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.slice().buffer }); }
}

function packet(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags, checksum: 0, id: 0xB, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

function u32List(values: number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 4);
  const v = new DataView(out.buffer);
  v.setUint32(0, values.length, true);
  values.forEach((x, i) => v.setUint32(4 + i * 4, x, true));
  return out;
}

function connectRequest(): Uint8Array {
  const payload = new Uint8Array(32);
  const v = new DataView(payload.buffer);
  v.setFloat64(0, 12345.0, true);
  payload.fill(0x11, 8, 16);
  v.setUint32(16, 0x0007, true);
  payload.set([1, 2, 3, 4], 20);
  payload.set([5, 6, 7, 8], 24);
  return packet(0, PacketHeaderFlags.ConnectRequest, payload);
}

describe('ClientConnection.getPacketLossPercentage — retail counters on the live send/receive paths', () => {
  let savedWebSocket: unknown;
  beforeEach(() => {
    savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
    vi.restoreAllMocks();
  });

  it('a clean session reports 0; resending a NAKed packet raises it to 2 × retransmits / (received + sent)', () => {
    const conn = new ClientConnection('ws://sim');
    conn.autoReconnect = false;
    conn.connect('acct', 'pw');
    const ws = FakeWebSocket.last!;
    ws.open();
    let received = 0;
    ws.receive(connectRequest()); received++;
    vi.advanceTimersByTime(4100);
    expect(conn.getPacketLossPercentage()).toBe(0);

    // One game message out, then the server NAKs it → we resend it once.
    conn.sendMessage(new Uint8Array([0xad, 0xde, 0, 0, 1, 2, 3, 4]), GameMessageGroup.UIQueue);
    const fragPkt = ws.sent[ws.sent.length - 1];
    const seq = readPacketHeader(fragPkt, 0).sequence;
    const beforeNak = ws.sent.length;
    ws.receive(packet(1, PacketHeaderFlags.RequestRetransmit, u32List([seq]))); received++;
    expect(ws.sent.length).toBe(beforeNak + 1); // the retransmission
    expect(ws.sent[ws.sent.length - 1]).toEqual(fragPkt);

    const sentAtNak = ws.sent.length;
    vi.advanceTimersByTime(2100); // ≥ one heartbeat
    const loss = conn.getPacketLossPercentage();
    expect(loss).toBeGreaterThan(0);
    // 2 × 1 retransmit / (received + sent), sent counted up to the heartbeat
    // (an ACK may go out in the same service pass, just before it).
    const candidates = [];
    for (let s = sentAtNak; s <= ws.sent.length; s++) candidates.push(Math.fround(2 / (received + s)));
    expect(candidates).toContain(loss);
  });
});

// ─── GameUI: toggle, ping cadence, text refresh ────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubPanelRenderer(win: any) {
  const calls: number[] = [];
  return {
    calls,
    renderPanel: (layoutId: number, parent: HTMLElement, opts: {
      x?: number; y?: number; subtreeElementId?: number; closeButtonId?: number; dragHandleId?: number; persistKey?: string;
    }) => {
      calls.push(layoutId);
      // renderPanel's own wrapper, placed at (x, y), with the panel root inside.
      const wrapper = win.document.createElement('div');
      wrapper.dataset.wrapper = '1';
      wrapper.style.left = `${opts.x ?? 0}px`;
      wrapper.style.top = `${opts.y ?? 0}px`;
      parent.appendChild(wrapper);
      const root = win.document.createElement('div');
      root.dataset.layout = layoutId.toString(16);
      root.dataset.subtree = (opts.subtreeElementId ?? 0).toString(16);
      root.dataset.close = (opts.closeButtonId ?? 0).toString(16);
      root.dataset.drag = (opts.dragHandleId ?? 0).toString(16);
      root.dataset.persist = opts.persistKey ?? '';
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [0x10000168, 0x10000169, 0x100000fc, 0x100000fd, 0x100000fe]) {
        const el = win.document.createElement('div');
        root.appendChild(el);
        elements.set(id, el);
      }
      return {
        root, elements,
        setText: (id: number, t: string) => { elements.get(id)!.textContent = t; },
        close: () => { wrapper.remove(); },
      };
    },
  };
}

describe('GameUI.toggleLinkStatusPanel — gmLinkStatusUI show/hide, ping cadence and refresh', () => {
  let H: GameUIFixture;
  let pings = 0;
  let loss = 0;
  let renderer: ReturnType<typeof stubPanelRenderer>;
  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onRequestPing: () => { pings++; } } });
    renderer = stubPanelRenderer(H.win);
    H.ui.layoutRenderer = renderer;
    H.ui.linkStatusPacketLossSource = () => loss;
  });
  afterAll(() => H.teardown());

  const panelRoot = () => H.container.querySelector('[data-layout="2100001d"]') as HTMLElement | null;
  const bodyText = () => (panelRoot()?.querySelector('[data-link-status-text]')?.textContent ?? '');

  it('opens layout 0x2100001d (root 0x10000167) in the panels window with its close 0x100000fc, and pings at once', () => {
    const t0 = 10_000_000;
    H.ui.toggleLinkStatusPanel(t0);
    expect(H.ui.isLinkStatusPanelOpen()).toBe(true);
    const root = panelRoot()!;
    expect(root).not.toBeNull();
    expect(root.dataset.subtree).toBe('10000167');
    expect(root.dataset.close).toBe('100000fc');
    // VISUAL.char-panel-body-too-bright.a.a.a — slot 0x10000187 of the panels
    // window: it drags with the window (WindowID 9), not on its own title bar
    // or persist key, and opens at the window's rect: right-flush and 100 px
    // above the bottom of the HUD, 310x372 round the 300x362 body at (5,5).
    expect(root.dataset.drag).toBe('0');
    expect(root.dataset.persist).toBe('');
    const wrapper = root.parentElement as HTMLElement;
    const hud = H.ui as unknown as { hudLogicalWidth(): number; hudLogicalHeight(): number };
    expect(wrapper.style.left).toBe(`${hud.hudLogicalWidth() - 310}px`);
    expect(wrapper.style.top).toBe(`${hud.hudLogicalHeight() - 100 - 372}px`);
    expect([wrapper.style.width, wrapper.style.height]).toEqual(['310px', '372px']);
    expect([root.style.left, root.style.top]).toEqual(['5px', '5px']);
    expect(pings).toBe(1);
    expect(H.ui.linkStatusPanelText).toBe(EXPECTED_BODY('0.00', '????'));
    expect(bodyText()).toContain('Packet loss for the last 10 sec: 0.00%');
    expect(bodyText()).toContain('Roundtrip Ping time to Server: ???? ms');
  });

  it('a ping result refreshes the text and flags the next ping (RecvNotice_Ping)', () => {
    const t0 = 10_000_000;
    loss = 0.05;
    H.ui.recvLinkStatusPing(42.7, t0 + 50);
    expect(H.ui.linkStatusPanelText).toBe(EXPECTED_BODY('0.05', '42'));
    expect(bodyText()).toContain('Roundtrip Ping time to Server: 42 ms');
    expect(bodyText()).not.toContain('????');
    // The 5 s gate was open (no tick yet), so Update ran and re-pinged.
    expect(pings).toBe(2);

    // Next response inside the 5 s gate: round trip stored, no Update yet.
    H.ui.recvLinkStatusPing(80, t0 + 1000);
    expect(H.ui.linkStatusPanelText).toContain('Server: 42 ms');
    expect(pings).toBe(2);
    // The tick after the gate reopens runs Update → shows 80 and pings (flag set).
    H.ui.tickLinkStatusPanel(t0 + 5100);
    expect(H.ui.linkStatusPanelText).toContain('Server: 80 ms');
    expect(pings).toBe(3);
    // Another tick within 5 s does nothing.
    H.ui.tickLinkStatusPanel(t0 + 6000);
    expect(pings).toBe(3);
  });

  it('with no response, Update re-pings once 120 s pass since the last request', () => {
    const t0 = 10_000_000;
    H.ui.tickLinkStatusPanel(t0 + 10_200); // Update, no flag, 5 s since the ping → no ping
    expect(pings).toBe(3);
    H.ui.tickLinkStatusPanel(t0 + 5100 + 120_000);
    expect(pings).toBe(4);
  });

  it('closing removes the panel and stops pinging; a late response does not repaint', () => {
    const t0 = 10_000_000;
    H.ui.toggleLinkStatusPanel(t0 + 200_000);
    expect(H.ui.isLinkStatusPanelOpen()).toBe(false);
    expect(panelRoot()).toBeNull();
    H.ui.recvLinkStatusPing(20, t0 + 200_100);
    H.ui.tickLinkStatusPanel(t0 + 400_000);
    expect(pings).toBe(4);
  });

  it('the link-status timer (updateLinkStatus) drives the panel tick', () => {
    const t0 = 20_000_000;
    H.ui.toggleLinkStatusPanel(t0);
    expect(pings).toBe(5);
    H.ui.recvLinkStatusPing(33, t0 + 10); // gate open → Update + ping
    expect(pings).toBe(6);
    H.ui.recvLinkStatusPing(35, t0 + 20); // 5 s gate closed → stored, not shown
    expect(H.ui.linkStatusPanelText).toContain('Server: 33 ms');
    H.ui.updateLinkStatus({ connected: true, secondsSinceLastPacket: 0 }, t0 + 1000);
    expect(H.ui.linkStatusPanelText).toContain('Server: 33 ms'); // still gated
    H.ui.updateLinkStatus({ connected: true, secondsSinceLastPacket: 0 }, t0 + 5020);
    expect(H.ui.linkStatusPanelText).toContain('Server: 35 ms');
    expect(pings).toBe(7); // the flagged re-ping went out with that Update
    H.ui.toggleLinkStatusPanel(t0 + 6000);
  });

  it('shares the panels-window body: the vitae panel displaces it, stops its pings, and does not hand it back', () => {
    // VISUAL.char-panel-body-too-bright.a.a.a — gmPanelUI::RecvNotice_
    // SetPanelVisibility @ 004bc6f0 shows one body panel at a time. Both
    // windows carry 0x10000049, so the vitae panel remembers nothing.
    H.ui.vitaePanelSource = () => ({ vitaePenalty: 0.05, vitaeCpPool: 0, deathLevel: 10, level: 10 });
    const t0 = 30_000_000;
    H.ui.toggleLinkStatusPanel(t0);
    expect(H.ui.isLinkStatusPanelOpen()).toBe(true);
    const before = pings;
    H.ui.toggleVitaePanel();
    expect(H.ui.isLinkStatusPanelOpen()).toBe(false);
    expect(panelRoot()).toBeNull();
    const vitae = H.container.querySelector('[data-layout="21000020"]') as HTMLElement;
    expect(vitae).not.toBeNull();
    expect(vitae.dataset.subtree).toBe('100001c1');
    expect(vitae.dataset.persist).toBe('');
    H.ui.tickLinkStatusPanel(t0 + 10_000);
    expect(pings).toBe(before);
    H.ui.toggleVitaePanel();
    expect(H.container.querySelector('[data-layout="21000020"]')).toBeNull();
    expect(H.ui.isLinkStatusPanelOpen()).toBe(false);
  });
});

// ─── DAT: the real StringTable 0x23000001 strings ──────────────────────────

describe.skipIf(!existsSync(LANG_DAT))('DAT — Link Status text resolves from StringTable 0x23000001', () => {
  beforeAll(async () => {
    const { DatDatabase, DatReader, parseStringTable } = await import('@ac/dat-parser');
    const buf = readFileSync(LANG_DAT);
    const db = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    registerStringTable(parseStringTable(new DatReader(db.getFileData(0x23000001)!)));
  });

  it('the body reads verbatim from the DAT fragments', () => {
    expect(buildLinkStatusPanelText({ packetLoss: 0.0123, pingRoundTripSeconds: 0.125 }))
      .toBe(EXPECTED_BODY('0.01', '125'));
  });

  it('the title is DAT string 187694290 "Link Status"', () => {
    expect(linkStatusPanelTitle()).toBe('Link Status');
  });
});
