/**
 * VirindiTank's pet refills: PetRefillCount-Normal (1) and PetRefillCount-Idle
 * (3) (docs/vtank-parity-gaps.md §1.8; facts from MOSS `PetAutomation.
 * TrySelectRefill` and `PetRefillRule`, no code copied). The first summoning
 * essence on the Items tab whose charges (Structure, PropertyInt 92) are down
 * to the count and short of full (MaxStructure, 91) is topped up with the
 * smallest stack of Encapsulated Spirits you carry, used on it in peace mode.
 * The normal count is checked high in the rule list (before the fellowship
 * manager and Attack), the idle one only with nothing to fight. An essence not
 * yet examined has no known charges and is left alone. Essences exist only in
 * end of retail: in the other eras nothing is ever listed, so nothing runs.
 */
import { PropertyInt, type PlanItem } from '@ac/shared';

/** The item that refills an essence's charges (ACE PetDevice: Encapsulated Spirit used on it). */
export const ENCAPSULATED_SPIRIT = 'Encapsulated Spirit';

export interface RefillPlan { device: PlanItem; spirit: PlanItem; why: string }

/** The refill to make at `threshold` charges, or null. `devices`: Items-tab essences in the tab's order; `carried`: your pack. */
export function planPetRefill(devices: PlanItem[], carried: PlanItem[], threshold: number): RefillPlan | null {
  const device = devices.find((d) => {
    const left = d.ints?.[PropertyInt.Structure];
    const max = d.ints?.[PropertyInt.MaxStructure];
    return left !== undefined && left <= threshold && (max === undefined || left < max);
  });
  if (!device) return null;
  let spirit: PlanItem | null = null;
  for (const i of carried) {
    if (i.name.toLowerCase() !== ENCAPSULATED_SPIRIT.toLowerCase()) continue;
    if (!spirit || Math.max(1, i.stack ?? 1) < Math.max(1, spirit.stack ?? 1)) spirit = i;
  }
  if (!spirit) return null;
  return { device, spirit, why: `${device.name} has ${device.ints?.[PropertyInt.Structure]} charges (refill at ${threshold})` };
}
