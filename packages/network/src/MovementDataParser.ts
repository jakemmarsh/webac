import { MovementStateFlag, MovementType } from '@ac/shared';

/**
 * Shared decoder for ACE's MovementData wire structure — the payload of
 * MovementEvent (0xF74C, header form) and of the PhysicsDesc Movement blob
 * inside CreateObject/LoginCharacter (headerless form).
 *
 * BUG.createobject-movement-placement-skipped — extracted from
 * ServerObjectManager.handleMovementEvent so CreateObject can parse the
 * same bytes instead of `r.skip(movLen)`-ing them. ACE writes the two
 * forms with the same serializer, gated on a `header` bool:
 *
 *   MovementData.cs `Write(this BinaryWriter, MovementData, bool header)`:
 *     if (header):                       // 0xF74C only
 *       movement_timestamp: uint16
 *       server_control_timestamp: uint16
 *       autonomous: uint8
 *       padding to DWORD (1 byte)
 *     movement_type: uint8               // MovementType (0 = Invalid)
 *     motion_flags: uint8                // bit 0x1 = StickToObject
 *     style: uint16                      // MotionStance low 16 bits
 *     <type-specific section>
 *
 *   WorldObject_Networking.cs SerializePhysicsData writes the CreateObject
 *   blob via `writer.Write(movementData, false)` — header=false — inside a
 *   uint32 length prefix, followed (when length > 0) by uint32 IsAutonomous.
 *
 * Type-specific section for MovementType.Invalid is InterpretedMotionState
 * (InterpretedMotionState.cs Write):
 *   bitfield: uint32 = MovementStateFlag bits | (numCommands << 7)
 *   commands in canonical order (each gated by its flag bit, all uint16):
 *     CurrentStyle, ForwardCommand, SideStepCommand, TurnCommand
 *   speeds (each gated, all float32): ForwardSpeed, SideStepSpeed, TurnSpeed
 *   commands list: numCommands × MotionItem
 *     (command_index uint16 + packed_sequence uint16 + speed float32)
 *   writer.Align() + optional sticky-object guid — both after everything we
 *   consume, so they are left unread (callers frame by outer length/message).
 *
 * MoveTo / TurnTo sections are not decoded — callers only need the outer
 * movement_type + style for those (walk-to-target rendering), matching the
 * pre-extraction handleMovementEvent behavior.
 */
export interface ParsedMotionAction {
  /** Wire command index — low 16 bits of a MotionCommand value. */
  command: number;
  /** Packed sequence (stamp + autonomous bit) — carried for completeness. */
  sequence: number;
  speed: number;
}

/**
 * MovementType.MoveToObject (6) / MoveToPosition (7) body — ACE
 * MoveToObject.cs / MoveToPosition.cs Write: [target guid (6 only)],
 * Origin (cell uint32 + Vector3), MoveToParameters (MoveToParameters.cs:
 * flags uint32, DistanceToObject, MinDistance, FailDistance, Speed,
 * WalkRunThreshold, DesiredHeading — floats), RunRate float. The retail
 * reader is MovementManager::unpack_movement @ 00524440 (cases 6 / 7).
 */
export interface ParsedMoveTo {
  /** The object moved to; 0 for MoveToPosition. */
  target: number;
  cellId: number;
  origin: { x: number; y: number; z: number };
  /** MovementParams bits (0x400 UseSpheres, 0x200 MoveTowards, 0x100 MoveAway, …). */
  flags: number;
  distanceToObject: number;
  minDistance: number;
  failDistance: number;
  speed: number;
  walkRunThreshold: number;
  desiredHeading: number;
  /** CMotionInterp::my_run_rate the move runs at. */
  runRate: number;
}

/**
 * MovementType.TurnToObject (8) / TurnToHeading (9) body — ACE TurnToObject.cs
 * / TurnToHeading.cs Write: [target guid + DesiredHeading float (8 only)],
 * TurnToParameters (flags uint32, Speed, DesiredHeading). Retail reader:
 * MovementManager::unpack_movement @ 00524440 cases 8 / 9.
 */
export interface ParsedTurnTo {
  /** The object turned to face; 0 for TurnToHeading. */
  target: number;
  flags: number;
  /** Turn speed multiplier. */
  speed: number;
  /** AC heading, degrees (TurnToHeading's destination; TurnToObject's outer one). */
  desiredHeading: number;
}

export interface ParsedMovementData {
  /** MovementType (uint8): 0 = Invalid → full InterpretedMotionState. */
  movementType: number;
  /**
   * The 0xF74C header's autonomous byte (false for the headerless
   * CreateObject form). Retail CPhysics::SetObjectMovement @ 00509690 skips a
   * movement for the player object only when it is autonomous (an echo of
   * the player's own input); server-initiated motions — swings, eating,
   * MoveTo — play on the player too.
   */
  autonomous: boolean;
  /** MotionFlags (uint8): bit 0x1 = StickToObject. */
  motionFlags: number;
  /**
   * Stance wire index (low 16 bits of MotionStance). Starts from the outer
   * MovementData style ushort; overridden by InterpretedMotionState's
   * CurrentStyle when that flag bit is present — same precedence as the
   * pre-extraction handleMovementEvent decoding.
   */
  styleIndex: number;
  /** The TurnTo body, for MovementType 8 / 9 (undefined otherwise). */
  turnTo?: ParsedTurnTo;
  /** The MoveTo body, for MovementType 6 / 7 (undefined otherwise). */
  moveTo?: ParsedMoveTo;
  /** Wire command indices — 0 when the corresponding flag bit is absent. */
  forwardCommand: number;
  sidestepCommand: number;
  turnCommand: number;
  /** Speeds — 1.0 when the corresponding flag bit is absent (ACE default). */
  forwardSpeed: number;
  sidestepSpeed: number;
  turnSpeed: number;
  /** One-shot action commands (attacks, emotes) from the commands list. */
  actions: ParsedMotionAction[];
}

