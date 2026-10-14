/**
 * The automation window's debug and inventory commands
 * (ui/automation/metaCommands.ts, docs/vtank-parity-gaps.md §5.3, §6, §8):
 * /vt dumpmetavars, listmetafunctions, metafunchelp, testspell, dumpspells,
 * dumpskills, getdb, refresh; /ub autostack, autocram, count, clearbugged.
 * Then through the real VTankWindow (a /ub line reaches them) and the real
 * GameUI parts they read (meta views' visibility, item cooldowns), and the
 * importer keeping these chat commands as supported steps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPR_FUNCTIONS, exprFunctionHelp, exprFunctionsWithoutHelp, metToProfile, type LootRule } from '../packages/shared/src/routines/index.js';
import { metaCommand, type AutomationTools, type MetaCommandContext } from '../packages/renderer/src/ui/automation/metaCommands.js';
import type { VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

function fakeTools() {
  const log: string[] = [];
  const tools: AutomationTools = {
    metaVars: () => [{ scope: 'var', name: 'kills', value: 12 }, { scope: 'gvar', name: 'leader', value: 'Bob' }, { scope: 'pvar', name: 'list', value: { kind: 'list', items: [1, 2] } }],
    testSpell: (id) => `tested ${id}`,
    spellRows: () => [{ id: 27, name: 'Flame Bolt I', school: 1, power: 1, category: 2, duration: 0 }, { id: 6, name: 'Heal Self I', school: 2, power: 1, category: 3 }],
    skillRows: () => [{ id: 34, name: 'War Magic', training: 'specialized', base: 200, buffed: 260 }],
    stackCram: (mode) => { log.push(`pass ${mode}`); return mode === 'stack' ? 'AutoStack running' : 'AutoCram - nothing to do'; },
    carried: () => [
      { name: 'Prismatic Taper', stack: 40, type: 'Spell Components' }, { name: 'Prismatic Taper', stack: 100, type: 'Spell Components' },
      { name: 'Mana Stone', type: 'Mana Stone', value: 50 }, { name: 'Pyreal', stack: 900, type: 'Money' },
    ],
    playersWithin: (r) => (r >= 50 ? 4 : 1),
    clearBugged: async () => ['Clear Bugged: checked 2 items; none were bugged.'],
  };
  const downloads: Array<{ name: string; text: string }> = [];
  const rules: LootRule[] = [{ action: 'keep', label: 'Tapers', match: { name: 'Taper' } } as LootRule, { action: 'sell', label: 'Stones', match: { name: '^Mana Stone$' } } as LootRule];
  const ctx: MetaCommandContext = { download: (name, text) => downloads.push({ name, text }), lootRules: (n) => (n.toLowerCase() === 'recomp' ? rules : null) };
  return { tools, ctx, log, downloads, run: (line: string) => metaCommand(line, tools, ctx) };
}

describe('/vt debug commands', () => {
  it('dumpmetavars lists every scope; with none set it says so', async () => {
    const f = fakeTools();
    expect(await f.run('/vt dumpmetavars')).toEqual(['Meta variables (3):', '  kills = 12', '  gvar leader = Bob', '  pvar list = [1,2]']);
    f.tools.metaVars = () => [];
    expect(await f.run('/vt dumpmetavars')).toEqual(['No meta variables are set.']);
  });
  it('listmetafunctions names every function; metafunchelp gives one\'s arguments and what it does', async () => {
    const f = fakeTools();
    const lines = (await f.run('/vt listmetafunctions'))!;
    expect(lines[0]).toBe(`${EXPR_FUNCTIONS.length} meta functions:`);
    expect(lines.slice(1).join(' ').split(/,\s*/).map((s) => s.trim())).toEqual([...EXPR_FUNCTIONS]);
    expect(lines.slice(1).every((l) => l.length <= 161)).toBe(true);
    expect(await f.run('/vt metafunchelp getvar')).toEqual(['getvar[string]: Returns the value of a meta variable, or false if it is not defined.']);
    expect(await f.run('/vt metafunchelp actiontrysplit[]')).toEqual([exprFunctionHelp('actiontrysplit')]);
    expect(await f.run('/vt metafunchelp nosuch')).toEqual(['No meta function "nosuch" (/vt listmetafunctions lists them).']);
    expect(await f.run('/vt metafunchelp')).toEqual(['/vt metafunchelp <function> (/vt listmetafunctions lists them)']);
  });
  it('every function has a help line', () => { expect(exprFunctionsWithoutHelp()).toEqual([]); });
  it('testspell takes a spell id', async () => {
    const f = fakeTools();
    expect(await f.run('/vt testspell 567')).toEqual(['tested 567']);
    expect(await f.run('/vt testspell')).toEqual(['/vt testspell <spell id> (example: /vt testspell 567)']);
    expect(await f.run('/vt testspell bolt')).toEqual(['/vt testspell <spell id> (example: /vt testspell 567)']);
  });
  it('dumpspells / dumpskills hand the player the file VTank wrote to C:\\', async () => {
    const f = fakeTools();
    expect(await f.run('/vt dumpspells')).toEqual(['spelldump.txt saved to your downloads (2 spells).']);
    expect(f.downloads[0]!.text).toBe('Id\tName\tSchool\tDifficulty\tFamily\tDuration\n27\tFlame Bolt I\tWar Magic\t1\t2\t0\n6\tHeal Self I\tLife Magic\t1\t3\t\n');
    expect(await f.run('/vt dumpskills')).toEqual(['skilldump.txt saved to your downloads (1 skills).']);
    expect(f.downloads[1]).toEqual({ name: 'skilldump.txt', text: 'Id\tName\tTraining\tBase\tBuffed\n34\tWar Magic\tspecialized\t200\t260\n' });
    f.tools.spellRows = () => [];
    expect(await f.run('/vt dumpspells')).toEqual(['The spell table has not loaded yet.']);
  });
  it('getdb has nothing to fetch; commands not its own are left to the window', async () => {
    const f = fakeTools();
    expect((await f.run('/vt getdb'))![0]).toMatch(/nothing to download/);
    expect(await f.run('/vt start')).toBeNull();
    expect(await f.run('/ub use Mana Stone')).toBeNull();
  });

  it('every other /ub command goes to UtilityBelt\'s runtime (agent/ub/ubCommands.ts) with the window\'s loot sets', async () => {
    const f = fakeTools();
    const seen: Array<[string, LootRule[] | null]> = [];
    f.tools.ub = async (line, loot) => { seen.push([line, loot('recomp')]); return [`ub: ${line}`]; };
    expect(await f.run('/ub use Mana Stone')).toEqual(['ub: /ub use Mana Stone']);
    expect(await f.run('/ub')).toEqual(['ub: /ub']);
    expect(await f.run('/ub autostack')).toEqual(['AutoStack running']); // still the window's own
    expect(seen.map(([l, r]) => [l, r?.length])).toEqual([['/ub use Mana Stone', 2], ['/ub', 2]]);
  });
});

