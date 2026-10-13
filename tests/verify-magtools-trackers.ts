// @vitest-environment happy-dom
/**
 * Mag-Tools' remaining trackers, loggers and Tools tab (docs/plugin-specs/magtools.md §2.3–2.5, §5.3–5.5,
 * §6.1, §7.1, §7.3): the real @ac/shared models fed injected snapshots and events, and the real
 * MagToolsWindow drawing them through a fake VVS kit.
 */
import { describe, expect, it } from 'vitest';
import {
  ChatMessageType, MtChatLogger, MtCombatTracker, MtCommandLists, MtCorpseTracker, MtInventoryTracker, MtManaTracker,
  MtObjectClass, MtOptions, MtPlayerTracker, MtValueSeries, MT_COPY_DONE, MT_COPY_START, MT_INVENTORY_SEARCH_HINT,
  mtChatChannel, mtChatLogFileLine, mtCleanChat, mtCommandListKey, mtCoordsText, mtCopyInventoryInfo, mtDateTime, mtDayTime,
  mtFileStamp, mtInventoryExportOrder, mtInventorySearch, mtIsIncantation, mtLine, mtParseChatLog,
  type MtInvItem, type MtInventoryExportItem, type MtOptionStorage, type MtTextStore,
} from '@ac/shared';
import { MagToolsWindow, MT_EXPORT_LOG_LABEL, type MagToolsHost } from '../packages/renderer/src/ui/magtools/MagToolsWindow.ts';
import type { VTankKit } from '../packages/renderer/src/ui/automation/VTankWindow.ts';

const ME = 'Hero';
const MIN = 60_000;
const T0 = new Date(2026, 9, 10, 14, 5, 0).getTime();

function memStore(): MtOptionStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k), set: (k, v) => { map.set(k, v); } };
}
function textStore(): MtTextStore & { value: string | null; removed: number } {
  const s = { value: null as string | null, removed: 0, get: () => s.value, set: (v: string) => { s.value = v; }, remove: () => { s.value = null; s.removed++; } };
  return s;
}

function fakeKit(): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', onClick); return d; };
  return {
    text: (t: string) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    textTab: (label: string, on: boolean, onClick: () => void) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    flatButton: (label: string, onClick: () => void) => div({ button: label }, onClick),
    check: (on: boolean, onChange: (v: boolean) => void) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    input: (value: string, _w: number, onChange: (v: string) => void) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (_sel: boolean, onClick?: () => void) => div({ row: '1' }, onClick),
    icon: (id: number, _s: number, onClick?: () => void) => div({ icon: String(id) }, onClick),
    list: () => {},
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
  } as unknown as VTankKit;
}

// ── Inv. Items (§5.5) ──

const inv = (name: string, objectClass: number, stackSize: number, value: number, icon?: number): MtInvItem =>
  ({ id: name.length * 7919 + value, name, objectClass, stackSize, value, ...(icon !== undefined ? { icon } : {}) });
function baseInventory(taper: number, pyreals: number): MtInvItem[] {
  return [
    inv('Lead Scarab', MtObjectClass.SpellComponent, 10, 500, 0x06001001),
    inv('Prismatic Taper', MtObjectClass.SpellComponent, taper, taper * 20, 0x06001002),
    inv('Hyssop', MtObjectClass.SpellComponent, 1, 300),
    inv('Copper Pea', MtObjectClass.SpellComponent, 1, 1000),
    inv('Mana Stone', MtObjectClass.ManaStone, 1, 100, 0x06001003),
    inv('Healing Kit', MtObjectClass.HealingKit, 1, 50, 0x06001004),
    inv('Pyreal', MtObjectClass.Money, pyreals, pyreals),
    inv('Salvaged Iron', MtObjectClass.Salvage, 1, 2000, 0x06001005),
    inv('Trade Note (250,000)', MtObjectClass.TradeNote, 1, 250_000, 0x06001006),
    inv('Lesser Corrupted Essence', MtObjectClass.Misc, 1, 10, 0x06001007),
    inv('Iron Sword', MtObjectClass.MeleeWeapon, 1, 9999),
  ];
}
function invTracker() {
  let now = T0;
  const t = new MtInventoryTracker(() => now);
  t.update(baseInventory(100, 5000));
  now = T0 + 55 * MIN; t.update(baseInventory(90, 255_000));
  now = T0 + 58 * MIN; t.update(baseInventory(85, 255_000));
  now = T0 + 60 * MIN;
  return { t, setNow: (v: number) => { now = v; } };
}

