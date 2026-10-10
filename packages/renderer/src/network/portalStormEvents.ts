import { PlayScript } from '@ac/shared';

/**
 * BUG.portalstorm-extent-ignored — retail presentation of the four portal
 * storm GameEvents, taken verbatim from the decompiled EoL client
 * (reference/client-eol/decomp/acclient-decompiled.c). CORE.17.k.a premise
 * correction: every handler raises its text through
 * `ECM_UI::SendNotice_DisplayStringInfo(0x1a, …)` (lines 347589 / 347620 /
 * 347661 and the Storm handler) — text type 0x1a is the SPEW BOX over the
 * 3D view (gmSpewBoxUI, SpewBoxModel.ts), filtered out of every chat window
 * unless Chat Options > Errors is ticked; the earlier "chat" reading below
 * was wrong. main.ts delivers them with gameUI.displayErrorText().
 *
 *   Handle_Misc__PortalStormBrewing  @ 00564fd0 (line 347600): spew box
 *     "This area is getting too crowded - a Portal Storm is brewing."
 *     + CPhysicsObj::play_script(player, PS_PortalStorm, 0.0)
 *   Handle_Misc__PortalStormImminent @ 005650a0 (line 347642): spew box
 *     "A Portal Storm is imminent - leave this crowded area!"
 *     + CPhysicsObj::play_script(player, PS_PortalStorm, 1.0)
 *   Handle_Misc__PortalStorm         @ 00565170 (line 347682): spew box
 *     "The Portal Storm has teleported you away from the crowded area!"
 *     (no script — the storm strike itself arrives as ordinary broadcast
 *     effects/teleport from the server)
 *   Handle_Misc__PortalStormSubsided @ 00564f30 (line 347572): spew box
 *     "The Portal Storm has subsided" (no trailing period in retail)
 *
 * The play_script float is a PhysicsScriptTable mod selector
 * (PhysicsScriptTable::GetScript picks the script variant whose mod range
 * contains the value — same semantics as ACE's PhysicsScriptTable.GetScript),
 * NOT an intensity/speed scale. Brewing selects the mod-0.0 variant,
 * Imminent the mod-1.0 variant, of the player's PS_PortalStorm entry.
 *
 * Era note (premise correction for the wire `extent` field): each retail
 * handler also broadcasts CM_Misc::SendNotice_PortalStormLevel(extent) (0.0
 * for Storm/Subsided), whose only receiver is gmUIElement_PortalStormIndicator
 * (RecvNotice_PortalStormLevel @ 004e6340) — a binary lit/ghosted status icon
 * (UIElement_Button::SetState(1) when level > 0, SetState(0xd) otherwise, with
 * a PORTALSTORM_WARNING_DECAY_TIME = 120.0s auto-clear; the level float is
 * only ever compared against 0, never displayed as a graded meter). That
 * element (0x100000f1) exists ONLY in the classic statusbar's indicator strip
 * (layout 0x21000015, embedded solely by classic statusbar layout 0x21000013)
 * — verified by scanning every LayoutDesc in the EoL client_local_English.dat
 * for element type 0x10000005. The EoL floaty HUD (root 0x21000005 → strip
 * 0x21000071) has no portal-storm element, and no statusbar class exists in
 * the EoL binary, so at our end-of-retail fidelity target NO HUD element
 * reflects the extent — dropping it after the parse is retail-correct.
 */

export type PortalStormEventKind = 'brewing' | 'imminent' | 'storm' | 'subsided';

export interface PortalStormPresentation {
  /** Retail chat line, byte-for-byte from the decompiled client handler. */
  text: string;
  /**
   * PhysicsScriptTable mod for the PS_PortalStorm script the retail client
   * plays on the local player, or null when the handler plays none.
   */
  playScript: { scriptId: PlayScript; mod: number } | null;
}

export function portalStormPresentation(kind: PortalStormEventKind): PortalStormPresentation {
  switch (kind) {
    case 'brewing':
      return {
        text: 'This area is getting too crowded - a Portal Storm is brewing.',
        playScript: { scriptId: PlayScript.PortalStorm, mod: 0.0 },
      };
    case 'imminent':
      return {
        text: 'A Portal Storm is imminent - leave this crowded area!',
        playScript: { scriptId: PlayScript.PortalStorm, mod: 1.0 },
      };
    case 'storm':
      return {
        text: 'The Portal Storm has teleported you away from the crowded area!',
        playScript: null,
      };
    case 'subsided':
      return {
        text: 'The Portal Storm has subsided',
        playScript: null,
      };
  }
}
