/**
 * TELEMETRY.portal-use-failed — a portal the player tried that did nothing.
 *
 * A Levistras player (an ACE server with custom content) reported that the
 * exit portal of the custom "Scrivener's Annex" dungeon (landblock 0x0135)
 * did nothing, and logged in inside the annex twice. The stock exit portal
 * there works in our client (verified on local ACE, 2026-10-21), and we cannot
 * see that server's custom portal data. This event is what explains the next
 * "portal does nothing", for any player on any server.
 *
 * A watch starts when the player tries a portal (an object whose
 * ObjectDescriptionFlag has Portal 0x40000 or whose ItemType has Portal
 * 0x10000):
 * - `use`: a Use on it (double-click, the Use key or button, ac_use), whether
 *   or not the client sent the Use (`useSent` false + `held` say why not);
 * - `walk_in`: the player's body began to touch the portal's physics shape
 *   (main.ts, each 100 ms: the body's Setup spheres against the portal's —
 *   bodyTouchesPortal, the sphere-sphere test a server transition makes —
 *   else, with either shape unknown, the body's middle within the portal's
 *   part-array reach). `closest` is the body's nearest horizontal approach to
 *   the portal's centre during the watch.
 *
 * GDLE (Dark Majesty) has no Use for a walk-in: the portal acts only when the
 * server's own transition of the player sweeps the player's spheres into the
 * portal's (CPhysicsObj::report_object_collision → CPortal::DoCollision), and
 * the server learns where we are from a MoveToState (a swept transition),
 * a once-a-second AutonomousPosition (SetPositionSimple: a placement at the
 * point, no sweep) and its own simulation between them. A walk-in the server
 * never collided with ends here as a failure with no WeenieError
 * (BUG.gdle-walkin-portal-silent, progress.md 2026-10-24).
 *
 * It ends well when the server teleports us (PlayerTeleport 0xF751, which
 * starts portal space): one light `portal_used` with the ms from the try to
 * the teleport. With no teleport within PORTAL_REPLY_MS of the last sign of
 * progress (the try, a UseDone, a step of the server's walk to the portal)
 * it ends as one `portal_use_failed`, carrying what came back meanwhile: the
 * UseDone code, every WeenieError code, and the first server chat line about
 * portals as a template.
 *
 * PORTAL_REPLY_MS (5 s): ACE runs a portal's use as soon as the player is in
 * range (Portal.cs ActOnUse → WorldManager.ThreadSafeTeleport → Player.Teleport,
 * which sends PlayerTeleport at once, or 1 s later when it first clears fog:
 * Player_Location.cs Teleport), and a refusal comes back as a WeenieError from
 * Portal.cs CheckUseRequirements at the same moment. Portal.cs's own
 * minTimeSinceLastPortal is 3.5 s (a second try inside it after a refusal gets
 * no answer at all). Five seconds covers the fog delay and a slow link
 * without folding two tries into one; the server's walk extends the wait
 * while the player is still moving, up to PORTAL_MAX_WAIT_MS.
 *
 * Limits: one event per portal per PORTAL_RATE_MS (a player walking back and
 * forth through a dead portal reports it once a minute), at most
 * MAX_FAILED_EVENTS / MAX_USED_EVENTS per page.
 *
 * Privacy (the pre-world reporter's rules): numbers, booleans, closed tokens.
 * No object or player name. Chat is reduced to a template (digits → '#') and
 * only for a server line that speaks of portals, teleporting, a destination,
 * a quest or a recall; any other line is only counted.
 *
 * Transport: the world reporter's route, `POST /client-preworld`, logged by
 * the bridge as `client_world` (services/ws-tcp-bridge/src/clientWorld.ts).
 * Eras: all three; the inputs (Use, UseDone, WeenieError, PlayerTeleport) are
 * the same messages from ACE, GDLE and the AC1999 server.
 *
 * BUG.portal-walk-in-nothing (2026-11-03): 7 days of production counted ~49
 * failures against ~730 uses, and every one but three was a portal acting as
 * retail made it act:
 * - (a use the client itself refused, held 'decided' on an ItemUseable-No
 *   portal such as wcid 28709 "Destroyed Portal to Sanamar", is a refusal too.)
 * - 31 were the server's answer: a WeenieError (0x0474 quest, 0x04AB level,
 *   0x0592 account age; ACE Portal.cs CheckUseRequirements) or the AC1999
 *   server's chat line ("You are not powerful enough to interact with that
 *   portal!"), each shown to the player. They now end as `portal_refused`.
 * - 15 were walk-ins into a portal that cannot act on a walk-in: "Gateway"
 *   (wcid 1955, PhysicsState Ethereal | LightingOn, its Use text "You must use
 *   this portal to activate it. Walking through the portal will not activate
 *   it.") and portals with IgnoreCollisions. A collision reaches the portal's
 *   weenie only when the portal has ReportCollisions and the mover lacks
 *   IgnoreCollisions (retail CPhysicsObj::report_object_collision @ 0x00513060:
 *   `(obj->state & 0x8) && !(this->state & 0x10)`; ACE PhysicsObj.cs
 *   report_object_collision → Portal.OnCollideObject), and an object with
 *   IgnoreCollisions is never a collision candidate (ACE PhysicsObj.cs
 *   FindObjCollisions). Those walk-ins are no try (walkInActs).
 * - 2 were a use the player walked away from (their own movement keys after
 *   the server's walk began) or died during; the player's own movement no
 *   longer extends the wait, a use the player walked off from without
 *   reaching the portal is dropped, and a death drops the watch.
 *
 * BUG.portal-refusal-before-watch (2026-11-06): a refusal can land just before the watch starts.
 * Coldeve (ACE), trace c9340448a5d0ec95: a walk-in into wcid 1307 drew 0x04A7 "You have been
 * teleported too recently!" (shown in chat) at 13:22:20.541, and the walk-in watch began 6 ms later
 * (waitedMs 5065 before 13:22:25.612). weenieError() kept codes only while a watch ran, so the refusal
 * was dropped and the walk-in reported `portal_use_failed` with weenieErrors []. A server collision can
 * beat ours: the body touch is checked every 100 ms on the render loop (a long frame delays it), and
 * the server's transition reaches about 0.1 m wider than bodyTouchesPortal (progress.md 2026-11-03).
 * A portal refusal with no watch running is now held for PORTAL_EARLY_REFUSAL_MS and the next watch
 * that starts takes it (refusalLeadMs says how early it came). It is taken once, only by a watch that
 * starts (a walk-in into a portal that cannot act on walk-ins starts none), only for a portal refusal
 * proper (PORTAL_REFUSAL_CODES or a portal chat line), never one heard before the overlap baseline
 * (portal space, entry), and a teleport or a world change drops it. ITeleported 0x003C, ACE's notice
 * after every portal teleport (Portal.cs ActOnUse), is no refusal in a watch either.
 *
 * BUG.portal-walkin-without-moving (2026-11-06): a touch the player's own movement did not make is no try.
 * Coldeve (ACE), build 20ff651c6: a walk-in watch on wcid 42155 (PhysicsState 0xC0C, ReportCollisions) in
 * cell 0x8a020111 reported `portal_use_failed` with playerMoved false, movesSent 0, serverMoves 0, sends 0:
 * the body never moved; something else closed the distance (the portal arriving into view, a placement).
 * Retail and ACE collide a mover with a portal only during the mover's own transition (report_object_collision
 * runs from the mover's transition; progress.md 2026-11-03: "teleloc onto a 1087 → nothing while standing,
 * teleported on the first step"). main.ts now tells overlaps() whether the player's own movement moved the
 * body since the last check (ownMovementTouch: the body moved, no server placement, and keys, the server's
 * walk, a jump / fall or a MoveToState drove it). A touch without it starts no watch and stays a pending
 * touch: the first own step while still touching starts the watch, as that step is the server's collision.
 *
 * BUG.portal-rim-brush-telemetry (2026-11-08): the server collides on the path it is TOLD, not on the body.
 * Prod (trace 02fe566b3f8f77e2, wcid 24230 Deeper Catacombs in the Lair of Death 0x01AA): a walk-in with
 * dist 2.5, endDist 2.2, closest 1.78, overlapped, playerMoved, no teleport, no WeenieError. The body
 * touched (bodyTouchesPortal reaches 1.835 m for a human) but the server never collided. Live on local ACE,
 * same portal: standing still inside the rim (teleloc to 1.70 / 1.78 / 1.85 / 1.92 m) does nothing, backing
 * straight out from any of them does nothing even at 1.70, strafing along the rim teleports at every one up
 * to 1.92, and a normal walk-in teleports. ACE sweeps the player between the positions it is sent (each
 * MoveToState through SetRequestedLocation, GameActionMoveToState.cs:33, and an AutonomousPosition about
 * once a second; Player_Tick.cs UpdatePlayerPosition) and reports a collision only for a move into or along
 * the portal's sphere, never one leaving it. A body that reaches the rim between two sent positions and
 * turns away is a collision the server never had. Retail's DoCollision (0x0058c3a0) sends nothing on a
 * walk-in either: this is retail behaviour. The watch now follows the path the server was sent
 * (positionSent / positionPlaced from MovementSync and the server's placements) and, when no segment of it
 * came within the server's collision reach (sentPathReach: the same Setup spheres bodyTouchesPortal uses
 * plus SERVER_REACH_TOLERANCE_M), a silent walk-in ends as `portal_rim_brush` (every field kept, plus
 * `sentClosest` / `sentReached`). A silent walk-in whose sent path DID come inside stays `portal_use_failed`.
 * Era-neutral: ACE, GDLE and the AC1999 server all learn our position only from these two messages.
 */
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';

