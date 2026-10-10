/**
 * MessageSerializer — serialize and deserialize AC game messages.
 *
 * Game messages have two forms:
 *   1. GameEvent (opcode 0xF7B0): server→client event with sequence number
 *      [uint32 opcode=0xF7B0] [uint32 sequence] [uint32 eventType] [payload...]
 *
 *   2. GameAction (opcode 0xF7B1): client→server action with sequence number
 *      [uint32 opcode=0xF7B1] [uint32 sequence] [uint32 actionType] [payload...]
 *
 *   3. Direct message (other opcodes): no sequence field
 *      [uint32 opcode] [payload...]
 *
 * All values are little-endian.
 *
 * Ported from ACE.Server.Network.GameMessages / GameActions.
 */

import { GameMessageOpcode } from './GameMessageOpcode.js';
import { GameActionType } from './GameActionType.js';
import { parseMovementData, type ParsedMovementData } from './MovementDataParser.js';
import { AllegianceIndex, encodeWindows1252, decodeWindows1252, ChatNetworkBlobType, ChatNetworkBlobDispatchType, TURBINE_CHAT_EXTRA_DATA_SIZE, CharacterOptionDataFlag, RawMotionFlags, HoldKey } from '@ac/shared';
export { encodeWindows1252, decodeWindows1252 };

// ─── Binary Writer ─────────────────────────────────────────

export class BinaryWriter {
  private _buf: Uint8Array;
  private _view: DataView;
  private _pos: number;

  constructor(initialSize: number = 256) {
    this._buf = new Uint8Array(initialSize);
    this._view = new DataView(this._buf.buffer);
    this._pos = 0;
  }

  private _grow(needed: number): void {
    if (this._pos + needed <= this._buf.length) return;
    let newSize = this._buf.length * 2;
    while (newSize < this._pos + needed) newSize *= 2;
    const newBuf = new Uint8Array(newSize);
    newBuf.set(this._buf);
    this._buf = newBuf;
    this._view = new DataView(this._buf.buffer);
  }

  get position(): number { return this._pos; }

  writeUInt8(v: number): void {
    this._grow(1);
    this._buf[this._pos++] = v & 0xFF;
  }

  writeUInt16(v: number): void {
    this._grow(2);
    this._view.setUint16(this._pos, v, true);
    this._pos += 2;
  }

  writeUInt32(v: number): void {
    this._grow(4);
    this._view.setUint32(this._pos, v >>> 0, true);
    this._pos += 4;
  }

  writeInt32(v: number): void {
    this._grow(4);
    this._view.setInt32(this._pos, v, true);
    this._pos += 4;
  }

  writeFloat32(v: number): void {
    this._grow(4);
    this._view.setFloat32(this._pos, v, true);
    this._pos += 4;
  }

  writeFloat64(v: number): void {
    this._grow(8);
    this._view.setFloat64(this._pos, v, true);
    this._pos += 8;
  }

  writeBytes(data: Uint8Array): void {
    this._grow(data.length);
    this._buf.set(data, this._pos);
    this._pos += data.length;
  }

  /**
   * Write a String16L (ACE WriteString16L) — u16 length + Windows-1252 bytes +
   * pad-to-4-byte-boundary. Mirrors ACE Network/Extensions.cs:12-21.
   *
   * Encoding rationale: ACE's `WriteString16L` uses Windows-1252
   * (`Encoding.GetEncoding(1252)`). UTF-8 (TextEncoder default) would emit
   * multi-byte sequences for chars ≥ 0x80 that ACE would interpret as
   * multiple Windows-1252 characters. For pure-ASCII text the two encodings
   * are byte-identical, but any user-typed name/message with accented
   * characters (Müller, Sørensen, José) must roundtrip through Windows-1252
   * to match ACE.
   *
   * TextEncoder has no built-in `windows-1252` mode, so we encode manually:
   * for chars > 0xFF we substitute '?' (matches ACE behavior of writing
   * GetEncoding(1252).GetBytes which uses replacement byte for unmappable).
   */
  writeString16(s: string): void {
    const bytes = encodeWindows1252(s);
    this.writeUInt16(bytes.length);
    this.writeBytes(bytes);
    // Align to 4 bytes (count from start of string, including 2-byte length)
    const totalWritten = 2 + bytes.length;
    const remainder = totalWritten % 4;
    if (remainder !== 0) {
      const padding = 4 - remainder;
      this._grow(padding);
      this._pos += padding; // zero-filled by default
    }
  }

  toBuffer(): Uint8Array {
    return this._buf.slice(0, this._pos);
  }
}

// ─── Binary Reader ─────────────────────────────────────────

export class BinaryReader {
  private _view: DataView;
  private _pos: number;
  private _data: Uint8Array;

  constructor(data: Uint8Array, offset: number = 0) {
    this._data = data;
    this._view = new DataView(data.buffer, data.byteOffset, data.length);
    this._pos = offset;
  }

  get position(): number { return this._pos; }
  get remaining(): number { return this._data.length - this._pos; }

  readUInt8(): number {
    return this._data[this._pos++];
  }

  readUInt16(): number {
    const v = this._view.getUint16(this._pos, true);
    this._pos += 2;
    return v;
  }

  readUInt32(): number {
    const v = this._view.getUint32(this._pos, true);
    this._pos += 4;
    return v;
  }

  readInt32(): number {
    const v = this._view.getInt32(this._pos, true);
    this._pos += 4;
    return v;
  }

  /**
   * Read a signed 64-bit little-endian integer. ACE writes int64 wire
   * fields via `BinaryWriter.Write(long)` (e.g. PrivateUpdatePropertyInt64,
   * the PropertiesInt64 hash table in PlayerDescription, etc.) — those
   * fields are read here in one call.
   */
  readInt64(): bigint {
    const v = this._view.getBigInt64(this._pos, true);
    this._pos += 8;
    return v;
  }

  readFloat32(): number {
    const v = this._view.getFloat32(this._pos, true);
    this._pos += 4;
    return v;
  }

  readFloat64(): number {
    const v = this._view.getFloat64(this._pos, true);
    this._pos += 8;
    return v;
  }

  readBytes(count: number): Uint8Array {
    const result = this._data.slice(this._pos, this._pos + count);
    this._pos += count;
    return result;
  }

  /**
   * Read a String16L (ACE WriteString16L) — u16 length + Windows-1252 bytes +
   * pad-to-4-byte-boundary.
   *
   * ENCODING: per ACE `Network/Extensions.cs:17`, `WriteString16L` writes
   *   `Encoding.GetEncoding(1252).GetBytes(data)` — Windows-1252, NOT UTF-8.
   * Pre-FAITHFUL.170 we used `TextDecoder('utf-8')` which silently mojibake'd
   * any byte ≥ 0x80 (accented characters in player names: Müller, Sørensen,
   * José; smart quotes, em-dashes, special symbols in NPC dialog).
   * Windows-1252 is a STRICT SUPERSET of ASCII so all English-only test data
   * continues to decode identically; only the 0x80-0xFF range changes — for
   * the better.
   */
  readString16(): string {
    const len = this.readUInt16();
    const bytes = this.readBytes(len);
    // NOTE: We do NOT use `new TextDecoder('windows-1252')` directly here —
    // Node.js's TextDecoder treats it as Latin-1 and maps the 0x80-0x9F range
    // to control characters instead of the Windows-1252 punctuation set
    // (€, smart quotes, em-dash, etc.). Use our explicit decoder for cross-
    // environment consistency.
    const str = decodeWindows1252(bytes);
    // Align to 4 bytes (per ACE WriteString16L's writer.Pad(CalculatePadMultiple(2+len, 4)))
    const totalRead = 2 + len;
    const remainder = totalRead % 4;
    if (remainder !== 0) {
      this._pos += 4 - remainder;
    }
    return str;
  }

  skip(count: number): void {
    this._pos += count;
  }

  readInt8(): number {
    const v = this._view.getInt8(this._pos);
    this._pos += 1;
    return v;
  }

  readInt16(): number {
    const v = this._view.getInt16(this._pos, true);
    this._pos += 2;
    return v;
  }

  /** Align position to given boundary (default 4). */
  align(boundary: number = 4): void {
    const rem = this._pos % boundary;
    if (rem !== 0) this._pos += boundary - rem;
  }

  /** Read packed DWORD (ACE format: 2 bytes if ≤0x7FFF, 4 bytes otherwise). */
  readPackedDword(): number {
    const first = this.readUInt16();
    if ((first & 0x8000) === 0) return first;
    const second = this.readUInt16();
    return ((first & 0x7FFF) << 16) | second;
  }

  /** Read packed DWORD of known type (add type mask back). */
  readPackedDwordOfKnownType(typeMask: number): number {
    const val = this.readPackedDword();
    return val + typeMask;
  }
}

// ─── Game Message Types ───────────────────────────────────

export interface GameEventMessage {
  type: 'event';
  opcode: GameMessageOpcode.GameEvent;
  objectGuid: number;
  sequence: number;
  eventType: number;
  payload: Uint8Array;
}

export interface GameActionMessage {
  type: 'action';
  opcode: GameMessageOpcode.GameAction;
  sequence: number;
  actionType: GameActionType;
  payload: Uint8Array;
}

export interface DirectMessage {
  type: 'direct';
  opcode: GameMessageOpcode;
  payload: Uint8Array;
}

export type GameMessage = GameEventMessage | GameActionMessage | DirectMessage;

/**
 * Consume a RestrictionDB struct from the reader, advancing the cursor past
 * its entire serialized form. Used by parseCreateObject + parseApproachVendor
 * when the HouseRestrictions weenie flag is set — pre-FAITHFUL.293 both
 * parsers bailed (return / break) when this flag appeared, dropping all
 * weenie fields after HouseRestrictions.
 *
 * Wire format mirrors `RestrictionDBExtensions.Write` in
 * reference/ACE/Source/ACE.Server/Network/Structure/RestrictionDB.cs:74-105:
 *
 *   uint32  Version       (typically 0x10000002 per the struct's default)
 *   uint32  OpenStatus    (bool serialized as Convert.ToUInt32 → 0 or 1)
 *   uint32  MonarchID     (ObjectGuid.Full — a single uint)
 *   uint16  count         (PackableHashTable header: # of guest entries)
 *   uint16  numBuckets    (header-num-buckets; 768 in retail per RestrictionDB.cs:82)
 *   count × { uint32 guestGuid; uint32 permission }   (0=dwelling, 1=storage)
 *
 * NOTE: No 4-byte align after — the immediately-following weenie fields
 * (HookItemTypes/Monarch/etc.) all have their own native alignment, and
 * the trailing `r.align(4)` at the end of parseCreateObject restores
 * payload-end parity.
 */
function skipRestrictionDB(r: BinaryReader): void {
  r.readUInt32(); // Version
  r.readUInt32(); // OpenStatus
  r.readUInt32(); // MonarchID
  const count = r.readUInt16();
  r.readUInt16(); // numBuckets (unused — retail used a hardcoded constant)
  for (let i = 0; i < count; i++) {
    r.readUInt32(); // guest guid
    r.readUInt32(); // permission (0=dwelling access, 1=storage access)
  }
}

// ─── Serialization ────────────────────────────────────────

/**
 * Serialize a GameEvent message (server→client).
 */
export function serializeGameEvent(
  sequence: number,
  eventType: number,
  payload: Uint8Array = new Uint8Array(0),
  objectGuid: number = 0,
): Uint8Array {
  const writer = new BinaryWriter(16 + payload.length);
  writer.writeUInt32(GameMessageOpcode.GameEvent);
  writer.writeUInt32(objectGuid);
  writer.writeUInt32(sequence);
  writer.writeUInt32(eventType);
  if (payload.length > 0) writer.writeBytes(payload);
  return writer.toBuffer();
}

/**
 * Serialize a GameAction message (client→server).
 */
export function serializeGameAction(
  sequence: number,
  actionType: GameActionType,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const writer = new BinaryWriter(12 + payload.length);
  writer.writeUInt32(GameMessageOpcode.GameAction);
  writer.writeUInt32(sequence);
  writer.writeUInt32(actionType);
  if (payload.length > 0) writer.writeBytes(payload);
  return writer.toBuffer();
}

/**
 * Serialize a direct message (no sequence field).
 */
export function serializeDirectMessage(
  opcode: GameMessageOpcode,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const writer = new BinaryWriter(4 + payload.length);
  writer.writeUInt32(opcode);
  if (payload.length > 0) writer.writeBytes(payload);
  return writer.toBuffer();
}

/**
 * Deserialize a game message from raw bytes.
 */
export function deserializeMessage(data: Uint8Array): GameMessage {
  const reader = new BinaryReader(data);
  const opcode = reader.readUInt32() as GameMessageOpcode;

  if (opcode === GameMessageOpcode.GameEvent) {
    // GameEvent format: [opcode] [objectGuid:uint32] [sequence:uint32] [eventType:uint32] [payload...]
    const objectGuid = reader.readUInt32();
    const sequence = reader.readUInt32();
    const eventType = reader.readUInt32();
    const payload = reader.readBytes(reader.remaining);
    return { type: 'event', opcode, sequence, eventType, objectGuid, payload };
  }

  if (opcode === GameMessageOpcode.GameAction) {
    const sequence = reader.readUInt32();
    const actionType = reader.readUInt32() as GameActionType;
    const payload = reader.readBytes(reader.remaining);
    return { type: 'action', opcode, sequence, actionType, payload };
  }

  const payload = reader.readBytes(reader.remaining);
  return { type: 'direct', opcode, payload };
}

// ─── Common Message Builders ──────────────────────────────

/**
 * Build a position update payload.
 *
 * Position format:
 *   [uint32 objCellId] [float x] [float y] [float z]
 *   [float qw] [float qx] [float qy] [float qz]
 *   [uint16 instanceSequence] [uint16 positionSequence] [uint16 teleportSequence]
 *   [uint16 forcePositionSequence]
 */
export function buildPositionPayload(
  objCellId: number,
  x: number, y: number, z: number,
  qw: number, qx: number, qy: number, qz: number,
  instanceSeq: number = 0,
  positionSeq: number = 0,
  teleportSeq: number = 0,
  forcePositionSeq: number = 0,
): Uint8Array {
  const writer = new BinaryWriter(36);
  writer.writeUInt32(objCellId);
  writer.writeFloat32(x);
  writer.writeFloat32(y);
  writer.writeFloat32(z);
  writer.writeFloat32(qw);
  writer.writeFloat32(qx);
  writer.writeFloat32(qy);
  writer.writeFloat32(qz);
  writer.writeUInt16(instanceSeq);
  writer.writeUInt16(positionSeq);
  writer.writeUInt16(teleportSeq);
  writer.writeUInt16(forcePositionSeq);
  return writer.toBuffer();
}

/**
 * Parse a position update payload.
 */
export function parsePositionPayload(data: Uint8Array): {
  objCellId: number;
  x: number; y: number; z: number;
  qw: number; qx: number; qy: number; qz: number;
  instanceSeq: number; positionSeq: number;
  teleportSeq: number; forcePositionSeq: number;
} {
  const reader = new BinaryReader(data);
  return {
    objCellId: reader.readUInt32(),
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    qw: reader.readFloat32(),
    qx: reader.readFloat32(),
    qy: reader.readFloat32(),
    qz: reader.readFloat32(),
    instanceSeq: reader.readUInt16(),
    positionSeq: reader.readUInt16(),
    teleportSeq: reader.readUInt16(),
    forcePositionSeq: reader.readUInt16(),
  };
}

/**
 * Build a Jump GameAction payload (outbound, GameActionType.Jump).
 *
 * Wire format per JumpPack.cs:18-26 (constructor read order) +
 * GameActionJump.cs:10-14 (trailing reads after the JumpPack ctor):
 *   [float32 extent] [float32 velocityX] [float32 velocityY] [float32 velocityZ]
 *   [uint16 instanceSequence] [uint16 serverControlSequence]
 *   [uint16 teleportSequence] [uint16 forcePositionSequence]
 *   [uint32 objectGuid] [uint32 spellId]
 * = 32 bytes total.
 */
export function buildJumpActionPayload(
  extent: number,
  velocityX: number, velocityY: number, velocityZ: number,
  instanceSequence: number, serverControlSequence: number,
  teleportSequence: number, forcePositionSequence: number,
  objectGuid: number = 0,
  spellId: number = 0,
): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeFloat32(extent);
  writer.writeFloat32(velocityX);
  writer.writeFloat32(velocityY);
  writer.writeFloat32(velocityZ);
  writer.writeUInt16(instanceSequence & 0xFFFF);
  writer.writeUInt16(serverControlSequence & 0xFFFF);
  writer.writeUInt16(teleportSequence & 0xFFFF);
  writer.writeUInt16(forcePositionSequence & 0xFFFF);
  writer.writeUInt32(objectGuid);
  writer.writeUInt32(spellId);
  return writer.toBuffer();
}

/**
 * Parse a Jump GameAction payload back out — test-only round-trip helper,
 * mirrors JumpPack's ctor read order exactly (see buildJumpActionPayload).
 */
export function parseJumpActionPayload(data: Uint8Array): {
  extent: number;
  velocityX: number; velocityY: number; velocityZ: number;
  instanceSequence: number; serverControlSequence: number;
  teleportSequence: number; forcePositionSequence: number;
  objectGuid: number; spellId: number;
} {
  const reader = new BinaryReader(data);
  return {
    extent: reader.readFloat32(),
    velocityX: reader.readFloat32(),
    velocityY: reader.readFloat32(),
    velocityZ: reader.readFloat32(),
    instanceSequence: reader.readUInt16(),
    serverControlSequence: reader.readUInt16(),
    teleportSequence: reader.readUInt16(),
    forcePositionSequence: reader.readUInt16(),
    objectGuid: reader.readUInt32(),
    spellId: reader.readUInt32(),
  };
}

/**
 * One entry of RawMotionState's trailing CommandList (soul-emote motions).
 * Per MotionItem.cs:91-106 (Write) / :37-51 (ctor read order):
 *   [uint16 rawCommand] [uint16 packedSequence] [float32 speed]
 * packedSequence = (sequence & 0x7FFF) | (autonomous ? 0x8000 : 0)
 */
export interface MotionCommandEntry {
  motionCommand: number;
  sequence: number;
  autonomous: boolean;
  speed: number;
}

/**
 * RawMotionState fields (outbound half of GameAction 0xF61C MoveToState).
 * Per RawMotionState.cs:49-96 (ctor read order) — PackedFlags low 11 bits
 * select which conditional fields follow, in this exact order:
 *   CurrentHoldKey, CurrentStyle, ForwardCommand, ForwardHoldKey,
 *   ForwardSpeed, SidestepCommand, SidestepHoldKey, SidestepSpeed,
 *   TurnCommand, TurnHoldKey, TurnSpeed
 * CurrentHoldKey / CurrentStyle are packed the way retail packs them
 * (RawMotionState::Pack @ 0051ed10): the hold key only when it is not
 * HoldKey_None, the style only when it is not NonCombat 0x8000003D, and a
 * per-command hold key (ForwardHoldKey / SidestepHoldKey / TurnHoldKey) only
 * when it is not HoldKey_Invalid. Retail's keyboard path never sets those
 * (they stay Invalid), so none go out: the retail A/B wire shows `05…` for
 * a run, never ours' old `0d…` with a trailing hold key (docs/movement-ab.md). A
 * peace-mode stop is then the same empty state a retail client sends, which
 * ACE relays to everyone as style 0 with no commands (the remote "never stops
 * walking" bug, 2026-10-04). The Forward/Sidestep/Turn command + hold key
 * pairs are only sent when their *Command is non-zero (an unset movement key),
 * and each speed only when it is not 1.0, as Pack does: ACE's
 * MovementData(Creature, MoveToState) keeps a present TurnSpeed ≤ 1.5 as the
 * mouse-look rate, so an always-packed 1.0 broadcast every keyboard run-turn
 * at 1.0 instead of the run turn's 1.5 — our players turned at two thirds of
 * their real rate on every other screen, snapping to each position's heading
 * (BUG.remote-turn-speed-packed, 2026-10-04). CurrentHoldKey comes from the
 * `running` bool (HoldKey.Run vs HoldKey.None). CommandListLength (upper
 * 21 bits of PackedFlags) is derived from commands.length.
 */
export interface RawMotionStateFields {
  running: boolean;
  currentStance: number;
  forwardCommand: number;
  sidestepCommand: number;
  turnCommand: number;
  /** TurnSpeed (default 1.0) — Use Mouse Turning turns at the mouse speed (CameraSet::Rotate). */
  turnSpeed?: number;
  /**
   * ForwardHoldKey Run: autorun's forward command. ApplyCurrentMovement
   * @ 006b3430 applies autorun as MovePlayer(WalkForward, …, hold_run = 1),
   * which stores HoldKey_Run on the forward command alone, and
   * RawMotionState::Pack @ 0051ed10 packs it (flag 0x8) as it is not Invalid.
   */
  forwardHoldRun?: boolean;
  commands: MotionCommandEntry[];
}

/** MotionCommand NonCombat: retail omits CurrentStyle when it is the stance. */
const NON_COMBAT_STANCE = 0x8000003d;

function writeRawMotionState(writer: BinaryWriter, fields: RawMotionStateFields): void {
  const holdKey = fields.running ? HoldKey.Run : HoldKey.None;
  let flags = 0;
  if (holdKey !== HoldKey.None) flags |= RawMotionFlags.CurrentHoldKey;
  if ((fields.currentStance >>> 0) !== NON_COMBAT_STANCE) flags |= RawMotionFlags.CurrentStyle;
  // Our forward / sidestep speeds are always the keyboard's 1.0 (never packed).
  const turnSpeed = fields.turnSpeed ?? 1.0;
  if (fields.forwardCommand !== 0) flags |= RawMotionFlags.ForwardCommand;
  // Packed whenever it is not Invalid, with or without a forward command.
  if (fields.forwardHoldRun) flags |= RawMotionFlags.ForwardHoldKey;
  if (fields.sidestepCommand !== 0) flags |= RawMotionFlags.SideStepCommand;
  if (fields.turnCommand !== 0) {
    flags |= RawMotionFlags.TurnCommand;
    if (turnSpeed !== 1.0) flags |= RawMotionFlags.TurnSpeed;
  }

  const commandListLength = fields.commands.length;
  const packedFlags = (flags & 0x7FF) | ((commandListLength & 0x1FFFFF) << 11);
  writer.writeUInt32(packedFlags);

  if (flags & RawMotionFlags.CurrentHoldKey) writer.writeUInt32(holdKey);
  if (flags & RawMotionFlags.CurrentStyle) writer.writeUInt32(fields.currentStance);
  if (flags & RawMotionFlags.ForwardCommand) writer.writeUInt32(fields.forwardCommand);
  if (flags & RawMotionFlags.ForwardHoldKey) writer.writeUInt32(HoldKey.Run);
  if (flags & RawMotionFlags.SideStepCommand) writer.writeUInt32(fields.sidestepCommand);
  if (flags & RawMotionFlags.TurnCommand) writer.writeUInt32(fields.turnCommand);
  if (flags & RawMotionFlags.TurnSpeed) writer.writeFloat32(turnSpeed);

  for (const cmd of fields.commands) {
    const packedSequence = (cmd.sequence & 0x7FFF) | (cmd.autonomous ? 0x8000 : 0);
    writer.writeUInt16(cmd.motionCommand & 0xFFFF);
    writer.writeUInt16(packedSequence);
    writer.writeFloat32(cmd.speed);
  }
}

