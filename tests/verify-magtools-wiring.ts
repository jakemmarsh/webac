/**
 * Mag-Tools' background features wired into the game (agent/magtools/magToolsRuntime.ts over the
 * @ac/shared models; docs/plugin-specs/magtools.md §9): chat filters through GameUI's chat paths
 * (a hidden line still reaches the sniffers), the status-text filters on the spew box, login /
 * login complete / periodic commands, log out on death, open main pack on login, one-touch heal,
 * auto trade add / accept, Autopack (with VirindiTank's tidy kept off placed items), and the
 * preview gate: with preview UI off nothing changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatMessageType, mtCommandListKey, MT_TRADE_WHITELIST_KEY, type LootRule } from '@ac/shared';
import { MagToolsWindow } from '../packages/renderer/src/ui/magtools/MagToolsWindow.js';
import { MagToolsRuntime, mtOptionWired, mtSenderClass, type MagToolsExtras } from '../packages/renderer/src/agent/magtools/magToolsRuntime.js';
import type { AgentApi } from '../packages/renderer/src/agent/AgentApi.js';
import { vtankHotkeys } from '../packages/renderer/src/ui/automation/VhsWindow.js';
import type { VTankWindow } from '../packages/renderer/src/ui/automation/VTankWindow.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

interface Slot { guid: number; name: string; packSlot: number; stack: number; maxStack: number; isPack: boolean; equipped: boolean; cls?: { itemType: number; flags: number }; props?: Record<number, number> }

/** The agent API calls the runtime makes, recorded. */
function fakeGame() {
  const calls: string[] = [];
  const state = {
    me: { guid: 0x5001, name: 'Tester', health: { cur: 50, max: 100 }, combatMode: 'peace' as string },
    slots: [] as Slot[],
    packs: [{ slot: 0, guid: 0x5001, capacity: 102, count: 0 }, { slot: 1, guid: 0x7001, capacity: 24, count: 0 }],
    skills: [{ id: 6, name: 'Healing', training: 'trained' as const, base: 100, buffed: 120 }],
  };
  const api = {
    self: () => state.me,
    inventory: () => state.slots.map((s) => ({ guid: s.guid, name: s.name, where: s.equipped ? 'equipped' : s.packSlot === 0 ? 'pack' : 'Pack', type: 'Misc' })),
    itemSlots: () => state.slots.map(({ guid, name, packSlot, stack, maxStack, isPack, equipped }) => ({ guid, name, packSlot, stack, maxStack, wcid: 1, isPack, equipped })),
    packs: () => state.packs,
    itemData: (g: number) => { const s = state.slots.find((x) => x.guid === g); return s?.props ? { int: s.props, float: {}, string: {}, bool: {}, did: {}, spells: [] } : null; },
    skillList: () => state.skills,
    placeItem: (g: number, to: { packSlot: number } | { onto: number }) => { calls.push(`place ${g.toString(16)} ${JSON.stringify(to)}`); return { ok: true, message: '' }; },
    appraise: (g: number) => { calls.push(`appraise ${g.toString(16)}`); return Promise.resolve({ ok: true, message: '' }); },
    use: (g: number) => { calls.push(`use ${g.toString(16)}`); return Promise.resolve({ ok: true, message: '' }); },
    useOn: (a: number, b: number) => { calls.push(`useOn ${a.toString(16)} ${b.toString(16)}`); return { ok: true, message: '' }; },
    logout: () => { calls.push('logout'); return { ok: true, message: '' }; },
    select: (g: number) => { calls.push(`select ${g.toString(16)}`); return { ok: true, message: '' }; },
    fellowshipInfo: () => ({ leader: false, open: false, count: 2, members: ['Tester', 'Fellow'] }),
    trade: (action: string, id?: number) => { calls.push(`trade ${action}${id !== undefined && id !== null ? ` ${id.toString(16)}` : ''}`); return { ok: true, message: '' }; },
  };
  return { api: api as unknown as AgentApi, calls, state };
}

