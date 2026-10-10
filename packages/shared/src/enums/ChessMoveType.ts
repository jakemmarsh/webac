/**
 * ChessMoveType — wire-format dispatch for ChessMoveData.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/ChessMoveType.cs
 * Serialization: reference/ACE/Source/ACE.Server/Network/Structure/ChessMoveData.cs
 *   `writer.Write((int)data.Type)` — the C# enum value is written
 *   directly as a 32-bit integer. Default C# enum starts at 0 so:
 *   Invalid=0, Pass=1, Resign=2, Stalemate=3, Grid=4, FromTo=5, SelectedPiece=6.
 *
 * The ACE source comment "only ChessMoveType.FromTo used?" notes that in
 * practice live games only ever serialize FromTo (5). Earlier code in this
 * codebase incorrectly used 1/2/3 for Grid/FromTo/SelectedPiece — that
 * matched no part of ACE source and would silently drop the only
 * actually-used FromTo move.
 */
export enum ChessMoveType {
  Invalid       = 0,
  Pass          = 1,
  Resign        = 2,
  Stalemate     = 3,
  Grid          = 4,
  FromTo        = 5,
  SelectedPiece = 6,
}