function readRawMotionState(reader: BinaryReader): RawMotionStateFields & { commandListLength: number } {
  const packedFlags = reader.readUInt32();
  const flags = packedFlags & 0x7FF;
  const commandListLength = packedFlags >>> 11;

  let holdKey = HoldKey.None;
  // Absent CurrentStyle = NonCombat (RawMotionState ctor default; retail omits it).
  let currentStance = NON_COMBAT_STANCE;
  let forwardCommand = 0;
  let sidestepCommand = 0;
  let turnCommand = 0;
  let turnSpeed = 1.0;

  if (flags & RawMotionFlags.CurrentHoldKey) holdKey = reader.readUInt32();
  if (flags & RawMotionFlags.CurrentStyle) currentStance = reader.readUInt32();
  if (flags & RawMotionFlags.ForwardCommand) forwardCommand = reader.readUInt32();
  let forwardHoldRun = false;
  if (flags & RawMotionFlags.ForwardHoldKey) forwardHoldRun = reader.readUInt32() === HoldKey.Run;
  if (flags & RawMotionFlags.ForwardSpeed) reader.readFloat32();
  if (flags & RawMotionFlags.SideStepCommand) sidestepCommand = reader.readUInt32();
  if (flags & RawMotionFlags.SideStepHoldKey) reader.readUInt32();
  if (flags & RawMotionFlags.SideStepSpeed) reader.readFloat32();
  if (flags & RawMotionFlags.TurnCommand) turnCommand = reader.readUInt32();
  if (flags & RawMotionFlags.TurnHoldKey) reader.readUInt32();
  if (flags & RawMotionFlags.TurnSpeed) turnSpeed = reader.readFloat32();

  const commands: MotionCommandEntry[] = [];
  for (let i = 0; i < commandListLength; i++) {
    const motionCommand = reader.readUInt16();
    const packedSequence = reader.readUInt16();
    const speed = reader.readFloat32();
    commands.push({
      motionCommand,
      sequence: packedSequence & 0x7FFF,
      autonomous: (packedSequence >>> 15) === 1,
      speed,
    });
  }

  return {
    running: holdKey === HoldKey.Run,
    currentStance,
    forwardCommand,
    ...(forwardHoldRun ? { forwardHoldRun } : {}),
    sidestepCommand,
    turnCommand,
    turnSpeed,
    commands,
    commandListLength,
  };
}

/**
 * Shared movement-position tail sent after RawMotionState in MoveToState,
 * and standalone in AutonomousPosition. Per Position(BinaryReader) ctor
 * (ACE.Entity/Position.cs:251-264) + MoveToState.cs:36-51 /
 * GameActionAutonomousPosition.cs:18-33:
 *   [uint32 landblockId] [float32 x] [float32 y] [float32 z]
 *   [float32 qw] [float32 qx] [float32 qy] [float32 qz]
 *   [uint16 instanceSequence] [uint16 serverControlSequence]
 *   [uint16 teleportSequence] [uint16 forcePositionSequence]
 *   [uint8 contactLongJump] then align to a 4-byte boundary.
 * Note the quaternion is written WXYZ — NOT the XYZW order of the
 * Quaternion(float,float,float,float) constructor (see Position.cs:259-260).
 */
export interface MovementPositionFields {
  landblockId: number;
  x: number; y: number; z: number;
  qw: number; qx: number; qy: number; qz: number;
  instanceSequence: number;
  serverControlSequence: number;
  teleportSequence: number;
  forcePositionSequence: number;
  /** true = ContactLongJump.Contact (0x1). */
  contact: boolean;
  /**
   * ContactLongJump.StandingLongJump (0x2): MoveToStatePack::Pack @ 005168f0
   * writes `(longjump_mode != 0) << 1 | contact`, and SendMovementEvent
   * @ 006b4680 passes CMotionInterp::standing_longjump as longjump_mode.
   * AutonomousPositionPack carries contact only, so it is never set there.
   */
  standingLongJump?: boolean;
}

function writeMovementPositionTail(writer: BinaryWriter, fields: MovementPositionFields): void {
  writer.writeUInt32(fields.landblockId);
  writer.writeFloat32(fields.x);
  writer.writeFloat32(fields.y);
  writer.writeFloat32(fields.z);
  writer.writeFloat32(fields.qw);
  writer.writeFloat32(fields.qx);
  writer.writeFloat32(fields.qy);
  writer.writeFloat32(fields.qz);
  writer.writeUInt16(fields.instanceSequence & 0xFFFF);
  writer.writeUInt16(fields.serverControlSequence & 0xFFFF);
  writer.writeUInt16(fields.teleportSequence & 0xFFFF);
  writer.writeUInt16(fields.forcePositionSequence & 0xFFFF);
  writer.writeUInt8((fields.standingLongJump ? 0x2 : 0x0) | (fields.contact ? 0x1 : 0x0));
  const remainder = writer.position % 4;
  if (remainder !== 0) {
    for (let i = 0; i < 4 - remainder; i++) writer.writeUInt8(0);
  }
}

function readMovementPositionTail(reader: BinaryReader): MovementPositionFields {
  const fields: MovementPositionFields = {
    landblockId: reader.readUInt32(),
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    qw: reader.readFloat32(),
    qx: reader.readFloat32(),
    qy: reader.readFloat32(),
    qz: reader.readFloat32(),
    instanceSequence: reader.readUInt16(),
    serverControlSequence: reader.readUInt16(),
    teleportSequence: reader.readUInt16(),
    forcePositionSequence: reader.readUInt16(),
    contact: false,
  };
  const contactLongJump = reader.readUInt8();
  fields.contact = (contactLongJump & 0x1) !== 0;
  if (contactLongJump & 0x2) fields.standingLongJump = true;
  const remainder = reader.position % 4;
  if (remainder !== 0) reader.skip(4 - remainder);
  return fields;
}

/**
 * Build a MoveToState GameAction payload (outbound, GameActionType.MoveToState
 * = 0xF61C). Sent when movement keys change, and for soul-emote motions
 * (with a single-entry CommandList — see MotionCommandEntry).
 * Wire format: RawMotionState, then the shared movement-position tail
 * (see writeRawMotionState / writeMovementPositionTail above).
 */
export function buildMoveToStatePayload(
  motion: RawMotionStateFields,
  position: MovementPositionFields,
): Uint8Array {
  const writer = new BinaryWriter(128);
  writeRawMotionState(writer, motion);
  writeMovementPositionTail(writer, position);
  return writer.toBuffer();
}

/**
 * Parse a MoveToState GameAction payload back out — test-only round-trip
 * helper mirroring MoveToState.cs's ctor read order exactly (RawMotionState
 * first, then Position + sequences + contact byte + align).
 */
export function parseMoveToStatePayload(data: Uint8Array): {
  motion: RawMotionStateFields & { commandListLength: number };
  position: MovementPositionFields;
} {
  const reader = new BinaryReader(data);
  const motion = readRawMotionState(reader);
  const position = readMovementPositionTail(reader);
  return { motion, position };
}

/**
 * Build an AutonomousPosition GameAction payload (outbound,
 * GameActionType.AutonomousPosition). Sent ~1s while moving and as a 20s
 * idle keepalive heartbeat. Wire format is just the shared
 * movement-position tail (see writeMovementPositionTail above) — per
 * GameActionAutonomousPosition.cs:18-33, no RawMotionState precedes it.
 */
export function buildAutonomousPositionPayload(position: MovementPositionFields): Uint8Array {
  const writer = new BinaryWriter(48);
  writeMovementPositionTail(writer, position);
  return writer.toBuffer();
}

/**
 * Parse an AutonomousPosition GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionAutonomousPosition.cs's read order.
 */
export function parseAutonomousPositionPayload(data: Uint8Array): MovementPositionFields {
  return readMovementPositionTail(new BinaryReader(data));
}

/**
 * Build a SetDesiredComponentLevel GameAction payload (/fillcomps).
 * Per GameActionSetDesiredComponentLevel.cs:11-12:
 *   [uint32 component_wcid] [uint32 amount]
 */
export function buildSetDesiredComponentLevelPayload(componentWcid: number, amount: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(componentWcid);
  writer.writeUInt32(amount);
  return writer.toBuffer();
}

export function parseSetDesiredComponentLevelPayload(data: Uint8Array): {
  componentWcid: number; amount: number;
} {
  const reader = new BinaryReader(data);
  return { componentWcid: reader.readUInt32(), amount: reader.readUInt32() };
}

/**
 * Build an AdvocateTeleport GameAction payload.
 * Per GameActionAdvocateTeleport.cs:17-18 + Position(BinaryReader) ctor
 * (Position.cs:251-264 — note the packet's quaternion order is WXYZ,
 * NOT the XYZW order of the Quaternion constructor):
 *   [String16L target] [uint32 cell] [float x] [float y] [float z]
 *   [float rw] [float rx] [float ry] [float rz]
 */
export function buildAdvocateTeleportPayload(
  target: string, cell: number,
  x: number, y: number, z: number,
  rw: number = 1.0, rx: number = 0, ry: number = 0, rz: number = 0,
): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(target);
  writer.writeUInt32(cell);
  writer.writeFloat32(x);
  writer.writeFloat32(y);
  writer.writeFloat32(z);
  writer.writeFloat32(rw);
  writer.writeFloat32(rx);
  writer.writeFloat32(ry);
  writer.writeFloat32(rz);
  return writer.toBuffer();
}

export function parseAdvocateTeleportPayload(data: Uint8Array): {
  target: string; cell: number;
  x: number; y: number; z: number;
  rw: number; rx: number; ry: number; rz: number;
} {
  const reader = new BinaryReader(data);
  const target = reader.readString16();
  return {
    target, cell: reader.readUInt32(),
    x: reader.readFloat32(), y: reader.readFloat32(), z: reader.readFloat32(),
    rw: reader.readFloat32(), rx: reader.readFloat32(), ry: reader.readFloat32(), rz: reader.readFloat32(),
  };
}

/**
 * Build a RentHouse GameAction payload.
 * Per GameActionHouseRentHouse.cs:17-18:
 *   [uint32 slumlordGuid] [uint32 itemCount] [itemCount × uint32 itemGuid]
 */
export function buildRentHousePayload(slumlordGuid: number, paymentItemGuids: number[]): Uint8Array {
  const writer = new BinaryWriter(8 + paymentItemGuids.length * 4);
  writer.writeUInt32(slumlordGuid);
  writer.writeUInt32(paymentItemGuids.length);
  for (const guid of paymentItemGuids) writer.writeUInt32(guid);
  return writer.toBuffer();
}

export function parseRentHousePayload(data: Uint8Array): {
  slumlordGuid: number; paymentItemGuids: number[];
} {
  const reader = new BinaryReader(data);
  const slumlordGuid = reader.readUInt32();
  const count = reader.readUInt32();
  const paymentItemGuids: number[] = [];
  for (let i = 0; i < count; i++) paymentItemGuids.push(reader.readUInt32());
  return { slumlordGuid, paymentItemGuids };
}

/**
 * Build a ListAvailableHouses GameAction payload (outbound,
 * GameActionType.ListAvailableHouses).
 *
 * Wire format per GameActionHouseListAvailable.cs:14-19 (read order):
 *   [uint32 houseType (HouseType enum)]
 * = 4 bytes total. HouseType per ACE.Entity/Enum/HouseType.cs:
 *   Undef=0, Cottage=1, Villa=2, Mansion=3, Apartment=4.
 */
export function buildListAvailableHousesPayload(houseType: number): Uint8Array {
  const writer = new BinaryWriter(4);
  writer.writeUInt32(houseType);
  return writer.toBuffer();
}

/**
 * Parse a ListAvailableHouses GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionHouseListAvailable.cs's read order.
 */
export function parseListAvailableHousesPayload(data: Uint8Array): { houseType: number } {
  const reader = new BinaryReader(data);
  return { houseType: reader.readUInt32() };
}

/**
 * Build a QueryLord GameAction payload (outbound, GameActionType.QueryLord).
 *
 * Wire format per GameActionHouseQueryLord.cs:13 (read order):
 *   [uint32 slumlordGuid]
 * = 4 bytes total. The server discards the value (handler is a no-op
 * beyond the read), but the field is still mandatory on the wire.
 */
export function buildQueryLordPayload(slumlordGuid: number): Uint8Array {
  const writer = new BinaryWriter(4);
  writer.writeUInt32(slumlordGuid);
  return writer.toBuffer();
}

/**
 * Parse a QueryLord GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionHouseQueryLord.cs's read order.
 */
export function parseQueryLordPayload(data: Uint8Array): { slumlordGuid: number } {
  const reader = new BinaryReader(data);
  return { slumlordGuid: reader.readUInt32() };
}

/**
 * Build a ListChannels GameAction payload (outbound, GameActionType.ListChannels).
 *
 * Wire format per GameActionChannelList.cs:11 (read order):
 *   [uint32 channel (Channel [Flags] enum)]
 * = 4 bytes total.
 */
export function buildListChannelsPayload(channel: number): Uint8Array {
  const writer = new BinaryWriter(4);
  writer.writeUInt32(channel);
  return writer.toBuffer();
}

/**
 * Parse a ListChannels GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionChannelList.cs's read order.
 */
export function parseListChannelsPayload(data: Uint8Array): { channel: number } {
  const reader = new BinaryReader(data);
  return { channel: reader.readUInt32() };
}

/**
 * Build a UseWithTarget GameAction payload (outbound, GameActionType.UseWithTarget).
 *
 * Wire format per GameActionUseWithTarget.cs:10-11 (read order):
 *   [uint32 sourceObjectGuid] [uint32 targetObjectGuid]
 * = 8 bytes total.
 */
export function buildUseWithTargetPayload(sourceGuid: number, targetGuid: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(sourceGuid);
  writer.writeUInt32(targetGuid);
  return writer.toBuffer();
}

/**
 * Parse a UseWithTarget GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionUseWithTarget.cs's read order exactly.
 */
export function parseUseWithTargetPayload(data: Uint8Array): {
  sourceGuid: number;
  targetGuid: number;
} {
  const reader = new BinaryReader(data);
  return {
    sourceGuid: reader.readUInt32(),
    targetGuid: reader.readUInt32(),
  };
}

/**
 * Build a ModifyCharacterSquelch GameAction payload (outbound,
 * GameActionType.ModifyCharacterSquelch).
 *
 * Wire format per GameActionModifyCharacterSquelch.cs:12-15 (read order):
 *   [uint32 squelch (bool)] [uint32 playerGuid] [String16L playerName]
 *   [uint32 messageType (ChatMessageType)]
 */
export function buildModifyCharacterSquelchPayload(
  squelch: boolean,
  playerGuid: number,
  playerName: string,
  messageType: number,
): Uint8Array {
  const writer = new BinaryWriter(48);
  writer.writeUInt32(squelch ? 1 : 0);
  writer.writeUInt32(playerGuid);
  writer.writeString16(playerName);
  writer.writeUInt32(messageType);
  return writer.toBuffer();
}

/**
 * Parse a ModifyCharacterSquelch GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionModifyCharacterSquelch.cs's read
 * order exactly.
 */
export function parseModifyCharacterSquelchPayload(data: Uint8Array): {
  squelch: boolean;
  playerGuid: number;
  playerName: string;
  messageType: number;
} {
  const reader = new BinaryReader(data);
  return {
    squelch: reader.readUInt32() !== 0,
    playerGuid: reader.readUInt32(),
    playerName: reader.readString16(),
    messageType: reader.readUInt32(),
  };
}

/**
 * Build a SetSingleCharacterOption GameAction payload (outbound,
 * GameActionType.SetSingleCharacterOption).
 *
 * Wire format per GameActionSetSingleCharacterOption.cs:11-12 (read order):
 *   [uint32 option (CharacterOption enum)] [uint32 value (bool, 0/1)]
 */
export function buildSetCharacterOptionPayload(option: number, value: boolean): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(option);
  writer.writeUInt32(value ? 1 : 0);
  return writer.toBuffer();
}

/**
 * Parse a SetSingleCharacterOption GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionSetSingleCharacterOption.cs's read
 * order exactly.
 */
export function parseSetCharacterOptionPayload(data: Uint8Array): {
  option: number;
  value: boolean;
} {
  const reader = new BinaryReader(data);
  return {
    option: reader.readUInt32(),
    value: reader.readUInt32() !== 0,
  };
}

/**
 * Build a FinishBarber GameAction payload (outbound, GameActionType.FinishBarber).
 *
 * Wire format per Player_Character.cs:409-425 HandleActionFinishBarber (read order,
 * all uint32): paletteBaseId, headObjectDID, hairTexture, defaultHairTexture,
 * eyesTextureDID, defaultEyesTextureDID, noseTextureDID, defaultNoseTextureDID,
 * mouthTextureDID, defaultMouthTextureDID, skinPaletteDID, hairPaletteDID,
 * eyesPaletteDID, setupTableId, optionBound, optionUnk.
 */
export interface FinishBarberFields {
  paletteBaseId: number;
  headObjectDID: number;
  hairTexture: number;
  defaultHairTexture: number;
  eyesTextureDID: number;
  defaultEyesTextureDID: number;
  noseTextureDID: number;
  defaultNoseTextureDID: number;
  mouthTextureDID: number;
  defaultMouthTextureDID: number;
  skinPaletteDID: number;
  hairPaletteDID: number;
  eyesPaletteDID: number;
  setupTableId: number;
  optionBound?: number;
  optionUnk?: number;
}

export function buildFinishBarberPayload(fields: FinishBarberFields): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeUInt32(fields.paletteBaseId);
  writer.writeUInt32(fields.headObjectDID);
  writer.writeUInt32(fields.hairTexture);
  writer.writeUInt32(fields.defaultHairTexture);
  writer.writeUInt32(fields.eyesTextureDID);
  writer.writeUInt32(fields.defaultEyesTextureDID);
  writer.writeUInt32(fields.noseTextureDID);
  writer.writeUInt32(fields.defaultNoseTextureDID);
  writer.writeUInt32(fields.mouthTextureDID);
  writer.writeUInt32(fields.defaultMouthTextureDID);
  writer.writeUInt32(fields.skinPaletteDID);
  writer.writeUInt32(fields.hairPaletteDID);
  writer.writeUInt32(fields.eyesPaletteDID);
  writer.writeUInt32(fields.setupTableId);
  writer.writeUInt32(fields.optionBound ?? 0);
  writer.writeUInt32(fields.optionUnk ?? 0);
  return writer.toBuffer();
}

/**
 * Parse a FinishBarber GameAction payload back out — test-only round-trip
 * helper, mirrors Player_Character.HandleActionFinishBarber's read order exactly.
 */
export function parseFinishBarberPayload(data: Uint8Array): Required<FinishBarberFields> {
  const reader = new BinaryReader(data);
  return {
    paletteBaseId: reader.readUInt32(),
    headObjectDID: reader.readUInt32(),
    hairTexture: reader.readUInt32(),
    defaultHairTexture: reader.readUInt32(),
    eyesTextureDID: reader.readUInt32(),
    defaultEyesTextureDID: reader.readUInt32(),
    noseTextureDID: reader.readUInt32(),
    defaultNoseTextureDID: reader.readUInt32(),
    mouthTextureDID: reader.readUInt32(),
    defaultMouthTextureDID: reader.readUInt32(),
    skinPaletteDID: reader.readUInt32(),
    hairPaletteDID: reader.readUInt32(),
    eyesPaletteDID: reader.readUInt32(),
    setupTableId: reader.readUInt32(),
    optionBound: reader.readUInt32(),
    optionUnk: reader.readUInt32(),
  };
}

/**
 * Build a GetAndWieldItem GameAction payload (outbound, GameActionType.GetAndWieldItem).
 *
 * Wire format per GameActionGetAndWieldItem.cs (read order):
 *   [uint32 itemGuid] [int32 location (EquipMask)]
 */
export function buildGetAndWieldItemPayload(itemGuid: number, location: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(itemGuid);
  writer.writeInt32(location);
  return writer.toBuffer();
}

/**
 * Parse a GetAndWieldItem GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionGetAndWieldItem.cs's read order exactly.
 */
export function parseGetAndWieldItemPayload(data: Uint8Array): {
  itemGuid: number;
  location: number;
} {
  const reader = new BinaryReader(data);
  return {
    itemGuid: reader.readUInt32(),
    location: reader.readInt32(),
  };
}

/**
 * Build a StackableMerge GameAction payload (outbound, GameActionType.StackableMerge).
 *
 * Wire format per GameActionStackableMerge.cs (read order):
 *   [uint32 mergeFromGuid] [uint32 mergeToGuid] [int32 amount]
 */
export function buildStackableMergePayload(
  mergeFromGuid: number,
  mergeToGuid: number,
  amount: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(mergeFromGuid);
  writer.writeUInt32(mergeToGuid);
  writer.writeInt32(amount);
  return writer.toBuffer();
}

/**
 * Parse a StackableMerge GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionStackableMerge.cs's read order exactly.
 */
export function parseStackableMergePayload(data: Uint8Array): {
  mergeFromGuid: number;
  mergeToGuid: number;
  amount: number;
} {
  const reader = new BinaryReader(data);
  return {
    mergeFromGuid: reader.readUInt32(),
    mergeToGuid: reader.readUInt32(),
    amount: reader.readInt32(),
  };
}

/**
 * Build a PutItemInContainer GameAction payload (outbound, GameActionType.PutItemInContainer).
 *
 * Wire format per GameActionPutItemInContainer.cs (read order):
 *   [uint32 itemGuid] [uint32 containerGuid] [int32 placement]
 */
export function buildPutItemInContainerPayload(
  itemGuid: number,
  containerGuid: number,
  placement: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(itemGuid);
  writer.writeUInt32(containerGuid);
  writer.writeInt32(placement);
  return writer.toBuffer();
}

/**
 * Parse a PutItemInContainer GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionPutItemInContainer.cs's read order exactly.
 */
export function parsePutItemInContainerPayload(data: Uint8Array): {
  itemGuid: number;
  containerGuid: number;
  placement: number;
} {
  const reader = new BinaryReader(data);
  return {
    itemGuid: reader.readUInt32(),
    containerGuid: reader.readUInt32(),
    placement: reader.readInt32(),
  };
}

/**
 * Build an AddToTrade GameAction payload (outbound, GameActionType.AddToTrade).
 *
 * Wire format per GameActionAddToTrade.cs (read order):
 *   [uint32 itemGuid] [uint32 tradeSlot]
 */
export function buildAddToTradePayload(itemGuid: number, tradeSlot: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(itemGuid);
  writer.writeUInt32(tradeSlot);
  return writer.toBuffer();
}

/**
 * Parse an AddToTrade GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionAddToTrade.cs's read order exactly.
 */
export function parseAddToTradePayload(data: Uint8Array): {
  itemGuid: number;
  tradeSlot: number;
} {
  const reader = new BinaryReader(data);
  return {
    itemGuid: reader.readUInt32(),
    tradeSlot: reader.readUInt32(),
  };
}

/**
 * Build a TargetedMeleeAttack GameAction payload (outbound, GameActionType.TargetedMeleeAttack).
 *
 * Wire format per GameActionTargetedMeleeAttack.cs (read order):
 *   [uint32 targetGuid] [uint32 attackHeight] [float32 powerLevel]
 */
export function buildTargetedMeleeAttackPayload(
  targetGuid: number,
  attackHeight: number,
  powerLevel: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(targetGuid);
  writer.writeUInt32(attackHeight);
  writer.writeFloat32(powerLevel);
  return writer.toBuffer();
}

/**
 * Parse a TargetedMeleeAttack GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionTargetedMeleeAttack.cs's read order exactly.
 */