function runtime(over: Partial<MagToolsExtras> = {}) {
  const g = fakeGame();
  const printed: string[] = [];
  const sent: string[] = [];
  const opts = new Map<string, string>();
  let enabled = true;
  let t = 1000;
  let date = new Date(2026, 9, 12, 10, 0, 0);
  let sets: Record<string, LootRule[]> | null = null;
  const mem = new Mem();
  const x: MagToolsExtras = {
    print: (s) => printed.push(s),
    openContainer: () => null,
    spell: () => null,
    classOf: (guid) => g.state.slots.find((s) => s.guid === guid)?.cls ?? { itemType: 0x80, flags: 0 },
    lootRules: () => null,
    selectedGuid: () => null,
    enabled: () => enabled,
    me: () => 'Tester',
    who: () => 'w.Tester',
    manaReads: { worn: () => [], playerEnchantments: () => [], now: () => 0 },
    account: () => 'acct',
    server: () => 'Srv',
    character: () => 'Tester',
    sendChat: (l) => sent.push(l),
    lootSets: () => sets,
    combatStore: () => mem,
    ...over,
  };
  const rt = new MagToolsRuntime(g.api, x, { get: (k) => opts.get(k), set: (k, v) => { opts.set(k, v); } }, () => t, () => date);
  return {
    rt, g, printed, sent, opts, mem,
    setEnabled: (v: boolean) => { enabled = v; },
    advance: (ms: number) => { t += ms; date = new Date(date.getTime() + ms); },
    setSets: (s: Record<string, LootRule[]> | null) => { sets = s; },
    on: (path: string) => { rt.options.set(path, true); },
  };
}

const keepUpTo = (name: string, count: number): LootRule => ({ action: 'keep-up-to', count, match: { name } } as LootRule);
const keep = (name: string): LootRule => ({ action: 'keep', match: { name } } as LootRule);

describe('Mag-Tools chat filters (runtime)', () => {
  it('hides an enabled filter\'s line, and nothing with preview UI off', () => {
    const m = runtime();
    const line = { text: 'You evaded the Drudge Skulker!', type: ChatMessageType.CombatEnemy };
    expect(m.rt.filterChat(line)).toBe(false);
    m.on('Filters.DefenseEvades');
    expect(m.rt.filterChat(line)).toBe(true);
    m.setEnabled(false);
    expect(m.rt.filterChat(line)).toBe(false);
  });

  it('uses the speech info: an NPC\'s say with NPC Chatter, a player\'s say kept', () => {
    const m = runtime();
    m.on('Filters.NpcChatter');
    const say = (cls: number) => ({ text: 'Town Crier says, "Hear ye"', type: ChatMessageType.Speech, speech: { kind: 'say' as const, sender: 'Town Crier', message: 'Hear ye', senderClass: mtSenderClass(cls) } });
    expect(m.rt.filterChat(say(37))).toBe(true);
    expect(m.rt.filterChat(say(24))).toBe(false);
  });

  it('the status-text filters hide spew-box text', () => {
    const m = runtime();
    expect(m.rt.statusTextHidden("You're too busy!")).toBe(false);
    m.on('Filters.StatusTextYoureTooBusy');
    expect(m.rt.statusTextHidden("You're too busy!")).toBe(true);
    expect(m.rt.statusTextHidden('Casting Flame Bolt')).toBe(false);
  });

  it('maps Decal object classes to sender classes', () => {
    expect([24, 25, 5, 37, 1].map(mtSenderClass)).toEqual(['player', 'vendor', 'monster', 'npc', 'other']);
    expect(mtSenderClass(null)).toBeNull();
  });
});