describe('Mag-Tools Inv. Items tracker (spec §5.5)', () => {
  it('rates against the snapshot nearest 5 min / 1 h ago, and prunes past an hour', () => {
    const s = new MtValueSeries();
    s.add(0, 100); s.add(55 * MIN, 90); s.add(58 * MIN, 85);
    expect(s.perHour(60 * MIN, 60 * MIN)).toBeCloseTo(-15);
    expect(s.perHour(60 * MIN, 5 * MIN)).toBeCloseTo(-60);
    expect(new MtValueSeries().perHour(0, 5 * MIN)).toBe(0);
    const p = new MtValueSeries();
    for (let m = 0; m <= 180; m++) p.add(m * MIN, m);
    expect(p.size).toBeLessThanOrEqual(62);
    expect(p.perHour(180 * MIN, 60 * MIN)).toBeCloseTo(60);
  });

  it('lays out the profit rows and the consumables, row for row', () => {
    const { t } = invTracker();
    const rows = t.rows();
    expect(rows.slice(0, 7).map((r) => r.cells)).toEqual([
      ['', '', 'MMD/h ~5m', 'MMD/h ~1h', ''],
      ['Peas', '', '', '', ''],
      // Comps: −300 pyreals over the hour (the tapers) = −0.0012 MMD/h; over 5 min −100 → −1200/h.
      ['Comps', '', '-0.0', '-0.0', ''],
      ['Salvage', '', '', '', ''],
      // +250,000 pyreals − 300 of tapers over 60 min ≈ 1.0 MMD/h.
      ['Net Profit', '', '-0.0', '1.0', ''],
      ['', '', '', '', ''],
      ['', 'Count', 'Avg/h ~5m', 'Avg/h ~1h', '(Hrs)'],
    ]);
    // Class order, and within the comps the higher per-unit value first (scarab 50 > taper 20). Hyssop and the pea aren't tracked.
    expect(rows.slice(7).map((r) => r.group)).toEqual(['Lead Scarab', 'Prismatic Taper', 'Mana Stone', 'Healing Kit', 'Trade Note', 'Salvage', 'Corrupted Essence']);
    expect(rows[7]!.cells).toEqual(['Lead Scarab', '10', '0.0', '0.0', '']);
    // 85 tapers burning 15/h over the hour: 5.7 h left; 60/h over the last 5 min.
    expect(rows[8]!.cells).toEqual(['Prismatic Taper', '85', '-60.0', '-15.0', '5.7']);
    expect(rows[8]!.icon).toBe(0x06001002);
  });

  it('keeps a group at 0 with blank cells once it runs out; reset starts over', () => {
    const { t, setNow } = invTracker();
    setNow(T0 + 61 * MIN);
    t.update(baseInventory(85, 255_000).filter((i) => i.name !== 'Lead Scarab'));
    const scarab = t.rows().find((r) => r.group === 'Lead Scarab')!;
    expect(scarab.cells).toEqual(['Lead Scarab', '', '', '', '']);
    t.reset();
    expect(t.rows()).toHaveLength(7);
  });
});

// ── Corpse and Player (§5.3, §5.4) ──

const HOLT = 0xa9b40019;
function corpses(extra: Partial<ConstructorParameters<typeof MtCorpseTracker>[0]> = {}) {
  let now = T0;
  const settings = memStore();
  const options = new MtOptions(settings);
  const store = textStore();
  const t = new MtCorpseTracker({ me: () => ME, options, now: () => now, store: () => store, ...extra });
  return { t, options, store, settings, setNow: (v: number) => { now = v; } };
}
const corpse = (id: number, name: string, more: Partial<Parameters<MtCorpseTracker['seen']>[0]> = {}) =>
  ({ id, name, cell: HOLT, x: 84, y: 84, z: 0, appraised: false, ...more });

describe('Mag-Tools formats (spec §5.3, §5.4, §6.1)', () => {
  it('prints times and coords the way the lists do', () => {
    const d = new Date(2000, 0, 1, 14, 5, 9).getTime(); // a Saturday
    expect(mtDayTime(d)).toBe('Sat 14:05');
    expect(mtDateTime(d)).toBe('00/01/01 14:05');
    expect(mtFileStamp(d)).toBe('000101140509');
    // lbX 0xA9, lbY 0xB4: NS = (53 × 192 + 84 − 84) / 240 = 42.4; EW = (42 × 192) / 240 = 33.6.
    expect(mtCoordsText(HOLT, 84, 84)).toBe('42.4N, 33.6E');
    expect(mtCoordsText(0x10100001, 0, 0)).toMatch(/S, .*W$/);
  });
});