export function parseTargetedMeleeAttackPayload(data: Uint8Array): {
  targetGuid: number;
  attackHeight: number;
  powerLevel: number;
} {
  const reader = new BinaryReader(data);
  return {
    targetGuid: reader.readUInt32(),
    attackHeight: reader.readUInt32(),
    powerLevel: reader.readFloat32(),
  };
}

/**
 * Build a TargetedMissileAttack GameAction payload (outbound, GameActionType.TargetedMissileAttack).
 *
 * Wire format per GameActionTargetedMissileAttack.cs (read order):
 *   [uint32 targetGuid] [uint32 attackHeight] [float32 accuracyLevel]
 */
export function buildTargetedMissileAttackPayload(
  targetGuid: number,
  attackHeight: number,
  accuracyLevel: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(targetGuid);
  writer.writeUInt32(attackHeight);
  writer.writeFloat32(accuracyLevel);
  return writer.toBuffer();
}

/**
 * Parse a TargetedMissileAttack GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionTargetedMissileAttack.cs's read order exactly.
 */
export function parseTargetedMissileAttackPayload(data: Uint8Array): {
  targetGuid: number;
  attackHeight: number;
  accuracyLevel: number;
} {
  const reader = new BinaryReader(data);
  return {
    targetGuid: reader.readUInt32(),
    attackHeight: reader.readUInt32(),
    accuracyLevel: reader.readFloat32(),
  };
}

/**
 * Build a ConfirmationResponse GameAction payload (outbound, GameActionType.ConfirmationResponse).
 *
 * Wire format per GameActionConfirmationResponse.cs (read order):
 *   [int32 confirmationType] [uint32 context] [int32 response (bool as 0/1)]
 */
export function buildConfirmationResponsePayload(
  confirmationType: number,
  context: number,
  response: boolean,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeInt32(confirmationType);
  writer.writeUInt32(context);
  writer.writeInt32(response ? 1 : 0);
  return writer.toBuffer();
}

/**
 * Parse a ConfirmationResponse GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionConfirmationResponse.cs's read order exactly.
 */
export function parseConfirmationResponsePayload(data: Uint8Array): {
  confirmationType: number;
  context: number;
  response: boolean;
} {
  const reader = new BinaryReader(data);
  return {
    confirmationType: reader.readInt32(),
    context: reader.readUInt32(),
    response: reader.readInt32() !== 0,
  };
}

/**
 * Build a ModifyAccountSquelch GameAction payload (outbound, GameActionType.ModifyAccountSquelch).
 *
 * Wire format per GameActionModifyAccountSquelch.cs (read order):
 *   [uint32 squelch (bool)] [String16L playerName]
 */
export function buildModifyAccountSquelchPayload(
  squelch: boolean,
  playerName: string,
): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeUInt32(squelch ? 1 : 0);
  writer.writeString16(playerName);
  return writer.toBuffer();
}

/**
 * Parse a ModifyAccountSquelch GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionModifyAccountSquelch.cs's read order exactly.
 */
export function parseModifyAccountSquelchPayload(data: Uint8Array): {
  squelch: boolean;
  playerName: string;
} {
  const reader = new BinaryReader(data);
  return {
    squelch: reader.readUInt32() !== 0,
    playerName: reader.readString16(),
  };
}

/**
 * Build a ModifyGlobalSquelch GameAction payload (outbound, GameActionType.ModifyGlobalSquelch).
 *
 * Wire format per GameActionModifyGlobalSquelch.cs (read order):
 *   [uint32 squelch (bool)] [uint32 messageType (ChatMessageType)]
 */
export function buildModifyGlobalSquelchPayload(
  squelch: boolean,
  messageType: number,
): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(squelch ? 1 : 0);
  writer.writeUInt32(messageType);
  return writer.toBuffer();
}

/**
 * Parse a ModifyGlobalSquelch GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionModifyGlobalSquelch.cs's read order exactly.
 */
export function parseModifyGlobalSquelchPayload(data: Uint8Array): {
  squelch: boolean;
  messageType: number;
} {
  const reader = new BinaryReader(data);
  return {
    squelch: reader.readUInt32() !== 0,
    messageType: reader.readUInt32(),
  };
}

/**
 * Build a BreakAllegianceBoot GameAction payload (outbound, GameActionType.BreakAllegianceBoot).
 *
 * Wire format per GameActionBreakAllegianceBoot.cs (read order):
 *   [String16L playerName] [uint32 accountBoot (bool)]
 */
export function buildBreakAllegianceBootPayload(
  playerName: string,
  accountBoot: boolean,
): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(playerName);
  writer.writeUInt32(accountBoot ? 1 : 0);
  return writer.toBuffer();
}

/**
 * Parse a BreakAllegianceBoot GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionBreakAllegianceBoot.cs's read order exactly.
 */
export function parseBreakAllegianceBootPayload(data: Uint8Array): {
  playerName: string;
  accountBoot: boolean;
} {
  const reader = new BinaryReader(data);
  return {
    playerName: reader.readString16(),
    accountBoot: reader.readUInt32() !== 0,
  };
}

/**
 * Build a SetAllegianceOfficer GameAction payload (outbound, GameActionType.SetAllegianceOfficer).
 *
 * Wire format per GameActionSetAllegianceOfficer.cs (read order):
 *   [String16L playerName] [uint32 officerLevel]
 */
export function buildSetAllegianceOfficerPayload(
  playerName: string,
  officerLevel: number,
): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeString16(playerName);
  writer.writeUInt32(officerLevel);
  return writer.toBuffer();
}

/**
 * Parse a SetAllegianceOfficer GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionSetAllegianceOfficer.cs's read order exactly.
 */
export function parseSetAllegianceOfficerPayload(data: Uint8Array): {
  playerName: string;
  officerLevel: number;
} {
  const reader = new BinaryReader(data);
  return {
    playerName: reader.readString16(),
    officerLevel: reader.readUInt32(),
  };
}

/**
 * Build a SetAllegianceOfficerTitle GameAction payload (outbound,
 * GameActionType.SetAllegianceOfficerTitle).
 *
 * Wire format per GameActionSetAllegianceOfficerTitle.cs (read order):
 *   [uint32 level] [String16L title]
 */
export function buildSetAllegianceOfficerTitlePayload(
  level: number,
  title: string,
): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeUInt32(level);
  writer.writeString16(title);
  return writer.toBuffer();
}

/**
 * Parse a SetAllegianceOfficerTitle GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionSetAllegianceOfficerTitle.cs's read
 * order exactly.
 */
export function parseSetAllegianceOfficerTitlePayload(data: Uint8Array): {
  level: number;
  title: string;
} {
  const reader = new BinaryReader(data);
  return {
    level: reader.readUInt32(),
    title: reader.readString16(),
  };
}

/**
 * Build an AllegianceChatBoot GameAction payload (outbound, GameActionType.AllegianceChatBoot).
 *
 * Wire format per GameActionAllegianceChatBoot.cs (read order):
 *   [String16L playerName] [String16L reason]
 */
export function buildAllegianceChatBootPayload(
  playerName: string,
  reason: string,
): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(playerName);
  writer.writeString16(reason);
  return writer.toBuffer();
}

/**
 * Parse an AllegianceChatBoot GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionAllegianceChatBoot.cs's read order exactly.
 */
export function parseAllegianceChatBootPayload(data: Uint8Array): {
  playerName: string;
  reason: string;
} {
  const reader = new BinaryReader(data);
  return {
    playerName: reader.readString16(),
    reason: reader.readString16(),
  };
}

/**
 * Build an AllegianceChatGag GameAction payload (outbound, GameActionType.AllegianceChatGag).
 *
 * Wire format per GameActionAllegianceChatGag.cs (read order):
 *   [String16L playerName] [uint32 enabled (bool)]
 */
export function buildAllegianceChatGagPayload(
  playerName: string,
  enabled: boolean,
): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeString16(playerName);
  writer.writeUInt32(enabled ? 1 : 0);
  return writer.toBuffer();
}

/**
 * Parse an AllegianceChatGag GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionAllegianceChatGag.cs's read order exactly.
 */
export function parseAllegianceChatGagPayload(data: Uint8Array): {
  playerName: string;
  enabled: boolean;
} {
  const reader = new BinaryReader(data);
  return {
    playerName: reader.readString16(),
    enabled: reader.readUInt32() !== 0,
  };
}

/**
 * Build a CastTargetedSpell GameAction payload (outbound, GameActionType.CastTargetedSpell).
 *
 * Wire format per GameActionMagicCastTargetedSpell.cs (read order):
 *   [uint32 targetGuid] [uint32 spellId]
 */
export function buildCastTargetedSpellPayload(
  targetGuid: number,
  spellId: number,
): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(targetGuid);
  writer.writeUInt32(spellId);
  return writer.toBuffer();
}

/**
 * Parse a CastTargetedSpell GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionMagicCastTargetedSpell.cs's read order exactly.
 */
export function parseCastTargetedSpellPayload(data: Uint8Array): {
  targetGuid: number;
  spellId: number;
} {
  const reader = new BinaryReader(data);
  return {
    targetGuid: reader.readUInt32(),
    spellId: reader.readUInt32(),
  };
}

/**
 * Build an AddSpellFavorite GameAction payload (outbound, GameActionType.AddSpellFavorite).
 *
 * Wire format per GameActionAddSpellFavorite.cs (read order):
 *   [uint32 spellId] [uint32 spellBarPositionId] [uint32 spellBarId]
 */
export function buildAddSpellFavoritePayload(
  spellId: number,
  spellBarPositionId: number,
  spellBarId: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(spellId);
  writer.writeUInt32(spellBarPositionId);
  writer.writeUInt32(spellBarId);
  return writer.toBuffer();
}

/**
 * Parse an AddSpellFavorite GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionAddSpellFavorite.cs's read order exactly.
 */
export function parseAddSpellFavoritePayload(data: Uint8Array): {
  spellId: number;
  spellBarPositionId: number;
  spellBarId: number;
} {
  const reader = new BinaryReader(data);
  return {
    spellId: reader.readUInt32(),
    spellBarPositionId: reader.readUInt32(),
    spellBarId: reader.readUInt32(),
  };
}

/**
 * Build a RemoveSpellFavorite GameAction payload (outbound, GameActionType.RemoveSpellFavorite).
 *
 * Wire format per GameActionRemoveSpellFavorite.cs (read order):
 *   [uint32 spellId] [uint32 spellBarId]
 */
export function buildRemoveSpellFavoritePayload(
  spellId: number,
  spellBarId: number,
): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(spellId);
  writer.writeUInt32(spellBarId);
  return writer.toBuffer();
}

/**
 * Parse a RemoveSpellFavorite GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionRemoveSpellFavorite.cs's read order exactly.
 */
export function parseRemoveSpellFavoritePayload(data: Uint8Array): {
  spellId: number;
  spellBarId: number;
} {
  const reader = new BinaryReader(data);
  return {
    spellId: reader.readUInt32(),
    spellBarId: reader.readUInt32(),
  };
}

/**
 * Build a ChessJoin GameAction payload (outbound, GameActionType.ChessJoin).
 *
 * Wire format per GameActionChessJoin.cs (read order):
 *   [uint32 boardGuid] [int32 color (unused by server, sent as -1)]
 */
export function buildChessJoinPayload(boardGuid: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(boardGuid);
  writer.writeInt32(-1);
  return writer.toBuffer();
}

/**
 * Parse a ChessJoin GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionChessJoin.cs's read order exactly.
 */
export function parseChessJoinPayload(data: Uint8Array): {
  boardGuid: number;
  color: number;
} {
  const reader = new BinaryReader(data);
  return {
    boardGuid: reader.readUInt32(),
    color: reader.readInt32(),
  };
}

/**
 * Build a ChessMove GameAction payload (outbound, GameActionType.ChessMove).
 *
 * Wire format per GameActionChessMove.cs + ChessPieceCoord.cs (read order):
 *   [int32 fromX] [int32 fromY] [int32 toX] [int32 toY]
 */
export function buildChessMovePayload(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Uint8Array {
  const writer = new BinaryWriter(16);
  writer.writeInt32(fromX);
  writer.writeInt32(fromY);
  writer.writeInt32(toX);
  writer.writeInt32(toY);
  return writer.toBuffer();
}

/**
 * Parse a ChessMove GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionChessMove.cs + ChessPieceCoord.cs's read order exactly.
 */
export function parseChessMovePayload(data: Uint8Array): {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
} {
  const reader = new BinaryReader(data);
  return {
    fromX: reader.readInt32(),
    fromY: reader.readInt32(),
    toX: reader.readInt32(),
    toY: reader.readInt32(),
  };
}

/**
 * Build a StackableSplitTo3D GameAction payload (outbound, GameActionType.StackableSplitTo3D).
 *
 * Wire format per GameActionStackableSplitTo3D.cs (read order):
 *   [uint32 stackId] [int32 amount]
 */
export function buildStackableSplitTo3DPayload(
  stackId: number,
  amount: number,
): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(stackId);
  writer.writeInt32(amount);
  return writer.toBuffer();
}

/**
 * Parse a StackableSplitTo3D GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionStackableSplitTo3D.cs's read order exactly.
 */
export function parseStackableSplitTo3DPayload(data: Uint8Array): {
  stackId: number;
  amount: number;
} {
  const reader = new BinaryReader(data);
  return {
    stackId: reader.readUInt32(),
    amount: reader.readInt32(),
  };
}

/**
 * Build a GiveObjectRequest GameAction payload (outbound, GameActionType.GiveObjectRequest).
 *
 * Wire format per GameActionGiveObjectRequest.cs:9-11 (read order):
 *   [uint32 targetGuid] [uint32 objectGuid] [int32 amount] = 12 bytes total.
 */
export function buildGiveObjectRequestPayload(
  targetGuid: number,
  objectGuid: number,
  amount: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(targetGuid);
  writer.writeUInt32(objectGuid);
  writer.writeInt32(amount);
  return writer.toBuffer();
}

/**
 * Parse a GiveObjectRequest GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionGiveObjectRequest.cs's read order exactly.
 */
export function parseGiveObjectRequestPayload(data: Uint8Array): {
  targetGuid: number;
  objectGuid: number;
  amount: number;
} {
  const reader = new BinaryReader(data);
  return {
    targetGuid: reader.readUInt32(),
    objectGuid: reader.readUInt32(),
    amount: reader.readInt32(),
  };
}

/**
 * Build a ChatChannel GameAction payload (outbound, GameActionType.ChatChannel).
 *
 * Wire format per GameActionChatChannel.cs:15-16 (read order):
 *   [uint32 channel (Channel enum)] [String16L message]
 */
export function buildChatChannelPayload(channel: number, message: string): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeUInt32(channel);
  writer.writeString16(message);
  return writer.toBuffer();
}

/**
 * Parse a ChatChannel GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionChatChannel.cs's read order exactly.
 */
export function parseChatChannelPayload(data: Uint8Array): {
  channel: number;
  message: string;
} {
  const reader = new BinaryReader(data);
  return {
    channel: reader.readUInt32(),
    message: reader.readString16(),
  };
}

/**
 * Build a SetInscription GameAction payload (outbound, GameActionType.SetInscription).
 *
 * Wire format per GameActionSetInscription.cs:14-15 (read order):
 *   [uint32 objectGuid] [String16L inscriptionText]
 */
export function buildSetInscriptionPayload(objectGuid: number, text: string): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeUInt32(objectGuid);
  writer.writeString16(text);
  return writer.toBuffer();
}

/**
 * Parse a SetInscription GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionSetInscription.cs's read order exactly.
 */
export function parseSetInscriptionPayload(data: Uint8Array): {
  objectGuid: number;
  text: string;
} {
  const reader = new BinaryReader(data);
  return {
    objectGuid: reader.readUInt32(),
    text: reader.readString16(),
  };
}

/**
 * Build a TalkDirect GameAction payload (outbound, GameActionType.TalkDirect).
 *
 * Wire format per GameActionTalkDirect.cs:17-18 (read order — note the message
 * comes BEFORE the target guid, unlike most tell-shaped actions):
 *   [String16L message] [uint32 targetGuid]
 */
/**
 * AbuseLogRequest (0x0140) — CM_Character::Event_AbuseLogRequest @ 006a2a30:
 * the reported character's name (PString), a uint32 status (gmAbuseUI::
 * ReportAbuse passes 1), the 4-byte pad, then the complaint (PString).
 */
export function buildAbuseLogRequestPayload(name: string, complaint: string): Uint8Array {
  const w = new BinaryWriter(16 + name.length + complaint.length);
  w.writeString16(name);
  w.writeUInt32(1);
  w.writeString16(complaint);
  return w.toBuffer();
}

export function buildTalkDirectPayload(message: string, targetGuid: number): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(message);
  writer.writeUInt32(targetGuid);
  return writer.toBuffer();
}

/**
 * Parse a TalkDirect GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionTalkDirect.cs's read order exactly.
 */
export function parseTalkDirectPayload(data: Uint8Array): {
  message: string;
  targetGuid: number;
} {
  const reader = new BinaryReader(data);
  return {
    message: reader.readString16(),
    targetGuid: reader.readUInt32(),
  };
}

/**
 * Build a StackableSplitToWield GameAction payload (outbound,
 * GameActionType.StackableSplitToWield).
 *
 * Wire format per GameActionStackableSplitToWield.cs:11-13 (read order):
 *   [uint32 stackId] [int32 location (EquipMask)] [int32 amount] = 12 bytes.
 */
export function buildStackableSplitToWieldPayload(
  stackId: number,
  equipMask: number,
  amount: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(stackId);
  writer.writeInt32(equipMask);
  writer.writeInt32(amount);
  return writer.toBuffer();
}

/**
 * Parse a StackableSplitToWield GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionStackableSplitToWield.cs's read order
 * exactly.
 */
export function parseStackableSplitToWieldPayload(data: Uint8Array): {
  stackId: number;
  equipMask: number;
  amount: number;
} {
  const reader = new BinaryReader(data);
  return {
    stackId: reader.readUInt32(),
    equipMask: reader.readInt32(),
    amount: reader.readInt32(),
  };
}

/**
 * Build a TrainSkill GameAction payload (outbound, GameActionType.TrainSkill).
 *
 * Wire format per GameActionTrainSkill.cs:9-10 (read order):
 *   [uint32 skill (Skill enum)] [int32 creditsSpent] = 8 bytes.
 */
export function buildTrainSkillPayload(skill: number, creditsSpent: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(skill);
  writer.writeInt32(creditsSpent);
  return writer.toBuffer();
}

/**
 * Parse a TrainSkill GameAction payload back out — test-only round-trip
 * helper, mirrors GameActionTrainSkill.cs's read order exactly.
 */
export function parseTrainSkillPayload(data: Uint8Array): {
  skill: number;
  creditsSpent: number;
} {
  const reader = new BinaryReader(data);
  return {
    skill: reader.readUInt32(),
    creditsSpent: reader.readInt32(),
  };
}

/**
 * Build a StackableSplitToContainer GameAction payload (outbound,
 * GameActionType.StackableSplitToContainer).
 *
 * Wire format per GameActionStackableSplitToContainer.cs (read order):
 *   [uint32 stackId] [uint32 containerId] [int32 place] [int32 amount]
 */
export function buildStackableSplitToContainerPayload(
  stackId: number,
  containerId: number,
  place: number,
  amount: number,
): Uint8Array {
  const writer = new BinaryWriter(16);
  writer.writeUInt32(stackId);
  writer.writeUInt32(containerId);
  writer.writeInt32(place);
  writer.writeInt32(amount);
  return writer.toBuffer();
}

export function parseStackableSplitToContainerPayload(data: Uint8Array): {
  stackId: number; containerId: number; place: number; amount: number;
} {
  const reader = new BinaryReader(data);
  return {
    stackId: reader.readUInt32(),
    containerId: reader.readUInt32(),
    place: reader.readInt32(),
    amount: reader.readInt32(),
  };
}

/**
 * Build a Buy GameAction payload (outbound, GameActionType.Buy).
 *
 * Wire format per GameActionBuyItems.cs (read order):
 *   [uint32 vendorGuid] [uint32 numItems]
 *   numItems × ( [int32 amount] [uint32 objectId] )
 */
export function buildBuyPayload(
  vendorGuid: number,
  items: Array<{ amount: number; objectId: number }>,
): Uint8Array {
  const writer = new BinaryWriter(8 + items.length * 8);
  writer.writeUInt32(vendorGuid);
  writer.writeUInt32(items.length);
  for (const item of items) {
    writer.writeInt32(item.amount);
    writer.writeUInt32(item.objectId);
  }
  return writer.toBuffer();
}

export function parseBuyPayload(data: Uint8Array): {
  vendorGuid: number; items: Array<{ amount: number; objectId: number }>;
} {
  const reader = new BinaryReader(data);
  const vendorGuid = reader.readUInt32();
  const numItems = reader.readUInt32();
  const items: Array<{ amount: number; objectId: number }> = [];
  for (let i = 0; i < numItems; i++) {
    items.push({ amount: reader.readInt32(), objectId: reader.readUInt32() });
  }
  return { vendorGuid, items };
}

/**
 * Build a Sell GameAction payload (outbound, GameActionType.Sell).
 *
 * Wire format per GameActionSellItems.cs (read order) — identical shape to
 * Buy, distinct opcode:
 *   [uint32 vendorGuid] [uint32 numItems]
 *   numItems × ( [int32 amount] [uint32 objectGuid] )
 */
export function buildSellPayload(
  vendorGuid: number,
  items: Array<{ amount: number; objectGuid: number }>,
): Uint8Array {
  const writer = new BinaryWriter(8 + items.length * 8);
  writer.writeUInt32(vendorGuid);
  writer.writeUInt32(items.length);
  for (const item of items) {
    writer.writeInt32(item.amount);
    writer.writeUInt32(item.objectGuid);
  }
  return writer.toBuffer();
}

export function parseSellPayload(data: Uint8Array): {
  vendorGuid: number; items: Array<{ amount: number; objectGuid: number }>;
} {
  const reader = new BinaryReader(data);
  const vendorGuid = reader.readUInt32();
  const numItems = reader.readUInt32();
  const items: Array<{ amount: number; objectGuid: number }> = [];
  for (let i = 0; i < numItems; i++) {
    items.push({ amount: reader.readInt32(), objectGuid: reader.readUInt32() });
  }
  return { vendorGuid, items };
}

/**
 * Build an AcceptTrade GameAction payload (outbound, GameActionType.AcceptTrade).
 *
 * Wire format per GameActionAcceptTrade.cs (read order) — all 6 fields are
 * read then discarded server-side (HandleActionAcceptTrade takes no args),
 * but the byte layout must still match or the read cursor desyncs the
 * following message on the wire:
 *   [uint32 partnerGuid] [double tradeStamp] [uint32 tradeStatus]
 *   [uint32 initiatorGuid] [uint32 initiatorAccepts (bool)] [uint32 partnerAccepts (bool)]
 */
export function buildAcceptTradePayload(
  partnerGuid: number,
  tradeStamp: number,
  tradeStatus: number,
  initiatorGuid: number,
  initiatorAccepts: boolean,
  partnerAccepts: boolean,
): Uint8Array {
  const writer = new BinaryWriter(28);
  writer.writeUInt32(partnerGuid);
  writer.writeFloat64(tradeStamp);
  writer.writeUInt32(tradeStatus);
  writer.writeUInt32(initiatorGuid);
  writer.writeUInt32(initiatorAccepts ? 1 : 0);
  writer.writeUInt32(partnerAccepts ? 1 : 0);
  return writer.toBuffer();
}

