/**
 * AGENT.vtank-window — VirindiTank's pea splitting (agent/macro/peaPlan.ts):
 * SplitPeas with SpellCompMin-Critical / -Normal / -Idle, the Splitting Tool
 * used on the pea, a listed component or a listed pea, Add All Peas; and,
 * against the ACE world's CraftTable (gitignored, skipped without it), that
 * every pea recipe's component is the one the pea's name pairs it with.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addAllPeas, isPea, peaMakes, planPeaSplit, type PeaItem } from '../packages/renderer/src/agent/macro/peaPlan.ts';

const C = 'Spell Components';
const tool: PeaItem = { guid: 1, name: 'Splitting Tool', type: 'Misc', where: 'main pack' };
const pea = (guid: number, name: string, stack = 1): PeaItem => ({ guid, name, stack, type: C, where: 'main pack' });
const comp = (guid: number, name: string, stack: number): PeaItem => ({ guid, name, stack, type: C, where: 'main pack' });

describe('pea names', () => {
  it('a pea is a spell component named "<stem> Pea"; its stem names the component as whole words', () => {
    expect(isPea({ name: 'Gold Pea', type: C })).toBe(true);
    expect(isPea({ name: 'Gold Pea' })).toBe(true);
    expect(isPea({ name: 'Gold Pea', type: 'Food' })).toBe(false);
    expect(isPea({ name: 'Gold Scarab', type: C })).toBe(false);
    expect(peaMakes('Gold Pea', 'Gold Scarab')).toBe(true);
    expect(peaMakes('Ashwood Pea', 'Ashwood Talisman')).toBe(true);
    expect(peaMakes('Powdered Bloodstone Pea', 'Powdered Bloodstone')).toBe(true);
    // "Turquoise" is Turquoise Taper's, not Powdered Turquoise's.
    expect(peaMakes('Turquoise Pea', 'Turquoise Taper')).toBe(true);
    expect(peaMakes('Turquoise Pea', 'Powdered Turquoise')).toBe(false);
    expect(peaMakes('Powdered Turquoise Pea', 'Turquoise Taper')).toBe(false);
    expect(peaMakes('Red Pea', 'Redwood Talisman')).toBe(false);
  });

  it('Add All Peas: every pea carried, once, that the list lacks', () => {
    const inv = [pea(2, 'Gold Pea'), comp(3, 'Gold Scarab', 5), pea(4, 'Yellow Pea'), pea(5, 'Gold Pea'), { guid: 6, name: 'Healing Kit', where: 'main pack' }];
    expect(addAllPeas(['Yellow Pea'], inv)).toEqual(['Gold Pea']);
    expect(addAllPeas([], inv)).toEqual(['Gold Pea', 'Yellow Pea']);
    expect(addAllPeas([], [comp(3, 'Gold Scarab', 5)])).toEqual([]);
  });
});

describe('planPeaSplit', () => {
  const inv = (scarabs: number): PeaItem[] => [tool, pea(2, 'Gold Pea', 3), ...(scarabs ? [comp(3, 'Gold Scarab', scarabs)] : [])];

  it('a listed component below the tier\'s minimum: the Splitting Tool goes on its pea', () => {
    const s = planPeaSplit({ inventory: inv(3), listed: ['Gold Scarab'], settings: {}, tier: 'critical' });
    expect(s).toMatchObject({ tool: { guid: 1 }, pea: { guid: 2 }, component: 'Gold Scarab', have: 3, min: 4 });
    expect(s!.why).toContain('SpellCompMin-Critical');
    // 4 is not below Critical's 4, but is below Normal's and Idle's 20.
    expect(planPeaSplit({ inventory: inv(4), listed: ['Gold Scarab'], settings: {}, tier: 'critical' })).toBeNull();
    expect(planPeaSplit({ inventory: inv(4), listed: ['Gold Scarab'], settings: {}, tier: 'normal' })).toMatchObject({ min: 20 });
    expect(planPeaSplit({ inventory: inv(4), listed: ['Gold Scarab'], settings: { 'SpellCompMin-Idle': 3 }, tier: 'idle' })).toBeNull();
    // None at all is the most critical case.
    expect(planPeaSplit({ inventory: inv(0), listed: ['gold scarab'], settings: {}, tier: 'critical' })).toMatchObject({ have: 0 });
  });

  it('a listed pea keeps its own component supplied (what Add All Peas lists)', () => {
    expect(planPeaSplit({ inventory: inv(2), listed: ['Gold Pea'], settings: {}, tier: 'critical' })).toMatchObject({ component: 'Gold', have: 2, pea: { guid: 2 } });
    expect(planPeaSplit({ inventory: inv(25), listed: ['Gold Pea'], settings: {}, tier: 'normal' })).toBeNull();
  });

  it('nothing without SplitPeas, a Splitting Tool, a matching pea, or a listed component', () => {
    expect(planPeaSplit({ inventory: inv(0), listed: ['Gold Scarab'], settings: { SplitPeas: 'false' }, tier: 'critical' })).toBeNull();
    expect(planPeaSplit({ inventory: inv(0).filter((i) => i.guid !== 1), listed: ['Gold Scarab'], settings: {}, tier: 'critical' })).toBeNull();
    expect(planPeaSplit({ inventory: inv(0), listed: ['Lead Scarab'], settings: {}, tier: 'critical' })).toBeNull();
    expect(planPeaSplit({ inventory: inv(0), listed: ['Healing Kit'], settings: {}, tier: 'critical' })).toBeNull();
    expect(planPeaSplit({ inventory: inv(0), listed: [], settings: {}, tier: 'critical' })).toBeNull();
  });

  it('counts every stack of the component; a Gold Ring (not a component) is not a Gold scarab', () => {
    const items = [tool, pea(2, 'Gold Pea'), comp(3, 'Gold Scarab', 2), comp(4, 'Gold Scarab', 2), { guid: 5, name: 'Gold Ring', stack: 30, type: 'Jewelry', where: 'main pack' }];
    expect(planPeaSplit({ inventory: items, listed: ['Gold Scarab'], settings: {}, tier: 'critical' })).toBeNull();
    expect(planPeaSplit({ inventory: items, listed: ['Gold Pea'], settings: {}, tier: 'normal' })).toMatchObject({ have: 4 });
  });
});

const CRAFT = resolve(__dirname, '../world-db-raw/ACE-World-16PY/Database/3-Core/4 CraftTable/SQL');

describe.skipIf(!existsSync(CRAFT))('the ACE world\'s pea recipes (needs world-db-raw)', () => {
  let recipes: Array<{ source: string; pea: string; component: string; skill: number }> = [];
  beforeAll(() => {
    for (const f of readdirSync(CRAFT)) {
      const t = readFileSync(resolve(CRAFT, f), 'utf8');
      const cb = /VALUES \(\d+, \d+ \/\* Splitting Tool \*\/,\s+\d+ \/\* ([^*]+?) \*\//.exec(t);
      if (!cb || !/ Pea$/.test(cb[1])) continue;
      const r = /VALUES \(\d+, 0, (\d+)(?: \/\* [^*]+ \*\/)?, \d+, \d+, \d+ \/\* ([^*]+?) \*\//.exec(t)!;
      recipes.push({ source: 'Splitting Tool', pea: cb[1], component: r[2], skill: Number(r[1]) });
    }
  });

  it('75 recipes; each pea makes exactly the component its name pairs it with, and needs no skill', () => {
    expect(recipes.length).toBe(75);
    const comps = recipes.map((r) => r.component);
    for (const r of recipes) {
      expect(peaMakes(r.pea, r.component), `${r.pea} → ${r.component}`).toBe(true);
      expect(comps.filter((c) => peaMakes(r.pea, c)), r.pea).toEqual([r.component]);
      expect(r.skill).toBe(0);
    }
  });
});
