/**
 * probe-connection.ts — drive Connection1999 headlessly (Node, no browser)
 * against a 1999 server through a bridge: login → character list → create a
 * character if the account has none → enter the world → idle, then report
 * every end-of-retail message the adapter produced and every 1999 message it
 * dropped. The fastest loop for the 1999 adapter (docs/ac1999-support-scope.md
 * Phase 3–4).
 *
 *   npx tsx tools/ac1999/probe-connection.ts ws://localhost:9101 <account> [--seconds 20] [--name Acjsprobe] [--resume] [--iterations 102/67]
 *
 * --social: once in the world, exercise the social codecs (Misc1999.ts): create a
 * fellowship, ask for a fellowship update, query age and birth, list @friends,
 * squelch an unknown name (the server answers "Player not found."), then quit the fellowship; the
 * server's chat lines are printed as they arrive.
 *
 * --resume: after the first character list, disconnect() and connect() again on
 * the same connection (what the page's auto-resume does after a drop) and
 * require a second clean login before going on.
 *
 * Bridge: `BRIDGE_ERA=ac1999-retail npx tsx services/ws-tcp-bridge/src/bridge.ts 9101 127.0.0.1 9310 9311`
 * (the local server: tools/ac1999/start-ac1999.sh). The password is the account name.
 */
import {
  buildCharacterCreate, buildCharacterEnterWorld, buildCharacterEnterWorldRequest, Connection1999,
  parseCharacterList, serializeGameAction, GameActionType, buildFellowshipCreatePayload,
  buildModifyCharacterSquelchPayload, buildFriendsCommand1999, BinaryWriter,
} from '../../packages/network/src/index.js';
import type { ConnectionEvent, GameMessage } from '../../packages/network/src/index.js';
import { WebSocket as NodeWebSocket } from 'ws';

// Node 20 has no global WebSocket; the bridge's `ws` package stands in.
(globalThis as { WebSocket?: unknown }).WebSocket ??= NodeWebSocket;

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const url = args[0];
const account = args[1];
const seconds = Number(opt('--seconds') ?? 20);
const name = opt('--name') ?? `Acjs${account.slice(-4).replace(/[^a-z]/gi, 'x')}`;
if (!url || !account) { console.error('usage: probe-connection.ts <bridge ws url> <account> [--seconds N] [--name Name]'); process.exit(2); }

const conn = new Connection1999(url);
// --iterations P/C: the DAT iterations the login reports (default the retail CD's 102/67). A returning
// browser reports the server's iterations from its stored patches instead.
const [itPortal, itCell] = (opt('--iterations') ?? '102/67').split('/').map(Number);
conn.datIterations = { portal: itPortal, cell: itCell, language: 0 };
const seen = new Map<string, number>();
const note = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
let entered = false;
let resumed = !args.includes('--resume');
let created = false;
let actionSeq = 0;

function enter(guid: number): void {
  console.log(`[probe] entering the world as 0x${guid.toString(16)}`);
  conn.sendMessage(buildCharacterEnterWorldRequest());
  const onReady = (e: ConnectionEvent) => {
    if (e.type !== 'enterWorldReady') return;
    conn.off(onReady);
    conn.sendMessage(buildCharacterEnterWorld(guid, account));
  };
  conn.on(onReady);
}

const social = args.includes('--social');
function exerciseSocial(): void {
  const act = (type: GameActionType, payload?: Uint8Array) => conn.sendMessage(serializeGameAction(++actionSeq, type, payload));
  const dw = (v: number) => { const w = new BinaryWriter(4); w.writeUInt32(v); return w.toBuffer(); };
  const s16 = (v: string) => { const w = new BinaryWriter(8); w.writeString16(v); return w.toBuffer(); };
  console.log('[probe] social: create fellowship, update, age, birth, @friends, squelch, quit');
  act(GameActionType.FellowshipCreate, buildFellowshipCreatePayload('Probers', true));
  setTimeout(() => act(GameActionType.FellowshipUpdateRequest, dw(1)), 500);
  setTimeout(() => act(GameActionType.QueryAge, s16('')), 1000);
  setTimeout(() => act(GameActionType.QueryBirth, s16('')), 1500);
  setTimeout(() => conn.sendMessage(buildFriendsCommand1999(0)), 2000);
  setTimeout(() => act(GameActionType.ModifyCharacterSquelch, buildModifyCharacterSquelchPayload(true, 0, 'Nosuchplayer', 1)), 2500);
  setTimeout(() => act(GameActionType.FellowshipQuit, dw(0)), 3500);
}