export function parseAcceptTradePayload(data: Uint8Array): {
  partnerGuid: number; tradeStamp: number; tradeStatus: number;
  initiatorGuid: number; initiatorAccepts: boolean; partnerAccepts: boolean;
} {
  const reader = new BinaryReader(data);
  return {
    partnerGuid: reader.readUInt32(),
    tradeStamp: reader.readFloat64(),
    tradeStatus: reader.readUInt32(),
    initiatorGuid: reader.readUInt32(),
    initiatorAccepts: reader.readUInt32() !== 0,
    partnerAccepts: reader.readUInt32() !== 0,
  };
}

/**
 * Build a CreateTinkeringTool GameAction payload (outbound,
 * GameActionType.CreateTinkeringTool — used for salvage-kit salvaging).
 *
 * Wire format per GameActionCreateTinkeringTool.cs (read order):
 *   [uint32 toolGuid] [uint32 itemCount] itemCount × [uint32 itemGuid]
 */
export function buildCreateTinkeringToolPayload(toolGuid: number, itemGuids: number[]): Uint8Array {
  const writer = new BinaryWriter(8 + itemGuids.length * 4);
  writer.writeUInt32(toolGuid);
  writer.writeUInt32(itemGuids.length);
  for (const guid of itemGuids) writer.writeUInt32(guid);
  return writer.toBuffer();
}

export function parseCreateTinkeringToolPayload(data: Uint8Array): {
  toolGuid: number; itemGuids: number[];
} {
  const reader = new BinaryReader(data);
  const toolGuid = reader.readUInt32();
  const count = reader.readUInt32();
  const itemGuids: number[] = [];
  for (let i = 0; i < count; i++) itemGuids.push(reader.readUInt32());
  return { toolGuid, itemGuids };
}

/**
 * Build a BuyHouse GameAction payload (outbound, GameActionType.BuyHouse).
 *
 * Wire format per GameActionHouseBuyHouse.cs + PackableList.ReadListUInt32
 * (read order) — same shape as RentHouse (buildRentHousePayload above) but
 * a distinct opcode:
 *   [uint32 slumlordGuid] [uint32 itemCount] itemCount × [uint32 itemGuid]
 */
export function buildBuyHousePayload(slumlordGuid: number, itemGuids: number[]): Uint8Array {
  const writer = new BinaryWriter(8 + itemGuids.length * 4);
  writer.writeUInt32(slumlordGuid);
  writer.writeUInt32(itemGuids.length);
  for (const guid of itemGuids) writer.writeUInt32(guid);
  return writer.toBuffer();
}

export function parseBuyHousePayload(data: Uint8Array): {
  slumlordGuid: number; itemGuids: number[];
} {
  const reader = new BinaryReader(data);
  const slumlordGuid = reader.readUInt32();
  const count = reader.readUInt32();
  const itemGuids: number[] = [];
  for (let i = 0; i < count; i++) itemGuids.push(reader.readUInt32());
  return { slumlordGuid, itemGuids };
}

/**
 * Build a RaiseAttribute GameAction payload (outbound, GameActionType.RaiseAttribute).
 *
 * Wire format per GameActionRaiseAttribute.cs (read order):
 *   [uint32 attribute (PropertyAttribute)] [uint32 xpSpent]
 */
export function buildRaiseAttributePayload(attribute: number, xpSpent: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(attribute);
  writer.writeUInt32(xpSpent);
  return writer.toBuffer();
}

export function parseRaiseAttributePayload(data: Uint8Array): { attribute: number; xpSpent: number } {
  const reader = new BinaryReader(data);
  return { attribute: reader.readUInt32(), xpSpent: reader.readUInt32() };
}

/**
 * Build a RaiseSkill GameAction payload (outbound, GameActionType.RaiseSkill).
 *
 * Wire format per GameActionRaiseSkill.cs (read order):
 *   [uint32 skill (Skill enum)] [uint32 xpSpent]
 */
export function buildRaiseSkillPayload(skill: number, xpSpent: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(skill);
  writer.writeUInt32(xpSpent);
  return writer.toBuffer();
}

export function parseRaiseSkillPayload(data: Uint8Array): { skill: number; xpSpent: number } {
  const reader = new BinaryReader(data);
  return { skill: reader.readUInt32(), xpSpent: reader.readUInt32() };
}

/**
 * Build a RaiseVital GameAction payload (outbound, GameActionType.RaiseVital).
 *
 * Wire format per GameActionRaiseVital.cs (read order):
 *   [uint32 vital (PropertyAttribute2nd)] [uint32 xpSpent]
 */
export function buildRaiseVitalPayload(vital: number, xpSpent: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(vital);
  writer.writeUInt32(xpSpent);
  return writer.toBuffer();
}

export function parseRaiseVitalPayload(data: Uint8Array): { vital: number; xpSpent: number } {
  const reader = new BinaryReader(data);
  return { vital: reader.readUInt32(), xpSpent: reader.readUInt32() };
}

/**
 * Build a Tell GameAction payload (outbound, GameActionType.Tell).
 *
 * Wire format per GameActionTell.cs (read order) — message comes BEFORE
 * target, the reverse of what the "Tell <target> <message>" command syntax
 * might suggest:
 *   [String16L message] [String16L target]
 */
export function buildTellPayload(message: string, target: string): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(message);
  writer.writeString16(target);
  return writer.toBuffer();
}

export function parseTellPayload(data: Uint8Array): { message: string; target: string } {
  const reader = new BinaryReader(data);
  return { message: reader.readString16(), target: reader.readString16() };
}

/**
 * Build a FellowshipCreate GameAction payload (outbound, GameActionType.FellowshipCreate).
 *
 * Wire format per GameActionFellowshipCreate.cs (read order):
 *   [String16L fellowshipName] [uint32 shareXp (bool)]
 */
export function buildFellowshipCreatePayload(fellowshipName: string, shareXp: boolean): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(fellowshipName);
  writer.writeUInt32(shareXp ? 1 : 0);
  return writer.toBuffer();
}

export function parseFellowshipCreatePayload(data: Uint8Array): { fellowshipName: string; shareXp: boolean } {
  const reader = new BinaryReader(data);
  return { fellowshipName: reader.readString16(), shareXp: reader.readUInt32() !== 0 };
}

/**
 * Build an AddShortCut GameAction payload (outbound, GameActionType.AddShortCut).
 *
 * Wire format per GameActionAddShortcut.cs + Shortcut.cs's ReadShortcut /
 * LayeredSpell.cs's ReadLayeredSpell (read order):
 *   [uint32 index] [uint32 objectId] [uint16 spellId] [uint16 layer]
 */
export function buildAddShortcutPayload(
  index: number,
  objectId: number,
  spellId: number,
  layer: number,
): Uint8Array {
  const writer = new BinaryWriter(12);
  writer.writeUInt32(index);
  writer.writeUInt32(objectId);
  writer.writeUInt16(spellId);
  writer.writeUInt16(layer);
  return writer.toBuffer();
}

export function parseAddShortcutPayload(data: Uint8Array): {
  index: number; objectId: number; spellId: number; layer: number;
} {
  const reader = new BinaryReader(data);
  return {
    index: reader.readUInt32(),
    objectId: reader.readUInt32(),
    spellId: reader.readUInt16(),
    layer: reader.readUInt16(),
  };
}

/**
 * Build a BookModifyPage GameAction payload (outbound, GameActionType.BookModifyPage).
 *
 * Wire format per GameActionBookModifyPage.cs (read order):
 *   [uint32 bookGuid] [int32 page (0-based)] [String16L text]
 */
export function buildBookModifyPagePayload(bookGuid: number, page: number, text: string): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeUInt32(bookGuid);
  writer.writeInt32(page);
  writer.writeString16(text);
  return writer.toBuffer();
}

export function parseBookModifyPagePayload(data: Uint8Array): {
  bookGuid: number; page: number; text: string;
} {
  const reader = new BinaryReader(data);
  return {
    bookGuid: reader.readUInt32(),
    page: reader.readInt32(),
    text: reader.readString16(),
  };
}

/**
 * Build a BookDeletePage GameAction payload (outbound, GameActionType.BookDeletePage).
 *
 * Wire format per GameActionBookDeletePage.cs (read order):
 *   [uint32 bookGuid] [int32 page (0-based)]
 */
export function buildBookDeletePagePayload(bookGuid: number, page: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(bookGuid);
  writer.writeInt32(page);
  return writer.toBuffer();
}

export function parseBookDeletePagePayload(data: Uint8Array): { bookGuid: number; page: number } {
  const reader = new BinaryReader(data);
  return { bookGuid: reader.readUInt32(), page: reader.readInt32() };
}

/**
 * Build a BookPageData GameAction payload (outbound, GameActionType.BookPageData).
 *
 * Wire format per GameActionBookPageData.cs (read order):
 *   [uint32 bookGuid] [int32 pageNum (0-based)]
 */
export function buildBookPageDataPayload(bookGuid: number, pageNum: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(bookGuid);
  writer.writeInt32(pageNum);
  return writer.toBuffer();
}

export function parseBookPageDataPayload(data: Uint8Array): { bookGuid: number; pageNum: number } {
  const reader = new BinaryReader(data);
  return { bookGuid: reader.readUInt32(), pageNum: reader.readInt32() };
}

/**
 * Build a ChangeStoragePermission GameAction payload (outbound,
 * GameActionType.ChangeStoragePermission).
 *
 * Wire format per GameActionHouseChangeStoragePermission.cs (read order):
 *   [String16L guestName] [uint32 hasPermission (bool)]
 */
export function buildChangeStoragePermissionPayload(guestName: string, hasPermission: boolean): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeString16(guestName);
  writer.writeUInt32(hasPermission ? 1 : 0);
  return writer.toBuffer();
}

export function parseChangeStoragePermissionPayload(data: Uint8Array): {
  guestName: string; hasPermission: boolean;
} {
  const reader = new BinaryReader(data);
  return { guestName: reader.readString16(), hasPermission: reader.readUInt32() !== 0 };
}

/**
 * Build a BootSpecificHouseGuest GameAction payload (outbound,
 * GameActionType.BootSpecificHouseGuest), sent by /house boot <name>.
 *
 * Wire format per GameActionHouseBootSpecificGuest.cs (read order):
 *   [String16L playerName]
 */
export function buildBootSpecificHouseGuestPayload(playerName: string): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeString16(playerName);
  return writer.toBuffer();
}

export function parseBootSpecificHouseGuestPayload(data: Uint8Array): { playerName: string } {
  const reader = new BinaryReader(data);
  return { playerName: reader.readString16() };
}

/**
 * Build a SetOpenHouseStatus GameAction payload (outbound,
 * GameActionType.SetOpenHouseStatus), sent by /house open|close.
 *
 * Wire format per GameActionHouseSetOpenStatus.cs (read order):
 *   [uint32 openHouse (bool)]
 */
export function buildSetOpenHouseStatusPayload(openHouse: boolean): Uint8Array {
  const writer = new BinaryWriter(4);
  writer.writeUInt32(openHouse ? 1 : 0);
  return writer.toBuffer();
}

export function parseSetOpenHouseStatusPayload(data: Uint8Array): { openHouse: boolean } {
  const reader = new BinaryReader(data);
  return { openHouse: reader.readUInt32() !== 0 };
}

/**
 * Build an AddFriend GameAction payload (outbound, GameActionType.AddFriend),
 * sent by /friends add|_add <name>.
 *
 * Wire format per GameActionAddFriend.cs (read order):
 *   [String16L friendName]
 */
export function buildAddFriendPayload(friendName: string): Uint8Array {
  const writer = new BinaryWriter(32);
  writer.writeString16(friendName);
  return writer.toBuffer();
}

export function parseAddFriendPayload(data: Uint8Array): { friendName: string } {
  const reader = new BinaryReader(data);
  return { friendName: reader.readString16() };
}

/**
 * Build a RemoveFriend GameAction payload (outbound, GameActionType.RemoveFriend),
 * sent by /friends remove|_remove <name> after the client resolves name→guid
 * against the cached friends list.
 *
 * Wire format per GameActionRemoveFriend.cs (read order):
 *   [uint32 friendGuid]
 */
export function buildRemoveFriendPayload(friendGuid: number): Uint8Array {
  const writer = new BinaryWriter(4);
  writer.writeUInt32(friendGuid);
  return writer.toBuffer();
}

export function parseRemoveFriendPayload(data: Uint8Array): { friendGuid: number } {
  const reader = new BinaryReader(data);
  return { friendGuid: reader.readUInt32() };
}

/**
 * Build a TurbineChat direct-message payload (outbound, GameMessageOpcode.TurbineChat,
 * ChatNetworkBlobType.NETBLOB_REQUEST_BINARY / ChatNetworkBlobDispatchType.ASYNCMETHOD_SENDTOROOMBYID).
 * This is NOT a GameAction — it's sent via serializeDirectMessage, not serializeGameAction.
 *
 * Wire format per TurbineChatHandler.cs:25-60 (read order):
 *   [uint32 outerBytesToFollow] [uint32 blobType] [uint32 dispatchType]
 *   [uint32 1] [uint32 0] [uint32 0] [uint32 0] [uint32 0]
 *   [uint32 innerBytesToFollow] [uint32 contextId] [uint32 2] [uint32 2]
 *   [uint32 channelId] [packed-byte msgLen] [UTF-16LE message]
 *   [uint32 extraDataSize=0xC] [uint32 senderGuid] [uint32 0] [uint32 chatType(=channelId)]
 *
 * The two "bytes to follow" fields do NOT hold the textbook "bytes strictly after
 * this field" count. GameMessageTurbineChat.cs:81-113 (the server's own writer for
 * the same wire format, S→C direction) computes each one via
 * `WritePosition(currentPos - fieldStartPos + 4, fieldStartPos)` — i.e. the field's
 * OWN 4 bytes are included in the delta, plus another +4 on top. A naive
 * "bytes after this field" reimplementation undercounts both fields by 4 (outer)
 * and 8 (inner). ACE's TurbineChatHandler discards both values (`ReadUInt32();
 * // Bytes to follow`, never used to bound reads) so the undercount has no effect
 * talking to ACE, but it's still a real wire-content deviation from the protocol
 * ACE itself constructs — the kind of silent corruption GAP.87 audits for.
 */
export function buildTurbineChatPayload(
  channelId: number,
  message: string,
  contextId: number,
  senderGuid: number,
  /** The blob's ChatType (SendTurbineChat's argument); defaults to the room id, which equals it for the fixed rooms. */
  chatType: number = channelId,
): Uint8Array {
  const msgLen = message.length;
  const packedLenSize = msgLen < 128 ? 1 : 2;
  const textUtf16 = new Uint8Array(msgLen * 2);
  for (let i = 0; i < msgLen; i++) {
    const code = message.charCodeAt(i);
    textUtf16[i * 2] = code & 0xFF;
    textUtf16[i * 2 + 1] = (code >> 8) & 0xFF;
  }
  // innerSize/outerSize per GameMessageTurbineChat.cs's WritePosition formula
  // (see doc comment above) — NOT plain "bytes after this field".
  const innerSize = 40 + packedLenSize + msgLen * 2;
  const outerSize = innerSize + 32;
  const writer = new BinaryWriter(outerSize + 4);
  writer.writeUInt32(outerSize);
  writer.writeUInt32(ChatNetworkBlobType.NETBLOB_REQUEST_BINARY);
  writer.writeUInt32(ChatNetworkBlobDispatchType.ASYNCMETHOD_SENDTOROOMBYID);
  writer.writeUInt32(1);
  writer.writeUInt32(0);
  writer.writeUInt32(0);
  writer.writeUInt32(0);
  writer.writeUInt32(0);
  writer.writeUInt32(innerSize);
  writer.writeUInt32(contextId);
  writer.writeUInt32(2);
  writer.writeUInt32(2);
  writer.writeUInt32(channelId);
  if (msgLen < 128) {
    writer.writeUInt8(msgLen);
  } else {
    writer.writeUInt8((msgLen >> 8) | 0x80);
    writer.writeUInt8(msgLen & 0xFF);
  }
  writer.writeBytes(textUtf16);
  writer.writeUInt32(TURBINE_CHAT_EXTRA_DATA_SIZE);
  writer.writeUInt32(senderGuid);
  writer.writeUInt32(0);
  writer.writeUInt32(chatType);
  return writer.toBuffer();
}

/**
 * Fields for {@link buildSetCharacterOptionsPayload}. Mirrors the subset of
 * GameActionSetCharacterOptions.cs's read that our "apply options panel"
 * caller emits — shortcut list and multi-spell-list tabs are always sent
 * empty (managed elsewhere via AddShortCut/RemoveShortCut +
 * AddSpellFavorite/RemoveSpellFavorite), so those flag bits are never set.
 */
export interface SetCharacterOptionsFields {
  options1: number;
  options2?: number;
  spellbookFilters?: number;
  desiredComponents?: Array<{ wcid: number; count: number }>;
  /**
   * CORE.3.f — serialized PackObjPropertyCollection (chat-window options)
   * appended as the trailing GameplayOptions section (flag 0x200). ACE
   * captures every remaining payload byte verbatim into
   * Character.GameplayOptions (GameActionSetCharacterOptions.cs:183-191)
   * and echoes it back in PlayerDescription, so the payload tail is padded
   * to a 4-byte boundary exactly like retail PlayerModule::Pack @ 005d45c0
   * (the pad bytes become part of the stored blob).
   */
  gameplayOptions?: Uint8Array;
}

/**
 * Build a SetCharacterOptions GameAction payload (outbound, GameActionType.SetCharacterOptions).
 *
 * Wire format per GameActionSetCharacterOptions.cs:45-130 (read order — only
 * the fields this builder ever emits are shown; Shortcut/MultiSpellList/
 * ExtendedMultiSpellLists/SpellLists8/TimestampFormat/GenericQualitiesData/
 * GameplayOptions are all gated by flag bits this builder never sets, so ACE
 * skips over them):
 *   [uint32 flags] [int32 characterOptions1Flag] [uint32 numTab1Spells(=0)]
 *   if flags & DesiredComps:   [uint32 sizeInfo=(0x80<<16)|count] [count × (uint32 wcid, int32 amount)]
 *   if flags & SpellbookFilters: [uint32 spellbookFilters]
 *   if flags & CharacterOptions2: [int32 characterOptions2Flag]
 */
export function buildSetCharacterOptionsPayload(opts: SetCharacterOptionsFields): Uint8Array {
  let flags = 0;
  if (opts.spellbookFilters !== undefined) flags |= CharacterOptionDataFlag.SpellbookFilters;
  if (opts.options2 !== undefined) flags |= CharacterOptionDataFlag.CharacterOptions2;
  const comps = opts.desiredComponents ?? [];
  if (comps.length > 0) flags |= CharacterOptionDataFlag.DesiredComps;
  const gameplay = opts.gameplayOptions;
  if (gameplay !== undefined && gameplay.length > 0) flags |= CharacterOptionDataFlag.GameplayOptions;

  const writer = new BinaryWriter(64 + comps.length * 8 + (gameplay?.length ?? 0) + 4);
  writer.writeUInt32(flags);
  writer.writeInt32(opts.options1);
  writer.writeUInt32(0); // numTab1Spells
  if (comps.length > 0) {
    const sizeInfo = (0x80 << 16) | (comps.length & 0xFFFF);
    writer.writeUInt32(sizeInfo);
    for (const c of comps) {
      writer.writeUInt32(c.wcid);
      writer.writeInt32(c.count);
    }
  }
  if (opts.spellbookFilters !== undefined) writer.writeUInt32(opts.spellbookFilters);
  if (opts.options2 !== undefined) writer.writeInt32(opts.options2);
  if (gameplay !== undefined && gameplay.length > 0) {
    // CORE.3.f — trailing GameplayOptions blob + zero-pad to a 4-byte
    // boundary (retail PlayerModule::Pack @ 005d45c0 pads the pack tail;
    // ACE stores blob + pad verbatim and PlayerModule::UnPack @ 005d49d0
    // re-aligns past the pad on read-back).
    writer.writeBytes(gameplay);
    while (writer.position % 4 !== 0) writer.writeUInt8(0);
  }
  return writer.toBuffer();
}

/**
 * Parse a SetCharacterOptions GameAction payload back out — test-only
 * round-trip helper, mirrors GameActionSetCharacterOptions.cs's read order
 * exactly for the flag combinations this builder can produce.
 */
export function parseSetCharacterOptionsPayload(data: Uint8Array): {
  flags: number;
  options1: number;
  numTab1Spells: number;
  desiredComponents: Array<{ wcid: number; count: number }>;
  spellbookFilters?: number;
  options2?: number;
  gameplayOptions?: Uint8Array;
} {
  const reader = new BinaryReader(data);
  const flags = reader.readUInt32();
  const options1 = reader.readInt32();
  const numTab1Spells = reader.readUInt32();
  const desiredComponents: Array<{ wcid: number; count: number }> = [];
  if (flags & CharacterOptionDataFlag.DesiredComps) {
    const sizeInfo = reader.readUInt32();
    const num = sizeInfo & 0xFFFF;
    for (let i = 0; i < num; i++) {
      desiredComponents.push({ wcid: reader.readUInt32(), count: reader.readInt32() });
    }
  }
  let spellbookFilters: number | undefined;
  if (flags & CharacterOptionDataFlag.SpellbookFilters) spellbookFilters = reader.readUInt32();
  let options2: number | undefined;
  if (flags & CharacterOptionDataFlag.CharacterOptions2) options2 = reader.readInt32();
  let gameplayOptions: Uint8Array | undefined;
  if (flags & CharacterOptionDataFlag.GameplayOptions) {
    // Mirrors ACE: "the last message... all that is left" — including pad.
    gameplayOptions = reader.readBytes(reader.remaining);
  }
  return { flags, options1, numTab1Spells, desiredComponents, spellbookFilters, options2, gameplayOptions };
}

/**
 * Parse a TurbineChat direct-message payload back out — test-only round-trip
 * helper, mirrors TurbineChatHandler.cs's read order (NETBLOB_REQUEST_BINARY /
 * ASYNCMETHOD_SENDTOROOMBYID branch) exactly, including the two discarded
 * "bytes to follow" fields (returned so tests can assert their exact values).
 */
export function parseTurbineChatPayload(data: Uint8Array): {
  outerBytesToFollow: number;
  blobType: number;
  dispatchType: number;
  innerBytesToFollow: number;
  contextId: number;
  channelId: number;
  message: string;
  senderGuid: number;
  chatType: number;
} {
  const reader = new BinaryReader(data);
  const outerBytesToFollow = reader.readUInt32();
  const blobType = reader.readUInt32();
  const dispatchType = reader.readUInt32();
  reader.readUInt32(); // always 1
  reader.readUInt32(); // always 0
  reader.readUInt32(); // always 0
  reader.readUInt32(); // always 0
  reader.readUInt32(); // always 0
  const innerBytesToFollow = reader.readUInt32();
  const contextId = reader.readUInt32();
  reader.readUInt32(); // always 2
  reader.readUInt32(); // always 2
  const channelId = reader.readUInt32();
  let msgLen = reader.readUInt8();
  if ((msgLen & 0x80) !== 0) {
    const lowByte = reader.readUInt8();
    msgLen = ((msgLen & 0x7F) << 8) | lowByte;
  }
  const messageBytes = reader.readBytes(msgLen * 2);
  let message = '';
  for (let i = 0; i < msgLen; i++) {
    message += String.fromCharCode(messageBytes[i * 2] | (messageBytes[i * 2 + 1] << 8));
  }
  reader.readUInt32(); // always 0xC (extraDataSize)
  const senderGuid = reader.readUInt32();
  reader.readUInt32(); // always 0 (hResult)
  const chatType = reader.readUInt32();
  return { outerBytesToFollow, blobType, dispatchType, innerBytesToFollow, contextId, channelId, message, senderGuid, chatType };
}

