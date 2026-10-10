/**
 * ChessColor — player team in the chess minigame.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/ChessColor.cs
 *
 *     None  = -1   // unjoined / spectator
 *     White =  0   // first to move
 *     Black =  1
 *
 * Wire format: appears in several chess GameEvents (StartGame, GameOver,
 * JoinGameResponse, OpponentStalemate, OpponentTurn) — uint32 except
 * GameOver which uses teamWinner (same semantics).
 */
export enum ChessColor {
  None  = -1,
  White =  0,
  Black =  1,
}