export const PORTAL_OUTCOMES = ['portal_use_failed', 'portal_refused', 'portal_cancelled', 'portal_rim_brush', 'portal_used'] as const;
export type PortalOutcome = typeof PORTAL_OUTCOMES[number];

/** How the player tried the portal. */
export const PORTAL_TRIGGERS = ['use', 'walk_in'] as const;
export type PortalTrigger = typeof PORTAL_TRIGGERS[number];

/**
 * Why the client did not send a Use it was asked for (main.ts sendUseActionNow):
 * the target no longer resolves (GAP.88), the inventory-request gate refused it
 * (a pending request or an attack), or UseObject decided no Use goes out.
 */
export const PORTAL_USE_HELD = ['stale', 'busy', 'decided'] as const;
export type PortalUseHeld = typeof PORTAL_USE_HELD[number];

/** ObjectDescriptionFlag.Portal (ACE ObjectDescriptionFlag.cs) and ItemType.Portal (ItemType.cs). */
export const ODF_PORTAL = 0x00040000;
export const ITEM_TYPE_PORTAL = 0x00010000;
/** PhysicsState bits (ACE PhysicsState.cs). */
const PS_ETHEREAL = 0x4;
const PS_REPORT_COLLISIONS = 0x8;
const PS_IGNORE_COLLISIONS = 0x10;
const PS_REPORT_COLLISIONS_AS_ENVIRONMENT = 0x200000;
/** WeenieError.ActionCancelled: the server's walk was cancelled (no refusal). */
export const WEENIE_ERROR_ACTION_CANCELLED = 0x0036;
/** WeenieError.ITeleported: ACE's notice after a portal teleport (Portal.cs ActOnUse callback), no refusal. */
export const WEENIE_ERROR_I_TELEPORTED = 0x003c;

