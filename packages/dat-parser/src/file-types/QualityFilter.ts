import { DatReader } from '../DatReader.js';

/** First id of the QualityFilter range (ACE DatFile.cs: ObjectId >> 16 == 0x0E01). */
export const QUALITY_FILTER_ID_PREFIX = 0x0e01;

/**
 * QualityFilter — portal.dat 0x0E01xxxx: per-stat-type lists of the property
 * ids a filter lets through.
 * Reference: ACE.DatLoader/FileTypes/QualityFilter.cs — Id, then eight uint32
 * counts (Int, Int64, Bool, Float, DID, IID, String, Position) and their id
 * lists, then three more counts (Attribute, Attribute2nd, Skill) and lists.
 */
export class QualityFilter {
  id: number = 0;
  intStatFilter: number[] = [];
  int64StatFilter: number[] = [];
  boolStatFilter: number[] = [];
  floatStatFilter: number[] = [];
  didStatFilter: number[] = [];
  iidStatFilter: number[] = [];
  stringStatFilter: number[] = [];
  positionStatFilter: number[] = [];
  attributeStatFilter: number[] = [];
  attribute2ndStatFilter: number[] = [];
  skillStatFilter: number[] = [];

  static read(reader: DatReader): QualityFilter {
    const qf = new QualityFilter();
    qf.id = reader.readUInt32();
    const readLists = (lists: number[][]): void => {
      const counts = lists.map(() => reader.readUInt32());
      lists.forEach((list, i) => {
        for (let j = 0; j < counts[i]; j++) list.push(reader.readUInt32());
      });
    };
    readLists([
      qf.intStatFilter, qf.int64StatFilter, qf.boolStatFilter, qf.floatStatFilter,
      qf.didStatFilter, qf.iidStatFilter, qf.stringStatFilter, qf.positionStatFilter,
    ]);
    readLists([qf.attributeStatFilter, qf.attribute2ndStatFilter, qf.skillStatFilter]);
    return qf;
  }
}