conn.on((e) => {
  if (e.type === 'message') {
    const m = e.data as GameMessage;
    if (social && m.type !== 'event' && m.opcode === 0xf7e0) {
      const p = (m as { payload: Uint8Array }).payload;
      const len = p[0] | (p[1] << 8);
      console.log(`[probe] server line: ${new TextDecoder('latin1').decode(p.subarray(2, 2 + len))}`);
    }
    note(m.type === 'event' ? `event 0x${(m as { eventType: number }).eventType.toString(16)}` : `direct 0x${(m.opcode ?? 0).toString(16)}`);
    return;
  }
  if (e.type !== 'gameEvent') console.log(`[probe] ${e.type}${e.error ? `: ${e.error}` : ''}`);
  if ((e.type as string) === 'datPatch1999') { // Connection1999's extra event (not in ConnectionEventType)
    const d = e as unknown as { patches: unknown[]; portalIteration: number; cellIteration: number };
    console.log(`[probe] DAT sync: ${d.patches.length} file(s), iterations ${d.portalIteration}/${d.cellIteration}`);
  }
  if (e.type === 'characterList') {
    const list = parseCharacterList(e.data as Uint8Array);
    if (!resumed) {
      resumed = true;
      console.log('[probe] resume check: disconnect() + connect() on the same connection');
      conn.disconnect();
      setTimeout(() => conn.connect(account, account), 1500);
      return;
    }
    console.log(`[probe] characters: ${list.characters.map((c) => `${c.name} 0x${c.id.toString(16)}`).join(', ') || '(none)'}; account ${list.accountName}`);
    if (entered) return;
    if (list.characters.length) { entered = true; enter(list.characters[0].id); return; }
    if (created) return; // the server re-sends the list as a sequence probe
    created = true;
    console.log(`[probe] creating ${name}`);
    conn.sendMessage(buildCharacterCreate({
      accountName: account, heritage: 1, gender: 1,
      appearance: { eyes: 0, nose: 0, mouth: 0, hairColor: 0, eyeColor: 0, hairStyle: 0, headgearStyle: 0, headgearColor: 0,
        shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0, footwearStyle: 0, footwearColor: 0,
        skinHue: 0.5, hairHue: 0.5, headgearHue: 0.5, shirtHue: 0.5, pantsHue: 0.5, footwearHue: 0.5 },
      templateOption: 0, strength: 50, endurance: 50, coordination: 50, quickness: 50, focus: 50, self: 80,
      characterSlot: 0, classId: 0, skills: new Array(40).fill(0), name, startArea: 0,
    }));
  }
  if (e.type === 'characterCreateResponse') {
    const d = e.data as { responseCode: number; characterGuid?: number };
    console.log(`[probe] create response ${d.responseCode}`);
    if (d.responseCode === 1 && d.characterGuid && !entered) { entered = true; enter(d.characterGuid); }
  }
  if (e.type === 'playerCreate') {
    console.log('[probe] in world: PlayerCreate received');
    setTimeout(() => conn.sendMessage(serializeGameAction(++actionSeq, GameActionType.LoginComplete)), 1500);
    if (social) setTimeout(exerciseSocial, 4000);
  }
});

conn.connect(account, account);
setTimeout(() => {
  console.log('\n[probe] end-of-retail messages the page received:');
  for (const [k, n] of [...seen].sort()) console.log(`  ${k} ×${n}`);
  const adapter = (conn as unknown as { adapter: { unknownInbound: Map<string, number> } }).adapter;
  console.log('[probe] 1999 messages dropped (no codec yet):');
  for (const [k, n] of [...adapter.unknownInbound].sort()) console.log(`  ${k} ×${n}`);
  console.log(`[probe] checksum failures: ${conn.badChecksums}`);
  conn.disconnect();
  setTimeout(() => process.exit(0), 300);
}, seconds * 1000);