describe('/ub inventory commands', () => {
  it('autostack / autocram start a pass', async () => {
    const f = fakeTools();
    expect(await f.run('/ub autostack')).toEqual(['AutoStack running']);
    expect(await f.run('/ub autocram')).toEqual(['AutoCram - nothing to do']);
    expect(f.log).toEqual(['pass stack', 'pass cram']);
  });
  it('count item: each matching name and the total (stacks in full), by regex; bad patterns say why', async () => {
    const f = fakeTools();
    expect(await f.run('/ub count item taper')).toEqual(['Item Count: Prismatic Taper - 140', 'Total Item Count: 140']);
    expect(await f.run('/ub count Prismatic Taper')).toEqual(['Item Count: Prismatic Taper - 140', 'Total Item Count: 140']);
    expect(await f.run('/ub count item ^(Mana|Pyreal)')).toEqual(['Item Count: Mana Stone - 1', 'Item Count: Pyreal - 900', 'Total Item Count: 901']);
    expect(await f.run('/ub count item Nothing')).toEqual(['Item Count: Nothing - 0', 'Total Item Count: 0']);
    expect((await f.run('/ub count item ('))![0]).toMatch(/^Item Count: bad name pattern/);
  });
  it('count player: players in range, you included; count profile: what a loot profile keeps', async () => {
    const f = fakeTools();
    expect(await f.run('/ub count player 50')).toEqual(['Player Count: 4']);
    expect(await f.run('/ub count player far')).toEqual(['Player Count: bad range: far']);
    expect(await f.run('/ub count profile recomp.utl')).toEqual(['recomp', 'Rule Count: Tapers - 140', 'Rule Count: Stones - 1', 'Total Item Count: 141']);
    expect(await f.run('/ub count profile nope')).toEqual(['Profile does not exist: nope']);
    expect(await f.run('/ub count')).toEqual(['/ub count item <name regex> | player <range> | profile <loot profile>']);
  });
  it('clearbugged answers when its pass ends', async () => {
    expect(await fakeTools().run('/ub clearbugged')).toEqual(['Clear Bugged: checked 2 items; none were bugged.']);
  });
});

