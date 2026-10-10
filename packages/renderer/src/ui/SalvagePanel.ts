/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a — gmSalvageUI (layout 0x2100000c, dock slot
 * 0x1000005e) and ClientUISystem's salvage-result chat text.
 *
 * The panel is the DAT slot (title 0x10000077 p23 "WARNING: Items in this
 * panel will be destroyed!", the UIElement_ItemList 0x10000074 + bar
 * 0x10000075, the Salvage button 0x10000076 with its 0x10000079 state art,
 * close 0x10000078); it never prints results. The server's reply goes to the
 * chat log (Handle_Inventory__Recv_SalvageOperationsResultData @ 00565620 →
 * ClientSystem::AddTextToScroll).
 */
import { UI_STATE_DISABLED, UI_STATE_NORMAL } from './DatTextStyle.js';
import { DRAG_ACCEPT_STATE, UIITEM_DRAG_ACCEPT_TEX, uiItemDragAcceptState } from './UIItemDragAccept.js';

export const SALVAGE_SLOT_EL = {
  root: 0x10000073, list: 0x10000074, bar: 0x10000075, button: 0x10000076, title: 0x10000077, close: 0x10000078,
} as const;

/** The list's UIItem cell (m_cellW of template 0x10000339). */
export const SALVAGE_CELL = 32;

/**
 * UIElement_ItemList::UpdateEmptySlots @ 004e3700 for the salvage list
 * (attr 0x10000015 = -1, p95 = -1: one horizontal row): the view is padded
 * with empty tiles to floor(viewW / cell), and attr 0x10000017 (TRUE on
 * 0x10000074) keeps one empty tile after a filled last cell. ItemList_AddItem
 * @ 004e3e00 fills the first empty tile, so n items give max(floor, n + 1).
 */
export function salvageListCellCount(itemCount: number, viewW: number, cell = SALVAGE_CELL): number {
  return Math.max(Math.floor(viewW / cell), itemCount + 1);
}

/**
 * The Salvage button's state: _AddItem @ 004cb2d0 SetState(1) on the first
 * item; RemoveItem @ 004cafd0 (list emptied), OpenSalvagePanel,
 * CloseSalvagePanel and Salvage @ 004cb840 SetState(0xd).
 */
export function salvageButtonState(itemCount: number): number {
  return itemCount > 0 ? UI_STATE_NORMAL : UI_STATE_DISABLED;
}

/**
 * gmSalvageUI::Salvage @ 004cb840 walks the list from the LAST cell to the
 * first (GetNumUIItems − 1 down to 0), InsertTail-ing each guid: the
 * CreateTinkeringTool list is the queue reversed.
 */
export function salvageRequestGuids(queue: readonly number[]): number[] {
  return [...queue].reverse();
}

export interface SalvageResultLine { material: string; units: number; workmanship: number }

/**
 * GenerateMaterialsSalvagedString @ 00565300: each result as
 * "%s%d %s (ws %.2lf)" — the separator is "" before the first, " and "
 * before the last, ", " otherwise.
 */
export function materialsSalvagedString(results: readonly SalvageResultLine[]): string {
  let out = '';
  results.forEach((r, i) => {
    const sep = i === 0 ? '' : i === results.length - 1 ? ' and ' : ', ';
    out += `${sep}${r.units} ${r.material} (ws ${r.workmanship.toFixed(2)})`;
  });
  return out;
}

/**
 * The chat lines Handle_Inventory__Recv_SalvageOperationsResultData @
 * 00565620 adds: "You obtain %hs using your knowledge of %hs.%s" (the
 * augmentation suffix " Your augmentation has given you a return bonus of
 * %d%%!" when the percent return is non-zero); nothing salvaged and nothing
 * refused → "Salvaging Failed!".
 */
