/**
 * The agent tool table — one definition per tool, shared by the MCP server
 * (mcp-server.ts: each entry becomes an MCP tool) and the CLI (cli.ts: each
 * entry becomes a subcommand with key=value args). Add a tool here and both
 * front ends get it.
 */
import {
  formatEvents, formatInventory, formatObservation, formatSpells, formatTrace,
} from '../../packages/renderer/src/agent/format.ts';
import type { AgentEvent, AgentItem, AgentObservation, AgentResult, AgentSpell, AgentTracePoint } from '../../packages/renderer/src/agent/types.ts';
import { AgentClient, DEFAULT_PROFILE, requireClient, startDaemon } from './client.ts';
import { listInfos, type DaemonInfo } from './state.ts';
import { AGENT_ERAS, ERA_IDS } from './eras.ts';
import { NOTE_KINDS, type NoteKind, addNote, formatJournal, loadJournal, saveJournal } from './journal.ts';
import { RoutineStore } from './routineStore.ts';
import { EXAMPLE_HUNT_PROFILE, explainProfile, importVTank, validateRoutineDoc, type RoutineDoc } from '../../packages/shared/src/routines/index.ts';
import { readFileSync } from 'node:fs';
import { findDaemon } from './client.ts';

const journalOf = (info: DaemonInfo) => loadJournal(info.era ?? 'eor', info.account, info.character);

export interface ToolOutput {
  text: string;
  jpegBase64?: string;
  isError?: boolean;
}

type Props = Record<string, { type: 'string' | 'number' | 'boolean'; description: string; enum?: string[] }>;

export interface AgentTool {
  name: string;
  description: string;
  props: Props;
  required?: string[];
  run(args: Record<string, any>): Promise<ToolOutput>;
}

const PROFILE_PROP = { profile: { type: 'string' as const, description: `Session profile (default "${DEFAULT_PROFILE}"; only needed when several are running)` } };