describe('Mag-Tools corpse tracker (spec §5.3)', () => {
  it('tracks my corpses, and kills of mine once an appraisal says so', () => {
    const c = corpses();
    expect(c.t.seen(corpse(1, `Corpse of ${ME}`))).toBeNull();
    expect(c.t.seen(corpse(2, 'Corpse of Drudge Skulker', { burden: 100 }))).toBeNull();
    // Heavy: ask for the appraisal, then read "Killed by <me>."
    expect(c.t.seen(corpse(3, 'Corpse of Banderling', { burden: 7000 }))).toBe('appraise');
    expect(c.t.seen(corpse(3, 'Corpse of Banderling', { burden: 7000, appraised: true, longDesc: `Killed by ${ME}.` }))).toBeNull();
    expect(c.t.seen(corpse(4, 'Corpse of Mosswart', { burden: 7000, appraised: true, longDesc: 'Killed by Someone.' }))).toBeNull();
    expect(c.t.list().map((e) => [e.id, e.mine])).toEqual([[3, false], [1, true]]);
    expect(c.t.rows()[0]!.cells).toEqual([mtDayTime(T0), 'Corpse of Banderling', '42.4N, 33.6E', '3']);
  });

  it('a reused id elsewhere replaces the entry; opening or a near release removes it', () => {
    const c = corpses();
    c.t.seen(corpse(1, `Corpse of ${ME}`));
    c.t.seen(corpse(1, `Corpse of ${ME}`, { x: 84.5 }));
    expect(c.t.list()).toHaveLength(1);
    c.t.seen(corpse(1, `Corpse of ${ME}`, { x: 120 }));
    expect(c.t.list().map((e) => e.x)).toEqual([120]);
    c.t.released(1, 25);
    expect(c.t.list()).toHaveLength(1);
    c.t.released(1, 5);
    expect(c.t.list()).toHaveLength(0);
    c.t.seen(corpse(2, `Corpse of ${ME}`));
    c.t.opened(2);
    expect(c.t.list()).toHaveLength(0);
  });

  it('expires others after 2 hours and mine after 7 days', () => {
    const c = corpses();
    c.options.set('CorpseTracker.TrackAllCorpses', true);
    c.t.seen(corpse(1, `Corpse of ${ME}`));
    c.t.seen(corpse(2, 'Corpse of Drudge'));
    c.setNow(T0 + 2 * 3600_000 + 1);
    expect(c.t.list().map((e) => e.id)).toEqual([1]);
    c.setNow(T0 + 7 * 24 * 3600_000 + 1);
    expect(c.t.list()).toHaveLength(0);
  });

  it('fellow and permitted corpses work when the host gives the reads; Enabled off tracks nothing', () => {
    const none = corpses();
    expect([none.t.tracksFellows, none.t.tracksPermitted]).toEqual([false, false]);
    const c = corpses({ fellows: () => [ME, 'Ally'], permittedBy: () => ['Friend'] });
    expect([c.t.tracksFellows, c.t.tracksPermitted]).toEqual([true, true]);
    c.t.seen(corpse(1, 'Corpse of Ally'));
    c.t.seen(corpse(2, 'Corpse of Friend')); // Track Permitted Corpses defaults on
    expect(c.t.list().map((e) => e.id)).toEqual([2]);
    c.options.set('CorpseTracker.TrackFellowCorpses', true);
    c.t.seen(corpse(1, 'Corpse of Ally'));
    expect(c.t.list().map((e) => e.id)).toEqual([1, 2]);
    c.options.set('CorpseTracker.Enabled', false);
    c.t.seen(corpse(9, `Corpse of ${ME}`));
    expect(c.t.list()).toHaveLength(2);
  });

  it('keeps the list in the store while Keep Persistent Stats is on; Clear History drops both', () => {
    const c = corpses();
    c.t.seen(corpse(1, `Corpse of ${ME}`));
    expect(c.store.value).toContain(`Corpse of ${ME}`);
    const again = new MtCorpseTracker({ me: () => ME, options: c.options, now: () => T0 + MIN, store: () => c.store });
    again.load();
    expect(again.list().map((e) => e.id)).toEqual([1]);
    again.clear();
    expect([again.list().length, c.store.value, c.store.removed]).toEqual([0, null, 1]);
    // Persistence off: nothing written.
    const d = corpses();
    d.options.set('CorpseTracker.Persistent', false);
    d.t.seen(corpse(1, `Corpse of ${ME}`));
    expect(d.store.value).toBeNull();
  });
});

describe('Mag-Tools player tracker (spec §5.4)', () => {
  it('upserts other players by name when enabled; newest first, ties by name', () => {
    let now = T0;
    const settings = memStore();
    const options = new MtOptions(settings);
    const store = textStore();
    const t = new MtPlayerTracker({ me: () => ME, options, now: () => now, store: () => store });
    const p = (id: number, name: string) => ({ id, name, cell: HOLT, x: 84, y: 84, z: 0 });
    t.seen(p(1, 'Bob'));
    expect(t.list()).toHaveLength(0); // Player Tracker Enabled defaults off
    options.set('PlayerTracker.Enabled', true);
    t.seen(p(1, 'Bob')); t.seen(p(2, 'Alice')); t.seen(p(3, ME));
    now += MIN;
    t.seen(p(5, 'Carl'));
    expect(t.rows().map((r) => r.cells)).toEqual([
      [mtDateTime(T0 + MIN), 'Carl', '42.4N, 33.6E', '5'],
      [mtDateTime(T0), 'Alice', '42.4N, 33.6E', '2'],
      [mtDateTime(T0), 'Bob', '42.4N, 33.6E', '1'],
    ]);
    now += MIN;
    t.seen(p(11, 'Bob'));
    expect(t.list()[0]).toMatchObject({ name: 'Bob', id: 11 });
    // Keep Persistent Stats defaults off: nothing stored; on, flush writes.
    t.flush();
    expect(store.value).toBeNull();
    options.set('PlayerTracker.Persistent', true);
    t.seen(p(11, 'Bob'));
    t.flush();
    const again = new MtPlayerTracker({ me: () => ME, options, store: () => store });
    again.load();
    expect(again.list().map((e) => e.name)).toEqual(['Bob', 'Carl', 'Alice']);
    again.clear();
    expect(store.value).toBeNull();
  });
});