describe('GameUI chat hooks', () => {
  let H: GameUIFixture;
  let log: HTMLDivElement;
  const sniffed: string[] = [];
  beforeAll(async () => {
    H = await mountGameUI();
    log = H.win.document.createElement('div');
    H.container.appendChild(log);
    H.ui.chatMessages = log;
    H.ui.callbacks.onChatLine = (l: string) => sniffed.push(l);
  });
  afterAll(() => H.teardown());

  it('a hidden line is not shown but still reaches onChatLine (the combat tracker sees evades)', () => {
    const m = runtime();
    m.on('Filters.AttackEvades');
    H.ui.setMagTools(m.rt);
    H.ui.addSystemMessage('Drudge Skulker evaded your attack.', '#fff', ChatMessageType.CombatSelf);
    H.ui.addSystemMessage('You hit the Drudge Skulker for 10 points of slashing damage!', '#fff', ChatMessageType.CombatSelf);
    H.ui.addChatMessage('Bob', 'Drudge Skulker evaded your attack.');
    expect(log.textContent).not.toContain('evaded');
    expect(log.textContent).toContain('You hit the Drudge');
    expect(sniffed).toContain('Drudge Skulker evaded your attack.');
    expect(sniffed).toContain('Bob: Drudge Skulker evaded your attack.');
  });

  it('passes the speech info through addSystemMessage', () => {
    const m = runtime();
    m.on('Filters.VendorTells');
    H.ui.setMagTools(m.rt);
    H.ui.addSystemMessage('Jonathan tells you, "Buy now"', '#fff', ChatMessageType.Tell, 0, { kind: 'tell', sender: 'Jonathan', message: 'Buy now', senderClass: 'vendor' });
    H.ui.addSystemMessage('Bob tells you, "Buy now"', '#fff', ChatMessageType.Tell, 0, { kind: 'tell', sender: 'Bob', message: 'Buy now', senderClass: 'player' });
    expect(log.textContent).not.toContain('Jonathan');
    expect(log.textContent).toContain('Bob tells you');
  });

  it('the spew box drops filtered status text', () => {
    const m = runtime();
    m.on('Filters.StatusTextAll');
    H.ui.setMagTools(m.rt);
    const pushed: string[] = [];
    const real = H.ui.spewBox.push.bind(H.ui.spewBox);
    H.ui.spewBox.push = (text: string, now: number) => { pushed.push(text); return real(text, now); };
    H.ui.spewBoxEl = { isConnected: true, remove() {} };
    H.ui.refreshSpewBox = () => {};
    H.ui.spewNotice("You're too busy!");
    H.ui.setMagTools(null);
    H.ui.spewNotice("You're too busy!");
    expect(pushed).toEqual(["You're too busy!"]);
  });

  it('with preview UI off nothing is hidden', () => {
    const m = runtime();
    m.on('Filters.DefenseEvades');
    m.setEnabled(false);
    H.ui.setMagTools(m.rt);
    H.ui.addSystemMessage('You evaded the Mosswart!', '#fff', ChatMessageType.CombatEnemy);
    expect(log.textContent).toContain('You evaded the Mosswart!');
    H.ui.setMagTools(null);
  });
});

describe('the window shows the wired options', () => {
  it('filters, trade, login pack, log out on death; not the clipboard or left-click ident', () => {
    for (const p of ['Filters.SpellExpires', 'AutoTradeAdd.Enabled', 'AutoTradeAccept.Enabled', 'Misc.OpenMainPackOnLogin', 'Misc.LogOutOnDeath', 'ItemInfoOnIdent.Enabled']) expect(mtOptionWired({ path: p })).toBe(true);
    for (const p of ['ItemInfoOnIdent.AutoClipboard', 'ItemInfoOnIdent.LeftClickIdent', 'Looting.AutoLootChests', 'InventoryManagement.KeyRinger']) expect(mtOptionWired({ path: p })).toBe(false);
  });
});

