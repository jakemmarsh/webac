/**
 * GAP.world-drag-drop.b — retail's keyboard Give / Drop commands.
 *
 * `CPlayerSystem::OnAction @ 00561890` (decomp :344768) switches on a byte
 * table indexed by `InputAction - 0x1000002a` (acclient.exe .text 0x562758):
 * ActionMap command 0x10000040 "Give Selected Object to Target" → case 0x15
 * (:344996), 0x10000041 "Drop Selected Object" → case 0x16 (:345016). Both
 * sit in the Selection input map 0x10000007 and the retail KeyMap DATs
 * (0x14000000 gmDefaultMap / 0x14000002 DefaultMap) bind neither — they
 * ship unbound and are reached through Keyboard Configuration.
 *
 * - Give (0x15): with `ACCWeenieObject::selectedID` and `prevSelectedID`
 *   both set and different, and the PREVIOUS selection a creature (vtable
 *   +0x18 = item type, `& 0x10` TYPE_CREATURE): `ItemHolder::
 *   AttemptPlaceIn3D(selectedID, prevSelectedID, 0)` then
 *   `SetSelectedObject(prevSelectedID, 0)` (the recipient is selected
 *   again). A previous selection that is not a creature (or no longer
 *   exists) says "You must select a creature or a character to give that
 *   to." Without two different selections the case breaks: OnAction
 *   returns false (the key is not consumed).
 * - Drop (0x16): with `selectedID` set and the object `IsOwnedByPlayer`:
 *   `AttemptPlaceIn3D(selectedID, 0, 1)`; otherwise "You must pick that up
 *   first". Nothing selected → break (false).
 *
 * Both notices go out as `ClientSystem::AddTextToScroll(text, 0x1a, true,
 * 0)` — type 0x1a, the spew strip (see SpewBoxModel.ts); the give literal's
 * trailing "\n" is right-trimmed there (gmSpewBoxUI::Update @ 004d5df0), so
 * it is dropped here.
 *
 * "Previous selection" is `ACCWeenieObject::prevSelectedID`, kept by
 * `SetSelectedObject @ 0058c2e0` (:381535): whenever the selection changes
 * to a different id, prevSelectedID = the old selectedID — including 0 when
 * nothing was selected. SelectionHistory mirrors that.
 */

import { ItemType } from '@ac/shared';
import {
  attemptPlaceIn3D,
  type PlaceIn3DContext,
  type PlaceIn3DItem,
  type PlaceIn3DOutcome,
  type PlaceIn3DTarget,
} from './AttemptPlaceIn3D.js';

export const GIVE_DROP_STRINGS = {
  /** OnAction case 0x15 (:345008), trailing "\n" right-trimmed by the spew box. */
  mustSelectCreature: 'You must select a creature or a character to give that to.',
  /** OnAction case 0x16 (:345025). */
  mustPickUpFirst: 'You must pick that up first',
} as const;

/** ACCWeenieObject::selectedID / prevSelectedID as SetSelectedObject @ 0058c2e0 keeps them. */
export class SelectionHistory {
  private selected = 0;
  private prev = 0;
  private changedAt: number | null = null;

  /** `now` (ms) stamps each change, for the refusal telemetry's "selection went N ms ago" (TELEMETRY.refusal-context). */
  constructor(private readonly now: (() => number) | null = null) {}

  /** The selection is now `id` (0 = nothing): a change moves the old selection into prevSelectedID. */
  select(id: number): void {
    const next = id >>> 0;
    if (next === this.selected) return;
    this.prev = this.selected;
    this.selected = next;
    this.changedAt = this.now ? this.now() : null;
  }

  get selectedId(): number { return this.selected; }
  get prevSelectedId(): number { return this.prev; }
  /** Milliseconds since the selection last changed, or null (no clock, or never changed). */
  msSinceChange(): number | null {
    return this.now && this.changedAt !== null ? Math.max(0, this.now() - this.changedAt) : null;
  }
}

export interface GiveDropLookup {
  /** GetWeenieObject(selectedID) as AttemptPlaceIn3D reads it (null = unknown object). */
  item(id: number): PlaceIn3DItem | null;
  /** GetWeenieObject(prevSelectedID) as the recipient (null = unknown object). */
  target(id: number): PlaceIn3DTarget | null;
}

export type GiveDropResult =
  /** The case broke: OnAction returns false and the key is not consumed. */
  | { handled: false }
  | {
      handled: true;
      /** 0x1a lines, the command's own refusal first, then AttemptPlaceIn3D's. */
      notices: string[];
      /** AttemptPlaceIn3D's outcome (null when the command refused before calling it). */
      outcome: PlaceIn3DOutcome | null;
      item: PlaceIn3DItem | null;
      target: PlaceIn3DTarget | null;
      /** Give's SetSelectedObject(prevSelectedID, 0) — the id to select again (0 = none). */
      reselect: number;
    };

/*
 * `ctx` is read only when the command reaches AttemptPlaceIn3D, whose first
 * step is IsPlayerReadyToMakeInventoryRequest (a loud check): a command that
 * refuses first must not run it.
 */

/** OnAction case 0x15 — "Give Selected Object to Target". */
export function giveSelectedObject(
  selectedId: number,
  prevSelectedId: number,
  lookup: GiveDropLookup,
  ctx: () => PlaceIn3DContext,
): GiveDropResult {
  if (selectedId === 0 || prevSelectedId === 0 || selectedId === prevSelectedId) return { handled: false };
  const target = lookup.target(prevSelectedId);
  if (target && (target.itemType & ItemType.Creature) !== 0) {
    const item = lookup.item(selectedId);
    const outcome = attemptPlaceIn3D(item, target, false, ctx());
    return { handled: true, notices: outcome.notices.slice(), outcome, item, target, reselect: prevSelectedId };
  }
  return { handled: true, notices: [GIVE_DROP_STRINGS.mustSelectCreature], outcome: null, item: null, target, reselect: 0 };
}

/** OnAction case 0x16 — "Drop Selected Object". */
export function dropSelectedObject(
  selectedId: number,
  lookup: Pick<GiveDropLookup, 'item'>,
  ctx: () => PlaceIn3DContext,
): GiveDropResult {
  if (selectedId === 0) return { handled: false };
  const item = lookup.item(selectedId);
  if (item && item.ownedByPlayer) {
    const outcome = attemptPlaceIn3D(item, null, true, ctx());
    return { handled: true, notices: outcome.notices.slice(), outcome, item, target: null, reselect: 0 };
  }
  return { handled: true, notices: [GIVE_DROP_STRINGS.mustPickUpFirst], outcome: null, item, target: null, reselect: 0 };
}