export function salvageResultChatLines(skillName: string, results: readonly SalvageResultLine[], percentReturn: number): string[] {
  if (results.length === 0) return ['Salvaging Failed!'];
  const bonus = percentReturn !== 0 ? ` Your augmentation has given you a return bonus of ${percentReturn}%!` : '';
  return [`You obtain ${materialsSalvagedString(results)} using your knowledge of ${skillName}.${bonus}`];
}

/**
 * TinkeringSystem::IsValidMaterialType @ 005c9670: the switch's accepted
 * MaterialType values — 1, 2, 4..8, 10..55, 57..64, 66..71, 73..77 (every
 * other value, 0 included, returns 0).
 */
export function isValidSalvageMaterialType(materialType: number): boolean {
  const m = materialType >>> 0;
  if (m === 1 || m === 2) return true;
  if (m >= 4 && m <= 8) return true;
  if (m >= 10 && m <= 0x37) return true;
  if (m >= 0x39 && m <= 0x40) return true;
  if (m >= 0x42 && m <= 0x47) return true;
  return m >= 0x49 && m <= 0x4d;
}

/** PublicWeenieDesc._bitfield's Retained bit (ACE ObjectDescriptionFlag.Retained). */
export const SALVAGE_RETAINED_BIT = 0x01000000;

/** The PublicWeenieDesc fields gmSalvageUI's rules read off an object. */
export interface SalvageCandidate {
  id: number;
  name: string;
  pluralName?: string;
  stackSize?: number;
  containerId?: number;
  materialType?: number;
  structure?: number;
  objectDescFlags?: number;
}

/**
 * gmSalvageUI::IsItemSuitable @ 004cb040: a valid material type, _structure
 * < 100, and — unless the SalvageMultiple option is on — the list's material
 * (m_material, 0 while the list is empty) matches; then suitable exactly when
 * the bitfield lacks Retained.
 */
export function isSalvageItemSuitable(item: SalvageCandidate, listMaterial: number, salvageMultiple: boolean): boolean {
  const material = item.materialType ?? 0;
  if (!isValidSalvageMaterialType(material)) return false;
  if ((item.structure ?? 0) >= 100) return false;
  if (!salvageMultiple && listMaterial !== 0 && material !== listMaterial) return false;
  return ((item.objectDescFlags ?? 0) & SALVAGE_RETAINED_BIT) === 0;
}

/** DragItemAcceptable @ 004cb650's refusal for an object the player does not own. */
export const SALVAGE_NOT_OWNED_TEXT = 'You can only salvage items that you own!';

/** _AddContainedItems @ 004cb4f0's notice (.rdata 0x7b7b10), %s = GetObjectNameWide(NAME_APPROPRIATE). */
export function salvageAddingContentsText(containerName: string): string {
  return `Adding contents of ${containerName}`;
}

export interface SalvageDropState {
  /** The guids already in m_salvageList, in list order. */
  listed: readonly number[];
  /** m_material: the first listed item's material (0 while the list is empty). */
  listMaterial: number;
  /** PlayerModule::SalvageMultiple (CharacterOptions2 SalvageMultipleMaterialsAtOnce). */
  salvageMultiple: boolean;
  /** ACCWeenieObject::IsOwnedByPlayer for the dropped object. */
  owned: boolean;
  /** ACCWeenieObject::GetContainedItemsList: an object's contents, in list order. */
  contents: (guid: number) => readonly SalvageCandidate[];
  /** GetObjectNameWide(NAME_APPROPRIATE). */
  appropriateName: (item: SalvageCandidate) => string;
}

export interface SalvageDropResult<T extends SalvageCandidate> {
  /** AcceptDragObject's return (the drop was taken). */
  accepted: boolean;
  /** The objects _AddItem appended, in order. */
  added: T[];
  /** m_material after the drop. */
  listMaterial: number;
  /** SendNotice_DisplayStringInfo(0x1a, …) texts raised, in order. */
  notices: string[];
}

