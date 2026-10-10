/**
 * probe-login-version — which LoginRequest version literal a live server
 * accepts, without creating an account on it.
 *
 * ClassicACE (AuthenticationHandler.cs DoLogin / AccountSelectCallback)
 * auto-creates an account only when the password is non-empty, and checks
 * the client version BEFORE "account doesn't exist". So a random account
 * with an EMPTY password answers:
 *   - wrong version  → AccountBoot " because you are not running the correct
 *                      executable file version for this server"
 *   - right version  → CharacterError AccountDoesntExist (0x0A)
 * Stock ACE checks "1802" only and boots with its own wording (" because your
 * client is not the correct version…"). GDL/GDLE servers are not probed:
 * they have no version check, and an empty password is not a safe probe there.
 *
 * One server, through a bridge pinned to it:
 *   npx tsx services/ws-tcp-bridge/src/bridge.ts 9095 doctide.online 9000
 *   npx tsx tools/probe-login-version.ts ws://localhost:9095 [versions…]
 * Every ACE server in Servers.xml, through a multi-server bridge:
 *   BRIDGE_MODE=multi BRIDGE_CONNECT_RATE_PER_IP=1000 npx tsx services/ws-tcp-bridge/src/bridge.ts 9096
 *   npx tsx tools/probe-login-version.ts --all ws://localhost:9096 [versions…]
 * Default versions: 1802 i104 c118 c111 (docs/dark-majesty-support.md).
 */
import WebSocket from 'ws';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/ClientConnection.js';
import { GameMessageOpcode } from '../packages/network/src/GameMessageOpcode.js';
import { parseServersXml } from '../services/ws-tcp-bridge/src/serverList.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

const args = process.argv.slice(2);
const all = args[0] === '--all';
if (all) args.shift();
const url = args[0] ?? 'ws://localhost:9095';
const versions = args.length > 1 ? args.slice(1) : ['1802', 'i104', 'c118', 'c111'];

function readString16(bytes: Uint8Array): string {
  if (bytes.length < 2) return '';
  const n = bytes[0] | (bytes[1] << 8);
  return new TextDecoder('latin1').decode(bytes.subarray(2, 2 + n));
}

async function probe(target: string, version: string): Promise<string> {
  const conn = new ClientConnection(target, { loginProfile: { clientVersion: version, authStyle: 'account-password' } });
  conn.autoReconnect = false;
  const account = `probe${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    const done = (s: string) => { clearTimeout(timer); try { conn.disconnect(); } catch { /* closing */ } resolve(s); };
    const timer = setTimeout(() => done('timeout'), 15_000);
    conn.on((ev: ConnectionEvent) => {
      if (ev.type === 'message') {
        const msg = ev.data as { opcode: number; payload?: Uint8Array };
        if (msg.opcode === GameMessageOpcode.AccountBoot) done(`BOOT:${readString16(msg.payload ?? new Uint8Array()).trim()}`);
      } else if (ev.type === 'error') {
        done(ev.characterError !== undefined ? `CharErr 0x${ev.characterError.toString(16)}` : `error: ${ev.error}`);
      } else if (ev.type === 'characterList') {
        done('characterList');
      } else if (ev.type === 'disconnected') {
        done('disconnected');
      }
    });
    conn.connect(account, '');
  });
}

/** What a set of answers says about the server. */
function verdict(results: Record<string, string>): string {
  const accepted = Object.entries(results).filter(([, r]) => r === 'CharErr 0xa').map(([v]) => v);
  const boots = Object.values(results).filter((r) => r.startsWith('BOOT:'));
  const flavour = boots.some((b) => b.includes('executable file version')) ? 'ClassicACE'
    : boots.some((b) => b.includes('not the correct version')) ? 'ACE' : '?';
  if (Object.values(results).every((r) => r === 'timeout')) return 'no answer';
  return `${flavour}; accepts ${accepted.length ? accepted.join(',') : 'none of these'}`;
}

async function main(): Promise<void> {
  if (!all) {
    for (const v of versions) {
      console.log(`${v.padEnd(6)} → ${await probe(url, v)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.exit(0);
  }
  const xml = await (await fetch('https://raw.githubusercontent.com/acresources/serverslist/master/Servers.xml')).text();
  const servers = parseServersXml(xml).servers.filter((s) => s.emu.toUpperCase() === 'ACE');
  for (const s of servers) {
    const target = `${url}/connect?server=${encodeURIComponent(s.id)}`;
    const results: Record<string, string> = {};
    for (const v of versions) {
      results[v] = await probe(target, v);
      if (results[v] === 'timeout' && v === versions[0]) break; // down: don't wait on every literal
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`${s.name.padEnd(22)} ${s.id}  ${verdict(results).padEnd(36)} ${JSON.stringify(results)}`);
  }
  process.exit(0);
}

void main();