/**
 * Build a SIMPLIFIED 3-field test payload — NOT the real ACE HearSpeech wire format.
 *
 * The actual ACE GameMessageHearSpeech wire format (per
 * reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessageHearSpeech.cs)
 * is:
 *   WriteString16L messageText  — UTF-8 + pad-to-4
 *   WriteString16L senderName   — UTF-8 + pad-to-4
 *   Write senderID              — uint32
 *   Write (uint)chatMessageType — uint32
 *
 * That parser lives at ServerMessageHandler.handleHearSpeech in
 * packages/renderer/src/network/ServerMessageHandler.ts and reads all 4 fields.
 * The (build|parse)SpeechPayload helpers below are kept ONLY as a test-suite
 * round-trip harness for BinaryReader/Writer — they intentionally OMIT the
 * senderID field and should never be used to parse real wire data.
 *
 * @internal — DO NOT use for real ACE HearSpeech parsing.
 */
export function buildSpeechPayload(
  message: string,
  senderName: string,
  chatType: number,
): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeString16(message);
  writer.writeString16(senderName);
  writer.writeUInt32(chatType);
  return writer.toBuffer();
}

/**
 * @internal — paired with buildSpeechPayload. See the buildSpeechPayload JSDoc
 * for the warning: this is a 3-field test helper, NOT the real ACE wire format.
 */
export function parseSpeechPayload(data: Uint8Array): {
  message: string;
  senderName: string;
  chatType: number;
} {
  const reader = new BinaryReader(data);
  return {
    message: reader.readString16(),
    senderName: reader.readString16(),
    chatType: reader.readUInt32(),
  };
}

// ─── CharacterList Message Parser ────────────────────────

export interface CharacterListEntry {
  id: number;
  name: string;
  deleteTime: number;
}

export interface CharacterListData {
  characters: CharacterListEntry[];
  slotCount: number;
  accountName: string;
  useTurbineChat: boolean;
  hasThroneOfDestiny: boolean;
}

/**
 * Parse a CharacterList (0xF658) message payload.
 * The opcode uint32 has already been consumed by deserializeMessage.
 */
export function parseCharacterList(payload: Uint8Array): CharacterListData {
  const reader = new BinaryReader(payload);
  reader.readUInt32(); // unknown (always 0)
  const count = reader.readUInt32();

  const characters: CharacterListEntry[] = [];
  for (let i = 0; i < count; i++) {
    const id = reader.readUInt32();
    const name = reader.readString16();
    const deleteTime = reader.readUInt32();
    characters.push({ id, name, deleteTime });
  }

  reader.readUInt32(); // unknown (always 0)
  const slotCount = reader.readUInt32();
  const accountName = reader.readString16();
  const useTurbineChat = reader.readUInt32() !== 0;
  const hasThroneOfDestiny = reader.readUInt32() !== 0;

  return { characters, slotCount, accountName, useTurbineChat, hasThroneOfDestiny };
}

/**
 * Gate for outbound TurbineChat sends (global/trade/lfg/roleplay/society/
 * allegiance channels). ACE's TurbineChatHandler.TurbineChatReceived
 * silently drops the packet server-side when the use_turbine_chat server
 * property is false (PropertyManager.cs, default true), so the client
 * should check the CharacterList-supplied flag before sending rather than
 * emitting a packet the server will swallow with no feedback.
 * `undefined` (CharacterList not yet received) fails open, matching ACE's
 * own default-true property value.
 */
export function shouldSendTurbineChat(useTurbineChat: boolean | undefined): boolean {
  return useTurbineChat !== false;
}

// ─── ACE Server Message Builders ─────────────────────────

export interface CharacterCreateParams {
  accountName: string;
  heritage: number;
  gender: number;
  appearance: {
    eyes: number; nose: number; mouth: number;
    hairColor: number; eyeColor: number; hairStyle: number;
    headgearStyle: number; headgearColor: number;
    shirtStyle: number; shirtColor: number;
    pantsStyle: number; pantsColor: number;
    footwearStyle: number; footwearColor: number;
    skinHue: number; hairHue: number; headgearHue: number;
    shirtHue: number; pantsHue: number; footwearHue: number;
  };
  templateOption: number;
  strength: number; endurance: number; coordination: number;
  quickness: number; focus: number; self: number;
  characterSlot: number;
  classId: number;
  skills: number[]; // SkillAdvancementClass values per skill
  name: string;
  startArea: number;
}

/**
 * Build a CharacterCreate (0xF656) direct message.
 * Format: [opcode][accountName:String16L][uint32=1][heritage][gender]
 *         [appearance:14×uint32+6×float64][templateOption:int32]
 *         [6×attributes:uint32][slot][classId][numSkills][skills...][name:String16L]
 *         [startArea][isAdmin=0][isSentinel=0]
 */
export function buildCharacterCreate(params: CharacterCreateParams): Uint8Array {
  const writer = new BinaryWriter(512);
  writer.writeUInt32(GameMessageOpcode.CharacterCreate);
  writer.writeString16(params.accountName);

  // Unknown constant (always 1)
  writer.writeUInt32(1);

  writer.writeUInt32(params.heritage);
  writer.writeUInt32(params.gender);

  // Appearance: 14 uint32 + 6 float64
  const a = params.appearance;
  writer.writeUInt32(a.eyes);
  writer.writeUInt32(a.nose);
  writer.writeUInt32(a.mouth);
  writer.writeUInt32(a.hairColor);
  writer.writeUInt32(a.eyeColor);
  writer.writeUInt32(a.hairStyle);
  writer.writeUInt32(a.headgearStyle);
  writer.writeUInt32(a.headgearColor);
  writer.writeUInt32(a.shirtStyle);
  writer.writeUInt32(a.shirtColor);
  writer.writeUInt32(a.pantsStyle);
  writer.writeUInt32(a.pantsColor);
  writer.writeUInt32(a.footwearStyle);
  writer.writeUInt32(a.footwearColor);
  writer.writeFloat64(a.skinHue);
  writer.writeFloat64(a.hairHue);
  writer.writeFloat64(a.headgearHue);
  writer.writeFloat64(a.shirtHue);
  writer.writeFloat64(a.pantsHue);
  writer.writeFloat64(a.footwearHue);

  // Template option
  writer.writeInt32(params.templateOption);

  // Attributes
  writer.writeUInt32(params.strength);
  writer.writeUInt32(params.endurance);
  writer.writeUInt32(params.coordination);
  writer.writeUInt32(params.quickness);
  writer.writeUInt32(params.focus);
  writer.writeUInt32(params.self);

  // Character slot and class
  writer.writeUInt32(params.characterSlot);
  writer.writeUInt32(params.classId);

  // Skills
  writer.writeUInt32(params.skills.length);
  for (const skill of params.skills) {
    writer.writeUInt32(skill);
  }

  // Name
  writer.writeString16(params.name);

  // Start area, admin flags
  writer.writeUInt32(params.startArea);
  writer.writeUInt32(0); // isAdmin
  writer.writeUInt32(0); // isSentinel

  return writer.toBuffer();
}

/**
 * Build a CharacterEnterWorldRequest (0xF7C8) direct message.
 * Payload: empty (just opcode).
 */
export function buildCharacterEnterWorldRequest(): Uint8Array {
  const writer = new BinaryWriter(4);
  writer.writeUInt32(GameMessageOpcode.CharacterEnterWorldRequest);
  return writer.toBuffer();
}

/**
 * Build a CharacterEnterWorld (0xF657) direct message.
 * Payload: [uint32 characterGuid][String16L accountName]
 */
export function buildCharacterEnterWorld(characterGuid: number, accountName: string): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeUInt32(GameMessageOpcode.CharacterEnterWorld);
  writer.writeUInt32(characterGuid);
  writer.writeString16(accountName);
  return writer.toBuffer();
}

/**
 * Build a CharacterDelete (0xF655) C2S message. (ASSESS: real delete wire
 * flow — pre-fix the char-select Delete button only filtered a local array.)
 *
 * Wire format per ACE CharacterHandler.CharacterDelete
 * (reference/ACE/Source/ACE.Server/Network/Handlers/CharacterHandler.cs:273-277):
 *   string clientString = message.Payload.ReadString16L();  // MUST equal session.Account (line 291)
 *   uint characterSlot  = message.Payload.ReadUInt32();     // index into session.Characters (line 297)
 *
 * The slot index is the character's position in the last CharacterList
 * (0xF658): Session.cs:272 serializes `Characters` in list order, so the
 * index in our parsed list IS the server's slot index.
 *
 * On success ACE replies with GameMessageCharacterDelete (0xF655 S2C,
 * empty payload, CharacterHandler.cs:312) followed by a refreshed
 * CharacterList (line 322). The delete is SOFT: DeleteTime is set to the
 * EXPIRY timestamp `now + char_delete_time` (3600s default,
 * CharacterHandler.cs:314-315) — the slot is restorable until it passes.
 */
export function buildCharacterDelete(accountName: string, characterSlot: number): Uint8Array {
  const writer = new BinaryWriter(64);
  writer.writeUInt32(GameMessageOpcode.CharacterDelete);
  writer.writeString16(accountName);
  writer.writeUInt32(characterSlot);
  return writer.toBuffer();
}

/**
 * Build a CharacterRestore (0xF7D9) C2S message. (ASSESS: pairs with
 * buildCharacterDelete — un-deletes a slot inside its restore window.)
 *
 * Wire format per ACE CharacterHandler.CharacterRestore
 * (reference/ACE/Source/ACE.Server/Network/Handlers/CharacterHandler.cs:331-334):
 *   uint guid = message.Payload.ReadUInt32();
 *
 * Valid only while `Time.GetUnixTime() <= character.DeleteTime` (line 352).
 * Success reply: GameMessageCharacterRestore (0xF643) carrying
 * verification=1 + guid + name + 0u (line 379), already parsed by
 * ServerMessageHandler.onCharacterRestoreResponse. Name collision replies
 * CharCreateResponse NameInUse (line 362); expiry replies CharacterError.
 */
export function buildCharacterRestore(characterGuid: number): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeUInt32(GameMessageOpcode.CharacterRestore);
  writer.writeUInt32(characterGuid);
  return writer.toBuffer();
}

/**
 * Build a DDD_InterrogationResponse (0xF7E6) direct message.
 *
 * Format: [opcode][uint32 language=1]
 *         [m_ItersWithKeys: CAllIterationList = uint32 numLists, numLists × PTaggedIterationList]
 *         [m_ItersWithoutKeys: CAllIterationList, always empty = uint32 0]
 *         [uint32 m_dwFlags = 0]
 *
 * Field order is DDD_InterrogationResponseMessage::Serialize @ 004f9700.
 * CLCache::OnServerInterrogation @ 004fa3e0 builds the message on the stack:
 * it fills only m_ItersWithKeys (one AddIterationList per DAT) and leaves
 * m_ItersWithoutKeys as a fresh empty list and m_dwFlags at its zero init.
 * ACE stops reading after m_ItersWithKeys and GDLE after its fixed-size list
 * bodies, so the trailing 8 bytes are read by neither.
 *
 * Each PTaggedIterationList is keyed by a 64-bit tag (retail
 * `CAllIterationList::AddIterationList(unsigned __int64)` @ 006780a0, called
 * from the interrogation handler with each DAT's own tag): low dword = the DAT
 * header's DataSubset, high dword = its DataSet. From our EoL DAT headers
 * (offset 0x14C): portal (0, 1), cell (1, 2), local_English (1, 3). ACE calls
 * these DatFileType / DatFileId and only reads the id; GDLE switches on both
 * (Client.cpp, case 0xF7E6: ds 0/dss 1 = portal, ds 1/dss 2 = cell).
 *
 * The list body is the CMostlyConsecutiveIntSet, which retail serializes
 * straight from the DAT's iteration file (0xFFFF0001): [int32 total] then
 * (int32 -count, int32 start) runs. A fully patched DAT is the single run
 * "N iterations starting at 1": [N, -N, 1], 12 bytes. GDLE memcmp()s those 12
 * bytes against its own iteration file (TurbineData::CompareIteration) and
 * always advances 12 bytes per list, so anything else fails the login with
 * STR_LOGIN_CLIENT_VERSION. ACE's ReadCMostlyConsecutiveIntSet accepts it too
 * (-N adds N-1, the 1 adds one: total N), and DDDManager recognises
 * |-N| == total as "no missing iterations".
 *
 * N = 0 (DAT not loaded) writes just [0]: the set is empty.
 */
export function buildDDDInterrogationResponse(
  portalIterations: number = 0,
  cellIterations: number = 0,
  languageIterations: number = 0,
): Uint8Array {
  const writer = new BinaryWriter(128);
  writer.writeUInt32(GameMessageOpcode.DDD_InterrogationResponse);
  writer.writeUInt32(1); // m_ClientLanguage = English

  // CAllIterationList with 3 entries (portal, cell, language)
  writer.writeUInt32(3); // numElements

  const writeEntry = (dataSubset: number, dataSet: number, iterations: number) => {
    writer.writeUInt32(dataSubset); // tag low dword (ACE: DatFileType)
    writer.writeUInt32(dataSet);    // tag high dword (ACE: DatFileId)
    writer.writeInt32(iterations);  // CMostlyConsecutiveIntSet total
    if (iterations > 0) {
      writer.writeInt32(-iterations); // one run of N consecutive iterations...
      writer.writeInt32(1);           // ...starting at iteration 1
    }
  };

  writeEntry(0, 1, portalIterations);   // client_portal.dat
  writeEntry(1, 2, cellIterations);     // client_cell_1.dat
  writeEntry(1, 3, languageIterations); // client_local_English.dat

  writer.writeUInt32(0); // m_ItersWithoutKeys: empty CAllIterationList
  writer.writeUInt32(0); // m_dwFlags

  return writer.toBuffer();
}

/**
 * Build a LoginComplete GameAction (0xF7B1 + 0x00A1).
 * This tells the server the client has finished loading.
 */
export function buildLoginComplete(sequence: number): Uint8Array {
  return serializeGameAction(sequence, GameActionType.LoginComplete);
}

/**
 * Parse a CharacterCreateResponse (0xF643) payload.
 * Returns response code and (if successful) the new character GUID and name.
 */
export interface CharacterCreateResponseData {
  responseCode: number; // 1=Ok, 3=NameInUse, 4=NameBanned, 5=Corrupt, 6=DatabaseDown
  characterGuid?: number;
  characterName?: string;
}

export function parseCharacterCreateResponse(payload: Uint8Array): CharacterCreateResponseData {
  const reader = new BinaryReader(payload);
  const responseCode = reader.readUInt32();
  if (responseCode === 1 && reader.remaining >= 4) {
    const characterGuid = reader.readUInt32();
    const characterName = reader.remaining >= 2 ? reader.readString16() : '';
    return { responseCode, characterGuid, characterName };
  }
  return { responseCode };
}

/**
 * Parse a CharacterRestoreResponse (0xF643) payload — ACE reuses the same
 * wire opcode as CharacterCreateResponse for this message (see
 * GameMessageOpcode.ts). Wire format per ACE
 * GameMessageCharacterRestore.cs: u32 verificationOk (always 1) + u32
 * objectGuid + String16L name + u32 secondsDisabled (login cooldown after
 * undelete). Callers must disambiguate from CharacterCreateResponse via
 * client-side context (e.g. whether a CharacterCreate request is
 * outstanding) since the opcode alone can't tell the two shapes apart.
 */
export interface CharacterRestoreResponseData {
  verificationOk: boolean;
  objectGuid: number;
  name: string;
  secondsDisabled: number;
}

export function parseCharacterRestoreResponse(payload: Uint8Array): CharacterRestoreResponseData {
  const reader = new BinaryReader(payload);
  const verificationOk = reader.readUInt32() !== 0;
  const objectGuid = reader.readUInt32();
  const name = reader.readString16();
  const secondsDisabled = reader.remaining >= 4 ? reader.readUInt32() : 0;
  return { verificationOk, objectGuid, name, secondsDisabled };
}

/** ServerName (0xF7E1) payload — the world/realm identity shown on the
 *  character-select world plate. */
export interface ServerNameData {
  /** Players currently connected to this world. */
  currentConnections: number;
  /** Max connections this world accepts (-1 = unspecified). */
  maxConnections: number;
  /** World/realm name (ACE default "ACEmulator"; retail e.g. "Thistledown"). */
  serverName: string;
}

/** Parse a ServerName (0xF7E1) message. Wire format per ACE
 *  GameMessageServerName.cs: currentConnections:i32, maxConnections:i32,
 *  serverName:string16L (u16 length + windows-1252 bytes + 4-byte align). */
export function parseServerName(payload: Uint8Array): ServerNameData {
  const reader = new BinaryReader(payload);
  const currentConnections = reader.readInt32();
  const maxConnections = reader.readInt32();
  const serverName = reader.remaining >= 2 ? reader.readString16() : '';
  return { currentConnections, maxConnections, serverName };
}

// ─── DDD (Dynamic DAT Distribution / DAT patching) parsers ────────────────
// FAITHFUL: DDD_BeginDDD (0xF7E7) and DDD_DataMessage (0xF7E2) previously
// had no ClientConnection case despite a stale ServerMessageHandler comment
// claiming they were "handled by ClientConnection directly" — every message
// silently fell through to the generic no-op case. ACE only sends these
// when DDD.EnableDATPatching=true and the client's reported DAT iterations
// (DDD_InterrogationResponse) are older than the server's — a real,
// documented, non-default config, not a hypothetical.

/** Server's numeric (datFileType, datFileID) pair identifying which DAT a
 *  DDD entry targets. Per ACE GameMessageDDDBeginDDD.cs WriteIterations /
 *  GameMessageDDDDataMessage.cs: Portal=(0,1), Cell=(1,2), Language=(1,3),
 *  HighRes=(DDDManager.HiFi_String_As_Int, 1) — HighRes shares datFileID=1
 *  with Portal, so HiFi must be checked first via datFileType. */
export type DDDDatType = 'portal' | 'cell' | 'language' | 'highres';

/** DDDManager.HiFi_String_As_Int = BitConverter.ToInt32(UTF8("HiFi"), 0). */
const DDD_HIFI_STRING_AS_INT = 0x69466948;

function dddDatType(datFileType: number, datFileID: number): DDDDatType {
  if (datFileType === DDD_HIFI_STRING_AS_INT) return 'highres';
  if (datFileType === 0 && datFileID === 1) return 'portal';
  if (datFileType === 1 && datFileID === 2) return 'cell';
  return 'language';
}

/** One (datType, iteration) entry from a DDD_BeginDDD payload. */
export interface DDDMissingIterationEntry {
  datType: DDDDatType;
  iteration: number;
  /** File object IDs the server queued to stream via DDD_DataMessage next (empty for Cell — cell updates are purge-only per ACE's WriteIterations comment). */
  idsToDownload: number[];
  /** File object IDs to evict from the local cache (Cell-only in practice). */
  idsToPurge: number[];
}

export interface DDDBeginDDDData {
  /** Total byte size of the patch data about to be streamed via DDD_DataMessage. */
  totalFileSize: number;
  /** Total count of (datType, iteration) entries below — server-declared, drives the read loop. */
  totalMissingIterations: number;
  entries: DDDMissingIterationEntry[];
}

/** Parse a DDD_BeginDDD (0xF7E7) payload. Wire format per ACE
 *  GameMessageDDDBeginDDD.cs: u32 totalFileSize + u32 totalMissingIterations,
 *  then totalMissingIterations × entry: i32 datFileType + i32 datFileID +
 *  i32 iteration + i32 idsToDownloadCount + idsToDownloadCount×u32 +
 *  i32 idsToPurgeCount + idsToPurgeCount×u32. (Cell entries write download
 *  count=0 then purge count+ids; Portal/Language/HighRes write download
 *  count+ids then purge count=0 — the reader doesn't need to special-case
 *  this since both count-prefixed blocks are always present.) */
export function parseDDDBeginDDD(payload: Uint8Array): DDDBeginDDDData {
  const reader = new BinaryReader(payload);
  const totalFileSize = reader.readUInt32();
  const totalMissingIterations = reader.readUInt32();
  const entries: DDDMissingIterationEntry[] = [];
  for (let i = 0; i < totalMissingIterations; i++) {
    const datFileType = reader.readInt32();
    const datFileID = reader.readInt32();
    const iteration = reader.readInt32();
    const idsToDownloadCount = reader.readInt32();
    const idsToDownload: number[] = [];
    for (let j = 0; j < idsToDownloadCount; j++) idsToDownload.push(reader.readUInt32());
    const idsToPurgeCount = reader.readInt32();
    const idsToPurge: number[] = [];
    for (let j = 0; j < idsToPurgeCount; j++) idsToPurge.push(reader.readUInt32());
    entries.push({ datType: dddDatType(datFileType, datFileID), iteration, idsToDownload, idsToPurge });
  }
  return { totalFileSize, totalMissingIterations, entries };
}

/** One streamed DAT file's contents from a DDD_DataMessage payload. */
export interface DDDDataMessageData {
  datType: DDDDatType;
  /** ACE DatFile.GetFileType() result — the high-byte file-type range documented in CLAUDE.md (0x01=GraphicsObject, 0x06=Texture, etc). */
  fileType: number;
  /** The DAT object ID (ACE DatFile.ObjectId) this patch applies to. */
  fileId: number;
  iteration: number;
  isCompressed: boolean;
  /** Protocol version, always 3 per GameMessageDDDDataMessage.cs. */
  version: number;
  contents: Uint8Array;
}

/** Parse a DDD_DataMessage (0xF7E2) payload. Wire format per ACE
 *  GameMessageDDDDataMessage.cs: u32 datFileType + u32 datFileID +
 *  u32 fileType + u32 fileId + u32 iteration + bool isCompressed (1 byte,
 *  BinaryWriter.Write(bool)) + i32 version + i32 length (= contents.length+4,
 *  self-inclusive of this length field) + (length-4) content bytes. */
export function parseDDDDataMessage(payload: Uint8Array): DDDDataMessageData {
  const reader = new BinaryReader(payload);
  const datFileType = reader.readUInt32();
  const datFileID = reader.readUInt32();
  const fileType = reader.readUInt32();
  const fileId = reader.readUInt32();
  const iteration = reader.readUInt32();
  const isCompressed = reader.readUInt8() !== 0;
  const version = reader.readInt32();
  const length = reader.readInt32();
  const contents = reader.readBytes(Math.max(0, length - 4));
  return { datType: dddDatType(datFileType, datFileID), fileType, fileId, iteration, isCompressed, version, contents };
}

// ─── CreateObject Parser (0xF745) ───────────────────────────

/** Physics description flags from CreateObject. */
const enum PhysicsDescFlag {
  CSetup              = 0x000001,
  MTable              = 0x000002,
  Velocity            = 0x000004,
  Acceleration        = 0x000008,
  Omega              = 0x000010,
  Parent              = 0x000020,
  Children            = 0x000040,
  ObjScale            = 0x000080,
  Friction            = 0x000100,
  Elasticity          = 0x000200,
  STable              = 0x000800,
  PeTable             = 0x001000,
  DefaultScript       = 0x002000,
  DefaultScriptIntensity = 0x004000,
  Position            = 0x008000,
  Movement            = 0x010000,
  AnimationFrame      = 0x020000,
  Translucency        = 0x040000,
}

/** Weenie header flags for conditional fields. Anchored to
 *  reference/ACE/Source/ACE.Entity/Enum/WeenieHeaderFlags.cs WeenieHeaderFlag. */