// ── Chat logger (§6.1) ──

describe('Mag-Tools chat logger (spec §6.1)', () => {
  const words = new Set(['Zojak', 'Malar']);
  const incant = (t: string) => mtIsIncantation(t, words);

  it('classifies players\' tells, says and channel lines; NPC speech and incantations stay out', () => {
    const ch = (text: string, type: number, fromPlayer = true) => mtChatChannel({ text, type, fromPlayer }, incant);
    expect(ch('Bob tells you, "hi"', ChatMessageType.Tell)).toBe('Tells');
    expect(ch('You tell Bob, "hi"', ChatMessageType.OutgoingTell)).toBe('Tells');
    expect(ch('Town Crier tells you, "hi"', ChatMessageType.Tell, false)).toBeNull();
    expect(ch('Bob says, "hello"', ChatMessageType.Speech)).toBe('Area');
    expect(ch('You say, "Zojak Malar"', ChatMessageType.Speech)).toBeNull();
    expect(ch('Bob says, "Zojak Quasith"', ChatMessageType.Speech)).toBeNull();
    expect(ch('Guard says, "Halt"', ChatMessageType.Speech, false)).toBeNull();
    expect(ch('[General] Bob says, "anyone?"', ChatMessageType.Channel)).toBe('General');
    expect(ch('[Fellowship] You say, "pull"', ChatMessageType.Fellowship)).toBe('Fellowship');
    expect(ch('[LFG] Bob says, "lf1m"', ChatMessageType.Channel)).toBe('LFG');
    expect(ch('You gain 50 experience.', ChatMessageType.Advancement)).toBeNull();
    expect(mtCleanChat('<Tell:IIDString:123:Bob>Bob<\\Tell> tells you, "x"')).toBe('Bob tells you, "x"');
  });

  it('logs into the groups that pick the channel (Group 1 = Tells by default), and keeps the store when persistent', () => {
    let now = T0;
    const settings = memStore();
    const store = textStore();
    let persistent = true;
    const log = new MtChatLogger({ settings, persistent: () => persistent, store: () => store, now: () => now, isIncantation: incant });
    expect(log.add({ text: 'Bob tells you, "hi"', type: ChatMessageType.Tell, fromPlayer: true })).toBe('Tells');
    expect(log.add({ text: 'Bob says, "yo"', type: ChatMessageType.Speech, fromPlayer: true })).toBeNull();
    expect(log.rows(1)).toEqual([[mtDateTime(T0), 'Bob tells you, "hi"']]);
    expect(log.rows(2)).toEqual([]);
    log.setEnabled(2, 'Area', true);
    expect(settings.map.get('ChatLogger.Group2.Area')).toBe('True');
    now += MIN;
    log.add({ text: 'Bob says, "yo"', type: ChatMessageType.Speech, fromPlayer: true });
    expect(log.rows(2).map((r) => r[1])).toEqual(['Bob says, "yo"']);
    // The store holds the file's own lines.
    expect(store.value).toBe(`${mtFileStamp(T0)},2,Bob tells you, "hi"\n${mtFileStamp(T0 + MIN)},1,Bob says, "yo"\n`);
    expect(log.exportText()).toBe(store.value);
    expect(mtParseChatLog(store.value!).map((l) => [l.time, l.channel])).toEqual([[T0, 'Tells'], [T0 + MIN, 'Area']]);
    // At login the store reads back into both lists, newest on top.
    const again = new MtChatLogger({ settings, persistent: () => true, store: () => store });
    again.load();
    expect(again.rows(1).map((r) => r[1])).toEqual(['Bob tells you, "hi"']);
    expect(again.rows(2).map((r) => r[1])).toEqual(['Bob says, "yo"']);
    // Clear History: both lists and the stored log.
    again.clear();
    expect([again.rows(1).length, store.value, store.removed]).toEqual([0, null, 1]);
    // Not persistent: no store writes; export is this session's lines, oldest first.
    persistent = false;
    const s2 = textStore();
    const mem = new MtChatLogger({ settings, persistent: () => false, store: () => s2, now: () => now });
    mem.add({ text: 'Ann tells you, "a"', type: ChatMessageType.Tell, fromPlayer: true });
    now += MIN;
    mem.add({ text: 'Ann says, "b"', type: ChatMessageType.Speech, fromPlayer: true });
    expect(s2.value).toBeNull();
    expect(mem.exportText()).toBe(mtChatLogFileLine({ time: now - MIN, channel: 'Tells', text: 'Ann tells you, "a"' }) + mtChatLogFileLine({ time: now, channel: 'Area', text: 'Ann says, "b"' }));
  });

  it('trims a list past 10,000 rows to 9,000', () => {
    const log = new MtChatLogger({ settings: memStore(), persistent: () => false });
    for (let i = 0; i <= 10_000; i++) log.add({ text: `Bob tells you, "${i}"`, type: ChatMessageType.Tell, fromPlayer: true });
    expect(log.lines(1)).toHaveLength(9_000);
    expect(log.lines(1)[0]!.text).toBe('Bob tells you, "10000"');
  });
});

