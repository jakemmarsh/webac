/**
 * probe-gdl-chargen — which skill array a live GDL world's CClient::CreateCharacter
 * accepts, with our own message builder and the real classic DAT tables, no
 * browser. Built 2026-10-12 for Seedsow's launch-day "The server cannot create
 * your new character at this time" (CharGenVerificationResponse 5 = Corrupt).
 *
 * GDL's create answers Corrupt (5) when a trained/specialized skill id has no
 * entry in the SERVER's SkillTable (reference/classic/ClassicDereth/Source/
 * Client.cpp ~L467-501). Classic Dereth 1.0 and 1.1 differ only by Salvaging
 * (40, free trained in 1.1), and both report the same DDD iterations, so only a
 * create tells which set a world runs (docs/dark-majesty-support.md).
 *
 * Variants (one create each, same account, at most one succeeds):
 *   full    the 1.1 defaults our chargen sends for classic-dereth (Salvaging trained)
 *   no40    the same array without skill 40 (what classic-dereth-1-0 sends)
 * Each logs the exact CharacterCreate payload (hex) and the server's reply.
 *
 *   npx tsx tools/probe-gdl-chargen.ts --server <Servers.xml id> --account acjsprobeNNNNN
 *       --password <pw> [--variants full,no40] [--bridge wss://bridge.playwebac.com]
 *       [--dats dat-sets/classic-dereth-1.1] [--heritage 1] [--out dir]
 * Credentials go nowhere but the command line; keep them in a scratch dir.
 * Jake OK'd throwaway accounts on third-party worlds (2026-10-11).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import WebSocket from 'ws';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/ClientConnection.js';
import { buildCharacterCreate, parseCharacterList } from '../packages/network/src/MessageSerializer.js';
import { GameMessageGroup } from '../packages/network/src/GameMessageGroup.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { SkillTable, CharacterGenerator, skillTableWithout } from '../packages/dat-parser/src/index.js';
import { defaultChargenSkillClasses } from '../packages/renderer/src/ui/chargenSkillDefaults.js';

const args = process.argv.slice(2);
const opt = (n: string, d = ''): string => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] ?? d : d; };
const server = opt('server');
const account = opt('account');
const password = opt('password');
const bridge = opt('bridge', 'wss://bridge.playwebac.com');
const origin = opt('origin', 'https://playwebac.com');
const repo = new URL('..', import.meta.url).pathname;
const dats = opt('dats', join(repo, 'dat-sets/classic-dereth-1.1'));
const variants = opt('variants', 'full,no40').split(',').filter(Boolean);
const heritage = Number(opt('heritage', '1'));
const out = opt('out', `/tmp/gdl-chargen-${Date.now()}`);
if (!server || !account || !password) { console.error('need --server, --account, --password'); process.exit(2); }
mkdirSync(out, { recursive: true });

// Origin header: the hosted bridge admits only the deployed page's origin.
class OriginWebSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { Origin: origin } }); }
}
(globalThis as { WebSocket?: unknown }).WebSocket = OriginWebSocket;

const portal = new DatDatabase(new FileDatBytes(join(dats, 'client_portal.dat')));
const cell = new DatDatabase(new FileDatBytes(join(dats, 'client_cell_1.dat')));
const table = new SkillTable(new DatReader(portal.getFileData(0x0e000004)!));
const charGen = new CharacterGenerator(new DatReader(portal.getFileData(0x0e000002)!));

/** The array our chargen sends: GameUI.defaultChargenSkillClasses (shared module). */
const defaultSkills = (t: SkillTable): number[] => defaultChargenSkillClasses(t.skills, charGen.heritageGroups.get(heritage)?.skills);
/** Classic Dereth 1.0's table: 1.1's without Salvaging (what era classic-dereth-1-0 serves). */
const table10 = new SkillTable(new DatReader(skillTableWithout(portal.getFileData(0x0e000004)!, new Set([40]))));

function name(): string {
  const c = 'bdfgklmnprstvz', v = 'aeiou';
  const syl = () => c[randomInt(c.length)] + v[randomInt(v.length)];
  return (syl() + syl() + syl()).replace(/^./, (x) => x.toUpperCase());
}

function skillsFor(variant: string): number[] {
  return defaultSkills(variant === 'no40' ? table10 : table);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const log = (s: string) => { console.log(s); writeFileSync(join(out, 'log.txt'), s + '\n', { flag: 'a' }); };

async function run(): Promise<void> {
  const conn = new ClientConnection(`${bridge}/connect?server=${server}`, { loginProfile: { clientVersion: '1802', authStyle: 'account-colon-password' } });
  conn.autoReconnect = false;
  conn.datIterations = { portal: portal.totalIterations, cell: cell.totalIterations, language: 994 };
  log(`iterations portal ${portal.totalIterations} cell ${cell.totalIterations}; skill table ${table.skills.size} skills (max id ${Math.max(...table.skills.keys())})`);
  let accountName = account;
  const queue = [...variants];
  const next = (): void => {
    const variant = queue.shift();
    if (!variant) { log('done'); conn.disconnect(); setTimeout(() => process.exit(0), 500); return; }
    const skills = skillsFor(variant);
    const n = name();
    const msg = buildCharacterCreate({
      accountName, heritage, gender: 1,
      appearance: { eyes: 0, nose: 0, mouth: 0, hairColor: 0, eyeColor: 0, hairStyle: 0, headgearStyle: 0xffffffff, headgearColor: 0,
        shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0, footwearStyle: 0, footwearColor: 0,
        skinHue: 0.5, hairHue: 0.5, headgearHue: 0, shirtHue: 0, pantsHue: 0, footwearHue: 0 },
      templateOption: 0, strength: 60, endurance: 60, coordination: 60, quickness: 50, focus: 50, self: 50,
      characterSlot: 0, classId: 1, skills, name: n, startArea: 0,
    });
    log(`[${variant}] create "${n}" heritage ${heritage}, ${skills.length} skills, trained/spec ids [${skills.map((c, i) => (c >= 2 ? i : -1)).filter((i) => i >= 0).join(',')}]`);
    log(`[${variant}] payload ${hex(msg)}`);
    pending = variant;
    conn.sendMessage(msg, GameMessageGroup.UIQueue);
  };
  let pending = '';
  const timer = setTimeout(() => { log('timeout'); process.exit(1); }, 90_000);
  conn.on((ev: ConnectionEvent) => {
    if (ev.type === 'characterList') {
      const list = parseCharacterList(ev.data as Uint8Array);
      accountName = list.accountName || account;
      log(`character list: account "${list.accountName}", ${list.characters.length} characters, ${list.slotCount} slots`);
      next();
    } else if (ev.type === 'characterCreateResponse') {
      const r = ev.data as { responseCode: number; characterName?: string };
      log(`[${pending}] CharacterCreateResponse code ${r.responseCode}${r.characterName ? ` "${r.characterName}"` : ''}`);
      if (r.responseCode === 1) queue.length = 0; // one character at most
      setTimeout(next, 1500);
    } else if (ev.type === 'message') {
      const m = ev.data as { opcode: number; payload?: Uint8Array };
      if (m.opcode === 4 || m.opcode === 0xf7e0) log(`server text (0x${m.opcode.toString(16)}): ${Buffer.from(m.payload ?? []).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
    } else if (ev.type === 'error') {
      log(`error: ${JSON.stringify(ev)}`);
    } else if (ev.type === 'disconnected') {
      log('disconnected'); clearTimeout(timer); process.exit(0);
    }
  });
  conn.connect(account, password);
}
void run();