const enum WeenieHeaderFlag {
  PluralName                = 0x00000001,
  ItemsCapacity             = 0x00000002,
  ContainersCapacity        = 0x00000004,
  Value                     = 0x00000008,
  Usable                    = 0x00000010,
  UseRadius                 = 0x00000020,
  Monarch                   = 0x00000040,
  UiEffects                 = 0x00000080,
  AmmoType                  = 0x00000100,
  CombatUse                 = 0x00000200,
  Structure                 = 0x00000400,
  MaxStructure              = 0x00000800,
  StackSize                 = 0x00001000,
  MaxStackSize              = 0x00002000,
  Container                 = 0x00004000,
  Wielder                   = 0x00008000,
  ValidLocations            = 0x00010000,
  CurrentlyWieldedLocation  = 0x00020000,
  Priority                  = 0x00040000,
  TargetType                = 0x00080000,
  RadarBlipColor            = 0x00100000,
  Burden                    = 0x00200000,
  Spell                     = 0x00400000,
  RadarBehavior             = 0x00800000,
  Workmanship               = 0x01000000,
  HouseOwner                = 0x02000000,
  HouseRestrictions         = 0x04000000,
  PScript                   = 0x08000000,
  HookType                  = 0x10000000,
  HookItemTypes             = 0x20000000,
  IconOverlay               = 0x40000000,
  MaterialType              = 0x80000000,
}

/** Second weenie header flags (extension byte). Per
 *  reference/ACE/Source/ACE.Entity/Enum/WeenieHeaderFlags.cs WeenieHeaderFlag2. */
const enum WeenieHeaderFlag2 {
  IconUnderlay      = 0x01,
  Cooldown          = 0x02,
  CooldownDuration  = 0x04,
  PetOwner          = 0x08,
}

/** Object description flags. */
const enum ObjDescFlag {
  IncludesSecondHeader = 0x04000000,
}

export interface ACPosition {
  landblock: number; // uint32 landblock cell ID (0xXXYYZZWW)
  x: number;
  y: number;
  z: number;
  rw: number;
  rx: number;
  ry: number;
  rz: number;
}

/**
 * Retail PhysicsTimestamp — the index of each slot in a PhysicsDesc's
 * timestamp array / CPhysicsObj::update_times[] (the decomp's POSITION_TS 0
 * … INSTANCE_TS 8; ACE writes them in this order, WorldObject_Networking.cs
 * :411-419).
 */
export const PhysicsTimestamp = {
  Position: 0, Movement: 1, State: 2, Vector: 3, Teleport: 4,
  ServerControlledMove: 5, ForcePosition: 6, ObjDesc: 7, Instance: 8,
} as const;

export interface CreateObjectData {
  guid: number;
  name: string;
  /** CORE.10.e — WeenieHeaderFlag.PluralName (0x1) String16L, sent when the
   *  weenie defines PropertyString.PluralName (ACE WorldObject_Networking.cs:87).
   *  The parser always sets it ('' when the flag is absent); retail
   *  GetObjectName(NAME_APPROPRIATE) then pluralizes client-side
   *  (name+"s"/"es") for stacks of >=2. Optional so synthetic fixtures
   *  stay valid. */
  pluralName?: string;
  weenieClassId: number;
  itemType: number;
  position: ACPosition | null;
  setupId: number;   // 0x02xxxxxx model reference
  /** PhysicsScriptTable DID (0x34xxxxxx) from the PeTable physics-desc field — GAP.13. */
  peTableId?: number;
  motionTableId: number; // 0x09xxxxxx motion table reference
  iconId: number;
  physicsState: number;
  objectDescFlags: number;
  radarColor: number;
  radarBehavior: number;
  // Appearance overrides from ObjDesc (model data section)
  basePalette: number;  // 0x04xxxxxx base palette (only if numSubPalettes > 0)
  subPalettes: { paletteId: number; offset: number; length: number }[];
  textureChanges: { partIndex: number; oldTexture: number; newTexture: number }[];
  animPartChanges: { partIndex: number; partId: number }[];
  // Inventory/equipment fields
  containerId: number;   // GUID of container this item is in (0 = none)
  wielderId: number;     // GUID of wielder (0 = none)
  currentWieldedLocation: number; // EquipMask slot (0 = not wielded)
  /**
   * BUG.clothingpriority-never-lands — WeenieHeaderFlag.Priority (0x40000)
   * uint, filled by ACE from item.ClothingPriority (a CoverageMask;
   * WorldObject_Networking.cs:141-142). The flag is written only when the
   * property is non-null, so this is the authoritative per-object source:
   * retail orders overlapping equipped surfaces by it (cloak under armor)
   * in the paperdoll layer-blend pass. The PlayerDescription equipped-item
   * list (GameEventPlayerDescription.cs:418-424) carries the same value
   * with `?? 0`, so it adds no information beyond this field.
   * undefined = flag not sent.
   */
  clothingPriority?: number;
  /** WeenieHeaderFlag.AmmoType (0x100) — the AmmoType a launcher/ammo uses; undefined = not sent. */
  ammoType?: number;
  /**
   * FAITHFUL.574 — ACE-authoritative visual attachment point from
   * `PhysicsDescriptionFlag.Parent` per
   * `reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs:358-362`:
   *   if (Parent bit set): writer.Write(WielderId ?? 0) + writer.Write((uint)(ParentLocation ?? 0))
   * Different from CurrentWieldedLocation (which is an EquipMask, e.g.
   * MeleeWeapon=0x4000) — ParentLocation is the `ParentLocation` enum
   * (RightHand=1, LeftHand=2, Shield=3, etc.) used for the visual mesh
   * attachment point. Pre-fix the parser read both Parent fields but
   * stored neither, so the equipped-item visualization had to derive
   * ParentLocation from EquipMask + DefaultCombatStyle via
   * `wieldLocationFromMask` — which works for the 4 weapon EquipMasks
   * but returns `ParentLocation.None` for everything else and can't
   * distinguish unusual server-side overrides. 0 = none (no Parent
   * block written or ParentLocation was null).
   */
  parentLocation: number;
  /**
   * The PhysicsDesc Parent block's holder guid (0 = no Parent block).
   * `SmartBox::HandleCreateObject` @ 00454c80 reads it
   * (PhysicsDesc::get_parent_id): an object created with a parent never
   * enters the world, even when the desc also carries a position (ACE
   * sends both for an item wielded in view — BUG.wielded-item-left-behind-on-teleport).
   */
  physicsParentId?: number;
  validLocations: number;        // EquipMask bitmask of valid equip slots
  stackSize: number;
  maxStackSize: number;
  value: number;
  burden: number;
  uiEffects: number;     // UiEffects flag mask — Magical/Poisoned/Fire/Frost/etc. (per ACE UiEffects.cs)
  usable: number;        // ItemUseable bits (ACE Usable.cs) — high 16 bits ≠ 0 ⇒ use-with-target item
  /**
   * BUG.distant-use-silent-noop — WeenieHeaderFlag.UseRadius float from the
   * wire, defaulted to 0.6 when the flag is absent because every ACE
   * use-range gate applies exactly that fallback for a null property
   * (Player_Move.cs:59 / WorldObject_Use.cs:50 `wo.UseRadius ?? 0.6f`).
   * Drives the client-side approach-then-use walk distance.
   */
  useRadius: number;
  /** CORE.12 — WeenieHeaderFlag.CombatUse sbyte (ACE CombatUse.cs: Melee=1,
   *  Missile=2, Ammo=3, Shield=4, TwoHanded=5; 0 when flag absent). The
   *  combat toggle's GetDefaultCombatMode reads the wielded weapon's value
   *  to pick Missile vs Melee. Optional so hand-built CreateObjectData
   *  fixtures elsewhere stay valid; parseCreateObject always sets it. */
  combatUse?: number;
  /** CORE.17.o.a — WeenieHeaderFlag.ItemsCapacity byte (ACE ItemCapacity,
   *  WorldObject_Networking.cs:90, flag set when the property is non-null
   *  and the object is not a SlumLord), read SIGNED like retail's
   *  PublicWeenieDesc::UnPack (char): ACE packs carry 24, the world DB's
   *  -1 containers (chests, corpses) arrive as 0xff = -1. The open pack's
   *  grid is a fixed list of exactly this many cells when the container is
   *  Openable and the value is >= 0 (ItemList_UpdateContainerListSize
   *  @ 004e39e0; a negative value keeps the visible-area padding). 0 when
   *  the flag is absent — the retail unpack default. Optional so hand-built
   *  fixtures stay valid; parseCreateObject always sets it. */
  itemsCapacity?: number;
  /** CORE.18.c — PublicWeenieDesc._containersCapacity (WeenieHeaderFlag
   *  0x4), read like _itemsCapacity as a SIGNED char (UnPack @ 005ad470,
   *  decomp :415000), 0 when absent. m_containerList — the nested-container
   *  list of the open-container strip — is sized by it through the same
   *  ItemList_UpdateContainerListSize rule (a list with containerList set
   *  reads _containersCapacity): chests' -1 pads the list's visible area. */
  containersCapacity?: number;
  // Physics velocity (for missiles/projectiles)
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /** PhysicsDesc Omega (AC axes, rad/s); 0 when absent. Optional so hand-built fixtures stay valid. */
  omegaX?: number;
  omegaY?: number;
  omegaZ?: number;
  /** PhysicsDesc Elasticity; undefined when absent (the client default applies). */
  elasticity?: number;
  // Sound table for object-specific sounds
  soundTableId: number;
  /**
   * FAITHFUL.374 — ObjScale multiplier from the PhysicsDesc ObjScale
   * field (PhysicsDescFlag.ObjScale = 0x80; ACE PhysicsObj_Network.cs).
   * Pre-fix this was read and discarded — every creature/object
   * rendered at scale 1.0 even when the server sent a non-unit value
   * (mob "tier" growth, pets, polymorph). Defaults to 1.0 when the
   * flag bit isn't set on the wire.
   */
  objScale: number;
  /**
   * FAITHFUL.375 — Translucency from PhysicsDescFlag.Translucency (0x200).
   * 0.0 = fully opaque (default when flag bit absent), 1.0 = fully
   * invisible. ACE uses this for ghost creatures, fading-out lifestone
   * effects, and dispelled summons. Pre-fix this was parsed and
   * discarded; meshes always rendered fully opaque.
   */
  translucency: number;
  /**
   * FAITHFUL.376 — PhysicsScript ID override from
   * PhysicsDescFlag.DefaultScript (0x100000). When non-zero, this
   * overrides the SetupModel's defaultScript on a per-instance basis
   * (admin-spawned glow, custom particle, etc.). Pre-fix the parser
   * read the uint32 and discarded it; the override had no effect.
   * 0 = no override (use setup.defaultScript).
   */
  defaultScript: number;
  /**
   * FAITHFUL.376 — DefaultScriptIntensity from
   * PhysicsDescFlag.DefaultScriptIntensity (0x200000). Float multiplier
   * passed to the script player; 1.0 when the flag bit is absent.
   */
  defaultScriptIntensity: number;
  /**
   * DECOMP.recreate-teardown — the PhysicsDesc's 9 sequence timestamps in
   * retail PhysicsTimestamp order (PhysicsTimestamp below): position,
   * movement, state, vector, teleport, server-controlled move, force
   * position, objdesc, instance. Optional: hand-built CreateObjectData
   * (tests, appearance rebuilds) may omit it.
   */
  timestamps?: number[];
  /**
   * BUG.createobject-movement-placement-skipped — the PhysicsDesc Movement
   * blob (PhysicsDescFlag.Movement, 0x4), ACE's serialization of the
   * object's authoritative CurrentMotionState at create time: stance +
   * forward command (MotionCommand.Dead for corpses, On/Off for open/closed
   * doors, sitting/sleeping poses, etc.). Written headerless by ACE
   * WorldObject_Networking.cs SerializePhysicsData via
   * `writer.Write(movementData, false)` inside a uint32 length prefix.
   * Pre-fix the parser skipped the blob wholesale, so already-open doors
   * rendered closed and corpses stood in idle until their next live motion
   * broadcast. Undefined when the flag is absent or the blob is empty.
   */
  initialMotion?: ParsedMovementData;
  /**
   * BUG.createobject-movement-placement-skipped — IsAutonomous uint32
   * written after a non-empty Movement blob (client- vs server-initiated
   * motion). Undefined when no Movement blob was present.
   */
  isAutonomous?: boolean;
  /**
   * BUG.createobject-movement-placement-skipped — Placement uint from
   * PhysicsDescFlag.AnimationFrame (0x8000000), written when the object has
   * no CurrentMotionState (ACE CalculatedPhysicsDescriptionFlag: Movement
   * else AnimationFrame). Indexes the SetupModel's placementFrames (per-part
   * static pose — e.g. Resting/On/Off hooks). Undefined when absent;
   * 0 = Placement.Default.
   */
  placement?: number;
  /**
   * BUG.icon-overlay-underlay-dropped — WeenieHeaderFlag.IconOverlay
   * (0x40000000) DID. Composited on top of the base icon: a small badge
   * in the icon's top-right corner (Aetheria tier number per
   * asheron.fandom.com/wiki/Aetheria: "the level is also indicated on
   * the top right corner of the icon"). ACE sets this on Aetheria via
   * LootGenerationFactory_Aetheria.cs:29. 0 = no overlay.
   */
  iconOverlayId: number;
  /**
   * CORE.17.d — WeenieHeaderFlag.Monarch (0x40) IID: the object's allegiance
   * monarch (ACE WorldObject_Networking.cs writes MonarchId when set). The
   * retail radar draws players of the local player's own allegiance as the
   * hollow-box blip (gmRadarUI::GetBlipShape → ACCWeenieObject::
   * IsAllegianceMember: obj.monarch != 0 && obj.monarch == player.monarch).
   * 0 / undefined = flag absent.
   */
  monarchGuid?: number;
  /**
   * PublicWeenieDesc._hook_type (WeenieHeaderFlag.HookType ushort): on a
   * housing hook, the kinds of mount it is (floor / wall / ceiling bits); on
   * an item, the mounts it fits. ItemHolder::CheckHookStatus @ 00586e90.
   * 0 / undefined = not sent.
   */
  hookType?: number;
  /** PublicWeenieDesc._hook_item_types (WeenieHeaderFlag.HookItemTypes): the ITEM_TYPE bits a hook takes. */
  hookItemTypes?: number;
  /** PublicWeenieDesc._house_owner_iid (WeenieHeaderFlag.HouseOwner): the owner of the house a hook belongs to (0 = none). */
  houseOwnerId?: number;
  /**
   * BUG.icon-overlay-underlay-dropped — WeenieHeaderFlag2.IconUnderlay
   * (0x01) DID. Composited full-size BEHIND the base icon (a background
   * glow). ACE stamps rare items with 0x6005B0C via Corpse.cs:341-342.
   * 0 = no underlay.
   */
  iconUnderlayId: number;
  /**
   * BUG.cooldown-id-duration-discarded — WeenieHeaderFlag2.Cooldown (0x02)
   * uint. ACE PropertyInt.SharedCooldown (280): the shared-cooldown group id
   * for a use-triggered item (rare gems). While the item is recharging, the
   * player carries a Cooldown-category enchantment whose spell id is
   * 0x8000 + this value (EnchantmentManager.StartCooldown); the retail icon
   * decile meter is driven by that pairing
   * (UIElement_UIItem::UpdateCooldownDisplay @ 004e1e20). 0 = none.
   */
  cooldownId: number;
  /**
   * BUG.cooldown-id-duration-discarded — WeenieHeaderFlag2.CooldownDuration
   * (0x04) double, seconds. ACE PropertyFloat.CooldownDuration (167): full
   * recharge time when used; the denominator of the icon meter's
   * remaining/duration decile. 0 = not sent.
   */
  cooldownDuration: number;
  /**
   * RECON.object-is-attackable-port — WeenieHeaderFlag2.PetOwner: the guid
   * of the player who owns this pet (PublicWeenieDesc._pet_owner, 0 when
   * absent). ClientCombatSystem::ObjectIsAttackable @ 0056a600 never treats
   * an owned pet as attackable.
   */
  petOwner?: number;
  /**
   * BUG.structure-maxstructure-discarded — WeenieHeaderFlag.Structure
   * (0x400) ushort. ACE PropertyInt.Structure (92): uses remaining on a
   * limited-use item (healing kit, lockpick, mana stone). Numerator of the
   * retail icon uses-remaining bar (UIElement_UIItem::UpdateStructureDisplay
   * @ 004e17a0 fills StructureBar element 0x10000348 to
   * structure/maxStructure). Optional so hand-built CreateObjectData
   * fixtures elsewhere stay valid; parseCreateObject always sets it
   * (0 when the flag is absent).
   */
  structure?: number;
  /**
   * BUG.structure-maxstructure-discarded — WeenieHeaderFlag.MaxStructure
   * (0x800) ushort. ACE PropertyInt.MaxStructure (91): total uses when
   * fresh; the bar's denominator. Retail hides the bar when this is 0 or
   * when structure/maxStructure is exactly 1.0. Optional for fixtures;
   * parseCreateObject always sets it (0 when the flag is absent).
   */
  maxStructure?: number;
  /**
   * CORE.17.k.b.b.c.c.a.a.c.a.a.a — WeenieHeaderFlag.MaterialType
   * (0x80000000) uint. ACE PropertyInt.MaterialType (131); retail keeps it
   * as PublicWeenieDesc._material_type, which gmSalvageUI::IsItemSuitable
   * @ 004cb040 tests with TinkeringSystem::IsValidMaterialType. Optional for
   * fixtures; parseCreateObject always sets it (0 when the flag is absent).
   */
  materialType?: number;
  /**
   * BUG.weenie-targettype-discarded — WeenieHeaderFlag.TargetType (0x80000)
   * uint. ACE PropertyInt.TargetType (94): ItemType bitmask of legal
   * use-with targets for this item (healing kit → Creature, key → item
   * types). Retail gates targeted use client-side with it:
   * ItemHolder::TargetCompatibleWithObject @ 00587520 accepts only when
   * `source.pwd._targetType & target->GetItemType()` is non-zero, else
   * notices "Cannot use the %s with the %s" and never sends the request.
   * 0 = no restriction (ACE writes the flag only when TargetType != null).
   * Optional for hand-built fixtures; parseCreateObject always sets it.
   */
  targetType?: number;
  /**
   * CORE.17.k.b.b.a.g.e — WeenieHeaderFlag.Spell (0x400000) ushort: the
   * item's built-in spell (ACE PropertyDataId.Spell, written only when
   * SpellDID is set — WorldObject_Networking.cs:159-160 / 791-792). Retail's
   * `pwd._spellID` — gmSpellcastingUI::UpdateEndowmentIcon @ 004c6120 draws
   * the wielded caster's spell as the spell bar's endowment icon 0x100000b1.
   * undefined = flag absent (no built-in spell).
   */
  spellDid?: number;
}

/**
 * Parse a CreateObject (0xF745) payload.
 * Extracts key fields: guid, name, position, model, icon.
 * Skips over complex sub-structures (model data, movement data, etc.)
 */
export function parseCreateObject(payload: Uint8Array): CreateObjectData | null {
  try {
    return parseCreateObjectFromReader(new BinaryReader(payload));
  } catch (e) {
    // Log first 4 bytes to identify GUID
    const guidHex = payload.length >= 4 ? `0x${(payload[0] | (payload[1]<<8) | (payload[2]<<16) | ((payload[3]<<24)>>>0)).toString(16)}` : '?';
    console.error(`[parseCreateObject] PARSE ERROR guid=${guidHex}, payload length=${payload.length}:`, e);
    // Log first 64 bytes hex for debugging
    const hexSlice = Array.from(payload.slice(0, Math.min(64, payload.length))).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.error(`[parseCreateObject] payload hex (first 64): ${hexSlice}`);
    return null;
  }
}

/**
 * Same field-parsing logic as {@link parseCreateObject}, but takes an
 * already-constructed {@link BinaryReader} and does not catch parse errors.
 * `parseCreateObject`'s `Uint8Array`-in / `CreateObjectData`-out contract
 * discards the reader's final cursor position; this variant exposes it so
 * callers (tests) can assert on `r.position` after parsing — used to
 * behaviorally pin the trailing `r.align(4)` per ACE
 * WorldObject_Networking.cs:220 (tests/verify-create-object-final-align.ts).
 */