// ── Command lists (§7.3) and Tools → Inventory (§7.1) ──

describe('Mag-Tools command lists (spec §7.3)', () => {
  it('adds, reorders and removes, per account+server+character and per server', () => {
    const store = memStore();
    const l = new MtCommandLists(store);
    const char = { account: 'acct', server: 'Coldeve', character: ME };
    const server = { server: 'Coldeve' };
    expect(l.add('OnLoginCommands', char, '')).toBe(false);
    l.add('OnLoginCommands', char, '/mt fellow create Hunt');
    l.add('OnLoginCommands', char, '/hom');
    l.add('OnLoginCommands', server, '/ls');
    expect(JSON.parse(store.map.get(mtCommandListKey('OnLoginCommands', char))!)).toEqual(['/mt fellow create Hunt', '/hom']);
    expect(l.commands('OnLoginCommands', server)).toEqual(['/ls']);
    expect(l.moveUp('OnLoginCommands', char, 0)).toBe(false);
    l.moveUp('OnLoginCommands', char, 1);
    expect(l.commands('OnLoginCommands', char)).toEqual(['/hom', '/mt fellow create Hunt']);
    expect(l.moveDown('OnLoginCommands', char, 1)).toBe(false);
    l.moveDown('OnLoginCommands', char, 0);
    l.remove('OnLoginCommands', char, 1);
    expect(l.commands('OnLoginCommands', char)).toEqual(['/mt fellow create Hunt']);
    // Periodic: text, integer interval > 0, integer offset ≥ 0.
    expect(l.addPeriodic(char, '/say hi', '0', '0')).toBe(false);
    expect(l.addPeriodic(char, '/say hi', '5', '-1')).toBe(false);
    expect(l.addPeriodic(char, '/say hi', 'x', '0')).toBe(false);
    expect(l.addPeriodic(char, '', '5', '0')).toBe(false);
    expect(l.addPeriodic(char, '/say hi', '5', '2')).toBe(true);
    expect(l.periodic(char)).toEqual([{ command: '/say hi', interval: 5, offset: 2 }]);
    expect(l.periodic(server)).toEqual([]);
  });
});

describe('Mag-Tools Tools → Inventory (spec §7.1)', () => {
  it('searches item info as a case-insensitive regex', () => {
    const items = [{ id: 1, name: 'Helm', info: 'Helm, AL 200, Lore 100' }, { id: 2, name: 'Sword', info: 'Sword, 50/40, Imbued Crit' }];
    expect(mtInventorySearch(items, 'al 2\\d\\d').map((i) => i.id)).toEqual([1]);
    expect(mtInventorySearch(items, 'IMBUED').map((i) => i.id)).toEqual([2]);
    expect(mtInventorySearch(items, '[')).toEqual([]);
    expect(mtInventorySearch(items, MT_INVENTORY_SEARCH_HINT)).toEqual([]);
  });

  it('orders the export and copies after the appraisals; a refused clipboard becomes a download', async () => {
    const e = (id: number, more: Partial<MtInventoryExportItem>): MtInventoryExportItem =>
      ({ id, objectClass: MtObjectClass.Misc, info: `item ${id}`, appraised: true, equipped: false, pack: 0, slot: 0, ...more });
    const items = [
      e(1, { pack: 1, slot: 0 }), e(2, { pack: 0, slot: 3, container: true }), e(3, { pack: 0, slot: 1 }),
      e(4, { equipped: true, wieldedLocation: 0x200, objectClass: MtObjectClass.Armor, appraised: false }), e(5, { equipped: true, wieldedLocation: 0x1 }),
    ];
    expect(mtInventoryExportOrder(items).map((i) => i.id)).toEqual([5, 4, 3, 2, 1]);
    const printed: string[] = [];
    let appraised: number[] = [];
    let clip = '';
    await mtCopyInventoryInfo('worn', {
      items: () => items, appraise: async (ids) => { appraised = ids; }, writeClipboard: async (t) => { clip = t; }, print: (l) => printed.push(l),
    });
    expect(appraised).toEqual([4]);
    expect(clip).toBe('item 5\r\nitem 4');
    expect(printed).toEqual([mtLine(MT_COPY_START), mtLine(MT_COPY_DONE)]);
    const files: Array<[string, string]> = [];
    await mtCopyInventoryInfo('inventory', {
      items: () => items, appraise: async () => {}, writeClipboard: async () => { throw new Error('no gesture'); }, print: () => {}, download: (n, t) => files.push([n, t]),
    });
    expect(files).toEqual([['InventoryInfo.txt', 'item 3\r\nitem 2\r\nitem 1']]);
  });
});

