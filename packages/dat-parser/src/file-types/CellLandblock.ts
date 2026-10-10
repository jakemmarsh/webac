import { DatReader } from '../DatReader.js';

/**
 * CellLandblock — cell.dat files ending in 0xFFFF.
 * Contains 9×9 terrain grid and 9×9 height grid for one landblock.
 *
 * Height 0-9 is the western-most edge. 10-18 is the S-to-N strip just to the east, etc.
 * Z value in-game is double the height byte value.
 *
 * Terrain uint16 bit layout:
 *   bits 0-1: road type
 *   bits 2-6: terrain type
 *   bits 11-15: scenery
 */
export class CellLandblock {
  id: number = 0;
  hasObjects: boolean = false;
  terrain: number[] = [];
  heights: number[] = [];

  static read(reader: DatReader): CellLandblock {
    const lb = new CellLandblock();
    lb.id = reader.readUInt32();
    lb.hasObjects = reader.readUInt32() === 1;

    // 9×9 = 81 terrain entries (uint16 each)
    for (let i = 0; i < 81; i++) {
      lb.terrain.push(reader.readUInt16());
    }

    // 9×9 = 81 height entries (byte each)
    for (let i = 0; i < 81; i++) {
      lb.heights.push(reader.readUInt8());
    }

    reader.align(4);
    return lb;
  }

  /** Extract road type from terrain value (bits 0-1) */
  static getRoad(terrain: number): number {
    return terrain & 0x3;
  }

  /** Extract terrain type from terrain value (bits 2-6) */
  static getType(terrain: number): number {
    return (terrain & 0x7c) >> 2;
  }

  /** Extract scenery from terrain value (bits 11-15) */
  static getScenery(terrain: number): number {
    return (terrain & 0xf800) >> 11;
  }
}