/**
 * Parse a MovementData blob. `hasHeader` selects the 0xF74C form (6-byte
 * timestamps/autonomous header + DWORD pad) vs the CreateObject PhysicsDesc
 * form (no header). Returns null when the buffer is too short to carry the
 * structure (truncation — matches the old handleMovementEvent early-outs).
 */
export function parseMovementData(bytes: Uint8Array, hasHeader: boolean): ParsedMovementData | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = hasHeader ? 6 : 0; // u16 + u16 + u8 + 1 pad byte

  if (offset + 4 > bytes.length) return null;
  const autonomous = hasHeader && bytes.length > 4 ? bytes[4] !== 0 : false;
  const movementType = view.getUint8(offset); offset += 1;
  const motionFlags = view.getUint8(offset); offset += 1;
  let styleIndex = view.getUint16(offset, true); offset += 2;

  const parsed: ParsedMovementData = {
    movementType,
    autonomous,
    motionFlags,
    styleIndex,
    forwardCommand: 0,
    sidestepCommand: 0,
    turnCommand: 0,
    forwardSpeed: 1.0,
    sidestepSpeed: 1.0,
    turnSpeed: 1.0,
    actions: [],
  };

  if (movementType === MovementType.MoveToObject || movementType === MovementType.MoveToPosition) {
    const need = (movementType === MovementType.MoveToObject ? 4 : 0) + 16 + 28 + 4;
    if (offset + need <= bytes.length) {
      const target = movementType === MovementType.MoveToObject ? view.getUint32(offset, true) : 0;
      if (movementType === MovementType.MoveToObject) offset += 4;
      const cellId = view.getUint32(offset, true); offset += 4;
      const origin = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
      offset += 12;
      const flags = view.getUint32(offset, true); offset += 4;
      const f = (): number => { const v = view.getFloat32(offset, true); offset += 4; return v; };
      parsed.moveTo = {
        target, cellId, origin, flags,
        distanceToObject: f(), minDistance: f(), failDistance: f(), speed: f(), walkRunThreshold: f(), desiredHeading: f(),
        runRate: f(),
      };
    }
    return parsed;
  }
  if (movementType === MovementType.TurnToObject || movementType === MovementType.TurnToHeading) {
    const isObject = movementType === MovementType.TurnToObject;
    if (offset + (isObject ? 8 : 0) + 12 <= bytes.length) {
      let target = 0;
      let heading = 0;
      if (isObject) {
        target = view.getUint32(offset, true); offset += 4;
        heading = view.getFloat32(offset, true); offset += 4;
      }
      const flags = view.getUint32(offset, true); offset += 4;
      const speed = view.getFloat32(offset, true); offset += 4;
      const paramHeading = view.getFloat32(offset, true); offset += 4;
      parsed.turnTo = { target, flags, speed, desiredHeading: isObject ? heading : paramHeading };
    }
    return parsed;
  }
  // Only MovementType.Invalid carries InterpretedMotionState.
  if (movementType !== MovementType.Invalid) return parsed;
  if (offset + 4 > bytes.length) return null;

  const bitfield = view.getUint32(offset, true); offset += 4;

  // Commands (uint16) in ACE's canonical write order: CurrentStyle,
  // ForwardCommand, SideStepCommand, TurnCommand — note SideStep (bit 0x08)
  // is written BEFORE Turn (bit 0x20).
  if (bitfield & MovementStateFlag.CurrentStyle) {
    styleIndex = view.getUint16(offset, true); offset += 2;
    parsed.styleIndex = styleIndex;
  }
  if (bitfield & MovementStateFlag.ForwardCommand) {
    parsed.forwardCommand = view.getUint16(offset, true); offset += 2;
  }
  if (bitfield & MovementStateFlag.SideStepCommand) {
    parsed.sidestepCommand = view.getUint16(offset, true); offset += 2;
  }
  if (bitfield & MovementStateFlag.TurnCommand) {
    parsed.turnCommand = view.getUint16(offset, true); offset += 2;
  }

  if (bitfield & MovementStateFlag.ForwardSpeed) {
    parsed.forwardSpeed = view.getFloat32(offset, true); offset += 4;
  }
  if (bitfield & MovementStateFlag.SideStepSpeed) {
    parsed.sidestepSpeed = view.getFloat32(offset, true); offset += 4;
  }
  if (bitfield & MovementStateFlag.TurnSpeed) {
    parsed.turnSpeed = view.getFloat32(offset, true); offset += 4;
  }

  // Commands-list length rides at bits 7+ of the bitfield.
  const numActions = (bitfield >> 7) & 0x1F;
  for (let i = 0; i < numActions && offset + 8 <= bytes.length; i++) {
    const command = view.getUint16(offset, true); offset += 2;
    const sequence = view.getUint16(offset, true); offset += 2;
    const speed = view.getFloat32(offset, true); offset += 4;
    parsed.actions.push({ command, sequence, speed });
  }

  return parsed;
}