/**
 * The WeenieErrors a portal sends refusing a try (ACE Portal.cs CheckUseRequirements and
 * QuestManager.HandlePortalQuestError; ClassicACE's Portal.cs sends the same codes). Only these, or a
 * portal chat line (GDLE Portal.cpp CheckedTeleport and the AC1999 server's Portal.cpp refuse in
 * chat), are held for a watch that has not started yet: any other code is some other request's answer.
 */
export const PORTAL_REFUSAL_CODES: ReadonlySet<number> = new Set([
  0x0446, // QuestSolvedTooLongAgo
  0x045c, // PKsMayNotUsePortal
  0x045d, // NonPKsMayNotUsePortal
  0x0474, // YouMustCompleteQuestToUsePortal
  0x04a7, // YouHaveBeenTeleportedTooRecently
  0x04a8, // YouMustBeAnAdvocateToUsePortal
  0x04aa, // PlayersMayNotUsePortal
  0x04ab, // YouAreNotPowerfulEnoughToUsePortal
  0x04ac, // YouAreTooPowerfulToUsePortal
  0x04cc, // YouHaveBeenInPKBattleTooRecently
  0x04f3, // PKLiteMayNotUsePortal
  0x0554, // MustPurchaseThroneOfDestinyToUsePortal
  0x058f, // OnlyOlthoiMayUsePortal
  0x0590, // OlthoiMayNotUsePortal
  0x0591, // YouMayNotUsePortalWithVitae
  0x0592, // YouMustBeTwoWeeksOldToUsePortal
]);

/**
 * How long a portal refusal heard with no watch running waits for one to start (BUG.portal-refusal-before-watch).
 * Production: 6 ms early. The touch check runs every 100 ms from the render loop, so a frame hitch
 * (streaming after an arrival) can push it out by most of a second; 2 s covers that and stays well
 * inside ACE's 3.5 s minTimeSinceLastPortal, so it never reaches a try the server would answer afresh.
 */
export const PORTAL_EARLY_REFUSAL_MS = 2_000;

export const PORTAL_REFUSED = 'portal_refused' as const;
/**
 * BUG.portal-use-held-keys: the player's own movement event (a MoveToState) went out while a Use was
 * unanswered. ACE cancels the server's walk on any MoveToState (GameActionMoveToState.cs:
 * StopExistingMoveToChains while IsPlayerMovingTo; the next MoveToChain poll, Player_Move.cs, calls back
 * false → Player_Use.cs TryUseItem(item, false) → UseDone(None), no teleport). Retail sends one only for
 * a fresh movement input (CommandInterpreter::HandleKeyboardCommand @ 0x006b3690 → TakeControlFromServer
 * @ 0x006b32d0); a key merely held does not (UseTime @ 0x006b3bf0 waits for the MoveTo to end).
 */
export const PORTAL_CANCELLED = 'portal_cancelled' as const;

/**
 * A portal whose PhysicsState lets a walk-in reach it: ReportCollisions set, IgnoreCollisions and
 * ReportCollisionsAsEnvironment clear (retail CPhysicsObj::report_object_collision @ 0x00513060; ACE
 * PhysicsObj.cs report_object_collision / FindObjCollisions). "Gateway" (wcid 1955, 0x804) is not one:
 * it must be used. The same flags come from ACE, GDLE and the AC1999 server.
 */
export function walkInActs(physicsState: number): boolean {
  const ps = Number.isFinite(physicsState) ? physicsState >>> 0 : 0;
  return (ps & PS_REPORT_COLLISIONS) !== 0 && (ps & (PS_IGNORE_COLLISIONS | PS_REPORT_COLLISIONS_AS_ENVIRONMENT)) === 0;
}

/** The least body displacement (m) between two portal checks that counts as the body moving (float noise below). */
export const OWN_MOVE_MIN_M = 0.01;

/** What main.ts knows about the body between two 100 ms portal checks (BUG.portal-walkin-without-moving). */
export interface OwnMovementSample {
  /** How far the body moved since the last check (m); 0 when there was no last check. */
  displacedM: number;
  /** The server placed the body since the last check (a forced position, a teleport arrival, a correction blend). */
  placed: boolean;
  /** The player's movement keys (or autorun) are held. */
  keys: boolean;
  /** The server's MoveTo (or the melee approach) is moving the player. */
  serverWalk: boolean;
  /** The body is in a jump or a fall. */
  airborne: boolean;
  /** A MoveToState went out since the last check. */
  moveSent: boolean;
}

/**
 * The player's own movement moved the body since the last check: the only motion a server transition sweeps
 * into a portal (CPhysicsObj::report_object_collision @ 0x00513060 runs from the mover's own transition).
 * A body that moved with no movement of its own (a placement, an unexplained shift) or a body standing still
 * while something else closed the distance is not.
 */
export function ownMovementTouch(m: OwnMovementSample): boolean {
  if (m.placed || !Number.isFinite(m.displacedM) || m.displacedM < OWN_MOVE_MIN_M) return false;
  return m.keys || m.serverWalk || m.airborne || m.moveSent;
}

export const PORTAL_REPLY_MS = 5_000;
export const PORTAL_MAX_WAIT_MS = 30_000;
export const PORTAL_RATE_MS = 60_000;
export const MAX_FAILED_EVENTS = 20;
export const MAX_USED_EVENTS = 30;
/** WeenieError codes kept per event. */
export const MAX_ERROR_CODES = 4;
/** A chat template's longest. */
export const MAX_TEMPLATE_CHARS = 96;

/** A portal object as the client sees it. */
export function isPortalObject(o: { itemType?: number; objectDescFlags?: number } | null | undefined): boolean {
  if (!o) return false;
  return (((o.objectDescFlags ?? 0) & ODF_PORTAL) !== 0) || (((o.itemType ?? 0) & ITEM_TYPE_PORTAL) !== 0);
}