// ── The window ──

function windowSetup(opts: { scopes?: boolean; download?: boolean; copy?: boolean } = {}) {
  const settings = memStore();
  const options = new MtOptions(settings);
  let now = T0;
  const corpseTracker = new MtCorpseTracker({ me: () => ME, options, now: () => now });
  const playerTracker = new MtPlayerTracker({ me: () => ME, options, now: () => now });
  const invT = new MtInventoryTracker(() => now);
  const logger = new MtChatLogger({ settings, persistent: () => false, now: () => now });
  const lists = new MtCommandLists(settings);
  const selected: number[] = [];
  const downloads: Array<[string, string]> = [];
  const copies: string[] = [];
  const invItems = [
    { id: 11, name: 'Bronze Helm', icon: 0x06003001, info: 'Bronze Helm, AL 150' },
    { id: 12, name: 'Iron Sword', icon: 0x06003002, info: 'Iron Sword, 20/10' },
  ];
  const body = document.createElement('div');
  let win!: MagToolsWindow;
  const host: MagToolsHost = {
    options,
    mana: new MtManaTracker({ worn: () => [], playerEnchantments: () => [], now: () => now }),
    combat: { current: new MtCombatTracker(() => ME, () => now), persistent: new MtCombatTracker(() => ME, () => now), clearPersistent: () => {} },
    corpses: { tracker: corpseTracker, select: (id) => selected.push(id) },
    players: { tracker: playerTracker, select: (id) => selected.push(id) },
    inventoryTracker: invT,
    chatLog: { logger, fileName: () => `${ME}.ChatLogger.txt`, ...(opts.download !== false ? { download: (n: string, t: string) => { downloads.push([n, t]); } } : {}) },
    inventory: { items: () => invItems, select: (id) => selected.push(id), ...(opts.copy !== false ? { copy: (w: 'worn' | 'inventory') => { copies.push(w); } } : {}) },
    commands: {
      lists,
      character: () => (opts.scopes === false ? null : { account: 'acct', server: 'Coldeve', character: ME }),
      server: () => (opts.scopes === false ? null : { server: 'Coldeve' }),
    },
    redraw: () => win.render(body),
  };
  win = new MagToolsWindow(fakeKit(), host);
  win.render(body);
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => body.querySelector<T>(sel);
  const click = (sel: string) => { const e = q(sel); if (!e) throw new Error(`no ${sel}`); e.click(); };
  const tabs = (level: string) => [...body.querySelectorAll<HTMLElement>(`[data-mt-level="${level}"]`)].map((e) => e.dataset.mtTab);
  const cells = (r: Element) => [...r.querySelectorAll<HTMLElement>('[data-mt-cell]')].map((c) => c.dataset.text);
  const listRows = (name: string) => [...body.querySelectorAll<HTMLElement>(`[data-mt-list="${name}"] [data-mt-row]`)];
  return { body, win, host, settings, options, corpseTracker, playerTracker, invT, logger, lists, selected, downloads, copies, q, click, tabs, cells, listRows, setNow: (v: number) => { now = v; } };
}

