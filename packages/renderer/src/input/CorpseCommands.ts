/**
 * BUG.keybind-use-closest-corpse (webac#13) — the four corpse commands of
 * CPlayerSystem::OnAction @ 00561890 (UI tab, Item Selection map 0x10000007;
 * the action → case byte table is the switch's jumptable at 0x00562758):
 *
 * - Use Closest Unopened Corpse 0x1000003e (case 0x13): SelectNext(1, 1,
 *   SELECTION_TYPE_UNOPENED_CORPSE), then — when the object now selected is a
 *   corpse (ACCWeenieObject vtable +0x7c) — ItemHolder::UseObject(selectedID, 1, 0).
 * - Use Next Unopened Corpse 0x1000003f (case 0x14): SelectNext(0, 0), and
 *   SelectNext(1, 1) when that changed nothing, then the same use.
 * - Select Closest / Next Unopened Corpse 0x10000121 / 0x10000122 (cases
 *   0x43 / 0x44): the same walks, and nothing more.
 *
 * SelectNext @ 0055f9a0 takes a corpse not yet opened
 * (ACCWeenieObject::HasCorpseBeenOpened) within the radar radius; it selects
 * nothing when none is in range and the selection stays. Retail prints no
 * refusal: the use runs on whatever is then selected if that is a corpse (an
 * already-open corpse selected before the key is used again), else nothing
 * happens.
 */
import { SelectionType, type SelectCycle } from '../controllers/SelectNext.js';

export const USE_CLOSEST_UNOPENED_CORPSE = 0x1000003e;
export const USE_NEXT_UNOPENED_CORPSE = 0x1000003f;
export const SELECT_CLOSEST_UNOPENED_CORPSE = 0x10000121;
export const SELECT_NEXT_UNOPENED_CORPSE = 0x10000122;

/** The corpse command of an action id, or null. */
export function corpseCommand(actionId: number): { use: boolean; cycle: Extract<SelectCycle, 'closest' | 'next'> } | null {
  switch (actionId) {
    case USE_CLOSEST_UNOPENED_CORPSE: return { use: true, cycle: 'closest' };
    case USE_NEXT_UNOPENED_CORPSE: return { use: true, cycle: 'next' };
    case SELECT_CLOSEST_UNOPENED_CORPSE: return { use: false, cycle: 'closest' };
    case SELECT_NEXT_UNOPENED_CORPSE: return { use: false, cycle: 'next' };
    default: return null;
  }
}

export interface CorpseCommandDeps {
  /** CPlayerSystem::SelectNext's walk for `type` (main.ts runSelectCycle): selects and returns the guid, 0 = unchanged. */
  selectCycle(type: SelectionType, cycle: SelectCycle): number;
  /** ACCWeenieObject::selectedID. */
  selectedId(): number;
  /** The ACCWeenieObject vtable +0x7c test: the object is a corpse (PublicWeenieDesc BF_CORPSE). */
  isCorpse(guid: number): boolean;
  /** ItemHolder::UseObject(guid, 1, 0): the Use the Use key / a double-click send. */
  useObject(guid: number): void;
}

/** Run a corpse command. Retail's cases all return true (the key is consumed). */
export function runCorpseCommand(cmd: { use: boolean; cycle: 'closest' | 'next' }, deps: CorpseCommandDeps): true {
  deps.selectCycle(SelectionType.UnopenedCorpse, cmd.cycle);
  if (!cmd.use) return true;
  const sel = deps.selectedId();
  if (sel && deps.isCorpse(sel)) deps.useObject(sel);
  return true;
}