/**
 * The player's body overlaps a portal's shape: horizontal distance within the portal's reach plus the
 * body's radius (touching counts: a solid portal stops the body at its edge), and the portal's base
 * between 1.5 m below the feet and 2 m above them. Render-frame metres.
 */
export function overlapsPortal(horizontalM: number, portalBaseAboveFeetM: number, reachM: number, bodyRadiusM: number): boolean {
  if (!Number.isFinite(horizontalM) || !Number.isFinite(portalBaseAboveFeetM)) return false;
  return horizontalM <= Math.max(0, reachM) + bodyRadiusM + 0.05 && portalBaseAboveFeetM >= -1.5 && portalBaseAboveFeetM <= 2;
}

/**
 * The body touches the portal the way a server transition finds it: any of the body's Setup spheres
 * within (radius sum) of any of the portal's, centres at the objects' origins plus each sphere's height
 * (both Setups' spheres sit on the vertical axis: the portal 0x020001B3 and the heritage bodies).
 * `portalBaseAboveFeetM` = the portal's origin height minus the feet. Empty shapes never touch.
 */
export function bodyTouchesPortal(
  horizontalM: number, portalBaseAboveFeetM: number,
  body: readonly { z: number; radius: number }[], portal: readonly { z: number; radius: number }[],
): boolean {
  if (!Number.isFinite(horizontalM) || !Number.isFinite(portalBaseAboveFeetM)) return false;
  for (const b of body) {
    for (const p of portal) {
      const dz = portalBaseAboveFeetM + p.z - b.z;
      if (Math.hypot(horizontalM, dz) <= b.radius + p.radius) return true;
    }
  }
  return false;
}

/** A point in the server's frame: east, north, up (m), landblock × 192 m + the cell-local offset. */
export interface SentPoint { x: number; y: number; z: number }

/** The server frame of a cell id + its local origin (a dungeon's cells share their landblock's frame). */
export function serverFramePoint(cellId: number, x: number, y: number, z: number): SentPoint {
  return { x: ((cellId >>> 24) & 0xff) * 192 + x, y: ((cellId >>> 16) & 0xff) * 192 + y, z };
}

/**
 * BUG.portal-rim-brush-telemetry — how much wider the server's collision reaches than bodyTouchesPortal
 * (progress.md 2026-11-03: about 0.1 m; live 2026-11-08, a strafe along the rim of 24230 teleported at 1.92 m
 * against the 1.835 m body touch).
 */
export const SERVER_REACH_TOLERANCE_M = 0.1;
/**
 * A sent segment that starts nearest the portal and leaves it at more than this cosine to the outward
 * direction is a move out of the overlap: ACE reports no collision for it (live 2026-11-08: backing straight
 * out from 1.70 m never teleported; a strafe along the rim, cosine ~0, always did).
 */
export const SENT_OUTWARD_COS = 0.5;

/** One sent segment against a portal: its nearest horizontal approach, and whether the server's sweep reaches the portal on it. */
export interface SentSegmentReach { closest: number; reached: boolean }

/**
 * The server's swept move from `a` to `b` (two positions it was sent, body origins) against the portal at
 * `portal`: `closest` = the segment's nearest horizontal approach to the portal's centre (comparable with
 * the body's `closest`); `reached` = some pair of the body's and the portal's Setup spheres (the shapes
 * bodyTouchesPortal tests, on the vertical axis) comes within their radius sum + SERVER_REACH_TOLERANCE_M on
 * the way, moving in or along (a chord that dips inside counts even with both ends outside), not leaving
 * an overlap it started in. A segment with no length is no move (standing still collides with nothing).
 * With either shape unknown, the portal's part-array `fallbackReach` stands in, horizontally.
 */
export function sentPathReach(
  a: SentPoint, b: SentPoint, portal: SentPoint,
  body: readonly { z: number; radius: number }[] | null | undefined,
  portalSpheres: readonly { z: number; radius: number }[] | null | undefined,
  fallbackReach: number,
): SentSegmentReach {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  // Horizontal nearest approach.
  const h2 = dx * dx + dy * dy;
  const th = h2 > 0 ? Math.min(1, Math.max(0, ((portal.x - a.x) * dx + (portal.y - a.y) * dy) / h2)) : 0;
  const closest = Math.hypot(a.x + th * dx - portal.x, a.y + th * dy - portal.y);
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-4)) return { closest, reached: false };
  const pairs: { off: number; r: number; horizontal: boolean }[] = [];
  if (body?.length && portalSpheres?.length) {
    for (const s of body) for (const p of portalSpheres) pairs.push({ off: p.z - s.z, r: s.radius + p.radius + SERVER_REACH_TOLERANCE_M, horizontal: false });
  } else {
    pairs.push({ off: 0, r: Math.max(0, fallbackReach) + SERVER_REACH_TOLERANCE_M, horizontal: true });
  }
  let reached = false;
  for (const pr of pairs) {
    // The body sphere's centre moves a → b (offset by its height); the portal sphere's centre is fixed.
    const qx = portal.x - a.x, qy = portal.y - a.y, qz = pr.horizontal ? 0 : portal.z + pr.off - a.z;
    const sz = pr.horizontal ? 0 : dz;
    const l2 = dx * dx + dy * dy + sz * sz;
    if (!(l2 > 1e-8)) continue;
    const t = Math.min(1, Math.max(0, (qx * dx + qy * dy + qz * sz) / l2));
    const d = Math.hypot(a.x + t * dx - portal.x, a.y + t * dy - portal.y, pr.horizontal ? 0 : a.z + t * dz - (portal.z + pr.off));
    if (d > pr.r) continue;
    if (t > 0) { reached = true; break; }
    // Nearest at the start: a move along the rim counts, a move out of the overlap does not.
    const out = Math.hypot(qx, qy, qz);
    const cos = out > 1e-6 ? -(qx * dx + qy * dy + qz * sz) / (out * Math.sqrt(l2)) : 1;
    if (cos <= SENT_OUTWARD_COS) { reached = true; break; }
  }
  return { closest, reached };
}

