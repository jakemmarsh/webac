import { DatReader } from '../DatReader.js';
import { readBaseProperty, type BaseProperty } from './LayoutDesc.js';

/**
 * DbProperty — portal.dat files starting with 0x78.
 *
 * Generic property-bag DAT entries. Each is a hashmap of `propertyId →
 * BaseProperty`, where BaseProperty dispatch depends on the type table
 * loaded from MasterProperty (0x39000001).
 *
 * Per ACE retrospectives: "Some basic UI related items related to window
 * Opacity." Used by the retail UI runtime; we don't currently consume
 * these but parse for completeness.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/DbProperty.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/BaseProperty.cs
 *
 * Prerequisite: setMasterPropertyTypes() must be called with a loaded
 * MasterProperty table before reading any DbProperty file (otherwise the
 * BaseProperty dispatch throws for unknown property IDs).
 */
export class DbProperty {
  id: number = 0;
  /** Map of propertyId → BaseProperty. */
  properties: Map<number, BaseProperty> = new Map();

  static read(reader: DatReader): DbProperty {
    const t = new DbProperty();
    t.id = reader.readUInt32();
    // Custom hash-table header: uint8 bucketSize + uint8 totalObjects
    reader.readUInt8();
    const total = reader.readUInt8();
    for (let i = 0; i < total; i++) {
      const key = reader.readUInt32();
      const value = readBaseProperty(reader);
      t.properties.set(key, value);
    }
    return t;
  }
}