export function parseCreateObjectFromReader(r: BinaryReader): CreateObjectData {
    // ── GUID ────────────────────────────
    const guid = r.readUInt32();

    // ── MODEL DATA ──────────────────────
    const modelByte = r.readUInt8(); // should be 0x11
    if (modelByte !== 0x11) {
      console.warn(`[parseCreateObject] unexpected model byte 0x${modelByte.toString(16)}, expected 0x11`);
    }
    const numSubPalettes = r.readUInt8();
    const numTexChanges = r.readUInt8();
    const numAnimParts = r.readUInt8();

    // Sub-palettes: optional palette base ID + per-palette entries
    let basePalette = 0;
    const subPalettes: CreateObjectData['subPalettes'] = [];
    if (numSubPalettes > 0) {
      basePalette = r.readPackedDwordOfKnownType(0x04000000);
    }
    for (let i = 0; i < numSubPalettes; i++) {
      const paletteId = r.readPackedDwordOfKnownType(0x04000000);
      const rawOffset = r.readUInt8();
      const rawLength = r.readUInt8();
      // AC protocol: offset/length are in units of 8 palette entries
      subPalettes.push({
        paletteId,
        offset: rawOffset * 8,
        length: (rawLength === 0 ? 256 : rawLength) * 8,
      });
    }

    // Texture changes
    const textureChanges: CreateObjectData['textureChanges'] = [];
    for (let i = 0; i < numTexChanges; i++) {
      textureChanges.push({
        partIndex: r.readUInt8(),
        oldTexture: r.readPackedDwordOfKnownType(0x05000000),
        newTexture: r.readPackedDwordOfKnownType(0x05000000),
      });
    }

    // Animation part changes
    const animPartChanges: CreateObjectData['animPartChanges'] = [];
    for (let i = 0; i < numAnimParts; i++) {
      animPartChanges.push({
        partIndex: r.readUInt8(),
        partId: r.readPackedDwordOfKnownType(0x01000000),
      });
    }

    r.align(4);

    // ── PHYSICS DATA ────────────────────
    const physFlags = r.readUInt32();
    const physicsState = r.readUInt32();

    let position: ACPosition | null = null;
    let setupId = 0;
    let peTableId = 0;
    let motionTableId = 0;
    let soundTableId = 0;

    // Movement — BUG.createobject-movement-placement-skipped: the blob is
    // ACE's headerless MovementData (CurrentMotionState — the object's
    // initial pose). Framing stays length-driven: the cursor always lands
    // at blobStart + movLen regardless of what the body parse consumes
    // (the blob carries a trailing align + optional sticky guid we don't
    // need), so byte-consumption is identical to the old r.skip(movLen).
    let initialMotion: ParsedMovementData | undefined;
    let isAutonomous: boolean | undefined;
    let placement: number | undefined;
    if (physFlags & PhysicsDescFlag.Movement) {
      const movLen = r.readUInt32();
      if (movLen > 0) {
        initialMotion = parseMovementData(r.readBytes(movLen), false) ?? undefined;
        isAutonomous = r.readUInt32() !== 0;
      }
    } else if (physFlags & PhysicsDescFlag.AnimationFrame) {
      placement = r.readUInt32();
    }

    // Position
    if (physFlags & PhysicsDescFlag.Position) {
      const landblock = r.readUInt32();
      const x = r.readFloat32();
      const y = r.readFloat32();
      const z = r.readFloat32();
      const rw = r.readFloat32();
      const rx = r.readFloat32();
      const ry = r.readFloat32();
      const rz = r.readFloat32();
      position = { landblock, x, y, z, rw, rx, ry, rz };
    }

    // MTable (MotionTable ID — 0x09xxxxxx)
    if (physFlags & PhysicsDescFlag.MTable) motionTableId = r.readUInt32();

    // STable (SoundTable ID — 0x20xxxxxx)
    if (physFlags & PhysicsDescFlag.STable) soundTableId = r.readUInt32();

    // PeTable — GAP.13: the object's PhysicsScriptTable DID (0x34xxxxxx,
    // PropertyDataId.PhysicsEffectTable=22). The retail client resolves
    // broadcast PlayScript enums through THIS table (player setups carry
    // no DefaultScriptTable — players get 0x34000004 from the weenie).
    // Was read-and-discarded pre-GAP.13.
    if (physFlags & PhysicsDescFlag.PeTable) peTableId = r.readUInt32();

    // CSetup
    if (physFlags & PhysicsDescFlag.CSetup) {
      setupId = r.readUInt32();
    }

    // Parent — FAITHFUL.574: surface ParentLocation (was discarded).
    // wielderId is redundant with the WeenieHeaderFlag.Wielder field
    // below (both come from WorldObject.WielderId in ACE), but
    // ParentLocation is ONLY available via this physics block — the
    // visual attachment point can't be recovered from EquipMask alone
    // for non-weapon wieldables.
    let parentLocation = 0;
    let physicsParentId = 0;
    if (physFlags & PhysicsDescFlag.Parent) {
      physicsParentId = r.readUInt32() >>> 0;
      parentLocation = r.readUInt32();
    }

    // Children
    if (physFlags & PhysicsDescFlag.Children) {
      const childCount = r.readUInt32();
      for (let i = 0; i < childCount; i++) {
        r.readUInt32(); // child guid
        r.readUInt32(); // location id
      }
    }

    // ObjScale — FAITHFUL.374: captured + returned (was discarded).
    let objScale = 1.0;
    if (physFlags & PhysicsDescFlag.ObjScale) objScale = r.readFloat32();

    // Friction
    if (physFlags & PhysicsDescFlag.Friction) r.readFloat32();

    // Elasticity — BUG.spell-projectile-physics: a missile's contact
    // reflection factor (CPhysicsObj::set_description → set_elasticity).
    let elasticity: number | undefined;
    if (physFlags & PhysicsDescFlag.Elasticity) elasticity = r.readFloat32();

    // Translucency — FAITHFUL.375: captured + returned (was discarded).
    let translucency = 0.0;
    if (physFlags & PhysicsDescFlag.Translucency) translucency = r.readFloat32();

    // Velocity
    let velocityX = 0, velocityY = 0, velocityZ = 0;
    if (physFlags & PhysicsDescFlag.Velocity) { velocityX = r.readFloat32(); velocityY = r.readFloat32(); velocityZ = r.readFloat32(); }

    // Acceleration
    if (physFlags & PhysicsDescFlag.Acceleration) { r.readFloat32(); r.readFloat32(); r.readFloat32(); }

    // Omega — BUG.spell-projectile-physics: the spin a spell projectile
    // with a RotationSpeed launches with (SpellProjectile.Setup sets
    // PhysicsObj.Omega = (2π·RotationSpeed, 0, 0)); set_description copies it
    // into m_omegaVector.
    let omegaX = 0, omegaY = 0, omegaZ = 0;
    if (physFlags & PhysicsDescFlag.Omega) { omegaX = r.readFloat32(); omegaY = r.readFloat32(); omegaZ = r.readFloat32(); }

    // DefaultScript — FAITHFUL.376: captured + returned (was discarded).
    let defaultScript = 0;
    if (physFlags & PhysicsDescFlag.DefaultScript) defaultScript = r.readUInt32();

    // DefaultScriptIntensity — FAITHFUL.376: captured + returned (was discarded).
    // Absent = 0.0 (CPhysicsDesc::UnPack, decomp :277285).
    let defaultScriptIntensity = 0;
    if (physFlags & PhysicsDescFlag.DefaultScriptIntensity) defaultScriptIntensity = r.readFloat32();

    // 9 sequence timestamps (always present) — each is ushort (UShortSequence
    // in ACE, WorldObject_Networking.cs:411-419). DECOMP.recreate-teardown —
    // kept: SmartBox::HandleCreateObject @ 00454c80 compares INSTANCE_TS
    // against the held object's and seeds each update_times[] slot from them.
    const timestamps: number[] = [];
    for (let i = 0; i < 9; i++) timestamps.push(r.readUInt16());

    r.align(4);

    // ── WEENIE DATA ─────────────────────
    const weenieFlags = r.readUInt32();
    const name = r.readString16();
    const weenieClassId = r.readPackedDword();
    const iconId = r.readPackedDwordOfKnownType(0x06000000);
    const itemType = r.readUInt32();
    const objectDescFlags = r.readUInt32();

    r.align(4);

    // WeenieHeaderFlags2 (if present)
    let weenieFlags2 = 0;
    if (objectDescFlags & ObjDescFlag.IncludesSecondHeader) {
      weenieFlags2 = r.readUInt32();
    }

    // Parse conditional weenie fields, extracting inventory-relevant data
    let radarColor = 0;
    let radarBehavior = 0;
    let containerId = 0;
    let wielderId = 0;
    let currentWieldedLocation = 0;
    let validLocations = 0;
    let stackSize = 0;
    let maxStackSize = 0;
    let value = 0;
    let burden = 0;
    let uiEffects = 0;
    // GAP.21 — ItemUseable routing bits (ACE Usable.cs): low 16 = source
    // flags, high 16 = target flags. TargetMask ≠ 0 marks a use-WITH-
    // target item (key, lockpick, healing kit) — the client routes
    // double-click to UseWithTarget when a world object is selected.
    let usable = 0;
    // CORE.12 — CombatUse captured (was consumed + dropped): the retail
    // combat toggle's GetDefaultCombatMode needs the wielded weapon's
    // CombatUse to pick Missile vs Melee.
    let combatUse = 0;
    // BUG.distant-use-silent-noop — an absent UseRadius flag means the
    // property is null server-side, and every ACE use-range gate falls back
    // to 0.6f there (Player_Move.cs:59 `target.UseRadius ?? 0.6f`), so the
    // fallback IS the correct parsed value, not merely unknown.
    let useRadius = 0.6;

    // CORE.10.e — PluralName captured (was consumed + dropped): retail
    // GetObjectName(NAME_APPROPRIATE) labels stacks of >=2 with it.
    let pluralName = '';
    if (weenieFlags & WeenieHeaderFlag.PluralName) pluralName = r.readString16();
    // CORE.17.o.a — ItemsCapacity captured (was consumed + dropped): the
    // retail pack grid is a FIXED list of the open container's
    // PublicWeenieDesc._itemsCapacity cells (UIElement_ItemList::
    // ItemList_UpdateContainerListSize @ 004e39e0). PublicWeenieDesc::UnPack
    // @ 005ad470 (decomp :414997) reads it as a SIGNED char — ACE writes the
    // world DB's -1 containers (chests, corpses) as 0xff, which retail sees
    // as -1 (no fixed count) — and defaults it to 0 when the flag is absent
    // (:414533), as here.
    let itemsCapacity = 0;
    if (weenieFlags & WeenieHeaderFlag.ItemsCapacity) itemsCapacity = r.readInt8(); // signed byte
    let containersCapacity = 0;
    if (weenieFlags & WeenieHeaderFlag.ContainersCapacity) containersCapacity = r.readInt8(); // signed byte
    // WeenieHeaderFlag.AmmoType (ushort) — the appraisal's "Uses arrows as
    // ammunition." (ItemExamineUI: PWD _ammoType); kept, not discarded.
    let ammoType: number | undefined;
    if (weenieFlags & WeenieHeaderFlag.AmmoType) ammoType = r.readUInt16();
    if (weenieFlags & WeenieHeaderFlag.Value) value = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.Usable) usable = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.UseRadius) useRadius = r.readFloat32();
    // BUG.weenie-targettype-discarded — captured, not discarded: the retail
    // client-side use-with-target compatibility gate
    // (ItemHolder::TargetCompatibleWithObject @ 00587520) tests
    // `pwd._targetType & target itemType` before sending the request.
    let targetType = 0;
    if (weenieFlags & WeenieHeaderFlag.TargetType) targetType = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.UiEffects) uiEffects = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.CombatUse) combatUse = r.readInt8(); // sbyte
    // BUG.structure-maxstructure-discarded — captured, not discarded: the
    // retail item-icon uses-remaining bar (UIElement_UIItem::
    // UpdateStructureDisplay @ 004e17a0) fills the 5x30 StructureBar meter
    // (element 0x10000348, LayoutDesc 0x21000037) to _structure /
    // _maxStructure. ACE writes both as ushorts
    // (WorldObject_Networking.cs:117-121).
    let structure = 0;
    let maxStructure = 0;
    if (weenieFlags & WeenieHeaderFlag.Structure) structure = r.readUInt16();
    if (weenieFlags & WeenieHeaderFlag.MaxStructure) maxStructure = r.readUInt16();
    if (weenieFlags & WeenieHeaderFlag.StackSize) stackSize = r.readUInt16();
    if (weenieFlags & WeenieHeaderFlag.MaxStackSize) maxStackSize = r.readUInt16();
    if (weenieFlags & WeenieHeaderFlag.Container) containerId = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.Wielder) wielderId = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.ValidLocations) validLocations = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.CurrentlyWieldedLocation) currentWieldedLocation = r.readUInt32();
    // BUG.clothingpriority-never-lands — captured, not discarded: ACE fills
    // this from item.ClothingPriority (WorldObject_Networking.cs:141-142,
    // flag set only when the property is non-null), making it the
    // authoritative per-object source for the paperdoll layer-blend order.
    // undefined = flag not sent (property null server-side).
    let clothingPriority: number | undefined;
    if (weenieFlags & WeenieHeaderFlag.Priority) clothingPriority = r.readUInt32();
    if (weenieFlags & WeenieHeaderFlag.RadarBlipColor) radarColor = r.readUInt8();
    if (weenieFlags & WeenieHeaderFlag.RadarBehavior) radarBehavior = r.readUInt8();
    // BUG.9 — PScript is a USHORT on the wire: ACE WorldObject_Properties.cs:1536
    // `public ushort? Script` → WorldObject_Networking.cs:150 writes 2 bytes.
    // Reading u32 here drifted every later field by 2 bytes; on house objects
    // (which also carry HouseRestrictions) the misaligned RestrictionDB walk
    // ran off the buffer and the object never spawned client-side (observed
    // live 2026-07-04: cottages 0x73b9c04e-50, RangeError at payload 140/144).
    if (weenieFlags & WeenieHeaderFlag.PScript) r.readUInt16();     // ushort script DID
    if (weenieFlags & WeenieHeaderFlag.Workmanship) r.readFloat32(); // float
    if (weenieFlags & WeenieHeaderFlag.Burden) burden = r.readUInt16();
    // CORE.17.k.b.b.a.g.e — captured, not discarded: pwd._spellID feeds the
    // spell bar's endowment icon (gmSpellcastingUI::UpdateEndowmentIcon @
    // 004c6120). ACE writes the ushort SpellDID only when set.
    let spellDid: number | undefined;
    if (weenieFlags & WeenieHeaderFlag.Spell) spellDid = r.readUInt16();
    // ItemHolder::CheckHookStatus @ 00586e90 reads _house_owner_iid,
    // _hook_item_types and _hook_type (a housing hook's store gate).
    let houseOwnerId = 0;
    if (weenieFlags & WeenieHeaderFlag.HouseOwner) houseOwnerId = r.readUInt32();  // uint owner guid
    if (weenieFlags & WeenieHeaderFlag.HouseRestrictions) {
      // FAITHFUL.293 — consume the RestrictionDB struct in place so the
      // trailing weenie fields (HookItemTypes / Monarch / HookType / IconOverlay /
      // IconUnderlay / MaterialType / Cooldown / CooldownDuration / PetOwner)
      // remain readable. Pre-fix this branch returned a partial weenie and
      // dropped those 9 fields whenever a house object was sent in a
      // CreateObject. Wire format per ACE RestrictionDBExtensions.Write
      // (reference/ACE/Source/ACE.Server/Network/Structure/RestrictionDB.cs:74).
      skipRestrictionDB(r);
    }
    let hookItemTypes = 0;
    if (weenieFlags & WeenieHeaderFlag.HookItemTypes) hookItemTypes = r.readUInt32();
    // CORE.17.d — captured, not discarded: the radar's allegiance-member
    // blip shape is ACCWeenieObject::IsAllegianceMember @ 0058c630 =
    // `obj.monarch != 0 && obj.monarch == player.monarch` (see
    // CreateObjectData.monarchGuid).
    let monarchGuid = 0;
    if (weenieFlags & WeenieHeaderFlag.Monarch) monarchGuid = r.readUInt32();     // uint monarch guid
    let hookType = 0;
    if (weenieFlags & WeenieHeaderFlag.HookType) hookType = r.readUInt16();    // ushort
    // BUG.icon-overlay-underlay-dropped — captured, not discarded (see
    // CreateObjectData.iconOverlayId/.iconUnderlayId doc comments).
    let iconOverlayId = 0;
    if (weenieFlags & WeenieHeaderFlag.IconOverlay) iconOverlayId = r.readPackedDwordOfKnownType(0x06000000);
    // weenieFlags2 fields (IconUnderlay, Cooldown, CooldownDuration, PetOwner)
    let iconUnderlayId = 0;
    if (weenieFlags2 & WeenieHeaderFlag2.IconUnderlay) iconUnderlayId = r.readPackedDwordOfKnownType(0x06000000);
    // CORE.17.k.b.b.c.c.a.a.c.a.a.a — captured (CreateObjectData.materialType).
    let materialType = 0;
    if (weenieFlags & WeenieHeaderFlag.MaterialType) materialType = r.readUInt32();
    // BUG.cooldown-id-duration-discarded — captured, not discarded: the
    // retail item-icon cooldown meter (UIElement_UIItem::UpdateCooldownDisplay
    // @ 004e1e20) maps the icon to the player's active cooldown enchantment
    // via pwd._cooldown_id (+0x8000) and scales the decile overlay by
    // pwd._cooldown_duration. ACE writes uint + double
    // (WorldObject_Networking.cs:211-215).
    let cooldownId = 0;
    let cooldownDuration = 0;
    if (weenieFlags2 & WeenieHeaderFlag2.Cooldown) cooldownId = r.readUInt32();
    if (weenieFlags2 & WeenieHeaderFlag2.CooldownDuration) cooldownDuration = r.readFloat64();
    let petOwner = 0;
    if (weenieFlags2 & WeenieHeaderFlag2.PetOwner) petOwner = r.readUInt32();

    // Per ACE WorldObject_Networking.cs:220 SerializeCreateObject ends with
    // `writer.Align();` (4-byte boundary by default). Without this final
    // align, the parser cursor stops up to 3 bytes short of payload end.
    // Today the function returns and the cursor isn't reused, but pinning
    // byte-exact wire-format parity protects against any future consumer
    // that reads from the same buffer post-parse (e.g. multi-message
    // dispatch in a single fragment).
    r.align(4);

    return {
      guid, name, pluralName, weenieClassId, itemType, position, setupId, peTableId, motionTableId,
      iconId, physicsState, objectDescFlags, radarColor, radarBehavior,
      basePalette, subPalettes, textureChanges, animPartChanges,
      containerId, wielderId, currentWieldedLocation, clothingPriority, ammoType, parentLocation, physicsParentId, validLocations, stackSize, maxStackSize, value, burden,
      uiEffects, usable, useRadius, combatUse, itemsCapacity, containersCapacity,
      velocityX, velocityY, velocityZ, omegaX, omegaY, omegaZ, elasticity, soundTableId,
      objScale,
      translucency,
      defaultScript,
      defaultScriptIntensity,
      iconOverlayId,
      iconUnderlayId,
      monarchGuid,
      hookType,
      hookItemTypes,
      houseOwnerId,
      cooldownId,
      cooldownDuration,
      petOwner,
      structure,
      maxStructure,
      materialType,
      targetType,
      spellDid,
      initialMotion,
      isAutonomous,
      placement,
      timestamps,
    };
}

// ─── ApproachVendor Parser (GameEvent 0x0062) ──────────────────

export interface VendorItemData {
  guid: number;
  name: string;
  weenieClassId: number;
  iconId: number;
  itemType: number;
  value: number;
  burden: number;
  stackSize: number;
  maxStackSize: number;
  /** CORE.10.f — WeenieHeaderFlag.PluralName, kept for the toolbar stack
   *  label when a vendor row seeds the global selection ('' = not sent). */
  pluralName?: string;
  /** BUG.icon-overlay-underlay-dropped — see CreateObjectData.iconOverlayId doc. */
  iconOverlayId: number;
  /** BUG.icon-overlay-underlay-dropped — see CreateObjectData.iconUnderlayId doc. */
  iconUnderlayId: number;
  /** BUG.cooldown-id-duration-discarded — see CreateObjectData.cooldownId doc. */
  cooldownId: number;
  /** BUG.cooldown-id-duration-discarded — see CreateObjectData.cooldownDuration doc. */
  cooldownDuration: number;
  /** BUG.structure-maxstructure-discarded — see CreateObjectData.structure doc. */
  structure: number;
  /** BUG.structure-maxstructure-discarded — see CreateObjectData.maxStructure doc. */
  maxStructure: number;
  /** BUG.weenie-targettype-discarded — see CreateObjectData.targetType doc. */
  targetType: number;
  /** CORE.18.c.a — WeenieHeaderFlag.UiEffects (0 = not sent): the merchandise
   *  cell's RenderIcons outline tint (IconData::RenderIcons @ 0058d180). */
  uiEffects: number;
  /** RECON.vendor-price-formulas — PublicWeenieDesc._bitfield / _itemsCapacity / _containersCapacity (InqListSlotCount). */
  objectDescFlags?: number;
  itemsCapacity?: number;
  containersCapacity?: number;
  /** The weenie desc's own _stackSize (WeenieHeaderFlag.StackSize; 0 when absent). */
  descStackSize?: number;
  /** WeenieHeaderFlag.Usable (_useability; 0 when absent) — toolbar Use button. */
  usable?: number;
  /** WeenieHeaderFlag.CombatUse sbyte (0 when absent) — toolbar Use button. */
  combatUse?: number;
}

export interface ApproachVendorData {
  vendorGuid: number;
  merchandiseItemTypes: number;
  merchandiseMinValue: number;
  merchandiseMaxValue: number;
  dealMagicalItems: boolean;
  buyPrice: number;   // multiplier when buying from vendor
  sellPrice: number;  // multiplier when selling to vendor
  alternateCurrency: number;
  altCurrencyAmount: number;
  altCurrencyName: string;
  items: VendorItemData[];
}

/**
 * Parse an ApproachVendor (0x0062) GameEvent payload.
 * ACE format: vendor header + numItems × (stackPacked + GameDataOnly serialization).
 * GameDataOnly = weenie data WITHOUT model/physics sections.
 */
export function parseApproachVendor(payload: Uint8Array): ApproachVendorData | null {
  try {
    const r = new BinaryReader(payload);

    const vendorGuid = r.readUInt32();
    const merchandiseItemTypes = r.readUInt32();
    const merchandiseMinValue = r.readUInt32();
    const merchandiseMaxValue = r.readUInt32();
    const dealMagicalItems = r.readUInt32() !== 0;
    const buyPrice = r.readFloat32();
    const sellPrice = r.readFloat32();
    const alternateCurrency = r.readUInt32();

    // Alt currency info (always present — 0 + empty string if no alt currency)
    const altCurrencyAmount = r.readUInt32();
    const altCurrencyName = r.readString16();

    const numItems = r.readUInt32();
    const items: VendorItemData[] = [];

    // BUG.approach-vendor-no-per-item-recovery — each item's parse is
    // wrapped in its own try/catch. A malformed/unexpected merchandise
    // entry leaves the reader cursor at an unknown offset (no per-item
    // length prefix to resync on), so we can't safely parse *later*
    // items once one fails — but we CAN still return the vendor header
    // plus every item successfully parsed before the failure, instead of
    // the pre-fix behavior of the outer catch discarding the whole
    // message (vendor header AND all already-parsed items) on any single
    // bad entry anywhere in the stream.
    for (let i = 0; i < numItems; i++) {
      try {
        // Packed: (stackSize & 0xFFFFFF) | (pwdType << 24)
        // pwdType is always -1 (0xFF in upper byte) = PublicWeenieDesc format
        const packed = r.readUInt32();
        const vendorStackSize = packed & 0x00FFFFFF;
        // Sign-extend: if bit 23 is set, it's negative (unlimited = -1)
        const signedStack = (vendorStackSize & 0x800000) ? (vendorStackSize | 0xFF000000) : vendorStackSize;

        // ── GameDataOnly: skip model/physics, start at GUID + weenie data ──
        const guid = r.readUInt32();

        const weenieFlags = r.readUInt32();
        const name = r.readString16();
        const weenieClassId = r.readPackedDword();
        const iconId = r.readPackedDwordOfKnownType(0x06000000);
        const itemType = r.readUInt32();
        const objectDescFlags = r.readUInt32();

        r.align(4);

        // WeenieHeaderFlags2
        let weenieFlags2 = 0;
        if (objectDescFlags & ObjDescFlag.IncludesSecondHeader) {
          weenieFlags2 = r.readUInt32();
        }

        // Parse conditional weenie fields — same order as parseCreateObject
        let value = 0;
        let burden = 0;
        let stackSize = 0;
        let maxStackSize = 0;
        // BUG.structure-maxstructure-discarded — uses-remaining bar inputs.
        let structure = 0;
        let maxStructure = 0;

        // CORE.10.f — captured (was read-and-discarded), sibling of the
        // CORE.10.e CreateObject capture: the toolbar stack label needs it.
        let pluralName = '';
        if (weenieFlags & WeenieHeaderFlag.PluralName) pluralName = r.readString16();
        // RECON.vendor-price-formulas — kept for gmVendorUI::InqListSlotCount
        // @ 004c0c10 (a pack / container in the buy list takes a container
        // slot, not an item slot).
        let itemsCapacity = 0;
        let containersCapacity = 0;
        if (weenieFlags & WeenieHeaderFlag.ItemsCapacity) itemsCapacity = r.readUInt8();
        if (weenieFlags & WeenieHeaderFlag.ContainersCapacity) containersCapacity = r.readUInt8();
        if (weenieFlags & WeenieHeaderFlag.AmmoType) r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.Value) value = r.readUInt32();
        // SWEEP1006B.hud-status.toolbar-use-button-greyed-target — kept for
        // the toolbar Use button when a merchandise row is the selection.
        let usable = 0;
        if (weenieFlags & WeenieHeaderFlag.Usable) usable = r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.UseRadius) r.readFloat32();
        // BUG.weenie-targettype-discarded — captured (see parseCreateObject).
        let targetType = 0;
        if (weenieFlags & WeenieHeaderFlag.TargetType) targetType = r.readUInt32();
        // CORE.18.c.a — captured (was read-and-discarded): the cell's tint.
        let uiEffects = 0;
        if (weenieFlags & WeenieHeaderFlag.UiEffects) uiEffects = r.readUInt32();
        let combatUse = 0;
        if (weenieFlags & WeenieHeaderFlag.CombatUse) combatUse = r.readInt8();
        // BUG.structure-maxstructure-discarded — captured (see
        // parseCreateObject): a used lockpick/kit in the player's pack shows
        // its uses-remaining bar in the vendor sell list too.
        if (weenieFlags & WeenieHeaderFlag.Structure) structure = r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.MaxStructure) maxStructure = r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.StackSize) stackSize = r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.MaxStackSize) maxStackSize = r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.Container) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.Wielder) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.ValidLocations) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.CurrentlyWieldedLocation) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.Priority) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.RadarBlipColor) r.readUInt8();
        if (weenieFlags & WeenieHeaderFlag.RadarBehavior) r.readUInt8();
        // BUG.9 — ushort on the wire (ACE WorldObject_Properties.cs:1536), same
        // fix as parseCreateObject above.
        if (weenieFlags & WeenieHeaderFlag.PScript) r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.Workmanship) r.readFloat32();
        if (weenieFlags & WeenieHeaderFlag.Burden) burden = r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.Spell) r.readUInt16();
        if (weenieFlags & WeenieHeaderFlag.HouseOwner) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.HouseRestrictions) {
          // FAITHFUL.293 — consume the RestrictionDB struct so trailing weenie
          // fields stay readable. Vendors aren't usually expected to ship items
          // with HouseRestrictions set, but the pre-fix `break` would silently
          // stop the entire merchandise stream after the offending item.
          skipRestrictionDB(r);
        }
        if (weenieFlags & WeenieHeaderFlag.HookItemTypes) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.Monarch) r.readUInt32();
        if (weenieFlags & WeenieHeaderFlag.HookType) r.readUInt16();
        // BUG.icon-overlay-underlay-dropped — captured, not discarded.
        let iconOverlayId = 0;
        if (weenieFlags & WeenieHeaderFlag.IconOverlay) iconOverlayId = r.readPackedDwordOfKnownType(0x06000000);
        let iconUnderlayId = 0;
        if (weenieFlags2 & WeenieHeaderFlag2.IconUnderlay) iconUnderlayId = r.readPackedDwordOfKnownType(0x06000000);
        if (weenieFlags & WeenieHeaderFlag.MaterialType) r.readUInt32();
        // BUG.cooldown-id-duration-discarded — captured (see parseCreateObject):
        // a vendor-stocked gem shows the same decile meter when the player is
        // on its shared cooldown.
        let cooldownId = 0;
        let cooldownDuration = 0;
        if (weenieFlags2 & WeenieHeaderFlag2.Cooldown) cooldownId = r.readUInt32();
        if (weenieFlags2 & WeenieHeaderFlag2.CooldownDuration) cooldownDuration = r.readFloat64();
        if (weenieFlags2 & WeenieHeaderFlag2.PetOwner) r.readUInt32();

        r.align(4);

        items.push({
          guid,
          name,
          weenieClassId,
          iconId,
          itemType,
          value,
          burden,
          stackSize: signedStack < 0 ? -1 : (stackSize || vendorStackSize),
          // RECON.vendor-price-formulas — the desc's OWN _stackSize (0 when
          // the header omits it): VendorSellPrice divides _value by it, never
          // by the profile amount above (-1 = unlimited stock).
          descStackSize: stackSize,
          usable,
          combatUse,
          maxStackSize,
          pluralName: pluralName || undefined,
          iconOverlayId,
          iconUnderlayId,
          cooldownId,
          cooldownDuration,
          structure,
          maxStructure,
          targetType,
          uiEffects,
          objectDescFlags,
          itemsCapacity,
          containersCapacity,
        });
      } catch (itemError) {
        console.warn(
          `[parseApproachVendor] item ${i + 1}/${numItems} failed to parse — keeping the ${items.length} item(s) already parsed, dropping the rest of this vendor's stock (cursor position is unrecoverable past a malformed entry):`,
          itemError,
        );
        break;
      }
    }

    return {
      vendorGuid, merchandiseItemTypes, merchandiseMinValue, merchandiseMaxValue,
      dealMagicalItems, buyPrice, sellPrice, alternateCurrency,
      altCurrencyAmount, altCurrencyName, items,
    };
  } catch (e) {
    console.error('[parseApproachVendor] Parse error:', e);
    return null;
  }
}