/** A server chat line worth a template: it speaks of portals or teleports. */
const PORTAL_CHAT = /portal|teleport|destination|quest|recall|summon/i;

/** A chat line as a template: printable ASCII, every number (hex too) as '#', at most MAX_TEMPLATE_CHARS; null when not about portals. */
export function chatTemplate(text: string): string | null {
  if (!PORTAL_CHAT.test(text)) return null;
  const t = text
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/[0-9]+(?:\.[0-9]+)?/g, '#')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEMPLATE_CHARS);
  return t || null;
}

/** What main.ts reads off a portal and the player, at the try and at the end. */
export interface PortalSnapshot {
  wcid: number;
  itemType: number;
  descFlags: number;
  physicsState: number;
  useRadius: number;
  /** The portal's part-array radius (agent fixtureReach), m. */
  reach: number;
  /** Player → portal in the server's frame: east, north, up (m); null when either position is unknown. */
  rel: { dx: number; dy: number; dz: number } | null;
  playerCell: number | null;
  portalCell: number | null;
  /** BUG.portal-rim-brush-telemetry — the portal's origin in the server's frame (serverFramePoint); null/absent = unknown. */
  portalAt?: SentPoint | null;
  /** The player's and the portal's Setup spheres (the shapes bodyTouchesPortal tests); absent = unknown. */
  bodySpheres?: readonly { z: number; radius: number }[] | null;
  portalSpheres?: readonly { z: number; radius: number }[] | null;
}

interface Ids { era: string; server: string | null; trace: string; build: string }

export interface PortalUseFailedEvent extends Ids {
  /**
   * `portal_refused`: the server answered the try with a refusal (a WeenieError, a portal chat line).
   * `portal_cancelled`: no refusal, and the player's own movement event went out while a Use was unanswered
   * (PORTAL_CANCELLED: ACE ends the walk and the use on it).
   * `portal_rim_brush`: a silent walk-in whose SENT path never came within the server's collision reach
   * (BUG.portal-rim-brush-telemetry): the body brushed the rim between positions the server was told.
   */
  outcome: 'portal_use_failed' | 'portal_refused' | 'portal_cancelled' | 'portal_rim_brush';
  trigger: PortalTrigger;
  wcid: number;
  itemType: number;
  descFlags: number;
  physicsState: number;
  ethereal: boolean;
  reportCollisions: boolean;
  /** m, 0.01. */
  useRadius: number;
  reach: number;
  /**
   * Player → portal at the try, server frame (east, north, up), m 0.1; and the horizontal distance at the
   * try and at the end. "Player" is the last AutonomousPosition sent (where the server was last told we
   * are), not the body: walking in, it trails the body by up to a second of running.
   */
  dx: number | null;
  dy: number | null;
  dz: number | null;
  dist: number | null;
  endDist: number | null;
  /** Cells, 8 hex digits: the player's at the try and the portal's. */
  playerCell: string | null;
  portalCell: string | null;
  /** The client sent a Use; when it did not for a use, why (PORTAL_USE_HELD). */
  useSent: boolean;
  held: PortalUseHeld | null;
  /** Uses of this portal during the watch (a player double-clicking again counts). */
  attempts: number;
  /** The body overlapped the portal at some point during the watch. */
  overlapped: boolean;
  /** The body's closest horizontal approach to the portal's centre during the watch, m 0.01; null = not measured. */
  closest: number | null;
  /** The server moved the player during the watch (its MoveTo toward the portal). */
  serverWalk: boolean;
  /** The player's own movement keys moved them during the watch. */
  playerMoved: boolean;
  /** The UseDone code that came back (0 = done, no error); null = no UseDone. */
  useDone: number | null;
  /** Uses the client sent (of `attempts`), and those it held because a request was pending ('busy'). */
  sends: number;
  busyHeld: number;
  /** Server movements of the player during the watch (MoveToPosition / MoveToObject / TurnTo). */
  serverMoves: number;
  /** Movement input (a key in a movement list, or autorun) was held when the first Use went out; null = none went out. */
  keysAtSend: boolean | null;
  /** The player's own movement events (MoveToState) sent while a Use was unanswered (after its send, before a UseDone). */
  movesSent: number;
  /** UseDones in the watch, and ms from the first Use sent to the first UseDone. */
  useDones: number;
  firstUseDoneMs: number | null;
  /** WeenieError / WeenieErrorWithString codes that came back, in order. */
  weenieErrors: number[];
  /** Server chat lines in the watch, the first portal line's ChatMessageType and template. */
  chatLines: number;
  chatType: number | null;
  chatTemplate: string | null;
  /** From the try to the verdict. */
  waitedMs: number;
  /** A refusal that came before the watch began (PORTAL_EARLY_REFUSAL_MS): how many ms before; null = none. */
  refusalLeadMs: number | null;
  /**
   * BUG.portal-rim-brush-telemetry — the nearest horizontal approach (m 0.01) of the path the server was sent
   * (segments between consecutive MoveToState / AutonomousPosition positions, from the one before the watch
   * began), and whether it came within the server's collision reach (sentPathReach). null = no segment.
   */
  sentClosest: number | null;
  sentReached: boolean | null;
}

export const PORTAL_RIM_BRUSH = 'portal_rim_brush' as const;

export interface PortalUsedEvent extends Ids {
  outcome: 'portal_used';
  trigger: PortalTrigger;
  wcid: number;
  /** The try → PlayerTeleport (portal space starts). */
  ms: number;
  useSent: boolean;
  serverWalk: boolean;
  attempts: number;
}

export type PortalEvent = PortalUseFailedEvent | PortalUsedEvent;

