import { DatReader } from '../DatReader.js';

/**
 * GeneratorTable — portal.dat file 0x0E00000D.
 *
 * Hierarchical weenie-object tree used by the original AC world builder
 * tools. Each node carries an obfuscated (nibble-swapped Windows-1252)
 * name + a uint32 ID + a list of child generators. The root has exactly
 * two children:
 *   [0] PlayDay items — periodic-spawn schedule entries
 *   [1] WeenieObjects items — the world's weenie class hierarchy
 *
 * Not directly consumed by the playing client but parsed for completeness
 * — the original retail client read this file at startup and tooling /
 * admin features in our client (eventual world editor, weenie picker)
 * will need it.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/GeneratorTable.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/Generator.cs
 */
export interface Generator {
  name: string;
  id: number;
  items: Generator[];
}

function readGenerator(reader: DatReader): Generator {
  const name = reader.readObfuscatedString();
  reader.align(4);
  const id = reader.readUInt32();
  const count = reader.readUInt32();
  const items: Generator[] = [];
  for (let i = 0; i < count; i++) {
    items.push(readGenerator(reader));
  }
  return { name, id, items };
}

export class GeneratorTable {
  id: number = 0;
  root: Generator = { name: '', id: 0, items: [] };
  playDayItems: Generator[] = [];
  weenieObjects: Generator[] = [];

  static read(reader: DatReader): GeneratorTable {
    const t = new GeneratorTable();
    t.id = reader.readUInt32();
    t.root = readGenerator(reader);
    t.playDayItems = t.root.items[0]?.items ?? [];
    t.weenieObjects = t.root.items[1]?.items ?? [];
    return t;
  }

  /**
   * Find a generator anywhere in the tree by its weenie-class ID. Recursive
   * DFS — used by admin/tooling features that need a name for an ID.
   */
  findById(id: number): Generator | null {
    const stack: Generator[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.id === id) return node;
      for (const child of node.items) stack.push(child);
    }
    return null;
  }

  /** Total node count across the whole tree (root + all descendants). */
  get totalNodes(): number {
    let count = 0;
    const stack: Generator[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      count++;
      for (const child of node.items) stack.push(child);
    }
    return count;
  }
}
