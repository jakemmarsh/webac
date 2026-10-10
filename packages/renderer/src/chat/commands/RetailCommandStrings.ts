/**
 * string2command @ 006b4c20: a motion command by name, case-insensitive,
 * whole-string (`_strnicmp(name, s, strlen(name) + 1)`), first match wins,
 * 0 for none. ClientCommunicationSystem::Pose resolves a ChatPoseTable
 * pose's command ("WARMHANDS", "AFKSTATE", …) through it.
 *
 * The names → ids come from our MotionCommand table (ACE MotionCommand.cs),
 * NOT the decompiled exe's command_strings / command_ids @ 0x803df0 /
 * 0x804450. That exe is the September 2013 build (ac1_sep13). From
 * ClosestPlayer (0x09000114) on, its ids sit 3 below the end-of-retail
 * DATs (2017) we run: e.g. Motion_AFKState = 0x43000118 there, but the human
 * motion table 0x09000001 keys its AFK / Meditate / Curtsey / SnowAngel
 * cycles at 0x11b / 0x11c / 0x11a / 0x118, the ACE numbering, with nothing
 * at 0x115–0x117. Three commands were inserted after the 2013 build, so the
 * DAT-consistent table is the one that plays the right motion.
 */
import { MotionCommand } from '../../animation/MotionCommands.js';

const BY_NAME: ReadonlyMap<string, number> = new Map(
  Object.entries(MotionCommand).map(([name, id]) => [name.toLowerCase(), id >>> 0]),
);

/** string2command: the motion command id for a name (case-insensitive, exact), 0 when none. */
export function string2command(name: string): number {
  return BY_NAME.get(name.toLowerCase()) ?? 0;
}