describe('Mag-Tools window: the new tabs (spec §2.3–2.5)', () => {
  it('draws every built notebook, labels exact; Tinkering and Client stay out', () => {
    const w = windowSetup();
    expect(w.tabs('top')).toEqual([' Trackers ', ' Loggers ', ' Tools ', '   Misc   ']);
    expect(w.tabs('trackers')).toEqual(['  Mana  ', ' Combat ', ' Corpse ', ' Player ', ' Inv. Items ']);
    w.click('[data-mt-tab=" Loggers "]');
    expect(w.tabs('loggers')).toEqual(['  Chat Group 1  ', '  Chat Group 2  ', '    Options    ']);
    w.click('[data-mt-tab=" Tools "]');
    expect(w.tabs('tools')).toEqual(['  Inventory  ', '  Character  ', '  Server  ']);
    expect(w.q('[data-mt-tab="  Tinkering  "]')).toBeNull();
    // Before login there's no scope: Character and Server go.
    const pre = windowSetup({ scopes: false });
    pre.click('[data-mt-tab=" Tools "]');
    expect(pre.tabs('tools')).toEqual(['  Inventory  ']);
  });

  it('Inv. Items: the tracker\'s rows with their icons and the 16/55/35/65/65/40 columns', () => {
    const w = windowSetup();
    let now = T0;
    w.setNow(now); w.invT.update(baseInventory(100, 5000));
    now += 55 * MIN; w.setNow(now); w.invT.update(baseInventory(90, 255_000));
    now += 3 * MIN; w.setNow(now); w.invT.update(baseInventory(85, 255_000));
    now += 2 * MIN; w.setNow(now);
    w.click('[data-mt-tab=" Inv. Items "]');
    const rows = w.listRows('inventory-tracker');
    expect(w.cells(rows[0]!)).toEqual(['', '', '', 'MMD/h ~5m', 'MMD/h ~1h', '']);
    expect(w.cells(rows[4]!)).toEqual(['', 'Net Profit', '', '-0.0', '1.0', '']);
    const taper = w.q('[data-mt-group="Prismatic Taper"]')!;
    expect(w.cells(taper)).toEqual(['', 'Prismatic Taper', '85', '-60.0', '-15.0', '5.7']);
    expect(taper.querySelector('[data-mt-icon]')!.getAttribute('data-mt-icon')).toBe(String(0x06001002));
    expect([...taper.querySelectorAll<HTMLElement>('[data-mt-cell]')].map((c) => c.style.width)).toEqual(['16px', '55px', '35px', '65px', '65px', '40px']);
  });

  it('Corpse and Player: a header row, newest on top, a click selects; Options clear and toggle', () => {
    const w = windowSetup();
    w.corpseTracker.seen(corpse(0x5001, `Corpse of ${ME}`));
    w.click('[data-mt-tab=" Corpse "]');
    const rows = w.listRows('corpses');
    expect(w.cells(rows[0]!)).toEqual(['Time', 'Name', 'Coords', 'Id']);
    expect(w.cells(rows[1]!)).toEqual([mtDayTime(T0), `Corpse of ${ME}`, '42.4N, 33.6E', String(0x5001)]);
    expect([...rows[1]!.querySelectorAll<HTMLElement>('[data-mt-cell]')].map((c) => c.style.width)).toEqual(['53px', '162px', '100px', '0px']);
    rows[1]!.click();
    expect(w.selected).toEqual([0x5001]);
    w.click('[data-mt-tab="    Options    "]');
    // No fellowship / permission reads were given: those two checkboxes aren't drawn.
    expect(w.q('[data-mt-option="CorpseTracker.TrackFellowCorpses"]')).toBeNull();
    const all = w.q('[data-mt-option="CorpseTracker.TrackAllCorpses"]')!;
    expect([all.style.left, all.style.top]).toEqual(['10px', '90px']);
    all.querySelector<HTMLElement>('[data-check]')!.click();
    expect(w.settings.map.get('CorpseTracker.TrackAllCorpses')).toBe('True');
    w.click('[data-mt-button="Clear History"]');
    expect(w.corpseTracker.list()).toHaveLength(0);
    // Player: enable it from the window, feed a sighting, select it.
    w.click('[data-mt-tab=" Player "]');
    w.click('[data-mt-tab="    Options    "]');
    w.q('[data-mt-option="PlayerTracker.Enabled"] [data-check]')!.click();
    w.playerTracker.seen({ id: 0x5002, name: 'Bob', cell: HOLT, x: 84, y: 84, z: 0 });
    w.click('[data-mt-tab=" Tracked Players "]');
    const prow = w.listRows('players')[1]!;
    expect(w.cells(prow)).toEqual([mtDateTime(T0), 'Bob', '42.4N, 33.6E', String(0x5002)]);
    prow.click();
    expect(w.selected).toEqual([0x5001, 0x5002]);
  });

  it('Loggers: each group shows its channels; Options toggles them, clears, and exports (only with a download)', () => {
    const w = windowSetup();
    w.logger.add({ text: 'Bob tells you, "hi"', type: ChatMessageType.Tell, fromPlayer: true });
    w.logger.add({ text: 'Bob says, "yo"', type: ChatMessageType.Speech, fromPlayer: true });
    w.click('[data-mt-tab=" Loggers "]');
    expect(w.listRows('chat-group-1').map((r) => w.cells(r))).toEqual([[mtDateTime(T0), 'Bob tells you, "hi"']]);
    w.click('[data-mt-tab="  Chat Group 2  "]');
    expect(w.listRows('chat-group-2')).toHaveLength(0);
    w.click('[data-mt-tab="    Options    "]');
    const rows = [...w.body.querySelectorAll<HTMLElement>('[data-mt-list="ChatGroup1OptionsList"] [data-mt-channel]')];
    expect(rows.map((r) => [r.dataset.mtChannel, r.dataset.on])).toEqual([
      ['1/Area', '0'], ['1/Tells', '1'], ['1/Fellowship', '0'], ['1/General', '0'], ['1/Trade', '0'], ['1/Allegiance', '0'],
    ]);
    w.q('[data-mt-channel="2/General"] [data-check]')!.click();
    expect(w.logger.enabled(2, 'General')).toBe(true);
    expect(w.q('[data-mt-channel="2/General"]')!.dataset.on).toBe('1');
    const persist = w.q('[data-mt-option="ChatLogger.Persistent"]')!;
    expect([persist.style.left, persist.style.top, persist.dataset.on]).toEqual(['10px', '60px', '1']);
    w.click(`[data-mt-button="${MT_EXPORT_LOG_LABEL}"]`);
    expect(w.downloads).toEqual([[`${ME}.ChatLogger.txt`, `${mtFileStamp(T0)},2,Bob tells you, "hi"\n`]]);
    w.click('[data-mt-button="Clear History"]');
    expect(w.logger.rows(1)).toEqual([]);
    const noDl = windowSetup({ download: false });
    noDl.click('[data-mt-tab=" Loggers "]');
    noDl.click('[data-mt-tab="    Options    "]');
    expect(noDl.q(`[data-mt-button="${MT_EXPORT_LOG_LABEL}"]`)).toBeNull();
  });

  it('Tools → Inventory: the hint clears on click, typing filters in place, a click selects and shows the info', () => {
    const w = windowSetup();
    w.click('[data-mt-tab=" Tools "]');
    const field = w.q<HTMLInputElement>('[data-mt="InventorySearch"]')!;
    expect([field.value, field.style.left, field.style.top]).toEqual([MT_INVENTORY_SEARCH_HINT, '5px', '40px']);
    field.dispatchEvent(new Event('mousedown'));
    expect(field.value).toBe('');
    field.value = 'al \\d+'; field.dispatchEvent(new Event('input'));
    // Same input element (no redraw), the list rebuilt.
    expect(w.q('[data-mt="InventorySearch"]')).toBe(field);
    const rows = w.listRows('inventory-search');
    expect(rows.map((r) => r.dataset.mtId)).toEqual(['11']);
    rows[0]!.click();
    expect(w.selected).toEqual([11]);
    expect(w.q('[data-mt="InventoryItemText"]')!.textContent).toBe('Bronze Helm, AL 150');
    w.click('[data-mt-button="Clipboard Worn Equipment"]');
    w.click('[data-mt-button="Clipboard Inventory Info"]');
    expect(w.copies).toEqual(['worn', 'inventory']);
    const noCopy = windowSetup({ copy: false });
    noCopy.click('[data-mt-tab=" Tools "]');
    expect(noCopy.q('[data-mt-button="Clipboard Worn Equipment"]')).toBeNull();
  });

  it('Tools → Character / Server: Add, the row icons and the periodic rules, each scope its own lists', () => {
    const w = windowSetup();
    w.click('[data-mt-tab=" Tools "]');
    w.click('[data-mt-tab="  Character  "]');
    const type = (name: string, v: string) => { const f = w.q<HTMLInputElement>(`[data-mt="${name}"]`)!; f.value = v; f.dispatchEvent(new Event('input')); };
    const addAt = (left: string, top: string) => [...w.body.querySelectorAll<HTMLElement>('[data-mt-button="Add"]')].find((b) => b.style.left === left && b.style.top === top)!.click();
    type('LoginText', '/hom'); addAt('275px', '10px');
    type('LoginText', '/ls'); addAt('275px', '10px');
    const char = { account: 'acct', server: 'Coldeve', character: ME };
    expect(w.lists.commands('OnLoginCommands', char)).toEqual(['/hom', '/ls']);
    expect(w.q<HTMLInputElement>('[data-mt="LoginText"]')!.value).toBe('');
    const loginRows = w.listRows('LoginList');
    expect(loginRows.map((r) => w.cells(r)[0])).toEqual(['/hom', '/ls']);
    // Row 1's up icon (0x060028FC) swaps it up; row 0's delete icon (0x060011F8) removes it.
    loginRows[1]!.querySelector<HTMLElement>(`[data-mt-icon="${0x060028fc}"]`)!.click();
    expect(w.lists.commands('OnLoginCommands', char)).toEqual(['/ls', '/hom']);
    w.listRows('LoginList')[0]!.querySelector<HTMLElement>(`[data-mt-icon="${0x060011f8}"]`)!.click();
    expect(w.listRows('LoginList').map((r) => w.cells(r)[0])).toEqual(['/hom']);
    // On Login Complete.
    type('LoginCompleteText', '/mt jump'); addAt('275px', '120px');
    expect(w.lists.commands('OnLoginCompleteCommands', char)).toEqual(['/mt jump']);
    // Periodic: the boxes start at 1 / 0; a bad interval is refused and keeps the text.
    expect(w.q<HTMLInputElement>('[data-mt="PeriodicCommandInterval"]')!.value).toBe('1');
    type('PeriodicCommandText', '/say buffs'); type('PeriodicCommandInterval', '0'); addAt('275px', '248px');
    expect(w.lists.periodic(char)).toEqual([]);
    expect(w.q<HTMLInputElement>('[data-mt="PeriodicCommandText"]')!.value).toBe('/say buffs');
    type('PeriodicCommandInterval', '30'); type('PeriodicCommandOffset', '5'); addAt('275px', '248px');
    expect(w.lists.periodic(char)).toEqual([{ command: '/say buffs', interval: 30, offset: 5 }]);
    expect(w.cells(w.listRows('PeriodicCommandList')[0]!)).toEqual(['/say buffs', '30', '5', '']);
    // Server: its own (empty) lists and its own box names.
    w.click('[data-mt-tab="  Server  "]');
    expect(w.listRows('ServerLoginList')).toHaveLength(0);
    type('ServerLoginText', '/a hi'); addAt('275px', '10px');
    expect(w.lists.commands('OnLoginCommands', { server: 'Coldeve' })).toEqual(['/a hi']);
    expect(w.lists.commands('OnLoginCommands', char)).toEqual(['/hom']);
  });
});