/** A guid argument: "#1a2b", "0x1a2b", "1a2b" (hex, as observe prints them) or a decimal number. */
export function parseGuid(v: unknown): number {
  if (typeof v === 'number') return v >>> 0;
  const s = String(v ?? '').trim().replace(/^#/, '');
  if (!s) throw new Error('missing guid');
  const n = /^0x/i.test(s) || /[a-f]/i.test(s) || s.length >= 6 ? parseInt(s.replace(/^0x/i, ''), 16) : parseInt(s, 10);
  if (!Number.isFinite(n)) throw new Error(`bad guid: ${v}`);
  return n >>> 0;
}

/** A target that is a guid or a name to search for nearby. */
function guidOrName(v: unknown): number | string {
  const s = String(v ?? '').trim();
  return /^(#|0x)?[0-9a-f]+$/i.test(s) && (/^(#|0x)/i.test(s) || s.length >= 6) ? parseGuid(s) : s;
}

const result = (r: AgentResult): ToolOutput => ({ text: r.message, isError: !r.ok });

/** Put a pending "the session reloaded" notice in front of a tool's output. */
function withNotice(c: AgentClient, out: ToolOutput): ToolOutput {
  if (!c.notice) return out;
  const n = c.notice;
  c.notice = null;
  return { ...out, text: `NOTE: ${n}\n\n${out.text}` };
}

function act(name: string, description: string, props: Props, required: string[], toArgs: (a: Record<string, any>) => unknown[], timeoutMs = 120_000): AgentTool {
  return {
    name, description, props: { ...props, ...PROFILE_PROP }, required,
    async run(a) {
      const c = requireClient(a.profile);
      return withNotice(c, result(await c.call<AgentResult>(name.replace(/^ac_/, '').replace(/_([a-z])/g, (_, x) => x.toUpperCase()), toArgs(a), timeoutMs)));
    },
  };
}

/**
 * AC_AGENT_ATTACH (e.g. "chrome", set in Claude Desktop's config) makes a bare ac_start play the human's own
 * logged-in character on the live servers; naming a local-server choice (era, base, profile, a new
 * character) still starts a local test session.
 */
export function defaultAttach(a: Record<string, unknown>, env: string | undefined = process.env.AC_AGENT_ATTACH): string | undefined {
  if (!env) return undefined;
  const local = ['era', 'base', 'profile', 'character', 'template', 'heritage', 'gender', 'town', 'seed', 'attributes', 'skills', 'headless'].some((k) => a[k] !== undefined);
  return local ? undefined : env;
}

async function observeText(c: AgentClient, a: Record<string, any>): Promise<string> {
  const obs = await c.call<AgentObservation>('observe', [{ radius: a.radius, max: a.max, filter: a.filter }]);
  return formatObservation(obs);
}

export const TOOLS: AgentTool[] = [
  {
    name: 'ac_start',
    description: 'Start (or reconnect to) your Asheron\'s Call game session: opens a game window, logs in on the profile\'s own account and enters the world, creating a character if needed. Takes ~30 s–3 min the first time. Returns your first observation.',
    props: {
      ...PROFILE_PROP,
      character: { type: 'string', description: 'Character name to create on a new account (letters/spaces, ≤32 chars). Default "Claude <Profile>".' },
      template: { type: 'string', description: 'Profession for a NEW character, by the chargen\'s own names (e.g. "War Mage", "Soldier", "Bow Hunter", "Life Caster"; per era). Default: the random roll.' },
      heritage: { type: 'string', description: 'Heritage for a NEW character (e.g. Aluvian, Gharu\'ndim, Sho, Viamontian; per era).' },
      gender: { type: 'string', description: 'male | female, for a NEW character.' },
      town: { type: 'string', description: 'Starting town for a NEW character (e.g. Holtburg, Shoushi, Yaraq, Sanamar; per era).' },
      seed: { type: 'number', description: 'Pin the appearance roll (default: a fresh random look).' },
      attributes: { type: 'string', description: 'Attributes for a NEW character, set in this order and each kept once set, e.g. "strength=10, endurance=100, coordination=10, quickness=10, focus=100, self=100" (the chargen\'s points must cover them; applied after template=).' },
      skills: { type: 'string', description: 'Skills for a NEW character by name, e.g. "Weapon Tinkering=specialized; Armor Tinkering=trained; Item Tinkering=trained" (credits permitting; applied after template=). It is the whole build: trained skills not listed are untrained, free ones stay. A tinkerer is a custom build; there is no Tinkerer template.' },
      headless: { type: 'boolean', description: 'No visible window (default false: a window opens so a human can watch).' },
      era: { type: 'string', description: `Which era's local server to play: ${ERA_IDS.map((k) => `${k} (${AGENT_ERAS[k].label})`).join(', ')}. Default eor. Each era is its own session (profile claude-<era>).`, enum: ERA_IDS },
      base: { type: 'string', description: 'Game page origin to use, e.g. your own Vite to verify uncommitted work (default: a snapshot of the committed tree on its own Vite, which other sessions\' file saves can\'t reload).' },
      attach: { type: 'string', description: 'Play the human\'s OWN character instead, on any server (playwebac.com included): "chrome" opens (or reuses) a Chrome window at https://playwebac.com/?agent where the human logs in and enters the world themselves; or a DevTools endpoint like http://127.0.0.1:9222. Profile "me". Stopping never logs them out.' },
    },
    async run(a) {
      const attach = a.attach ?? defaultAttach(a);
      const { info, started } = await startDaemon({ profile: a.profile, character: a.character, headless: a.headless, base: a.base, era: a.era, template: a.template, heritage: a.heritage, gender: a.gender, town: a.town, seed: a.seed, attributes: a.attributes, skills: a.skills, attach });
      const c = new AgentClient(info);
      const st = await c.status().catch(() => null);
      if (st?.attached && !st.ready) {
        return {
          text: `Attached to ${st.url}, profile ${info.profile}. Nobody is in the world in that tab yet: ask the human to log in and enter with their character there (their password stays with them), then call ac_observe${info.profile === 'me' ? '' : ` profile=${info.profile}`} or ac_wait. If the page has no ?agent in its address, they reload it at https://playwebac.com/?agent first.`,
        };
      }
      const era = AGENT_ERAS[info.era ?? 'eor'];
      return {
        text: [
          started
            ? st?.attached
              ? `Attached: profile ${info.profile}, playing "${st.character}" in the human's own tab (${st.url}). This is their real character on a live server: play as they asked, as a plain player, and answer people who talk to you.`
              : `Started: profile ${info.profile}, ${era?.label ?? info.era}, account ${info.account}.`
            : `Already running (since ${info.startedAt}): profile ${info.profile} is "${info.character}", ${era?.label ?? info.era}, account ${info.account}. Profiles are shared by every session on this machine: if you didn't start this one, another Claude may be playing it, so pick your own profile= instead.`,
          ...(era?.notes ? [`Era note: ${era.notes}`] : []),
          '', formatJournal(journalOf(info)), '', await observeText(c, {}),
        ].join('\n'),
      };
    },
  },
  {
    name: 'ac_stop',
    description: 'Log out and close the game session (an attached one only lets go of the human\'s tab: they stay logged in).',
    props: { ...PROFILE_PROP },
    async run(a) {
      const c = requireClient(a.profile);
      await c.shutdown();
      return { text: `stopped ${c.info.profile}` };
    },
  },
  {
    name: 'ac_sessions',
    description: 'List running game sessions (profiles).',
    props: {},
    async run() {
      const all = listInfos();
      return { text: all.length ? all.map((i) => `${i.profile}: account ${i.account}, "${i.character}", since ${i.startedAt}`).join('\n') : 'no sessions running' };
    },
  },
  {
    name: 'ac_observe',
    description: 'Look around: your vitals, map coordinates, facing, target, nearby objects (nearest first; distance and direction relative to your facing) and chat/system lines since your last look. Object ids look like #8000123a; pass them to other tools.',
    props: {
      ...PROFILE_PROP,
      radius: { type: 'number', description: 'Metres (default 60).' },
      max: { type: 'number', description: 'Max objects listed (default 25).' },
      filter: { type: 'string', description: 'Only objects whose name or kind contains this text (e.g. "monster", "Drudge", "corpse").' },
    },
    async run(a) { const c = requireClient(a.profile); return withNotice(c, { text: await observeText(c, a) }); },
  },
  {
    name: 'ac_look',
    description: 'Look around properly: a screenshot of what your character sees plus the text observation, in one call. Use it whenever you arrive somewhere new or the list alone doesn\'t tell you what the place is like.',
    props: { ...PROFILE_PROP },
    async run(a) {
      const c = requireClient(a.profile);
      const [jpegBase64, text] = await Promise.all([c.screenshot(), observeText(c, { max: 15 })]);
      return withNotice(c, { text, jpegBase64 });
    },
  },
  {
    name: 'ac_note',
    description: 'Write in your character\'s journal, which you\'ll see again next session: a goal, something done (closes the goal it names), a place, a person, an event, or an idea. Keep notes short and specific ("Blacksmith in the Academy wants his bellows back from the thrungus in the gardens").',
    props: {
      ...PROFILE_PROP,
      kind: { type: 'string', description: NOTE_KINDS.join(' | '), enum: [...NOTE_KINDS] },
      text: { type: 'string', description: 'The note.' },
    },
    required: ['kind', 'text'],
    async run(a) {
      const c = requireClient(a.profile);
      const kind = String(a.kind) as NoteKind;
      if (!NOTE_KINDS.includes(kind)) return { text: `kind must be one of ${NOTE_KINDS.join(', ')}`, isError: true };
      const obs = await c.call<AgentObservation>('observe', [{ max: 0 }]).catch(() => null);
      const where = obs?.me ? (obs.me.coords ?? `indoors ${obs.me.cell}`) : undefined;
      const j = addNote(journalOf(c.info), kind, String(a.text), where);
      saveJournal(j);
      return { text: `noted (${kind}). ${j.notes.length} notes in ${c.info.character}'s journal.` };
    },
  },
  {
    name: 'ac_journal',
    description: 'Read your character\'s journal: open goals and the latest places, people and events you noted in earlier sessions.',
    props: { ...PROFILE_PROP },
    async run(a) { return { text: formatJournal(journalOf(requireClient(a.profile).info)) }; },
  },
  {
    name: 'ac_screenshot',
    description: 'A screenshot of the game window (for terrain, buildings, dungeons, or checking what the UI shows).',
    props: { ...PROFILE_PROP },
    async run(a) { return { text: 'screenshot', jpegBase64: await requireClient(a.profile).screenshot() }; },
  },
  {
    name: 'ac_click',
    description: 'Click the game window at a position in the last ac_screenshot (pixels from its top-left), as the mouse would: for panels and buttons the other tools do not cover (e.g. the Automation panel, opened with ac_say text=/automation). Take a screenshot after to see what changed.',
    props: {
      ...PROFILE_PROP,
      x: { type: 'number', description: 'Pixels from the screenshot\'s left edge.' },
      y: { type: 'number', description: 'Pixels from the screenshot\'s top edge.' },
      button: { type: 'string', description: 'left (default) or right.', enum: ['left', 'right'] },
    },
    required: ['x', 'y'],
    async run(a) {
      const c = requireClient(a.profile);
      await c.click(Number(a.x), Number(a.y), a.button === 'right' ? 'right' : 'left');
      return withNotice(c, { text: `clicked (${Math.round(Number(a.x))}, ${Math.round(Number(a.y))})` });
    },
  },
  {
    name: 'ac_wait',
    description: 'Sleep until something happens instead of polling: returns as soon as a matching event arrives (chat, tell, death, target-died, task-done, vitals-low, attacked, object-added, level-up, portal), or after timeout. Use after starting a walk or an attack.',
    props: {
      ...PROFILE_PROP,
      types: { type: 'string', description: 'Comma-separated event types to wake on (default: any): chat, dialog, task-done, target-died, target-lost, vitals-low, attacked (any incoming attack, even a 0-damage hit or a miss), death, object-added, portal, level-up, screen.' },
      chat_match: { type: 'string', description: 'Also wake on chat lines matching this regex.' },
      timeout_s: { type: 'number', description: 'Seconds (default 20, max 300).' },
      since_seq: { type: 'number', description: 'Only events after this seq (default: from now).' },
    },
    async run(a) {
      const c = requireClient(a.profile);
      const timeout = Math.min(Math.max(Number(a.timeout_s ?? 20), 1), 300) * 1000;
      const evs = await c.call<AgentEvent[]>('waitFor', [{
        types: a.types ? String(a.types).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        chatMatch: a.chat_match, sinceSeq: a.since_seq,
      }, timeout], timeout + 5000);
      return withNotice(c, { text: evs.length ? formatEvents(evs) : `(nothing within ${timeout / 1000} s)` });
    },
  },
  {
    name: 'ac_inventory',
    description: 'Your inventory: equipped items, main pack and side packs, with ids.',
    props: { ...PROFILE_PROP },
    async run(a) { return { text: formatInventory(await requireClient(a.profile).call<AgentItem[]>('inventory')) }; },
  },
  {
    name: 'ac_spells',
    description: 'Spells in your spellbook, optionally filtered by name/school text.',
    props: { ...PROFILE_PROP, filter: { type: 'string', description: 'Text to match (e.g. "Flame Bolt", "Life", "Self").' }, max: { type: 'number', description: 'Default 40.' } },
    async run(a) { return { text: formatSpells(await requireClient(a.profile).call<AgentSpell[]>('spells', [a.filter ?? '', a.max ?? 40])) }; },
  },
  {
    name: 'ac_character',
    description: 'Your character sheet: attributes, vitals, skills (with training), level, XP and unassigned XP.',
    props: { ...PROFILE_PROP },
    async run(a) { return { text: await requireClient(a.profile).call<string>('characterSheet') }; },
  },
  {
    name: 'ac_fellowship',
    description: 'Fellowship, through the fellowship pane: action=show (default; members, leader, XP sharing, whether you accept requests), create (name=…), recruit (target= a nearby player; they get a 30 s dialog to accept with ac_dialog button=Yes), quit, leader / dismiss (name= a fellow), open, close, disband, requests (name=accept|ignore: the "Ignore Fellowship Requests" option; a character ignoring requests can\'t be recruited), auto (name=on|off: automatically accept requests). Leader-only actions are refused for others, as the pane\'s buttons are.',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', enum: ['show', 'create', 'recruit', 'quit', 'leader', 'dismiss', 'open', 'close', 'disband', 'requests', 'auto'], description: 'What to do (default show).' },
      name: { type: 'string', description: 'create: the fellowship name (≤ 34 characters). leader / dismiss: the fellow. requests: accept | ignore. auto: on | off.' },
      target: { type: 'string', description: 'recruit: the player (id or name nearby).' },
    },
    async run(a) {
      const c = requireClient(a.profile);
      const action = a.action ?? 'show';
      const arg = action === 'recruit' ? (a.target ? guidOrName(a.target) : undefined) : a.name;
      if (action === 'recruit' && !arg) return { text: 'recruit needs target= (the player to recruit)', isError: true };
      if (action === 'show') return withNotice(c, result(await c.call<AgentResult>('fellowship', ['show'])));
      return withNotice(c, result(await c.call<AgentResult>('fellowship', [action, arg], 60_000)));
    },
  },
  {
    name: 'ac_allegiance',
    description: 'Allegiance, through the allegiance pane: action=show (patron, vassals, monarch), swear (swear to a nearby player: the server walks you over and asks them in a dialog that expires in 30 s; returns in about 5 s so you can answer it on the patron\'s profile with ac_dialog button=Yes right away), or break (from your patron; with target=<vassal name>, release that vassal).',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', enum: ['show', 'swear', 'break'], description: 'show (default), swear, or break.' },
      target: { type: 'string', description: 'swear: the player (id or name nearby). break: a vassal\'s name (omit to break from your patron).' },
    },
    async run(a) {
      const c = requireClient(a.profile);
      const action = a.action ?? 'show';
      if (action === 'show') return { text: await c.call<string>('allegiance') };
      if (action === 'swear') {
        if (!a.target) return { text: 'swear needs target= (the player to swear to)', isError: true };
        return withNotice(c, result(await c.call<AgentResult>('swearAllegiance', [guidOrName(a.target)], 60_000)));
      }
      if (action === 'break') return withNotice(c, result(await c.call<AgentResult>('breakAllegiance', a.target ? [String(a.target)] : [])));
      return { text: `unknown action "${action}" (show, swear, break)`, isError: true };
    },
  },
  act('ac_say', 'Type a line into chat exactly as a player would: plain text is said aloud; "/tell Name, msg", "/f msg", emotes like "*wave*" and the retail "/" commands work. "@" server commands are refused (agents play as players).', { text: { type: 'string', description: 'The chat line.' } }, ['text'], (a) => [String(a.text)]),
  act('ac_select', 'Select an object (it becomes your target).', { target: { type: 'string', description: 'Object id (#…) or a name to find nearby.' } }, ['target'], (a) => [guidOrName(a.target)]),
  act('ac_use', 'Use an object the way double-clicking does: talk to an NPC, open a door/chest/corpse, enter a portal, use a lifestone, eat/drink an item. You walk to it automatically.', { target: { type: 'string', description: 'Object id (#…) or a name to find nearby.' } }, ['target'], (a) => [guidOrName(a.target)], 60_000),
  act('ac_use_on', 'Use an item from your pack on a target (e.g. a healing kit on yourself, a key on a door, a tool on another item).', {
    item: { type: 'string', description: 'Item id or name in your inventory.' },
    target: { type: 'string', description: 'Target id or name ("self" for yourself).' },
  }, ['item', 'target'], (a) => [guidOrName(a.item), String(a.target) === 'self' ? 'self' : guidOrName(a.target)]),
  act('ac_walk_to', 'Walk/run to an object, map coordinates ("42.1N, 33.6E") or a relative offset. Returns when you arrive, get stuck, or after timeout; check ac_observe after.', {
    target: { type: 'string', description: 'Object id (#…), nearby object name, or map coordinates like "42.1N, 33.6E".' },
    within: { type: 'number', description: 'Stop this close, metres (default 2).' },
    timeout_s: { type: 'number', description: 'Give up after this long (default 60).' },
  }, ['target'], (a) => [/[NS]\s*,?\s*[\d.]+\s*[EW]/i.test(String(a.target)) ? String(a.target) : guidOrName(a.target), { within: a.within, timeoutMs: (a.timeout_s ?? 60) * 1000 }], 320_000),
  act('ac_turn', 'Turn to face a compass bearing (0 = north, 90 = east) or an object.', { toward: { type: 'string', description: 'Bearing in degrees, or an object id / name.' } }, ['toward'], (a) => [/^-?\d+(\.\d+)?$/.test(String(a.toward)) && String(a.toward).length < 6 ? Number(a.toward) : guidOrName(a.toward)]),
  act('ac_move', 'Hold a movement key for a while (fine control, e.g. backing off or strafing around an obstacle).', {
    direction: { type: 'string', description: 'forward | backward | strafe_left | strafe_right | turn_left | turn_right', enum: ['forward', 'backward', 'strafe_left', 'strafe_right', 'turn_left', 'turn_right'] },
    seconds: { type: 'number', description: 'How long (default 1, max 10).' },
  }, ['direction'], (a) => [String(a.direction), Math.min(Number(a.seconds ?? 1), 10)], 20_000),
  act('ac_dialog', 'Press a button on an open dialog (popups, Yes/No confirmations) — observe lists them as DIALOG lines. A modal dialog can block other actions until answered.', {
    button: { type: 'string', description: 'Button label, e.g. "OK", "Yes", "No".' },
    index: { type: 'number', description: 'Which dialog (the DIALOG number in observe); default newest.' },
  }, ['button'], (a) => [String(a.button), a.index]),
  act('ac_map', 'A text floor plan around you, built from the game\'s own movement collision: @ you, . floor you can walk to, : reachable floor over 1 m up/down, # walls/drops/unreachable, and nearby objects as letters with a legend. North is up, 1 character = 1 m. Use it to see rooms, doorways and exits when deciding where to go; ac_walk_to already paths around walls on its own.', {
    radius: { type: 'number', description: 'Metres around you (5–25, default 15).' },
  }, [], (a) => [{ radius: a.radius }]),
  act('ac_close', 'Close an open window the way its close box does: name="Social", "Container", "Inventory", "Vendor", "Examine" … (observe lists them under "windows open"), or "all" (what Escape does, plus an open chest/corpse). Pop-up DIALOG lines are answered with ac_dialog instead.', {
    name: { type: 'string', description: 'A window name from observe ("windows open: …"), or "all" (default).' },
  }, [], (a) => [String(a.name ?? 'all')]),
  act('ac_press', 'Press a key binding as the keyboard would: a keymap action name (e.g. "Show/Hide Inventory", "Toggle Autorun") or a key code ("F9", "Ctrl+KeyI"). Use ac_keys to look names up.', {
    key: { type: 'string', description: 'Action name or key code.' },
  }, ['key'], (a) => [String(a.key)]),
  act('ac_vendor', 'List what the open vendor sells, with prices. Open a vendor with ac_use first.', {}, [], () => []),
  act('ac_buy', 'Buy from the open vendor.', {
    item: { type: 'string', description: 'Merchandise name or id (from ac_vendor).' },
    amount: { type: 'number', description: 'How many (default 1).' },
  }, ['item'], (a) => [guidOrName(a.item), a.amount ?? null]),
  act('ac_sell', 'Sell an item from your inventory to the open vendor.', {
    item: { type: 'string', description: 'Inventory item name or id.' },
    amount: { type: 'number', description: 'For stacks (default: whole stack).' },
  }, ['item'], (a) => [guidOrName(a.item), a.amount ?? null]),
  act('ac_trade', 'Secure trade with another player (open it with ac_use on them): view, add an item, accept, decline, reset or close.', {
    action: { type: 'string', description: 'view | add | accept | decline | reset | close', enum: ['view', 'add', 'accept', 'decline', 'reset', 'close'] },
    item: { type: 'string', description: 'For add: inventory item name or id.' },
  }, [], (a) => [a.action ?? 'view', a.item === undefined ? null : guidOrName(a.item)]),
  act('ac_jump', 'Jump (forward if moving).', {}, [], () => []),
  act('ac_stop_moving', 'Stop any movement or walk task.', {}, [], () => []),
  act('ac_combat_mode', 'Switch stance: peace, melee, missile or magic (wields what you have equipped for it).', { mode: { type: 'string', description: 'peace | melee | missile | magic', enum: ['peace', 'melee', 'missile', 'magic'] } }, ['mode'], (a) => [String(a.mode)]),
  act('ac_attack', 'Attack a creature with your melee or missile weapon (switches to the right stance, faces it and keeps swinging until it dies, you stop, or the timeout). Use ac_wait for target-died.', {
    target: { type: 'string', description: 'Creature id or name (default: current target, else the nearest monster).' },
    height: { type: 'string', description: 'high | medium | low (default medium)', enum: ['high', 'medium', 'low'] },
    power: { type: 'number', description: 'Power/accuracy 0..1 (default 0.6).' },
  }, [], (a) => [a.target === undefined ? null : guidOrName(a.target), { height: a.height, power: a.power }]),
  act('ac_cast', 'Cast a spell by name or id at a target (or yourself). Switches to magic stance first.', {
    spell: { type: 'string', description: 'Spell name (e.g. "Flame Bolt I") or id.' },
    target: { type: 'string', description: 'Target id/name, or "self" (default: current target for hostile spells, else self).' },
  }, ['spell'], (a) => [/^\d+$/.test(String(a.spell)) ? Number(a.spell) : String(a.spell), a.target === undefined ? null : (String(a.target) === 'self' ? 'self' : guidOrName(a.target))]),
  act('ac_pick_up', 'Pick up an item from the ground or from an open container/corpse into your pack.', { item: { type: 'string', description: 'Item id or name.' } }, ['item'], (a) => [guidOrName(a.item)]),
  act('ac_loot', 'Open a corpse/chest and take everything (or only items whose name matches).', {
    target: { type: 'string', description: 'Corpse/chest id or name (default: nearest corpse).' },
    container: { type: 'string', description: 'Same as target (older name).' },
    match: { type: 'string', description: 'Regex of item names to take (default: all).' },
  }, [], (a) => { const t = a.target ?? a.container; return [t === undefined ? null : guidOrName(t), a.match ?? null]; }, 90_000),
  act('ac_drop', 'Drop an item from your inventory on the ground.', { item: { type: 'string', description: 'Item id or name.' } }, ['item'], (a) => [guidOrName(a.item)]),
  act('ac_give', 'Give an item to an NPC or player (quest turn-ins work this way).', {
    item: { type: 'string', description: 'Item id or name.' },
    target: { type: 'string', description: 'Recipient id or name.' },
    amount: { type: 'number', description: 'For stacks (default: whole stack).' },
  }, ['item', 'target'], (a) => [guidOrName(a.item), guidOrName(a.target), a.amount ?? null]),
  act('ac_equip', 'Wield or wear an item from your pack.', { item: { type: 'string', description: 'Item id or name.' } }, ['item'], (a) => [guidOrName(a.item)]),
  act('ac_appraise', 'Examine (ID) an object: full properties once the server answers.', { target: { type: 'string', description: 'Object id or name.' } }, ['target'], (a) => [guidOrName(a.target)], 20_000),
  {
    name: 'ac_keys',
    description: 'Look up keymap actions and their keys (e.g. filter "inventory", "spell", "camera").',
    props: { ...PROFILE_PROP, filter: { type: 'string', description: 'Text in the action name.' } },
    async run(a) { return { text: await requireClient(a.profile).call<string>('keys', [a.filter ?? '']) }; },
  },
  {
    name: 'ac_trace',
    description: 'Where your character has been (position, cell, height, facing, task) every 0.5 s — for working out what just happened (stuck, fell, clipped into something).',
    props: { ...PROFILE_PROP, seconds: { type: 'number', description: 'How far back (default 30, max 120).' } },
    async run(a) { return { text: formatTrace(await requireClient(a.profile).call<AgentTracePoint[]>('trace', [Math.min(Number(a.seconds ?? 30), 120)])) }; },
  },
  {
    name: 'ac_routines',
    description: 'Read and configure an account\'s automation routines (per account, kept between sessions; no game session needed). action: list (profiles), show (JSON), explain (plain words), example (a worked profile to edit), validate (a document file), set (store a whole document from file= after validating), import (VirindiTank .met / .nav / .utl files from files=, into profile name=: a meta makes the states, a nav adds a route, a loot profile replaces the loot rules; anything that cannot run exactly is switched off and listed). Defaults to the running session\'s account; pass account= (and server=) for any other, e.g. a player who asked you to set up their routines. Routines only do what a player can (no "@" commands).',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', description: 'list | show | explain | example | validate | set | import', enum: ['list', 'show', 'explain', 'example', 'validate', 'set', 'import'] },
      account: { type: 'string', description: 'Account name (default: the session\'s).' },
      server: { type: 'string', description: 'Server id (default: local-<era> of the session, else local-eor).' },
      name: { type: 'string', description: 'Profile name for show/explain (default: all).' },
      file: { type: 'string', description: 'For validate/set: path to the whole routine document (JSON).' },
      files: { type: 'string', description: 'For import: comma-separated paths of VirindiTank .met / .nav / .utl files.' },
    },
    required: ['action'],
    async run(a) {
      const info = findDaemon(a.profile);
      const account = String(a.account ?? info?.account ?? '');
      const server = String(a.server ?? `local-${info?.era ?? 'eor'}`);
      const store = new RoutineStore();
      const action = String(a.action);
      if (action === 'example') return { text: JSON.stringify(EXAMPLE_HUNT_PROFILE, null, 2) };
      const readFile = (): { body: unknown } | { text: string; isError: true } => {
        if (!a.file) return { text: 'pass file= (a JSON routine document)', isError: true };
        try { return { body: JSON.parse(readFileSync(String(a.file), 'utf8')) }; } catch (e) { return { text: `can't read ${a.file}: ${(e as Error).message}`, isError: true }; }
      };
      // validate checks a file alone: no account (nor a running session to take one from).
      if (action === 'validate') {
        const f = readFile();
        if (!('body' in f)) return f;
        const issues = validateRoutineDoc(f.body);
        return issues.length ? { text: issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n'), isError: true } : { text: 'valid' };
      }
      if (!account) return { text: 'pass account= (no game session is running to take it from)', isError: true };
      const doc = store.get(server, account);
      const pick = (n?: string) => doc.profiles.filter((p) => !n || p.name.toLowerCase() === String(n).toLowerCase());
      if (action === 'list') {
        return { text: doc.profiles.length
          ? `${server}/${account} (updated ${doc.updatedAt}):\n${doc.profiles.map((p) => `  ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')}${doc.characters ? `\ncharacters: ${Object.entries(doc.characters).map(([c, p]) => `${c} → ${p}`).join(', ')}` : ''}`
          : `${server}/${account} has no routines yet (start from: ac_routines action=example)` };
      }
      if (action === 'show') return { text: JSON.stringify(a.name ? pick(a.name)[0] ?? null : doc, null, 2) };
      if (action === 'explain') {
        const ps = pick(a.name);
        return { text: ps.length ? ps.map(explainProfile).join('\n\n') : `no profile${a.name ? ` "${a.name}"` : 's'} for ${server}/${account}` };
      }
      if (action === 'set') {
        const f = readFile();
        if (!('body' in f)) return f;
        const r = store.put(server, account, f.body);
        return r.ok
          ? { text: `stored ${r.doc.profiles.length} profile(s) for ${server}/${account}\n\n${r.doc.profiles.map(explainProfile).join('\n\n')}` }
          : { text: `not stored:\n${r.issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
      }
      if (action === 'import') {
        if (!a.files) return { text: 'pass files= (comma-separated .met / .nav / .utl paths)', isError: true };
        const paths = String(a.files).split(',').map((x) => x.trim()).filter(Boolean);
        const files: Array<{ name: string; text: string }> = [];
        for (const f of paths) {
          // VTank writes ASCII / Windows-1252; latin1 keeps every byte.
          try { files.push({ name: f, text: readFileSync(f, 'latin1') }); } catch (e) { return { text: `can't read ${f}: ${(e as Error).message}`, isError: true }; }
        }
        const name = String(a.name ?? paths.find((f) => /\.met$/i.test(f))?.replace(/^.*[\\/]/, '').replace(/\.met$/i, '') ?? 'Imported');
        const base = doc.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
        const r = importVTank(files, base, base?.name ?? name);
        const next = { ...doc, profiles: [...doc.profiles.filter((p) => p !== base), r.value] };
        const put = store.put(server, account, next);
        if (!put.ok) return { text: `not stored:\n${put.issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
        const off = r.value.states.flatMap((st) => st.rules).filter((x) => x.disabled).length + r.value.loot.filter((x) => x.disabled || x.match.unsupported).length;
        return { text: [`imported into "${r.value.name}" for ${server}/${account}: ${r.value.states.length} states, ${r.value.states.reduce((t, st) => t + st.rules.length, 0)} rules, ${r.value.routes.length} routes, ${r.value.loot.length} loot rules (${off} switched off)`,
          ...(r.problems.length ? ['', `not carried over exactly (${r.problems.length}):`, ...r.problems.slice(0, 40).map((x) => `  ${x}`), ...(r.problems.length > 40 ? [`  … and ${r.problems.length - 40} more`] : [])] : []),
          '', explainProfile(r.value)].join('\n') };
      }
      return { text: `unknown action ${action}`, isError: true };
    },
  },
  {
    name: 'ac_routine',
    description: 'Run one of the account\'s stored routines on your character (ac_routines configures them): action=dryrun shows which rule of the current state would fire now and why (check before running), run starts it, status shows its state, recent actions and this run\'s stats, pause/resume hold it, stop stops it. The routine acts through the same player actions as the other tools.',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', description: 'run | pause | resume | stop | status | dryrun', enum: ['run', 'pause', 'resume', 'stop', 'status', 'dryrun'] },
      name: { type: 'string', description: 'For run/dryrun: the profile name (default: the one assigned to this character, else the only one).' },
      server: { type: 'string', description: 'Server id the routines are stored under (default local-<era>).' },
    },
    required: ['action'],
    async run(a) {
      const c = requireClient(a.profile);
      const action = String(a.action);
      if (action === 'stop') return result(await c.call<AgentResult>('routineStop'));
      if (action === 'pause') return result(await c.call<AgentResult>('routinePause'));
      if (action === 'resume') return result(await c.call<AgentResult>('routineResume'));
      if (action === 'status') {
        const st = await c.call<{ running: boolean; paused: boolean; profile: string | null; state: string | null; acting: string | null; last: string[] }>('routineStatus');
        const s = await c.call<{ startedAt: number | null; xpGained: number; kills: number; deaths: number; kept: number; left: number; sold: number; rebuffs: number }>('routineStats');
        const stats = s.startedAt !== null ? `  this run: ${s.kills} kills, ${s.deaths} deaths, ${s.xpGained.toLocaleString('en-US')} XP, kept ${s.kept} · left ${s.left} · sold ${s.sold}, ${s.rebuffs} rebuffs` : '';
        return { text: st.running ? [`${st.paused ? 'paused' : 'running'} "${st.profile}" in state "${st.state}"${st.acting ? `, acting: ${st.acting}` : ''}`, ...(stats ? [stats] : []), ...st.last.map((l) => `  ${l}`)].join('\n') : ['no routine running', ...(stats ? [stats] : []), ...st.last.map((l) => `  ${l}`)].join('\n') };
      }
      // The game client loads its own account's routines through the bridge (AGENT.routine-store-auth);
      // the local files are the fallback for a bridge without /routines.
      let doc = new RoutineStore().get(String(a.server ?? `local-${c.info.era ?? 'eor'}`), c.info.account);
      let source = 'local files';
      if (a.server === undefined || a.server === null) {
        type Loaded = { ok: boolean; doc?: RoutineDoc; message?: string };
        const fromPage: Loaded = await c.call<Loaded>('routinesLoad').catch((e: Error): Loaded => ({ ok: false, message: e.message }));
        if (fromPage.ok && fromPage.doc) { doc = fromPage.doc; source = 'the bridge'; } else source = `local files (bridge: ${fromPage.message})`;
      }
      const wanted = a.name ?? doc.characters?.[c.info.character] ?? (doc.profiles.length === 1 ? doc.profiles[0].name : undefined);
      const prof = doc.profiles.find((p) => p.name.toLowerCase() === String(wanted ?? '').toLowerCase());
      if (!prof) return { text: `no routine ${wanted ? `"${wanted}" ` : ''}for ${c.info.account} in ${source} (have: ${doc.profiles.map((p) => p.name).join(', ') || 'none — configure one with ac_routines'})`, isError: true };
      if (action === 'run') {
        const r = await c.call<AgentResult>('routineStart', [prof]);
        return result({ ...r, message: `${r.message} (from ${source})` });
      }
      if (action === 'dryrun') {
        const st = await c.call<{ running: boolean; profile: string | null }>('routineStatus');
        const running = st.running && st.profile === prof.name;
        const v = await c.call<Array<{ rule: string; fires: boolean; enabled: boolean; off?: boolean; why: string[] }>>('routineDryRun', [running ? null : prof]);
        const first = v.findIndex((x) => x.fires);
        return { text: [`"${prof.name}", state "${prof.initialState}"${running ? ' (running)' : ''}:`, ...v.map((x, i) => `  ${i === first ? '▶' : ' '} ${x.rule}${x.off ? ' [off]' : x.enabled ? '' : ' [module off]'}: ${x.why.join(', ')}`), first < 0 ? '  (no rule would fire now)' : ''].join('\n') };
      }
      return { text: `unknown action ${action}`, isError: true };
    },
  },
  act('ac_raise', 'Spend unassigned XP to raise an attribute, vital or skill by one step (or several with times).', {
    stat: { type: 'string', description: 'Attribute (Strength…), vital (Health/Stamina/Mana) or skill name (e.g. "War Magic").' },
    times: { type: 'number', description: 'How many raises (default 1).' },
  }, ['stat'], (a) => [String(a.stat), Number(a.times ?? 1)]),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** JSON Schema for a tool's arguments (MCP inputSchema). */
export function inputSchema(t: AgentTool): Record<string, unknown> {
  return { type: 'object', properties: t.props, required: t.required ?? [], additionalProperties: false };
}