export interface PortalUseReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  /** The portal and the player now; null when the object is gone. */
  snapshot: (guid: number) => PortalSnapshot | null;
  now?: () => number;
  send?: TelemetrySend;
}

interface Watch {
  guid: number;
  trigger: PortalTrigger;
  startedAt: number;
  progressAt: number;
  snap: PortalSnapshot;
  useSent: boolean;
  held: PortalUseHeld | null;
  attempts: number;
  overlapped: boolean;
  closest: number | null;
  serverWalk: boolean;
  playerMoved: boolean;
  /** The body touched the portal after the player's own movement began (a use walked into it). */
  overlappedAfterMove: boolean;
  useDone: number | null;
  errors: number[];
  chatLines: number;
  chatType: number | null;
  chatTemplate: string | null;
  sends: number;
  busyHeld: number;
  serverMoves: number;
  keysAtSend: boolean | null;
  movesSent: number;
  useDones: number;
  firstSendAt: number | null;
  firstUseDoneMs: number | null;
  /** A Use went out and no UseDone has come back since. */
  useOutstanding: boolean;
  refusalLeadMs: number | null;
  sentClosest: number | null;
  sentReached: boolean;
}

/** A portal refusal heard while no watch ran (BUG.portal-refusal-before-watch). */
interface EarlyRefusal {
  at: number;
  code: number | null;
  chatTemplate: string | null;
  chatType: number | null;
}

function safe<T>(f: (() => T) | undefined, fallback: T): T {
  if (!f) return fallback;
  try { return f(); } catch { return fallback; }
}
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const cellHex = (c: number | null): string | null => (c === null || !Number.isFinite(c) || c === 0 ? null : (c >>> 0).toString(16).padStart(8, '0'));
const horiz = (rel: PortalSnapshot['rel']): number | null => (rel ? r1(Math.hypot(rel.dx, rel.dy)) : null);
const u32 = (v: number): number => (Number.isFinite(v) ? v >>> 0 : 0);

export class PortalUseReporter {
  private readonly now: () => number;
  private readonly outbox: TelemetryOutbox;
  private watch: Watch | null = null;
  private failedSent = 0;
  private usedSent = 0;
  /** guid → when its last event went (the per-portal rate). */
  private readonly lastEventAt = new Map<number, number>();
  /** Portals the body overlapped at the last check; null = take the next check as the baseline (after a teleport, at entry). */
  private overlapping: Set<number> | null = null;
  /** A portal refusal that came with no watch running; the next watch to start within PORTAL_EARLY_REFUSAL_MS takes it. */
  private early: EarlyRefusal | null = null;
  /** BUG.portal-rim-brush-telemetry — the last two points of the path the server was told (prev → last is its latest swept move). */
  private prevSent: SentPoint | null = null;
  private lastSent: SentPoint | null = null;