describe('login, login complete and periodic commands', () => {
  it('runs the lists one per tick: /mt through the handler, the rest as typed chat; once per login', () => {
    const m = runtime();
    m.opts.set(mtCommandListKey('OnLoginCommands', { account: 'acct', server: 'Srv', character: 'Tester' }), JSON.stringify(['/say hi']));
    m.opts.set(mtCommandListKey('OnLoginCompleteCommands', { server: 'Srv' }), JSON.stringify(['/mt opt set Filters.SpellExpires true']));
    m.rt.loggedIn();
    m.rt.tick(); // the placeholder frame
    expect(m.sent).toEqual([]);
    m.rt.tick();
    expect(m.sent).toEqual(['/say hi']);
    m.rt.loginComplete();
    m.rt.tick(); m.rt.tick();
    expect(m.rt.options.bool('Filters.SpellExpires')).toBe(true);
    // Open Main Pack On Login (default on): use yourself.
    expect(m.g.calls).toContain('use 5001');
    // A teleport's LoginComplete doesn't fire it again.
    m.g.calls.length = 0;
    m.rt.loginComplete();
    expect(m.g.calls).toEqual([]);
  });

  it('periodic commands run on the minute after Login Complete', () => {
    const m = runtime();
    m.opts.set(mtCommandListKey('PeriodicCommands', { account: 'acct', server: 'Srv', character: 'Tester' }), JSON.stringify([{ command: '/hp', interval: 1, offset: 0 }]));
    m.rt.loggedIn();
    m.rt.loginComplete();
    m.advance(20000);
    m.rt.tick(); m.rt.tick(); m.rt.tick();
    expect(m.sent).toContain('/hp');
  });

  it('nothing runs with preview UI off', () => {
    const m = runtime();
    m.opts.set(mtCommandListKey('OnLoginCommands', { server: 'Srv' }), JSON.stringify(['/say hi']));
    m.setEnabled(false);
    m.rt.loggedIn(); m.rt.loginComplete();
    for (let i = 0; i < 4; i++) m.rt.tick();
    expect(m.sent).toEqual([]);
    expect(m.g.calls).toEqual([]);
  });
});

describe('log out on death', () => {
  it('logs out only with the option on', () => {
    const m = runtime();
    m.rt.died();
    expect(m.g.calls).toEqual([]);
    m.on('Misc.LogOutOnDeath');
    m.rt.died();
    expect(m.g.calls).toEqual(['logout']);
  });
});

describe('one-touch heal', () => {
  it('applies the kit to yourself when the chance is good, else eats healing food', () => {
    const m = runtime();
    m.g.state.slots = [
      { guid: 0x10, name: 'Healing Kit', packSlot: 0, stack: 1, maxStack: 1, isPack: false, equipped: false, cls: { itemType: 0x80, flags: 0x10000 }, props: { 90: 10, 92: 5 } },
      { guid: 0x11, name: 'Healing Elixir... Meat Pie', packSlot: 0, stack: 1, maxStack: 1, isPack: false, equipped: false, cls: { itemType: 0x20, flags: 0 } },
    ];
    expect(m.rt.oneTouchHeal()).toEqual([]);
    expect(m.g.calls).toEqual(['useOn 10 5001']);
    m.g.calls.length = 0;
    m.g.state.me.health = { cur: 10, max: 100 }; // required 180 > 130: the food
    m.rt.oneTouchHeal();
    expect(m.g.calls).toEqual(['use 11']);
  });

  it('is listed as a hotkey with Pack Inventory (Ctrl+P), only with preview UI', () => {
    const m = runtime();
    const keys = m.rt.hotkeys();
    expect(keys.map((k) => [k.name, k.defaultCode])).toEqual([['Pack Inventory', 'Ctrl+KeyP'], ['One Touch Heal', null]]);
    const win = { source: { pluginHotkeys: () => m.rt.hotkeys(), tools: undefined }, metaStates: () => [], vvsWindows: () => [], hotkeys: { vvs: [] }, ubNetAvailable: () => false } as unknown as VTankWindow;
    expect(vtankHotkeys(win).filter((h) => h.plugin === 'Mag-Tools').map((h) => h.id)).toEqual(['Mag-Tools/Pack Inventory', 'Mag-Tools/One Touch Heal']);
    m.setEnabled(false);
    expect(m.rt.hotkeys()).toEqual([]);
  });
});

