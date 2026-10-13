/**
 * The Mag-Tools and GoArrow runtimes (agent/magtools/magToolsRuntime.ts, ui/goarrow/goArrowRuntime.ts):
 * gated as preview UI, Mag-Tools' item-info line printed once per selection on the player's own examine
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

  it('prints nothing for an item that isn\'t selected, nor when preview UI is off', () => {
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
  it('/goarrow to <coords> points the arrow and switches it on; bad input says GoArrow\'s error', () => {
    const g = goArrow();
    expect(g.rt.chat('/goarrow to 42.1N, 33.6E')).toBe(true);
    expect(g.rt.arrowTarget()).toMatchObject({ kind: 'coords', coords: { ns: 42.1, ew: 33.6 } });
    expect(g.rt.settings().visible).toBe(true);
    g.rt.chat('/goarrow to nowhere at all');
    expect(g.said.at(-1)).toMatch(/^<\{ GoArrow \}> Invalid coordinates or unknown location name/);
  });

  it('/goarrow tag follows the selected object; off without preview UI', () => {
    const g = goArrow();
    g.rt.chat('/goarrow tag');
    expect(g.rt.arrowTarget()).toMatchObject({ kind: 'object', name: 'Drudge Skulker', inRange: true });
    const off = goArrow({ enabled: () => false });
    expect(off.rt.chat('/goarrow to 1N, 1E')).toBe(false);
  });
});