  constructor(private readonly opts: PortalUseReporterOptions) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, this.now, true);
  }

  /** The portal under watch (tests, the agent trace). */
  get watching(): number | null { return this.watch?.guid ?? null; }

  /**
   * The player used `guid`. `sent` false with `held` = the client kept the Use. Not a portal: nothing.
   * A use of the portal already watched counts as another attempt and restarts the wait.
   */
  useAttempt(
    guid: number, o: { itemType?: number; objectDescFlags?: number } | null | undefined, sent: boolean,
    held: PortalUseHeld | null = null, keysHeld?: boolean,
  ): void {
    if (!isPortalObject(o)) return;
    const at = this.now();
    let w = this.watch;
    if (w && w.guid === guid >>> 0) {
      w.attempts++;
      w.progressAt = at;
      if (sent) { w.useSent = true; w.held = null; } else if (!w.useSent) w.held = held;
    } else {
      this.begin(guid, 'use', at, sent, sent ? null : held);
      w = this.watch;
      if (!w) return;
    }
    if (!sent) { if (held === 'busy') w.busyHeld++; return; }
    w.sends++;
    w.useOutstanding = true;
    if (w.firstSendAt === null) { w.firstSendAt = at; w.keysAtSend = keysHeld ?? null; }
  }

  /**
   * The client sent a MoveToState (MovementSync). While a Use is unanswered ACE cancels the use's walk on it
   * (PORTAL_CANCELLED).
   */
  movementSent(): void {
    const w = this.watch;
    if (!w || !w.useOutstanding) return;
    w.movesSent++;
  }

  /**
   * The portals the player's body overlaps now (main.ts, every 100 ms in the world). A portal newly
   * overlapped starts a walk-in watch unless one is running for it; the first check after a teleport or
   * a world entry only records where the body stands (arriving on a portal is no try).
   * `selfMoved` false (BUG.portal-walkin-without-moving): the player's own movement did not move the body
   * since the last check, so a new touch is no try. It starts no watch and is left out of the overlap
   * set, so the first check the body does move while still touching starts it.
   */
  overlaps(guids: Iterable<number>, selfMoved = true): void {
    const now = new Set<number>();
    for (const g of guids) now.add(g >>> 0);
    const before = this.overlapping;
    if (before === null) { this.overlapping = now; return; }
    for (const g of [...now]) {
      if (before.has(g)) continue;
      const w = this.watch;
      if (w && w.guid === g) {
        w.overlapped = true;
        if (w.playerMoved) w.overlappedAfterMove = true;
        w.progressAt = this.now();
        continue;
      }
      if (!selfMoved) { now.delete(g); continue; }
      this.begin(g, 'walk_in', this.now(), false, null);
    }
    this.overlapping = now;
  }

  /** The body's horizontal distance (m) to the portal under watch now (main.ts, each check); keeps the closest. */
  approach(guid: number, horizontalM: number): void {
    const w = this.watch;
    if (!w || w.guid !== guid >>> 0 || !Number.isFinite(horizontalM) || horizontalM < 0) return;
    if (w.closest === null || horizontalM < w.closest) w.closest = horizontalM;
  }

  /**
   * A position went out to the server (MoveToState or AutonomousPosition, server frame): the server sweeps the
   * player from the last one to it (BUG.portal-rim-brush-telemetry).
   */
  positionSent(p: SentPoint): void {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
    const pt = { x: p.x, y: p.y, z: p.z };
    if (this.lastSent) this.sentSegment(this.lastSent, pt);
    this.prevSent = this.lastSent;
    this.lastSent = pt;
  }

  /** The server placed the player (a teleport arrival, a forced position): the sent path starts again there, unswept. */
  positionPlaced(p: SentPoint | null): void {
    this.prevSent = null;
    this.lastSent = p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? { x: p.x, y: p.y, z: p.z } : null;
  }

  /**
   * One swept move the server was sent, against the watched portal. A use's watch carries it too (evidence for a
   * use the player then walked into themselves), but only a walk-in is judged on it (the server walks a use in).
   */
  private sentSegment(a: SentPoint, b: SentPoint): void {
    const w = this.watch;
    if (!w || !w.snap.portalAt) return;
    const r = sentPathReach(a, b, w.snap.portalAt, w.snap.bodySpheres, w.snap.portalSpheres, w.snap.reach);
    if (w.sentClosest === null || r.closest < w.sentClosest) w.sentClosest = r.closest;
    if (r.reached) w.sentReached = true;
  }

  /** The server moved the player (a MoveTo / MoveToPosition, our own movement event). */
  serverMovement(): void {
    const w = this.watch;
    if (!w) return;
    w.serverWalk = true;
    w.serverMoves++;
    w.progressAt = this.now();
  }

  /** UseDone came back (0 = done). */
  useDone(code: number): void {
    const w = this.watch;
    if (!w) return;
    if (w.useDone === null || code !== 0) w.useDone = u32(code);
    const at = this.now();
    w.progressAt = at;
    w.useDones++;
    w.useOutstanding = false;
    if (w.firstUseDoneMs === null && w.firstSendAt !== null) w.firstUseDoneMs = Math.max(0, Math.round(at - w.firstSendAt));
  }

  /** A WeenieError or WeenieErrorWithString came back (its code only). */
  weenieError(code: number): void {
    const w = this.watch;
    if (!w) {
      if (PORTAL_REFUSAL_CODES.has(u32(code))) this.hold({ code: u32(code), chatTemplate: null, chatType: null });
      return;
    }
    if (w.errors.length >= MAX_ERROR_CODES) return;
    w.errors.push(u32(code));
  }

  /** A server chat line (ServerMessage 0xF7E0): counted; the first portal line's template kept. */
  serverChat(text: string, chatType: number): void {
    const w = this.watch;
    if (!w) {
      const t = chatTemplate(text ?? '');
      if (t !== null) this.hold({ code: null, chatTemplate: t, chatType: u32(chatType) });
      return;
    }
    w.chatLines++;
    if (w.chatTemplate !== null) return;
    const t = chatTemplate(text ?? '');
    if (t !== null) { w.chatTemplate = t; w.chatType = u32(chatType); }
  }

  /** PlayerTeleport: the server took us (portal space starts). The watch ends well; overlaps re-baseline. */
  teleported(): void {
    this.overlapping = null;
    this.early = null;
    this.prevSent = null;
    this.lastSent = null;
    const w = this.watch;
    this.watch = null;
    if (!w) return;
    const at = this.now();
    if (!this.allowed(w.guid, at) || this.usedSent >= MAX_USED_EVENTS) return;
    this.usedSent++;
    this.post({
      outcome: 'portal_used', ...this.ids(), trigger: w.trigger, wcid: u32(w.snap.wcid),
      ms: Math.max(0, Math.round(at - w.startedAt)), useSent: w.useSent, serverWalk: w.serverWalk, attempts: w.attempts,
    });
  }

  /** Entered or left the world (any way): a watch from the last session is dropped unreported. */
  reset(): void {
    this.watch = null;
    this.overlapping = null;
    this.early = null;
    this.prevSent = null;
    this.lastSent = null;
  }

  /**
   * The verdict clock: main.ts calls it every 100 ms. `state.serverWalking` = the server's MoveTo is
   * moving the player now (it extends the wait); `state.playerMoving` = the player's own movement keys
   * (they never extend it: retail cancels a use's walk on a movement command); `state.dead` = the
   * player is dead (the watch is dropped: the try ended with the life).
   * A bare boolean is the old `moving` (server walk or keys), kept for callers that cannot tell them apart.
   */
  tick(state: boolean | { serverWalking: boolean; playerMoving: boolean; dead?: boolean }): void {
    this.outbox.retry();
    const w = this.watch;
    if (!w) return;
    const st = typeof state === 'boolean' ? { serverWalking: state, playerMoving: false, dead: false } : state;
    if (st.dead) { this.watch = null; return; }
    const at = this.now();
    if (st.playerMoving) w.playerMoved = true;
    if (st.serverWalking && w.serverWalk) w.progressAt = at;
    if (at - w.progressAt < PORTAL_REPLY_MS && at - w.startedAt < PORTAL_MAX_WAIT_MS) return;
    this.watch = null;
    // The player walked off from a use and never reached the portal: they changed their mind.
    if (w.trigger === 'use' && w.playerMoved && !w.overlappedAfterMove && !this.refused(w)) return;
    if (!this.allowed(w.guid, at) || this.failedSent >= MAX_FAILED_EVENTS) return;
    this.failedSent++;
    const end = safe(() => this.opts.snapshot(w.guid), null);
    const s = w.snap;
    const outcome = this.refused(w) ? PORTAL_REFUSED
      : w.trigger === 'use' && w.movesSent > 0 ? PORTAL_CANCELLED
      // BUG.portal-rim-brush-telemetry — the server was never sent a move that reaches the portal.
      : w.trigger === 'walk_in' && w.sentClosest !== null && !w.sentReached ? PORTAL_RIM_BRUSH
      : 'portal_use_failed';
    this.post({
      outcome, ...this.ids(), trigger: w.trigger,
      wcid: u32(s.wcid), itemType: u32(s.itemType), descFlags: u32(s.descFlags), physicsState: u32(s.physicsState),
      ethereal: (s.physicsState & PS_ETHEREAL) !== 0,
      reportCollisions: (s.physicsState & PS_REPORT_COLLISIONS) !== 0,
      useRadius: r2(Math.max(0, s.useRadius || 0)),
      reach: r2(Math.max(0, s.reach || 0)),
      dx: s.rel ? r1(s.rel.dx) : null,
      dy: s.rel ? r1(s.rel.dy) : null,
      dz: s.rel ? r1(s.rel.dz) : null,
      dist: horiz(s.rel),
      endDist: horiz(end?.rel ?? null),
      playerCell: cellHex(s.playerCell),
      portalCell: cellHex(s.portalCell),
      useSent: w.useSent,
      held: w.useSent ? null : w.held,
      attempts: w.attempts,
      overlapped: w.overlapped,
      closest: w.closest === null ? null : r2(w.closest),
      serverWalk: w.serverWalk,
      playerMoved: w.playerMoved,
      useDone: w.useDone,
      sends: w.sends,
      busyHeld: w.busyHeld,
      serverMoves: w.serverMoves,
      keysAtSend: w.keysAtSend,
      movesSent: w.movesSent,
      useDones: w.useDones,
      firstUseDoneMs: w.firstUseDoneMs,
      weenieErrors: [...w.errors],
      chatLines: w.chatLines,
      chatType: w.chatType,
      chatTemplate: w.chatTemplate,
      waitedMs: Math.max(0, Math.round(at - w.startedAt)),
      refusalLeadMs: w.refusalLeadMs,
      sentClosest: w.sentClosest === null ? null : r2(w.sentClosest),
      sentReached: w.sentClosest === null ? null : w.sentReached,
    });
  }

  /** online → retry; a hidden or leaving page sends what waits by beacon. */
  install(win: Pick<Window, 'addEventListener'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    this.outbox.install(win);
    win.addEventListener('pagehide', () => this.outbox.retry(true));
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.outbox.retry(true); });
  }

  /**
   * The try was answered with a refusal: a server WeenieError other than ActionCancelled, a portal chat
   * line, or the client's own UseObject refusing a use it never sent (held 'decided': "The Destroyed
   * Portal to Sanamar cannot be used", ItemUseable No; ItemHolder::UseObject @ 0x00588a80).
   */
  private refused(w: Watch): boolean {
    return w.errors.some((c) => c !== WEENIE_ERROR_ACTION_CANCELLED && c !== WEENIE_ERROR_I_TELEPORTED) || w.chatTemplate !== null
      || (!w.useSent && w.held === 'decided');
  }

  private begin(guid: number, trigger: PortalTrigger, at: number, sent: boolean, held: PortalUseHeld | null): void {
    const snap = safe(() => this.opts.snapshot(guid >>> 0), null);
    if (!snap) return;
    // A walk-in reaches only a portal that reports collisions (walkInActs); a Gateway must be used.
    if (trigger === 'walk_in' && !walkInActs(snap.physicsState)) return;
    this.watch = {
      guid: guid >>> 0, trigger, startedAt: at, progressAt: at, snap,
      useSent: sent, held, attempts: trigger === 'use' ? 1 : 0, overlapped: trigger === 'walk_in', closest: null,
      serverWalk: false, playerMoved: false, overlappedAfterMove: false,
      useDone: null, errors: [], chatLines: 0, chatType: null, chatTemplate: null,
      sends: 0, busyHeld: 0, serverMoves: 0, keysAtSend: null, movesSent: 0, useDones: 0,
      firstSendAt: null, firstUseDoneMs: null, useOutstanding: false, refusalLeadMs: null,
      sentClosest: null, sentReached: false,
    };
    // The server's latest swept move (into the last position sent) is part of this walk-in's path.
    if (this.prevSent && this.lastSent) this.sentSegment(this.prevSent, this.lastSent);
    // A portal refusal that beat the watch (BUG.portal-refusal-before-watch) is this try's answer: taken once.
    const e = this.early;
    this.early = null;
    if (!e || at - e.at > PORTAL_EARLY_REFUSAL_MS || at < e.at) return;
    const w = this.watch;
    if (e.code !== null) w.errors.push(e.code);
    if (e.chatTemplate !== null) { w.chatLines++; w.chatTemplate = e.chatTemplate; w.chatType = e.chatType; }
    w.refusalLeadMs = Math.round(at - e.at);
  }

  /**
   * Hold a portal refusal heard with no watch running. Not before the overlap baseline (portal space, an
   * entry: the notices around a teleport, "You have been teleported." among them, answer no try here).
   */
  private hold(r: Omit<EarlyRefusal, 'at'>): void {
    if (this.overlapping === null) return;
    this.early = { at: this.now(), ...r };
  }

  /** One event per portal per PORTAL_RATE_MS; records the send. */
  private allowed(guid: number, at: number): boolean {
    const last = this.lastEventAt.get(guid);
    if (last !== undefined && at - last < PORTAL_RATE_MS) return false;
    this.lastEventAt.set(guid, at);
    if (this.lastEventAt.size > 256) {
      for (const [g, t] of this.lastEventAt) if (at - t >= PORTAL_RATE_MS) this.lastEventAt.delete(g);
    }
    return true;
  }

  private ids(): Ids {
    return { era: safe(this.opts.era, 'unknown'), server: safe(this.opts.server, null), trace: this.opts.trace, build: this.opts.build };
  }

  private post(ev: PortalEvent): void {
    if (!this.opts.endpoint) return;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
