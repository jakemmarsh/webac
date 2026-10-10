/**
 * Determines the triangle-split diagonal direction for a single AC terrain
 * cell using AC's deterministic PRNG-style hash. Each 24m × 24m landblock
 * cell is rendered as two triangles, and the diagonal between them flips
 * based on the cell's global coordinates so adjacent cells visually
 * interlock without obvious patterning.
 *
 * Source: reference/ACE/Source/ACE.Server/Entity/LandblockMesh.cs:160-169
 *   public bool GetSplitDir(LandblockId id, int cellX, int cellY)
 *   {
 *       var x = (id.LandblockX * 8) + cellX;
 *       var y = (id.LandblockY * 8) + cellY;
 *       // Thanks to https://github.com/deregtd/AC2D for this bit
 *       var dw = x * y * 0x0CCAC033 - x * 0x421BE3BD + y * 0x6C1AC587 - 0x519B8F25;
 *       return (dw & 0x80000000) == 0;
 *   }
 *
 * Returns true = NW-to-SE diagonal, false = SW-to-NE diagonal. The C#
 * arithmetic is 32-bit signed and relies on overflow wraparound; we
 * reproduce it with Math.imul + a single `| 0` truncation at the end so
 * the high-bit sign-test on `dw` matches retail exactly.
 *
 * The four magic constants are not enums or named values in ACE source —
 * they're literal hash coefficients credited to the AC2D project. Co-located
 * here so any future drift surfaces as a single source-of-truth diff.
 */
export function computeCellSplitDir(blockX: number, blockY: number, cellX: number, cellY: number): boolean {
  const x = (blockX << 3) + cellX;
  const y = (blockY << 3) + cellY;

  const dw = (Math.imul(Math.imul(x, y), 0x0CCAC033)
    - Math.imul(x, 0x421BE3BD)
    + Math.imul(y, 0x6C1AC587)
    - 0x519B8F25) | 0;

  return (dw & 0x80000000) === 0;
}
