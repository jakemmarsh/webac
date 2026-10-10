import { DatReader } from '../DatReader.js';

/** File id of the Iteration record in every DAT (cell, portal, highres, local). */
export const ITERATION_FILE_ID = 0xFFFF0001;

/**
 * Iteration — the DAT's versioning record (0xFFFF0001).
 * Reference: ACE.DatLoader/FileTypes/Iteration.cs.
 *
 * `totalIterations` (int32) is followed by (consecutiveIterations, startingIteration)
 * int32 pairs; the count is negative, and pairs are read until the running
 * total (`totalIterations + Σ consecutive`) drops to 0. A complete DAT holds
 * exactly one range; more than one means an incompletely-patched DAT
 * (ACE DatDatabase.GetTotalIterations logs "contains an incomplete dat file").
 */
export class Iteration {
  totalIterations: number = 0;
  /** startingIteration → consecutiveIterations (ACE `Ints`). */
  ints: Map<number, number> = new Map();

  constructor(reader: DatReader) {
    this.totalIterations = reader.readInt32();
    let iterationCount = this.totalIterations;
    while (iterationCount > 0) {
      const consecutiveIterations = reader.readInt32();
      const startingIteration = reader.readInt32();
      this.ints.set(startingIteration, consecutiveIterations);
      iterationCount += consecutiveIterations;
    }
  }

  /** ACE DatDatabase.GetTotalIterations: `Ints.Count > 1` ⇒ incomplete dat. */
  get isComplete(): boolean {
    return this.ints.size <= 1;
  }
}
