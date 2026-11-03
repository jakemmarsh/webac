/**
 * The Mag-Tools and GoArrow runtimes (agent/magtools/magToolsRuntime.ts, ui/goarrow/goArrowRuntime.ts):
 * on where the automation is (the `enabled` dep), Mag-Tools' item-info line printed once per selection on the player's own examine
 * (the open examine window asks again a second later; found live 2026-10-12), /mt through its options,
 * the combat tracker reading chat, and /goarrow setting the arrow.
 */
import { describe, expect, it } from 'vitest';
import { MagToolsRuntime, type MagToolsExtras, type MtAppraisal } from '../packages/renderer/src/agent/magtools/magToolsRuntime.js';
import { GoArrowRuntime, type GoArrowDeps } from '../packages/renderer/src/ui/goarrow/goArrowRuntime.js';
import type { AgentApi } from '../packages/renderer/src/agent/AgentApi.js';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

function magTools(over: Partial<MagToolsExtras> = {}) {
  const printed: string[] = [];
  let enabled = true;
  let selected: number | null = 0x50;
  const opts = new Map<string, string>();
  const x: MagToolsExtras = {
    print: (t) => printed.push(t),
    openContainer: () => null,
    spell: () => null,
    classOf: () => ({ itemType: 2, flags: 0 }),
    lootRules: () => null,
    selectedGuid: () => selected,
    enabled: () => enabled,
    me: () => 'Tester',
    who: () => 'w.Tester',
    manaReads: { worn: () => [], playerEnchantments: () => [], now: () => 0 },
    combatStore: () => new Mem(),
    ...over,
  };
  let t = 1000;
  const rt = new MagToolsRuntime({} as AgentApi, x, { get: (k) => opts.get(k), set: (k, v) => { opts.set(k, v); } }, () => t);
  return { rt, printed, setEnabled: (v: boolean) => { enabled = v; }, setSelected: (g: number | null) => { selected = g; }, tick: (ms: number) => { t += ms; } };
}

const shield: MtAppraisal = { guid: 0x50, name: 'Round Shield', int: { 28: 20 }, float: {}, bool: {}, string: {}, did: {}, spellIds: [], activeSpellIds: [] };

describe('Mag-Tools in the game', () => {
  it('prints the item info once for the player\'s examine of the selected item, not for the examine window\'s re-ask', () => {
    const m = magTools();
    m.rt.appraised(shield);
    m.tick(1200);
    m.rt.appraised(shield);
    expect(m.printed).toEqual([expect.stringContaining('Round Shield')]);
  });

  it('prints nothing for an item that isn\'t selected, nor when the automation is off', () => {
    const m = magTools();
    m.setSelected(0x99);
    m.rt.appraised(shield);
    m.setSelected(0x50);
    m.setEnabled(false);
    m.rt.appraised(shield);
    expect(m.printed).toEqual([]);
    expect(m.rt.chat('/mt opt get ItemInfoOnIdent.Enabled')).toBe(false);
  });

  it('/mt opt reads and sets Mag-Tools\' options', () => {
    const m = magTools();
    expect(m.rt.chat('/mt opt set ItemInfoOnIdent.ShowValueAndBurden true')).toBe(true);
    expect(m.rt.options.bool('ItemInfoOnIdent.ShowValueAndBurden')).toBe(true);
    expect(m.rt.chat('hello')).toBe(false);
  });
});

function goArrow(over: Partial<GoArrowDeps> = {}) {
  const said: string[] = [];
  const store = new Mem();
  const d: GoArrowDeps = {
    era: () => 'eol',
    self: () => ({ cell: 0xa9b40019, x: 84, y: 84, headingRadians: 0 }),
    seenOutside: () => false,
    selected: () => ({ guid: 7, name: 'Drudge Skulker' }),
    object: (g) => (g === 7 ? { name: 'Drudge Skulker', cell: 0xa9b40019, x: 100, y: 100 } : null),
    findByName: () => [],
    select: () => {},
    say: (t) => said.push(t),
    chat: () => {},
    copy: () => {},
    storage: () => store,
    enabled: () => true,
    ...over,
  };
  return { rt: new GoArrowRuntime(d), said };
}

