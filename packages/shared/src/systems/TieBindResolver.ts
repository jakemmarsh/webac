/**
 * TieBindResolver — resolves which client subsystem to bind (and where)
 * when a lifestone/portal Tie completes.
 *
 * BUG.login-position-restore-unreachable-positiontypes — ACE never ships a
 * position packet for a Tie bind: the login snapshot's Position hash table
 * (`GameEventPlayerDescription.cs:202-212`) and the sole `new
 * GameMessagePrivateUpdatePosition` call site across ACE.Server
 * (`Creature_Death.cs:559`) both only ever carry PositionType.LastOutsideDeath.
 * Binding a lifestone/portal (`WorldObject_Magic.cs:967-1029`) only sets
 * `player.LinkedLifestone`/`LinkedPortalOneDID`/`LinkedPortalTwoDID` —
 * property setters that route through `WorldObject_Properties.cs
 * SetPosition`, which writes positionCache/Biota only, no network send —
 * plus a plain `SendChatMessage` confirming the link
 * (`ChatMessageType.Magic`). That chat line is therefore the only
 * client-visible signal a Tie succeeded.
 *
 * ACE reuses the IDENTICAL confirmation string for PortalTie1 (Primary) and
 * PortalTie2 (Secondary), so the caller must track which Tie spell its own
 * HearSpeech echo just confirmed (`isTieSpell`) to disambiguate which
 * recall slot to update, and supply the Tie's target object's position
 * (the client already knows it, since Tie is a targeted spell cast at a
 * visible lifestone/portal).
 *
 * SpellId values verified against the live SpellTable DAT (0x0E00000E):
 * 47 = "Primary Portal Tie", 2644 = "Lifestone Tie",
 * 2646 = "Secondary Portal Tie".
 */

export const SPELLID_PORTAL_TIE1 = 47;
export const SPELLID_LIFESTONE_TIE1 = 2644;
export const SPELLID_PORTAL_TIE2 = 2646;

const TIE_SPELL_IDS: ReadonlySet<number> = new Set([
  SPELLID_PORTAL_TIE1, SPELLID_LIFESTONE_TIE1, SPELLID_PORTAL_TIE2,
]);

/** True if `spellId` is one of the three Tie spells (Lifestone/Portal 1/Portal 2). */
export function isTieSpell(spellId: number): boolean {
  return TIE_SPELL_IDS.has(spellId);
}

export const LIFESTONE_TIE_CONFIRM_TEXT = 'You have successfully linked with the life stone.';
export const PORTAL_TIE_CONFIRM_TEXT = 'You have successfully linked with the portal.';

/** True if `message` is one of the two Tie confirmation strings ACE sends. */
export function isTieBindConfirmationText(message: string): boolean {
  return message === LIFESTONE_TIE_CONFIRM_TEXT || message === PORTAL_TIE_CONFIRM_TEXT;
}

export interface PendingTieBind {
  spellId: number;
  targetGuid: number | null;
}

export interface TieBindPosition {
  cellId: number;
  x: number;
  y: number;
  z: number;
}

export type TieBindAction =
  | ({ kind: 'lifestone' } & TieBindPosition)
  | ({ kind: 'portalOne' } & TieBindPosition)
  | ({ kind: 'portalTwo' } & TieBindPosition);

/**
 * Resolve the bind action for a SendChatMessage confirmation, given the Tie
 * spell our own HearSpeech echo just confirmed (`pending`) and the Tie
 * target's already-world-converted position. Returns undefined when
 * `message` isn't a Tie confirmation at all, or when it doesn't match the
 * pending cast's spell (e.g. a lifestone confirmation while a portal Tie
 * was pending — shouldn't happen against a real server, but fails closed
 * rather than binding the wrong subsystem).
 */
export function resolveTieBindConfirmation(
  pending: PendingTieBind,
  message: string,
  targetPosition: TieBindPosition,
): TieBindAction | undefined {
  if (message === LIFESTONE_TIE_CONFIRM_TEXT && pending.spellId === SPELLID_LIFESTONE_TIE1) {
    return { kind: 'lifestone', ...targetPosition };
  }
  if (message === PORTAL_TIE_CONFIRM_TEXT && pending.spellId === SPELLID_PORTAL_TIE1) {
    return { kind: 'portalOne', ...targetPosition };
  }
  if (message === PORTAL_TIE_CONFIRM_TEXT && pending.spellId === SPELLID_PORTAL_TIE2) {
    return { kind: 'portalTwo', ...targetPosition };
  }
  return undefined;
}