describe('auto trade add / accept', () => {
  it('adds the partner profile\'s Keep items when I opened the trade, then prints the done line', () => {
    const m = runtime();
    m.on('AutoTradeAdd.Enabled');
    m.setSets({ 'Mule.utl': [keep('Pyreal'), keepUpTo('Scarab', 1)] });
    m.g.state.slots = [
      { guid: 0x20, name: 'Pyreal', packSlot: 0, stack: 10, maxStack: 25000, isPack: false, equipped: false },
      { guid: 0x21, name: 'Scarab', packSlot: 0, stack: 1, maxStack: 1, isPack: false, equipped: false },
    ];
    m.rt.tradeOpened({ initiatorGuid: 0x5001, partnerGuid: 0x6001, partner: 'Mule' });
    for (let i = 0; i < 3; i++) m.rt.tick();
    expect(m.g.calls).toEqual(['trade add 20']);
    expect(m.printed).toContain('<{Mag-Tools}>: Auto Add To Trade - Inventory scan complete.');
  });

  it('does nothing when the partner opened the trade', () => {
    const m = runtime();
    m.on('AutoTradeAdd.Enabled');
    m.setSets({ Mule: [keep('Pyreal')] });
    m.g.state.slots = [{ guid: 0x20, name: 'Pyreal', packSlot: 0, stack: 10, maxStack: 25000, isPack: false, equipped: false }];
    m.rt.tradeOpened({ initiatorGuid: 0x6001, partnerGuid: 0x6001, partner: 'Mule' });
    m.rt.tick();
    expect(m.g.calls).toEqual([]);
  });

  it('accepts a whitelisted partner\'s Accept, not mine nor a stranger\'s', () => {
    const m = runtime();
    m.on('AutoTradeAccept.Enabled');
    m.opts.set(MT_TRADE_WHITELIST_KEY, JSON.stringify(['Mule|Bank']));
    m.rt.tradeOpened({ initiatorGuid: 0x6001, partnerGuid: 0x6001, partner: 'Mule' });
    m.rt.tradeAcceptedBy(0x5001);
    expect(m.g.calls).toEqual([]);
    m.rt.tradeAcceptedBy(0x6001);
    expect(m.g.calls).toEqual(['trade accept']);
    m.rt.tradeClosed();
    m.rt.tradeOpened({ initiatorGuid: 0x6002, partnerGuid: 0x6002, partner: 'Stranger' });
    m.advance(5000);
    m.rt.tradeAcceptedBy(0x6002);
    expect(m.g.calls).toEqual(['trade accept']);
  });
});

describe('Autopack', () => {
  const setup = () => {
    const m = runtime();
    m.setSets({ 'Tester.AutoPack': [keepUpTo('Mana Stone', 1)] });
    m.g.state.slots = [
      { guid: 0x30, name: 'Mana Stone', packSlot: 0, stack: 1, maxStack: 1, isPack: false, equipped: false },
      { guid: 0x7001, name: 'Pack', packSlot: 0, stack: 1, maxStack: 1, isPack: true, equipped: false },
    ];
    return m;
  };

  it('/mt autopack moves Keep # items to their pack and reports start and end', () => {
    const m = setup();
    expect(m.rt.chat('/mt autopack')).toBe(true);
    expect(m.printed).toEqual(['<{Mag-Tools}>: Auto Pack - Started.']);
    m.rt.tick();
    expect(m.g.calls).toEqual(['place 30 {"packSlot":1}']);
    m.g.state.slots[0]!.packSlot = 1; // the server moved it
    m.rt.tick();
    expect(m.printed).toEqual(['<{Mag-Tools}>: Auto Pack - Started.', '<{Mag-Tools}>: Auto Pack - Completed.']);
    expect(m.rt.autopacker.running).toBe(false);
  });

  it('a tell with "<me> autopack" starts it and is hidden; a say is not', () => {
    const m = setup();
    expect(m.rt.filterChat({ text: 'Alt tells you, "tester autopack"', type: ChatMessageType.Tell, speech: { kind: 'tell', sender: 'Alt', message: 'tester autopack' } })).toBe(true);
    expect(m.rt.autopacker.running).toBe(true);
    m.rt.autopacker.stop();
    expect(m.rt.filterChat({ text: 'Alt says, "tester autopack"', type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'Alt', message: 'tester autopack' } })).toBe(false);
    expect(m.rt.autopacker.running).toBe(false);
  });

  it('without a profile it stays silent; the tidy\'s placement names the placed items', () => {
    const m = setup();
    expect(m.rt.autopackPlacement()).toEqual(new Map([[0x30, [1]]]));
    m.setSets(null);
    expect(m.rt.chat('/mt autopack')).toBe(true);
    expect(m.printed).toEqual([]);
    expect(m.rt.autopackPlacement().size).toBe(0);
  });

  it('the Default.AutoPack profile is the fallback; it waits while the tidy has a move out', () => {
    let busy = true;
    const m = runtime({ tidyBusy: () => busy });
    m.setSets({ 'Default.AutoPack': [keepUpTo('Mana Stone', 1)] });
    m.g.state.slots = [{ guid: 0x30, name: 'Mana Stone', packSlot: 0, stack: 1, maxStack: 1, isPack: false, equipped: false }];
    expect(m.rt.startAutopack()).toBe(true);
    m.rt.tick();
    expect(m.g.calls).toEqual([]);
    busy = false;
    m.rt.tick();
    expect(m.g.calls).toEqual(['place 30 {"packSlot":1}']);
  });
});