describe('GoArrow in the game', () => {
  it('/goarrow to <coords> points the arrow and switches it on; bad input says GoArrow\'s error', async () => {
    const g = goArrow();
    expect(g.rt.chat('/goarrow to 42.1N, 33.6E')).toBe(true);
    expect(g.rt.arrowTarget()).toMatchObject({ kind: 'coords', coords: { ns: 42.1, ew: 33.6 } });
    expect(g.rt.settings().visible).toBe(true);
    g.rt.chat('/goarrow to nowhere at all');
    await g.rt.ensureData();
    await Promise.resolve();
    expect(g.said.at(-1)).toMatch(/^<\{ GoArrow \}> Invalid coordinates or unknown location name/);
  });

  it('/goarrow tag follows the selected object; off without the automation', () => {
    const g = goArrow();
    g.rt.chat('/goarrow tag');
    expect(g.rt.arrowTarget()).toMatchObject({ kind: 'object', name: 'Drudge Skulker', inRange: true });
    const off = goArrow({ enabled: () => false });
    expect(off.rt.chat('/goarrow to 1N, 1E')).toBe(false);
  });

  it('/goarrow to <place> works on a fresh page, before the era\'s location database has loaded (Reddit, 2026-11-03)', async () => {
    for (const era of ['eol', 'dm', 'ac1999'] as const) {
      const g = goArrow({ era: () => era });
      expect(g.rt.chat('/goarrow to Holtburg')).toBe(true);
      expect(g.said).toEqual([]);
      await g.rt.ensureData();
      await Promise.resolve();
      expect(g.rt.arrowTarget(), era).toMatchObject({ kind: 'location', name: 'Holtburg' });
      expect(g.rt.settings().visible).toBe(true);
      expect(g.said).toEqual([]);
    }
    // An unknown name still says GoArrow's error, once the database has answered.
    const g = goArrow();
    g.rt.chat('/goarrow to Nowhere Town');
    await g.rt.ensureData();
    await Promise.resolve();
    expect(g.said).toEqual([expect.stringMatching(/Invalid coordinates or unknown location name/)]);
  });
});

describe('GoArrow: what it answers', () => {
  it('switched on with no destination it says how to set one; with a destination it says nothing', () => {
    const g = goArrow();
    const replies: string[] = [];
    g.rt.onReply = (r) => replies.push(r);
    g.rt.chat('/goarrow arrow on');
    expect(g.said.at(-1)).toBe('<{ GoArrow }> The arrow has no destination yet. Type /goarrow to (coords) or /goarrow to (location name), or pick a place in the GoArrow window.');
    expect(replies).toEqual(['arrow_on', 'no_destination']);
    // The window's Show Arrow box and the bar's "GoArrow: Arrow" go through the same notice.
    g.rt.model.setShowArrow(false);
    g.rt.model.setShowArrow(true);
    expect(g.said.filter((t) => /no destination yet/.test(t))).toHaveLength(2);
    g.rt.chat('/goarrow to 42.1N, 33.6E');
    g.said.length = 0;
    g.rt.chat('/goarrow arrow on');
    expect(g.said).toEqual([]);
  });

  it('every command reports a reply from the closed list (telemetry), the place-name wait as to_waited', async () => {
    const g = goArrow();
    const replies: string[] = [];
    g.rt.onReply = (r) => replies.push(r);
    g.rt.chat('/goarrow');
    g.rt.chat('/goarrow bogus');
    g.rt.chat('/goarrow show nothing');
    g.rt.chat('/goarrow to [coords]');
    g.rt.chat('/goarrow map');
    g.rt.chat('/goarrow to Holtburg');
    g.rt.chat('/goarrow tag');
    g.rt.chat('/goarrow find Nobody');
    await g.rt.ensureData();
    await Promise.resolve();
    g.rt.chat('/goarrow to 1N, 1E');
    g.rt.chat('/goarrow to Nowhere Town');
    expect(replies).toEqual(['help', 'invalid_command', 'hud_target', 'coords_placeholder', 'no_map', 'tag_set', 'find_none', 'to_waited', 'to_set', 'to_unknown']);
  });
});

describe('GoArrow on the VVS bar', () => {
  it('the bar\'s "GoArrow: Arrow" works the Show Arrow box: switched on in a dungeon, it says why nothing shows', async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    const H = await mountGameUI();
    try {
      const ui = H.ui as unknown as { setAutomationSource(s: unknown): void; setGoArrow(rt: GoArrowRuntime | null): void; hudContainer: HTMLElement };
      const { rt, said } = goArrow({ self: () => ({ cell: 0x01030100, x: 10, y: 10, headingRadians: 0 }), seenOutside: () => false });
      const { emptyRoutineDoc } = await import('../packages/shared/src/routines/index.js');
      const base: Record<string, unknown> = {
        load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
        status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
        stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
        current: () => null, character: () => 'T', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [], setting: () => undefined, report: () => {}, spellTable: () => null, selection: () => null,
      };
      ui.setAutomationSource(new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) }));
      ui.setGoArrow(rt);
      rt.frame?.();
      const entry = ui.hudContainer.querySelector<HTMLElement>('[data-vvs-bar-entry="goarrow-arrow"]');
      expect(entry).not.toBeNull();
      entry!.click();
      expect(rt.settings().visible).toBe(true);
      expect(said.some((t) => /not visible because you are indoors/.test(t))).toBe(true);
      ui.setGoArrow(null); ui.setAutomationSource(null);
    } finally { H.teardown(); }
  });
});
