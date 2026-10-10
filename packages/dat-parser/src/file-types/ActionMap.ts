import { DatReader } from '../DatReader.js';

/**
 * ActionMap — portal.dat file 0x26000000.
 *
 * Keyboard binding map. AC retail stored its default keybinds in this
 * DAT entry; each input "category" maps a key code to an action via
 * `UserBindingValue` (actionClass + actionName-string-hash + description-
 * string-hash). String hashes resolve via StringTable 0x23000005.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/ActionMap.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/ActionMapValue.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/UserBindingValue.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/InputMapConflictsValue.cs
 */

export interface UserBindingValue {
  actionClass: number;
  /** Hash into StringTable for the human-readable action name. */
  actionNameHash: number;
  /** Hash into StringTable for the action description. */
  descriptionHash: number;
}

export interface ActionMapValue {
  unknownByte: number;
  unknownInt: number;
  unknownInt2: number;
  toggleType: number;
  userBindingData: UserBindingValue;
}

export interface InputMapConflictsValue {
  inputMap: number;
  conflictingInputMaps: number[];
}

function readUserBindingValue(reader: DatReader): UserBindingValue {
  return {
    actionClass: reader.readUInt32(),
    actionNameHash: reader.readUInt32(),
    descriptionHash: reader.readUInt32(),
  };
}

function readActionMapValue(reader: DatReader): ActionMapValue {
  return {
    unknownByte: reader.readUInt8(),
    unknownInt: reader.readUInt32(),
    unknownInt2: reader.readUInt32(),
    toggleType: reader.readUInt32(),
    userBindingData: readUserBindingValue(reader),
  };
}

export class ActionMap {
  id: number = 0;
  /**
   * Top-level keyed by input-category ID. Each entry is a sub-map of
   * key-code → ActionMapValue.
   */
  inputMaps: Map<number, Map<number, ActionMapValue>> = new Map();
  /** DataID of the StringTable for action-name + description hash lookup (typically 0x23000005). */
  stringTable: number = 0;
  /** Conflicting input maps that can't both be active. */
  conflictingMaps: Map<number, InputMapConflictsValue> = new Map();

  static read(reader: DatReader): ActionMap {
    const t = new ActionMap();
    t.id = reader.readUInt32();

    reader.readUInt8(); // bucketSize
    const count = reader.readUInt8();
    for (let i = 0; i < count; i++) {
      const key = reader.readUInt32();
      reader.readUInt8(); // bucketSize
      const valuesCount = reader.readUInt8();
      const values = new Map<number, ActionMapValue>();
      for (let j = 0; j < valuesCount; j++) {
        const vkey = reader.readUInt32();
        values.set(vkey, readActionMapValue(reader));
      }
      t.inputMaps.set(key, values);
    }

    t.stringTable = reader.readUInt32();

    reader.readUInt8(); // bucketSize
    const conflictCount = reader.readUInt8();
    for (let i = 0; i < conflictCount; i++) {
      const key = reader.readUInt32();
      const inputMap = reader.readUInt32();
      const listCount = reader.readUInt32();
      const conflictingInputMaps: number[] = [];
      for (let j = 0; j < listCount; j++) {
        conflictingInputMaps.push(reader.readUInt32());
      }
      t.conflictingMaps.set(key, { inputMap, conflictingInputMaps });
    }

    return t;
  }
}
