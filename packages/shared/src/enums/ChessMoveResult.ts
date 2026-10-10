/**
 * ChessMoveResult — int32 status code on MoveResponse GameEvent (0x033E).
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/ChessMoveResult.cs
 *
 * Negative codes are rejections with specific text strings preserved
 * verbatim in the ACE source comments. The classic AC client surfaces
 * these in chat after a failed chess move. Positive codes describe a
 * successful move's outcome (capture / check / checkmate / promotion).
 */
export enum ChessMoveResult {
  NoMoveResult                   =  0x0000,
  OKMoveToEmptySquare            =  0x0001,
  OKMoveToOccupiedSquare         =  0x0002,
  OKMoveCheck                    =  0x0400,
  OKMoveCheckmate                =  0x0800,
  OKMovePromotion                =  0x1000,

  BadMoveInvalidCommand          =  -1,    // "That move is invalid"
  BadMoveNotPlaying              =  -2,    // (no public string in ACE source)
  BadMoveNotYourTurn             =  -3,    // "It's not your turn, please wait for your opponent's move."
  BadMoveDirection               = -100,   // "The selected piece cannot move that direction"
  BadMoveDistance                = -101,   // "The selected piece cannot move that far"
  BadMoveNoPiece                 = -102,   // "You tried to move an empty square"
  BadMoveNotYours                = -103,   // "The selected piece is not yours"
  BadMoveDestination             = -104,   // "You cannot move off the board"
  BadMoveWouldClobber            = -105,   // "You cannot attack your own pieces"
  BadMoveSelfCheck               = -106,   // "That move would put you in check"
  BadMoveWouldCollide            = -107,   // "You can only move through empty squares"
  BadMoveCantCastleOutOfCheck    = -108,   // "You cannot castle out of check"
  BadMoveCantCastleThroughCheck  = -109,   // "You cannot castle through check"
  BadMoveCantCastleAfterMoving   = -110,   // "You cannot castle after moving the King or Rook"
  BadMoveInvalidBoardState       = -111,   // (no public string in ACE source)
}

/**
 * The user-visible chat text the AC client shows for each ChessMoveResult.
 * Strings are quoted verbatim from the ACE source comments — those are
 * the canonical original-client wordings (ACE preserves the exact strings).
 *
 * Returns `null` for codes that don't surface a chat message (e.g.
 * NoMoveResult, successful moves which are conveyed visually).
 */
export function chessMoveResultText(result: ChessMoveResult | number): string | null {
  switch (result) {
    case ChessMoveResult.BadMoveInvalidCommand:         return 'That move is invalid';
    case ChessMoveResult.BadMoveNotYourTurn:            return "It's not your turn, please wait for your opponent's move.";
    case ChessMoveResult.BadMoveDirection:              return 'The selected piece cannot move that direction';
    case ChessMoveResult.BadMoveDistance:               return 'The selected piece cannot move that far';
    case ChessMoveResult.BadMoveNoPiece:                return 'You tried to move an empty square';
    case ChessMoveResult.BadMoveNotYours:               return 'The selected piece is not yours';
    case ChessMoveResult.BadMoveDestination:            return 'You cannot move off the board';
    case ChessMoveResult.BadMoveWouldClobber:           return 'You cannot attack your own pieces';
    case ChessMoveResult.BadMoveSelfCheck:              return 'That move would put you in check';
    case ChessMoveResult.BadMoveWouldCollide:           return 'You can only move through empty squares';
    case ChessMoveResult.BadMoveCantCastleOutOfCheck:   return 'You cannot castle out of check';
    case ChessMoveResult.BadMoveCantCastleThroughCheck: return 'You cannot castle through check';
    case ChessMoveResult.BadMoveCantCastleAfterMoving:  return 'You cannot castle after moving the King or Rook';
    default: return null;
  }
}