/**
 * A drop on m_salvageList: AcceptDragObject @ 004cb790 → DragItemAcceptable
 * (false) @ 004cb650 (not owned → the notice; already listed → refused; a
 * container with contents → accepted; else IsItemSuitable) → AddNewItem @
 * 004cb430: a container with contents walks _AddContainedItems @ 004cb4f0
 * ("Adding contents of %s", then each child — a non-empty container
 * recursing, anything else through _AddItem), otherwise _AddItem @ 004cb2d0
 * (not listed + suitable → appended; the first item sets m_material).
 */
export function planSalvageDrop<T extends SalvageCandidate>(dropped: T, state: SalvageDropState): SalvageDropResult<T> {
  const notices: string[] = [];
  const added: T[] = [];
  const listed = new Set(state.listed);
  let count = state.listed.length;
  let material = count === 0 ? 0 : state.listMaterial;
  const refuse = (): SalvageDropResult<T> => ({ accepted: false, added, listMaterial: material, notices });

  if (!state.owned) {
    notices.push(SALVAGE_NOT_OWNED_TEXT);
    return refuse();
  }
  if (listed.has(dropped.id)) return refuse();

  const addItem = (item: T): void => {
    if (listed.has(item.id) || !isSalvageItemSuitable(item, material, state.salvageMultiple)) return;
    listed.add(item.id);
    added.push(item);
    count += 1;
    if (count === 1) material = item.materialType ?? 0;
  };
  const addContained = (container: T): void => {
    notices.push(salvageAddingContentsText(state.appropriateName(container)));
    for (const child of state.contents(container.id) as readonly T[]) {
      if (state.contents(child.id).length < 1) addItem(child);
      else addContained(child);
    }
  };

  if (state.contents(dropped.id).length > 0) {
    addContained(dropped);
    return { accepted: true, added, listMaterial: material, notices };
  }
  if (!isSalvageItemSuitable(dropped, material, state.salvageMultiple)) return refuse();
  addItem(dropped);
  return { accepted: true, added, listMaterial: material, notices };
}

/** The UIItem drag-accept states and art (shared by every drag-handler list — UIItemDragAccept.ts). */
export { DRAG_ACCEPT_STATE };

/**
 * The salvage list's cell template 0x1000033a (0x2100003d:0x10000339 p0x1000000e)
 * bases its 0x1000045a on 0x21000037:0x1000045d: state 0x10000040 draws the
 * green ring 0x060011f9, 0x10000041 the red slashed circle 0x060011f8,
 * 0x1000003f nothing.
 */
export const SALVAGE_DRAG_ACCEPT_TEX = UIITEM_DRAG_ACCEPT_TEX;

export type SalvageAcceptState = Pick<SalvageDropState, 'listed' | 'listMaterial' | 'salvageMultiple' | 'owned' | 'contents'>;

/**
 * DragItemAcceptable @ 004cb650 with silent = true (no notice): not owned →
 * false; already in m_salvageList → false; GetNumContainedItems > 0 → true;
 * else IsItemSuitable against m_material.
 */
export function salvageDragItemAcceptable(item: SalvageCandidate, state: SalvageAcceptState): boolean {
  if (!state.owned) return false;
  if (state.listed.includes(item.id)) return false;
  if (state.contents(item.id).length > 0) return true;
  const material = state.listed.length === 0 ? 0 : state.listMaterial;
  return isSalvageItemSuitable(item, material, state.salvageMultiple);
}

/**
 * gmSalvageUI::OnItemListDragOver @ 004cb740 for the hovered cell: no dragged
 * object, or an alias drag (DROPITEM_IS_ALIAS — a shortcut), leaves the cell
 * untouched (null); otherwise SetDragAcceptState 0x10000040 when the silent
 * DragItemAcceptable passes, 0x10000041 when it does not.
 */
export function salvageDragAcceptState(
  dragged: SalvageCandidate | null,
  state: SalvageAcceptState,
  isAlias = false,
): number | null {
  return uiItemDragAcceptState(dragged?.id ?? 0, () => salvageDragItemAcceptable(dragged!, state), isAlias);
}