describe('trackers, chat logger and Tools tab', () => {
  const world = new Map<number, { name: string; objectClass: number; cell: number; x: number; y: number; z: number; burden?: number }>();
  const withWorld = () => runtime({ object: (g) => world.get(g) ?? null });

  it('tracks my corpse on create, appraises a heavy one and tracks it when it names me, and drops it when opened', () => {
    world.clear();
    world.set(0x80, { name: 'Corpse of Tester', objectClass: 27, cell: 0xa9b40001, x: 10, y: 10, z: 0 });
    world.set(0x81, { name: 'Corpse of Drudge Skulker', objectClass: 27, cell: 0xa9b40001, x: 20, y: 10, z: 0, burden: 7000 });
    const m = withWorld();
    m.rt.loggedIn();
    m.rt.objectSeen(0x80);
    m.rt.objectSeen(0x81);
    expect(m.g.calls).toContain('appraise 81');
    m.rt.objectAppraised(0x81, 'Killed by Tester.');
    expect(m.rt.corpses.list().map((c) => c.id)).toEqual([0x81, 0x80]);
    m.rt.containerOpened(0x81);
    m.rt.objectReleased(0x80, 50); // out of view far away: not a decay
    expect(m.rt.corpses.list().map((c) => c.id)).toEqual([0x80]);
    m.rt.objectReleased(0x80, 3);
    expect(m.rt.corpses.list()).toEqual([]);
  });

  it('tracks other players once the option is on, and keeps them across a login when persistent', () => {
    world.clear();
    world.set(0x50000002, { name: 'Bob', objectClass: 24, cell: 0xa9b40001, x: 1, y: 2, z: 0 });
    const m = withWorld();
    m.rt.objectSeen(0x50000002);
    expect(m.rt.players.list()).toEqual([]);
    m.on('PlayerTracker.Enabled');
    m.on('PlayerTracker.Persistent');
    m.rt.objectSeen(0x50000002);
    m.rt.loggedOut();
    m.rt.loggedIn();
    expect(m.rt.players.list().map((p) => p.name)).toEqual(['Bob']);
  });

  it('the chat logger records a player\'s tell from the chat path, not an NPC\'s', () => {
    const m = runtime();
    m.rt.filterChat({ text: 'Bob tells you, "hi"', type: ChatMessageType.Tell, speech: { kind: 'tell', sender: 'Bob', message: 'hi', senderClass: 'player' } });
    m.rt.filterChat({ text: 'Jonathan tells you, "buy"', type: ChatMessageType.Tell, speech: { kind: 'tell', sender: 'Jonathan', message: 'buy', senderClass: 'vendor' } });
    expect(m.rt.chatLogger.lines(1).map((l) => l.text)).toEqual(['Bob tells you, "hi"']);
    expect(m.rt.chatLogFileName()).toBe('Tester.ChatLogger.txt');
  });

  it('skips spell incantations using the era\'s power words', () => {
    const m = runtime({ spellWords: () => new Set(['Zojak']) });
    m.rt.chatLogger.setEnabled(1, 'Area', true);
    m.rt.filterChat({ text: 'Bob says, "Zojak Quaril"', type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'Bob', message: 'Zojak Quaril', senderClass: 'player' } });
    m.rt.filterChat({ text: 'Bob says, "hello"', type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'Bob', message: 'hello', senderClass: 'player' } });
    expect(m.rt.chatLogger.lines(1).map((l) => l.text)).toEqual(['Bob says, "hello"']);
  });

  it('Inv. Items updates from the tick when the inventory changes', () => {
    const m = runtime({ itemDetails: () => ({ value: 1000, stackSize: 1 }) });
    m.g.state.slots = [{ guid: 0x40, name: 'Trade Note', packSlot: 0, stack: 1, maxStack: 100, isPack: false, equipped: false }];
    let updates = 0;
    const real = m.rt.inventoryTracker.update.bind(m.rt.inventoryTracker);
    m.rt.inventoryTracker.update = (items, t) => { updates++; real(items, t); };
    m.rt.tick();
    m.advance(1000); m.rt.tick();
    expect(updates).toBe(1);
    m.g.state.slots.push({ guid: 0x41, name: 'Pyreal', packSlot: 0, stack: 5, maxStack: 25000, isPack: false, equipped: false });
    m.advance(1000); m.rt.tick();
    expect(updates).toBe(2);
  });

  it('Tools → Character / Server edit the same lists the login scheduler runs', () => {
    const m = runtime();
    const scope = m.rt.characterScope()!;
    expect(scope).toEqual({ account: 'acct', server: 'Srv', character: 'Tester' });
    m.rt.commandLists.add('OnLoginCommands', scope, '/say from the editor');
    m.rt.commandLists.add('OnLoginCommands', m.rt.serverScope()!, '/say server wide');
    m.rt.loggedIn();
    for (let i = 0; i < 4; i++) m.rt.tick();
    expect(m.sent).toEqual(['/say from the editor', '/say server wide']);
  });

  it('Tools → Inventory lists items with their info, selects (opening a side pack), and copies via the clipboard', async () => {
    let clip = '';
    const m = runtime({ writeClipboard: async (t) => { clip = t; } });
    m.g.state.slots = [{ guid: 0x60, name: 'Round Shield', packSlot: 0, stack: 1, maxStack: 1, isPack: false, equipped: false, cls: { itemType: 2, flags: 0 }, props: { 28: 20 } }];
    expect(m.rt.inventoryToolItems()).toEqual([{ id: 0x60, name: 'Round Shield', info: 'Round Shield' }]);
    m.rt.selectInventoryItem(0x60);
    expect(m.g.calls).toContain('select 60');
    const appraised = runtime({ writeClipboard: async (t) => { clip = t; }, appraisal: () => ({ guid: 0x60, int: { 28: 20 }, float: {}, bool: {}, string: {}, did: {}, spellIds: [], activeSpellIds: [] }) });
    appraised.g.state.slots = m.g.state.slots;
    await appraised.rt.copyInventory('inventory');
    expect(clip).toContain('Round Shield');
    expect(appraised.printed.at(-1)).toBe('<{Mag-Tools}>: All inventory item info has been copied to the clipboard.');
  });

  it('the window draws the new tabs from the runtime\'s sources, and shows their options', () => {
    expect(['CorpseTracker.Enabled', 'CorpseTracker.TrackFellowCorpses', 'PlayerTracker.Persistent', 'ChatLogger.Persistent'].every((p) => mtOptionWired({ path: p }))).toBe(true);
    const m = runtime();
    expect(m.rt.corpses.tracksFellows).toBe(true);
    expect(m.rt.corpses.tracksPermitted).toBe(false);
    expect(typeof MagToolsWindow).toBe('function');
  });

  it('with preview UI off the trackers and logger see nothing', () => {
    world.clear();
    world.set(0x80, { name: 'Corpse of Tester', objectClass: 27, cell: 0xa9b40001, x: 10, y: 10, z: 0 });
    const m = withWorld();
    m.setEnabled(false);
    m.rt.objectSeen(0x80);
    m.rt.filterChat({ text: 'Bob tells you, "hi"', type: ChatMessageType.Tell, speech: { kind: 'tell', sender: 'Bob', message: 'hi', senderClass: 'player' } });
    expect(m.rt.corpses.list()).toEqual([]);
    expect(m.rt.chatLogger.lines(1)).toEqual([]);
  });
});