/* ================================================================ */
/*  Fellowship parsing                                                */
/* ================================================================ */

export interface FellowData {
  guid: number;
  level: number;
  healthMax: number;
  staminaMax: number;
  manaMax: number;
  healthCurrent: number;
  staminaCurrent: number;
  manaCurrent: number;
  shareLoot: boolean;
  name: string;
}

export interface FellowshipData {
  fellows: FellowData[];
  fellowshipName: string;
  leaderGuid: number;
  shareXP: boolean;
  evenShare: boolean;
  open: boolean;
  isLocked: boolean;
  /** The fellows PackableHashTable's bucket count (its iteration order: ClientFellowshipSystem::SelectNextFellow). */
  tableSize: number;
  /**
   * Fellowship::_fellows_departed (PackableHashTable<ulong,long>): departed
   * member guid → the server time they left. ACE Fellowship.cs writes it via
   * FellowshipExtensions.Write (header + guid u32 + timestamp i32 per entry).
   */
  departedMembers: Map<number, number>;
  /**
   * ACE's FellowshipLocks table (lock name → FellowshipLockData), appended
   * after the departed table. Retail Fellowship::UnPack @ 005b94f0 stops after
   * _fellows_departed and never reads it; we parse it so the payload is
   * consumed whole and nothing trailing goes unaccounted.
   */
  fellowshipLocks: Map<string, FellowshipLockData>;
}

/** ACE FellowshipLockData.cs: five u32s written in this order. */
export interface FellowshipLockData {
  unknown1: number;
  unknown2: number;
  unknown3: number;
  timestamp: number;
  sequence: number;
}

/** Parse GameEvent FellowshipFullUpdate (0x02BE). */
export function parseFellowshipFullUpdate(payload: Uint8Array): FellowshipData | null {
  try {
    const r = new BinaryReader(payload);

    // Hash table: count + numBuckets (always 16)
    const count = r.readUInt16();
    const tableSize = r.readUInt16();

    const fellows: FellowData[] = [];
    for (let i = 0; i < count; i++) {
      const guid = r.readUInt32();
      const _cpCached = r.readUInt32();
      const _lumCached = r.readUInt32();
      const level = r.readUInt32();
      const healthMax = r.readUInt32();
      const staminaMax = r.readUInt32();
      const manaMax = r.readUInt32();
      const healthCurrent = r.readUInt32();
      const staminaCurrent = r.readUInt32();
      const manaCurrent = r.readUInt32();
      const shareLootFlag = r.readUInt32();
      const shareLoot = (shareLootFlag & 0x10) !== 0;
      // ACE WriteString16L pads (2 + length) to 4-byte boundary. Skipping the
      // pad bytes silently shifts every subsequent field — including the next
      // fellow's guid — by 0–3 bytes.
      const name = readString16L(r);
      fellows.push({ guid, level, healthMax, staminaMax, manaMax, healthCurrent, staminaCurrent, manaCurrent, shareLoot, name });
    }

    // Fellowship metadata
    const fellowshipName = readString16L(r);
    const leaderGuid = r.readUInt32();
    const shareXP = r.readUInt32() !== 0;
    const evenShare = r.readUInt32() !== 0;
    const open = r.readUInt32() !== 0;
    const isLocked = r.readUInt32() !== 0;

    // ACE GameEventFellowshipFullUpdate.cs:40-42 then writes DepartedMembers
    // and FellowshipLocks. Retail CM_Fellowship::DispatchUI_FullUpdate
    // @ 006a68a0 ignores Fellowship::UnPack's result and hands the fellowship
    // over regardless, so a short or malformed tail keeps the roster above.
    const departedMembers = new Map<number, number>();
    const fellowshipLocks = new Map<string, FellowshipLockData>();
    try {
      if (r.remaining > 0) {
        const departedCount = r.readUInt16();
        r.readUInt16(); // numBuckets (ACE HashComparer(32))
        for (let i = 0; i < departedCount; i++) {
          const guid = r.readUInt32();
          departedMembers.set(guid, r.readInt32());
        }
      }
      if (r.remaining > 0) {
        const lockCount = r.readUInt16();
        r.readUInt16(); // numBuckets (FellowshipLockDataExtensions.NumBuckets = 32)
        for (let i = 0; i < lockCount; i++) {
          const name = readString16L(r);
          fellowshipLocks.set(name, {
            unknown1: r.readUInt32(), unknown2: r.readUInt32(), unknown3: r.readUInt32(),
            timestamp: r.readUInt32(), sequence: r.readUInt32(),
          });
        }
      }
      if (r.remaining !== 0) {
        console.warn(`[parseFellowshipFullUpdate] ${r.remaining} trailing byte(s) after FellowshipLocks`);
      }
    } catch (e) {
      console.warn('[parseFellowshipFullUpdate] malformed departed/locks tail:', e);
    }

    return { fellows, fellowshipName, leaderGuid, shareXP, evenShare, open, isLocked, tableSize, departedMembers, fellowshipLocks };
  } catch (e) {
    console.error('[parseFellowshipFullUpdate] Parse error:', e);
    return null;
  }
}

/** Parse a single fellow update from GameEvent FellowshipUpdateFellow (0x02C0). */
export function parseFellowshipUpdateFellow(payload: Uint8Array): { fellow: FellowData; updateType: number } | null {
  try {
    const r = new BinaryReader(payload);
    const guid = r.readUInt32();
    const _cpCached = r.readUInt32();
    const _lumCached = r.readUInt32();
    const level = r.readUInt32();
    const healthMax = r.readUInt32();
    const staminaMax = r.readUInt32();
    const manaMax = r.readUInt32();
    const healthCurrent = r.readUInt32();
    const staminaCurrent = r.readUInt32();
    const manaCurrent = r.readUInt32();
    const shareLootRaw = r.readUInt32();
    const shareLoot = (shareLootRaw & 0x02) !== 0; // shareLoot << 1 format
    // ACE WriteString16L pads (2 + length) to 4-byte boundary. Skipping the
    // pad bytes silently shifts updateType by 0–3 bytes, mis-dispatching the
    // entire fellow update (FellowUpdateType enum drives client behavior).
    const name = readString16L(r);
    const updateType = r.readUInt32();
    return { fellow: { guid, level, healthMax, staminaMax, manaMax, healthCurrent, staminaCurrent, manaCurrent, shareLoot, name }, updateType };
  } catch (e) {
    console.error('[parseFellowshipUpdateFellow] Parse error:', e);
    return null;
  }
}

/* ================================================================ */
/*  Allegiance parsing                                                */
/* ================================================================ */

export interface AllegianceMember {
  guid: number;
  parentGuid: number; // 0 for monarch
  name: string;
  level: number;
  rank: number;
  gender: number;
  heritage: number;
  isOnline: boolean;
  xpProduced: number;
  loyalty: number;
  leadership: number;
}

export interface AllegianceData {
  playerRank: number;
  totalMembers: number;
  totalVassals: number;
  allegianceName: string;
  isLocked: boolean;
  members: AllegianceMember[];
}

/**
 * Read a String16L (uint16 length + bytes, total padded to 4-byte boundary).
 *
 * Matches ACE Extensions.cs:12-21 WriteString16L which pads `sizeof(ushort) +
 * data.Length` to a multiple of 4 ("client expects string length to be a
 * multiple of 4 including the 2 bytes for length"). Skipping the padding
 * silently misaligns every field that follows. Empty strings still consume
 * 4 bytes on the wire (2 length + 2 pad).
 */
function readString16L(r: BinaryReader): string {
  const len = r.readUInt16();
  if (len === 0) {
    r.align(4);
    return '';
  }
  const bytes = r.readBytes(len);
  r.align(4);
  return decodeWindows1252(bytes);
}

function readAllegianceRecord(r: BinaryReader): AllegianceMember {
  const guid = r.readUInt32();
  const _cpCached = r.readUInt32();
  // ACE AllegianceData.cs:71 cpTithed = player.AllegianceXPGenerated — the
  // "Total allegiance XP contribution" the DAT-mandated XP Produced column
  // renders (GameUI.ts renderSocialPanel). Unlike Fellowship's cpCached/
  // lumCached (correctly hardcoded 0 server-side), this is live persisted
  // data and must not be discarded.
  const xpProduced = r.readUInt32();
  const bitfield = r.readUInt32();
  const gender = r.readUInt8();
  const heritage = r.readUInt8();
  const rank = r.readUInt16();
  let level = 0;
  if (bitfield & AllegianceIndex.HasPackedLevel) {
    level = r.readUInt32();
  }
  // AllegianceData.cs:83-84 — player.GetCurrentLoyalty()/GetCurrentLeadership(),
  // the buffed skill values (not the raw XP fed into the allegiance formulas
  // in AllegianceSystem.ts). Not shown on any retail Allegiance panel column
  // (checked reference/client-eol: AllegianceData::UnPack @ 005b6850 parses
  // _loyalty/_leadership but no gmAllegianceUI code path ever reads them
  // back out) — captured here only so downstream consumers aren't forced to
  // re-parse the wire format if a use for them turns up.
  const loyalty = r.readUInt16();
  const leadership = r.readUInt16();
  if (bitfield & AllegianceIndex.HasAllegianceAge) {
    const _timeOnline = r.readUInt32();
    const _allegianceAge = r.readUInt32();
  } else {
    const _uTimeOnline = r.readUInt32(); r.readUInt32(); // uint64 as two uint32s
  }
  const name = readString16L(r);
  const isOnline = (bitfield & AllegianceIndex.LoggedIn) !== 0;
  return { guid, parentGuid: 0, name, level, rank, gender, heritage, isOnline, xpProduced, loyalty, leadership };
}

/** Parse GameEvent AllegianceUpdate (0x0020). */
export function parseAllegianceUpdate(payload: Uint8Array): AllegianceData | null {
  try {
    const r = new BinaryReader(payload);

    const playerRank = r.readUInt32();
    const totalMembers = r.readUInt32();
    const totalVassals = r.readUInt32();

    // AllegianceHierarchy
    const recordCount = r.readUInt16();
    const _oldVersion = r.readUInt16(); // 0x000B

    // Officers hash table (always empty in retail)
    const officerCount = r.readUInt16();
    const _officerBuckets = r.readUInt16();
    for (let i = 0; i < officerCount; i++) {
      r.readUInt32(); // characterID
      r.readUInt32(); // officerLevel
    }

    // Officer titles list
    const titleCount = r.readUInt32();
    for (let i = 0; i < titleCount; i++) {
      readString16L(r);
    }

    // Broadcast times
    const _monarchBroadcastTime = r.readUInt32();
    const _monarchBroadcastsToday = r.readUInt32();
    const _spokesBroadcastTime = r.readUInt32();
    const _spokesBroadcastsToday = r.readUInt32();

    // MOTD
    const _motd = readString16L(r);
    const _motdSetBy = readString16L(r);

    // Chat room
    const _chatRoomID = r.readUInt32();

    // Bind point (Position: cell + xyz + quaternion = 8 fields × 4 bytes)
    for (let i = 0; i < 8; i++) r.readUInt32();

    // Allegiance name
    const allegianceName = readString16L(r);
    const _nameLastSetTime = r.readUInt32();
    const isLocked = r.readUInt32() !== 0;
    const _approvedVassal = r.readInt32();

    const members: AllegianceMember[] = [];

    if (recordCount > 0) {
      // Monarch record (no parent)
      const monarch = readAllegianceRecord(r);
      monarch.parentGuid = 0;
      members.push(monarch);

      // Remaining records (each has treeParent prefix)
      for (let i = 1; i < recordCount; i++) {
        const parentGuid = r.readUInt32();
        const member = readAllegianceRecord(r);
        member.parentGuid = parentGuid;
        members.push(member);
      }
    }

    return { playerRank, totalMembers, totalVassals, allegianceName, isLocked, members };
  } catch (e) {
    console.error('[parseAllegianceUpdate] Parse error:', e);
    return null;
  }
}

/* ================================================================ */
/*  ViewContents parsing                                              */
/* ================================================================ */

export interface ViewContentsItem {
  guid: number;
  containerType: number;
}

export interface ViewContentsData {
  containerGuid: number;
  items: ViewContentsItem[];
}

/**
 * Parse GameEvent ViewContents (0x0196).
 *
 * Per GameEventViewContents.cs, container.Guid.Full is written into the
 * event's own Data payload (not just the GameEvent header, which always
 * carries session.Player.Guid regardless of event type per
 * GameEventMessage's base ctor) -- the container GUID here is always the
 * real opened container, never the player.
 */
export function parseViewContents(payload: Uint8Array): ViewContentsData | null {
  try {
    const r = new BinaryReader(payload);
    const containerGuid = r.readUInt32();
    const count = r.readUInt32();
    const items: ViewContentsItem[] = [];
    for (let i = 0; i < count; i++) {
      const guid = r.readUInt32();
      const containerType = r.readUInt32();
      items.push({ guid, containerType });
    }
    return { containerGuid, items };
  } catch (e) {
    console.error('[parseViewContents] Parse error:', e);
    return null;
  }
}

/* ================================================================ */
/*  Friends list parsing                                              */
/* ================================================================ */

export interface FriendEntry {
  guid: number;
  name: string;
  isOnline: boolean;
}

export interface FriendsListData {
  friends: FriendEntry[];
  /** FriendsUpdateType flag: FullList=0, FriendAdded=1, FriendRemoved=2, FriendStatusChanged=4. */
  updateType: number;
}

/** Parse GameEvent FriendsListUpdate (0x0021). */
export function parseFriendsListUpdate(payload: Uint8Array): FriendsListData | null {
  try {
    const r = new BinaryReader(payload);
    const count = r.readUInt32();
    const friends: FriendEntry[] = [];

    for (let i = 0; i < count; i++) {
      const guid = r.readUInt32();
      const isOnline = r.readUInt32() !== 0;
      const _appearOffline = r.readUInt32();
      const name = readString16L(r);
      // FAITHFUL.571 — ACE GameEventFriendsListUpdate.cs:80-91 writes
      // the friend's friend-list AND the inverse friend-list as
      // (count u32 + N × FriendId u32) pairs. Live ACE always writes
      // count=0 (the TODO comments at those lines have been there
      // since the original port), so currently no list bytes follow.
      // But the wire format is `count + N × guid` regardless, and any
      // future ACE patch that actually populates those lists would
      // silently misalign every subsequent friend record (their guid
      // would be parsed as a friend-of-friend guid, then the parser
      // would walk off the end of the payload). The
      // `r.skip(N * 4)` is a no-op when N==0 today, defensive against
      // future drift — same pattern as FAITHFUL.560's fellowship
      // post-name alignment skip.
      const friendFriendCount = r.readUInt32();
      r.skip(friendFriendCount * 4);
      const inverseFriendCount = r.readUInt32();
      r.skip(inverseFriendCount * 4);
      friends.push({ guid, name, isOnline });
    }

    const updateType = r.readUInt32();
    return { friends, updateType };
  } catch (e) {
    console.error('[parseFriendsListUpdate] Parse error:', e);
    return null;
  }
}

// ─── Enchantment data (MagicUpdateEnchantment 0x02C2) ─────────────

/** Enchantment type flags — from ACE EnchantmentTypeFlags.cs */
/**
 * EnchantmentTypeFlags — bit flags packed into Enchantment.StatModType uint32.
 * Anchored to reference/ACE/Source/ACE.Entity/Enum/EnchantmentTypeFlags.cs.
 *
 * Categorizes what kind of stat each active enchantment modifies + how
 * (multiplicative vs additive, attack vs defense skills, etc).
 *
 * FAITHFUL.67 — expanded from 8 to 21 entries; the 13 missing entries
 * (BodyDamage/Armor, SingleStat/MultipleStat, Multiplicative/Additive,
 * AttackSkills/DefenseSkills, *Degrade variants, StatTypes mask) prevented
 * proper categorization of weapon enchantments, body-armor buffs, and
 * skill-group enchantments.
 */
export const EnchantmentTypeFlags = {
  Undef:                  0x0000000,
  Attribute:              0x0000001,
  SecondAtt:              0x0000002,
  Int:                    0x0000004,
  Float:                  0x0000008,
  Skill:                  0x0000010,
  BodyDamageValue:        0x0000020,
  BodyDamageVariance:     0x0000040,
  BodyArmorValue:         0x0000080,
  StatTypes:              0x00000FF,
  SingleStat:             0x0001000,
  MultipleStat:           0x0002000,
  Multiplicative:         0x0004000,
  Additive:               0x0008000,
  AttackSkills:           0x0010000,
  DefenseSkills:          0x0020000,
  Multiplicative_Degrade: 0x0100000,
  Additive_Degrade:       0x0200000,
  Vitae:                  0x0800000,
  Cooldown:               0x1000000,
  Beneficial:             0x2000000,
} as const;

export interface EnchantmentData {
  spellId: number;
  layer: number;
  spellCategory: number;
  hasSpellSetId: number;
  powerLevel: number;
  startTime: number;
  duration: number;
  casterGuid: number;
  degradeModifier: number;
  degradeLimit: number;
  lastTimeDegraded: number;
  statModType: number;
  statModKey: number;
  statModValue: number;
  spellSetId: number;
  isBeneficial: boolean;
  isVitae: boolean;
  isCooldown: boolean;
}

/**
 * Parse a single enchantment from MagicUpdateEnchantment (0x02C2).
 * Binary format from ACE Enchantment.cs Write():
 *   uint16 spellId, uint16 layer, uint16 spellCategory, uint16 hasSpellSetId,
 *   uint32 powerLevel, double startTime, double duration, uint32 casterGuid,
 *   float degradeModifier, float degradeLimit, double lastTimeDegraded,
 *   uint32 statModType, uint32 statModKey, float statModValue,
 *   [if hasSpellSetId != 0] uint32 spellSetId
 */
export function parseEnchantmentData(payload: Uint8Array): EnchantmentData | null {
  try {
    return parseEnchantmentFromReader(new BinaryReader(payload));
  } catch (e) {
    console.error('[parseEnchantmentData] Parse error:', e);
    return null;
  }
}

/**
 * Parse one Enchantment record from an already-positioned BinaryReader. Used by
 * `MagicUpdateMultipleEnchantments` which has `uint32 count + N × Enchantment`
 * — the multi-enchantment path needs to read N records from the same stream.
 */
export function parseEnchantmentFromReader(r: BinaryReader): EnchantmentData {
  const spellId = r.readUInt16();
  const layer = r.readUInt16();
  const spellCategory = r.readUInt16();
  const hasSpellSetId = r.readUInt16();
  const powerLevel = r.readUInt32();
  const startTime = r.readFloat64();
  const duration = r.readFloat64();
  const casterGuid = r.readUInt32();
  const degradeModifier = r.readFloat32();
  const degradeLimit = r.readFloat32();
  const lastTimeDegraded = r.readFloat64();
  const statModType = r.readUInt32();
  const statModKey = r.readUInt32();
  const statModValue = r.readFloat32();
  const spellSetId = hasSpellSetId !== 0 ? r.readUInt32() : 0;

  return {
    spellId, layer, spellCategory, hasSpellSetId, powerLevel,
    startTime, duration, casterGuid, degradeModifier, degradeLimit,
    lastTimeDegraded, statModType, statModKey, statModValue, spellSetId,
    isBeneficial: (statModType & EnchantmentTypeFlags.Beneficial) !== 0,
    isVitae: (statModType & EnchantmentTypeFlags.Vitae) !== 0,
    isCooldown: (statModType & EnchantmentTypeFlags.Cooldown) !== 0,
  };
}