describe('the importer keeps these chat commands as steps the window runs', () => {
  it('/ub autostack, /ub count and /vt dumpmetavars are Chat steps; an unknown /ub stays unsupported', () => {
    const chat = (text: string) => ({ cond: 1, condData: { t: 'i' as const, v: 0 }, act: 2, actData: { t: 's' as const, v: text }, state: 'Default' });
    const { value: p } = metToProfile('X', [chat('/ub autostack'), chat('/ub count item Taper'), chat('/vt dumpmetavars'), chat('/vt testspell 567'), chat('/ub frobnicate')]);
    const actions = p.states[0]!.rules.map((r) => r.do[0]);
    expect(actions.slice(0, 4)).toEqual([{ kind: 'say', text: '/ub autostack' }, { kind: 'say', text: '/ub count item Taper' }, { kind: 'say', text: '/vt dumpmetavars' }, { kind: 'say', text: '/vt testspell 567' }]);
    expect(actions[4]!.kind).toBe('unsupported');
  });
});

describe('through the window and GameUI', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('a /ub line reaches the commands; one they do not know is answered as unknown; /vt refresh reloads', async () => {
    const W = await import('../packages/renderer/src/ui/automation/VTankWindow.js');
    const f = fakeTools();
    let loads = 0;
    const source = {
      load: async () => { loads++; return { ok: true, doc: { schemaVersion: 1, profiles: [] } }; },
      character: () => 'Claude', status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
      now: () => 0,
      tools: f.tools,
    } as unknown as VTankSource;
    const win = new W.VTankWindow({ download: () => {} } as never, source, { open: () => {}, close: () => {} });
    expect(await win.command('/ub autostack')).toEqual(['AutoStack running']);
    expect(await win.command('/ub frobnicate')).toEqual(['unknown command /ub frobnicate (/ub autostack, autocram, count, clearbugged)']);
    expect(await win.command('/vt dumpmetavars')).toHaveLength(4);
    const before = loads;
    expect(await win.command('/vt refresh')).toEqual(['profiles reloaded']);
    expect(loads).toBe(before + 1);
  });

  it('meta views: uiviewexists / uiviewvisible / uisetvisible on a real view', () => {
    const ui = H.ui as {
      openMetaView(n: string, v: unknown, c: () => void): void; closeMetaView(n: string): void;
      metaViewExists(v: string): boolean; metaViewVisible(v: string): boolean; setMetaViewControlVisible(v: string, c: string, on: boolean): boolean;
    };
    ui.openMetaView('panel', { title: 'Panel', width: 100, height: 60, buttons: [{ name: 'btnGo', left: 4, top: 4, width: 40, height: 20, text: 'Go' }] }, () => {});
    expect([ui.metaViewExists('panel'), ui.metaViewVisible('panel'), ui.metaViewExists('other')]).toEqual([true, true, false]);
    const btn = () => H.container.ownerDocument.querySelector('[data-meta-view-button="btnGo"]') as HTMLElement;
    expect(ui.setMetaViewControlVisible('panel', 'btnGo', false)).toBe(true);
    expect(btn().style.visibility).toBe('hidden');
    expect(ui.setMetaViewControlVisible('panel', 'btnGo', true)).toBe(true);
    expect(btn().style.visibility).toBe('');
    expect(ui.setMetaViewControlVisible('panel', 'nope', false)).toBe(false);
    ui.closeMetaView('panel');
    expect([ui.metaViewExists('panel'), ui.metaViewVisible('panel')]).toEqual([false, false]);
  });

  it('item cooldowns: the cooldown enchantment for CooldownId + 0x8000, seconds left', () => {
    const ui = H.ui as { addEnchantment(d: unknown): void; agentCooldownRemaining(id: number, now?: number): number };
    ui.addEnchantment({ spellId: 0x8000 + 7, layer: 1, name: 'cooldown', iconId: 0, isBeneficial: true, isVitae: false, isCooldown: true, duration: 30, startTime: 0, casterGuid: 0 });
    const now = Date.now() / 1000;
    expect(ui.agentCooldownRemaining(7, now + 10)).toBeCloseTo(20, 0);
    expect(ui.agentCooldownRemaining(8, now)).toBe(0);
    expect(ui.agentCooldownRemaining(7, now + 60)).toBe(0);
  });
});
