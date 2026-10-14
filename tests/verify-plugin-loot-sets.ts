/**
 * The loot sets Mag-Tools and UtilityBelt read (agent/pluginLootSets.ts): the running routine's profile, else the
 * VirindiTank window's selection, so a player's sets work with the macro off (2026-10-14: UB read only the running one).
 */
import { describe, expect, it } from 'vitest';
import { pluginLootSets } from '../packages/renderer/src/agent/pluginLootSets.js';
import type { RoutineProfile } from '../packages/shared/src/routines/index.js';

const prof = (name: string, sets?: RoutineProfile['lootSets']) => ({ name, lootSets: sets }) as unknown as RoutineProfile;
const rule = { action: 'keep' as const, match: { name: '^Bread$' } };

describe('pluginLootSets', () => {
  it('reads the stand-by selection when no routine runs', () => {
    expect(pluginLootSets(null, () => prof('Hunt', { 'Default.AutoPack': [rule] }))).toEqual({ 'Default.AutoPack': [rule] });
  });
  it('the running routine wins, without asking the window', () => {
    let asked = false;
    expect(pluginLootSets(prof('Run', { Vendor: [rule] }), () => { asked = true; return prof('Hunt', {}); })).toEqual({ Vendor: [rule] });
    expect(asked).toBe(false);
  });
  it('null when neither has sets', () => {
    expect(pluginLootSets(undefined, () => null)).toBeNull();
    expect(pluginLootSets(null, () => prof('Hunt'))).toBeNull();
  });
});
