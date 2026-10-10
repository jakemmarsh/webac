import { DatReader } from '../DatReader.js';

/**
 * KeyMap — portal.dat files 0x14xxxxxx (DB_TYPE_KEYMAP, extension ".keymap",
 * DBTypeDef range 0x14000000–0x1400ffff per the retail client's type table).
 *
 * The EoL portal DAT ships two: 0x14000000 "gmDefaultMap" (the game's default
 * key bindings) and 0x14000002 "DefaultMap" (the engine's — system keys, the
 * mouse, the numpad camera, the text-edit keys). ACE.DatLoader has no reader
 * (DatTests.cs skips the type); the layout below is the retail client's
 * CMasterInputMap::Serialize @ 0068fce0 → CInputMap::Serialize @ 0068ee60
 * (reference/client-eol/decomp/acclient-decompiled.c), read with Archive
 * alignment off (the DAT bytes carry no padding):
 *
 *   id            uint32
 *   name          PStringBase<char>: compressed count (SB_As32Bit_Compressed)
 *                 + the bytes, no alignment
 *   guid          16 bytes (Serializer::SerializePrimitive of the map GUID)
 *   devices       uint32 count, then { uint8 type; 16-byte GUID } each
 *                 (SmartArray<DeviceKeyMapEntry>::Serialize @ 0068d180 —
 *                 1 = GUID_SysKeyboard, 2 = GUID_SysMouse)
 *   metaKeys      uint32 count, then { ControlSpecification (4); uint32 mode }
 *                 (m_listMetaKeys — the keys that form the meta-mode bits)
 *   sections      uint32 count, then { uint32 inputMapId; CInputMap }
 *                 CInputMap = uint32 count, then { QualifiedControl (12);
 *                 uint32 actionId } — m_listMappings in file order
 *
 * ControlSpecification is a dword whose low uint16 is the device index into
 * `devices` (0 = keyboard, 1 = mouse; the engine map's wheel entries carry
 * 0x0101 / 0x0201 — a sub-control direction in the high byte) and whose high
 * uint16 is the control: a DirectInput DIK_* scan code for the keyboard,
 * a DIMOFS_* offset for the mouse (ControlNameMapper::LoadSemantics @
 * 0068b820). QualifiedControl = { ControlSpecification key; uint32 metamode;
 * uint32 activation } (QualifiedControl::IsExactlyEqual @ 0068a0d0).
 *
 * The section ids are the ActionMap (0x26000000) input-map ids; the action
 * ids are the ActionMap command keys.
 */

export interface ControlSpecification {
  /** Index into KeyMap.devices (0 = keyboard, 1 = mouse); the high byte is a sub-control qualifier. */
  device: number;
  /** DIK_* scan code (keyboard) or DIMOFS_* offset (mouse). */
  control: number;
  /** The raw dword as serialized. */
  raw: number;
}

export interface KeyMapMetaKey {
  key: ControlSpecification;
  /** The meta-mode bit this key contributes (e.g. 0x80000000 for DIK_LSHIFT). */
  mode: number;
}

export interface KeyMapBinding {
  key: ControlSpecification;
  /** Meta-mode bits that must be held (see KeyMap.metaKeys). */
  metaMode: number;
  /** Activation mask (3 = press + release for keys; 0x80 = an axis). */
  activation: number;
  /** ActionMap command id. */
  actionId: number;
}

export interface KeyMapDevice {
  /** 1 = keyboard (GUID_SysKeyboard), 2 = mouse (GUID_SysMouse). */
  type: number;
  /** The DirectInput device GUID, lower-case hex of the 16 serialized bytes. */
  guid: string;
}

function hex16(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function readControlSpecification(reader: DatReader): ControlSpecification {
  const raw = reader.readUInt32();
  return { device: raw & 0xffff, control: (raw >>> 16) & 0xffff, raw };
}

export class KeyMap {
  id: number = 0;
  name: string = '';
  guid: string = '';
  devices: KeyMapDevice[] = [];
  metaKeys: KeyMapMetaKey[] = [];
  /** inputMapId → bindings in file order. */
  inputMaps: Map<number, KeyMapBinding[]> = new Map();

  static read(reader: DatReader): KeyMap {
    const t = new KeyMap();
    t.id = reader.readUInt32();
    const nameLen = reader.readCompressedUInt32();
    t.name = new TextDecoder('ascii').decode(reader.readBytes(nameLen));
    t.guid = hex16(reader.readBytes(16));

    const deviceCount = reader.readUInt32();
    for (let i = 0; i < deviceCount; i++) {
      const type = reader.readUInt8();
      const guid = hex16(reader.readBytes(16));
      t.devices.push({ type, guid });
    }

    const metaCount = reader.readUInt32();
    for (let i = 0; i < metaCount; i++) {
      const key = readControlSpecification(reader);
      const mode = reader.readUInt32();
      t.metaKeys.push({ key, mode });
    }

    const sectionCount = reader.readUInt32();
    for (let i = 0; i < sectionCount; i++) {
      const inputMapId = reader.readUInt32();
      const bindingCount = reader.readUInt32();
      const bindings: KeyMapBinding[] = [];
      for (let j = 0; j < bindingCount; j++) {
        const key = readControlSpecification(reader);
        const metaMode = reader.readUInt32();
        const activation = reader.readUInt32();
        const actionId = reader.readUInt32();
        bindings.push({ key, metaMode, activation, actionId });
      }
      t.inputMaps.set(inputMapId, bindings);
    }
    return t;
  }

  /** The meta-mode bit a control contributes, or 0 when it is not a meta key (CMasterInputMap::MetaModeFromKey @ 0068d850). */
  metaModeFromKey(raw: number): number {
    for (const m of this.metaKeys) if (m.key.raw === raw) return m.mode;
    return 0;
  }

  /** Every binding across every section, in file order. */
  allBindings(): Array<KeyMapBinding & { inputMapId: number }> {
    const out: Array<KeyMapBinding & { inputMapId: number }> = [];
    for (const [inputMapId, list] of this.inputMaps) for (const b of list) out.push({ ...b, inputMapId });
    return out;
  }
}

/** The two EoL portal KeyMap files. */
export const KEYMAP_GAME_DEFAULT_ID = 0x14000000;   // "gmDefaultMap" — DBObj::GetByEnum(0x10000001, 10, 0x1d)
export const KEYMAP_ENGINE_DEFAULT_ID = 0x14000002; // "DefaultMap"   — DBObj::GetByEnum(1, 10, 0x1d)