describe('GameUI hands the window the runtime\'s sources', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('opens the Mag-Tools window with Loggers and Tools tabs', () => {
    const m = runtime();
    H.ui.setMagTools(m.rt);
    H.ui.toggleMagToolsWindow();
    const el = H.ui.vtankWindows.get('magtools')?.el as HTMLElement | undefined;
    expect(el).toBeTruthy();
    const tops = [...el!.querySelectorAll<HTMLElement>('[data-mt-level="top"]')].map((e) => e.dataset.mtTab!.trim());
    expect(tops).toEqual(expect.arrayContaining(['Trackers', 'Loggers', 'Tools', 'Misc']));
    H.ui.toggleMagToolsWindow();
    H.ui.setMagTools(null);
  });

  it('Misc → Options\' whitelist editor feeds Auto Trade Accept: a partner added there is accepted', () => {
    const m = runtime();
    m.on('AutoTradeAccept.Enabled');
    H.ui.setMagTools(m.rt);
    H.ui.toggleMagToolsWindow();
    const el = () => H.ui.vtankWindows.get('magtools')!.el as HTMLElement;
    el().querySelector<HTMLElement>('[data-mt-tab="   Misc   "]')!.click();
    const type = (v: string) => { const f = el().querySelector<HTMLInputElement>('input[name="AutoTradeAcceptWhitelistText"]')!; f.value = v; f.dispatchEvent(new Event('input')); };
    const add = () => el().querySelector<HTMLElement>('[data-mt-page="misc/options"] [data-mt-button="Add"]')!.click();
    type('Mule.*');
    add();
    type('Bad[');
    add();
    expect(m.rt.tradeWhitelist()).toEqual(['Mule.*']);
    expect(m.printed).toContain('<{Mag-Tools}>: Auto Trade Accept - "Bad[" is not a valid regular expression.');
    const rows = [...el().querySelectorAll<HTMLElement>('[data-mt-list="AutoTradeAcceptWhitelist"] [data-mt-row]')];
    expect(rows.map((r) => r.querySelector<HTMLElement>('[data-mt-cell="0"]')!.dataset.text)).toEqual(['Mule.*']);
    // The trade path reads what the editor wrote.
    m.rt.tradeOpened({ initiatorGuid: 0x6001, partnerGuid: 0x6001, partner: 'Mule Two' });
    m.rt.tradeAcceptedBy(0x6001);
    expect(m.g.calls).toEqual(['trade accept']);
    // The delete icon takes it out again: the next partner's Accept isn't answered.
    rows[0]!.querySelector<HTMLElement>('[data-mt-cell="1"] [data-icon]')!.click();
    expect(m.rt.tradeWhitelist()).toEqual([]);
    m.rt.tradeClosed();
    m.advance(5000);
    m.rt.tradeOpened({ initiatorGuid: 0x6001, partnerGuid: 0x6001, partner: 'Mule Two' });
    m.rt.tradeAcceptedBy(0x6001);
    expect(m.g.calls).toEqual(['trade accept']);
    H.ui.toggleMagToolsWindow();
    H.ui.setMagTools(null);
  });
});
