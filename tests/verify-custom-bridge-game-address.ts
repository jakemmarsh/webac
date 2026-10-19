/**
 * Custom… worlds: a game server's address is not a bridge, and a bridge
 * that never answers is not the player's broken network.
 *
 * Production 2026-10-12/13: `client_preworld outcome=connect_failed
 * server=custom-bridge token=ID_NetError_CantSocket`. AC players type a game
 * server's address (`host:9000`, `1.2.3.4:9050`) into Custom…, which became
 * `wss://host:9000`; nothing answered and retail's "Couldn't create local
 * socket. Make sure you have a working network." blamed their network.
 *
 *  1. parseCustomBridge refuses game-server-shaped input up front and keeps
 *     plain hostnames, other scheme-less ports and explicit wss:// working.
 *  2. A Custom… world's CantSocket reads "No webAC bridge answered at <host>"
 *     through the real connection (ClientConnection for end of retail / Dark
 *     Majesty, Connection1999 for AC1999) → netErrorNotice → loginFailureText,
 *     the page's raiseNetError text. Listed worlds keep retail's text.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { netErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  parseCustomBridge, looksLikeGameServerAddress, loginFailureText, worldFromEntry,
  GAME_SERVER_ADDRESS_ERROR, type World,
} from '../packages/renderer/src/launcher/worldDirectory.js';

describe('Custom…: a game server address is refused up front', () => {
  it.each([
    'coldeve.example.net:9000',
    'play.example.net:9050',
    '203.0.113.7:9000',
    '203.0.113.7:9050',
    '203.0.113.7:7777', // a bare IP with a port: a wss:// bridge has a TLS hostname
    'localhost:9000',
    'udp://coldeve.example.net:9000',
    'tcp://203.0.113.7:9000',
    '  coldeve.example.net:9001  ',
  ])('%s → the game-server error', (input) => {
    expect(looksLikeGameServerAddress(input)).toBe(true);
    expect(parseCustomBridge(input)).toEqual({ error: GAME_SERVER_ADDRESS_ERROR });
  });

  it.each([
    ['play.example.net', 'wss://play.example.net/'],
    ['play.example.net:8443', 'wss://play.example.net:8443/'],
    ['play.example.net/bridge', 'wss://play.example.net/bridge'],
    ['wss://play.example.net:9000', 'wss://play.example.net:9000/'],
    ['wss://203.0.113.7:9050/', 'wss://203.0.113.7:9050/'],
    ['ws://localhost:9094', 'ws://localhost:9094/'],
  ])('%s still makes a custom world (%s)', (input, url) => {
    expect(looksLikeGameServerAddress(input)).toBe(false);
    expect(parseCustomBridge(input)).toMatchObject({ world: { kind: 'custom', bridgeUrl: url } });
  });

  it('the error points at the bridge and the world list', () => {
    expect(GAME_SERVER_ADDRESS_ERROR).toMatch(/game server's address/);
    expect(GAME_SERVER_ADDRESS_ERROR).toMatch(/wss:\/\//);
    expect(GAME_SERVER_ADDRESS_ERROR).toMatch(/world list/);
  });
});

class FakeSocket {
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(): void { /* nothing answers */ }
  close(): void { this.readyState = 3; }
  /** A socket the browser cannot open: error, then close. */
  fail(): void { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
}

type Conn = { connect(a: string, p: string): void; on(l: (e: ConnectionEvent) => void): void; autoReconnect?: boolean };
const lanes: Array<[string, (url: string) => Conn]> = [
  ['end of retail / Dark Majesty (ClientConnection)', (url) => new ClientConnection(url)],
  ['AC1999 (Connection1999)', (url) => new Connection1999(url)],
];

/** The page's raiseNetError text for a connection that never opened (main.ts). */
function failureText(make: (url: string) => Conn, world: World, inWorld = false): string {
  const conn = make(world.kind === 'custom' ? world.bridgeUrl! : 'wss://bridge.example/?server=x');
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('bael', 'pw');
  FakeSocket.sockets.at(-1)!.fail();
  const ids = events.map((e) => (e.type === 'error' ? e.netErrorId : undefined)).filter((x): x is string => !!x);
  expect(ids).toEqual(['ID_NetError_CantSocket']);
  return loginFailureText(netErrorNotice(ids[0]), world, inWorld);
}

describe('Custom…: a bridge that never answers is named, not the player\'s network', () => {
  const g = globalThis as { WebSocket?: unknown };
  let saved: unknown;
  beforeAll(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; });
  afterAll(() => { g.WebSocket = saved; });
  afterEach(() => { FakeSocket.sockets = []; });

  const retail = netErrorNotice('ID_NetError_CantSocket').text;

  for (const [lane, make] of lanes) {
    it(`${lane}: a custom world says no webAC bridge answered at its host`, () => {
      const custom = (parseCustomBridge('wss://ac.example.net:8443/bridge') as { world: World }).world;
      const text = failureText(make, custom);
      expect(text).toMatch(/^No webAC bridge answered at ac\.example\.net:8443\./);
      expect(text).toMatch(/server's operators/);
      expect(text).not.toBe(retail);
    });

    it(`${lane}: a listed world keeps retail's CantSocket text`, () => {
      const listed = worldFromEntry({ id: 'coldeve', name: 'Coldeve' })!;
      expect(failureText(make, listed)).toBe(retail);
    });

    it(`${lane}: once in the world, a custom world keeps retail's text`, () => {
      const custom = (parseCustomBridge('wss://ac.example.net/') as { world: World }).world;
      expect(failureText(make, custom, true)).toBe(retail);
    });
  }

  it('only CantSocket is reworded for a custom world (a refused login keeps its own text)', () => {
    const custom = (parseCustomBridge('wss://ac.example.net/') as { world: World }).world;
    const timeout = netErrorNotice('ID_ConnectionError_ClientTimedOutServer');
    expect(loginFailureText(timeout, custom, false)).toBe(`${timeout.text}\n\nTry again in a minute, or pick another world.`);
  });
});
