import type { LootRule, RoutineProfile } from '@ac/shared';

/**
 * The loot sets the plugins read (Mag-Tools' Autopack `<Character>.AutoPack` and Auto Add To Trade `<Partner>`,
 * UtilityBelt's AutoVendor and loot-profile commands): the running routine's profile, else the VirindiTank window's
 * selection. A player's .utl sets exist whether or not the macro runs, as the plugins' own profile folders did; reading
 * only the running routine left UB's sets empty with the macro off (2026-10-14).
 */
export function pluginLootSets(running: RoutineProfile | null | undefined, standby: () => RoutineProfile | null): Record<string, LootRule[]> | null {
  return (running ?? standby())?.lootSets ?? null;
}
