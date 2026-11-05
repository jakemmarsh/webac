/**
 * BUG.ac1999-auto-turn-to-mobs (webac#20): whether the client may appraise something on its own, a
 * look the player did not ask for (the agent API's level looks at a monster coming at you, Mag-Tools'
 * "my kill?" corpse check, UtilityBelt's nametag assessor, a routine's door ID).
 *
 * The AC1999 server turns the appraiser to face what they appraised: CClientEvents::Identify →
 * TurnToAppraiseTarget (reference/ac1999/Server/Source/ClientEvents.cpp) sends a TurnToObject toward
 * the target's top-level object in the world, as 1999 retail did until the 2002-07 Repercussions patch
 * ("Characters no longer turn towards a target when they try to Appraise it"). It skips your own
 * inventory and gear, and turns nothing while you are busy. So every background look at a monster
 * turned the player toward it, and a running player stopped to turn (webac#20). The 1999 client never
 * appraised on its own: CM_Item::Event_Appraise @ 0x005adca0 is reached only from ExaminePanel::
 * ExamineObject @ 0x005096d0 (the player's examine, or a new selection while the panel examines) and
 * the panel's release paths (ExamineSpell, @ 0x00509650), which send no object; the FellowPanel's
 * appraisal of a fellow follows the player's click on its row. None of those pass through here.
 *
 * End of retail and Dark Majesty (ACE / GDLE) turn nothing, but ACE keeps ONE appraisal target per
 * player (Player.HandleActionIdentifyObject: RequestedAppraisalTarget / CurrentAppraisalTarget): a
 * background look while the Examine window is open takes it, so the window's next re-appraisal
 * (gmExaminationUI::UseTime @ 004ab530) rolls Assess again and can come back failed, then rate-limited
 * for 5 s. While that window is open, background looks wait.
 *
 * Objects you carry, wear, have open (a corpse you loot: you stand at it) or are buying stay allowed
 * in every era: the server turns nothing for them, or you already face them.
 */
import { type TargetLocations } from '@ac/shared';

export interface BackgroundAppraisalContext {
  selfGuid: number | null;
  where: TargetLocations;
  /** The era's server turns the appraiser toward a world object (EraWorldRules.appraisalTurnsAppraiser). */
  turnsAppraiser: boolean;
  /** The player's own Examine window is up (it holds the server's one appraisal target). */
  examineOpen: boolean;
}

/** 'send', or why the look is not sent. */
export type BackgroundAppraisalVerdict = 'send' | 'turns-player' | 'examine-open';

export function backgroundAppraisalVerdict(guid: number, ctx: BackgroundAppraisalContext): BackgroundAppraisalVerdict {
  const g = guid >>> 0;
  const { where } = ctx;
  if (ctx.selfGuid !== null && g === ctx.selfGuid >>> 0) return 'send';
  if (where.inPack(g) || where.worn(g) || where.inOpenContainer(g) || where.forSale?.(g)) return 'send';
  // Not known anywhere: the send path's own resolve gate drops it (sendIdentifyAction).
  if (!where.inWorld(g)) return 'send';
  if (ctx.turnsAppraiser) return 'turns-player';
  if (ctx.examineOpen) return 'examine-open';
  return 'send';
}
