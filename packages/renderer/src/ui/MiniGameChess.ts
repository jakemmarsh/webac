/**
 * GAP.indicator-bar-interactive (mini-game panel) — the retail chess board:
 * a DOM-free port of the three decompiled classes behind gmMiniGameUI
 * (element class 0x1000001e, LayoutDesc 0x2100001e):
 *
 *  - `ChessLogic`   = CChessLogic<CBasePiece> (@004a7f10…@004a9e40): the
 *    client-side move validator. Retail validates every move locally before
 *    sending Event_Move and REPLAYS the opponent's move through the same
 *    logic, so the board, captures, castling, en passant, promotion and the
 *    check / checkmate flags all come from here.
 *  - `ChessBoardGrid` = GameBoardGrid (@004a7b60…@004aa810): the board the
 *    panel draws — snapshot / commit / undo around a pending move, the
 *    64-item list box orientation, and the click-to-select / click-to-move
 *    input (HandleMousePresses @ 004aa620).
 *  - `MiniGameSession` = gmMiniGameUI's notice handlers (@004a7cf0…@004aacd0):
 *    the GS_* state machine, the chat text (SetInfoText → AddTextToScroll),
 *    and the outbound CM_Game::Event_* actions.
 *
 * Coordinates are retail TCoord: x = file 0..7, y = rank 0..7, white's back
 * rank at y = 0 (GameBoardGrid::Reset @ 004a92b0), i.e. the same
 * ChessPieceCoord ACE reads in GameActionChessMove.cs.
 */

/**
 * ItemHolder::DetermineUseResult @ 00588460 case 7: an object the player
 * does not own whose ITEM_TYPE has the sign bit (TYPE_GAMEBOARD 0x80000000)
 * is "used" by starting a game — UseObject @ 00588a80 sends no Use event for
 * it; CPlayerSystem::UsingItem @ 00562f70 → CM_Game::SendNotice_BeginGame.
 */
export function isGameBoardUse(itemType: number | undefined, ownedByPlayer: boolean): boolean {
  return !ownedByPlayer && ((itemType ?? 0) | 0) < 0;
}

/** Retail ChessPieceType (TPawnPiece ctor writes 1 … TKingPiece 6; the rook is `Castle`). */
export enum ChessPieceType {
  Pawn = 1,
  Castle = 2,
  Knight = 3,
  Bishop = 4,
  Queen = 5,
  King = 6,
}

/**
 * Retail ChessMoveResult values the client logic produces (annotated decomp
 * `//=` values; the same numbers ACE's ChessMoveResult.cs carries, plus the
 * two ACE comments out: OKMoveEnPassant = 3 and OKMoveMask = 0x3ff).
 */
export const ChessResult = {
  NoMoveResult: 0,
  OKMoveToEmptySquare: 1,
  OKMoveToOccupiedSquare: 2,
  OKMoveEnPassant: 3,
  OKMoveMask: 0x3ff,
  OKMoveCheck: 0x400,
  OKMoveCheckmate: 0x800,
  OKMovePromotion: 0x1000,
  BadMoveInvalidCommand: -1,
  BadMoveNotYourTurn: -3,
  BadMoveDirection: -100,
  BadMoveDistance: -101,
  BadMoveNoPiece: -102,
  BadMoveNotYours: -103,
  BadMoveDestination: -104,
  BadMoveWouldClobber: -105,
  BadMoveSelfCheck: -106,
  BadMoveWouldCollide: -107,
  BadMoveCantCastleOutOfCheck: -108,
  BadMoveCantCastleThroughCheck: -109,
  BadMoveCantCastleAfterMoving: -110,
  BadMoveInvalidBoardState: -111,
} as const;

export interface ChessCoord { x: number; y: number }

export interface ChessPiece {
  type: ChessPieceType;
  /** Team: 0 = white, 1 = black (ACE ChessColor). */
  player: number;
  /** TChessPiece::m_bMoved (castling / pawn double step). */
  moved: boolean;
  cur: ChessCoord;
  lastGood: ChessCoord;
}

/** HEAVEN @ 0x822c38 — where captured / trial-captured pieces are parked. */
const HEAVEN: Readonly<ChessCoord> = { x: -10, y: -20 };

/** Directions @ 0x822bb8 — the 8 king steps, then the 8 knight jumps. */
const DIRECTIONS: ReadonlyArray<Readonly<ChessCoord>> = [
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
  { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
  { x: 1, y: 2 }, { x: 1, y: -2 }, { x: -1, y: 2 }, { x: -1, y: -2 },
  { x: 2, y: 1 }, { x: 2, y: -1 }, { x: -2, y: -1 }, { x: -2, y: 1 },
];

const onBoard = (c: ChessCoord): boolean => c.x >= 0 && c.y >= 0 && c.x < 8 && c.y < 8;

/** TPawnPiece…TKingPiece::bCanGoTo (@004a83a0 / 8440 / 84b0 / 8550 / 85c0 / 8650). `dy` is forward for the mover. */
function canGoTo(p: ChessPiece, dx: number, dy: number): boolean {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  switch (p.type) {
    case ChessPieceType.Pawn: return dx === 0 && (dy === 1 || (dy === 2 && !p.moved));
    case ChessPieceType.Castle: return (dx !== 0) !== (dy !== 0);
    case ChessPieceType.Knight: return (ax === 1 && ay === 2) || (ax === 2 && ay === 1);
    case ChessPieceType.Bishop: return ax === ay;
    case ChessPieceType.Queen: return dx === 0 || dy === 0 || ax === ay;
    case ChessPieceType.King: return ax < 2 && ay < 2;
  }
  return false;
}

/** bCanAttack — TPawnPiece @ 004a83d0 is the diagonal step; every other piece inherits TChessPiece @ 004a7e40 (= bCanGoTo). */
function canAttack(p: ChessPiece, dx: number, dy: number): boolean {
  if (p.type === ChessPieceType.Pawn) return Math.abs(dx) === 1 && dy === 1;
  return canGoTo(p, dx, dy);
}

/**
 * CChessLogic::ConvertMoveToVector @ 004a7f60 — the unit direction index
 * and step count of a straight / diagonal / knight move, or null when the
 * vector is none of those.
 */
function moveVector(from: ChessCoord, to: ChessCoord): { dir: number; steps: number } | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  let steps: number;
  if (dx === 0 || dy === 0 || dx === dy) {
    steps = Math.abs(dx !== 0 ? dx : dy);
  } else {
    steps = Math.min(Math.abs(dx), Math.abs(dy));
    if (dx % steps !== 0 || dy % steps !== 0) return null;
  }
  const ux = dx / steps, uy = dy / steps;
  const dir = DIRECTIONS.findIndex((d) => d.x === ux && d.y === uy);
  return dir < 0 ? null : { dir, steps };
}

/** Port of CChessLogic<CBasePiece>. */
export class ChessLogic {
  /** m_Board[x][y]. */
  board: (ChessPiece | null)[][] = Array.from({ length: 8 }, () => Array<ChessPiece | null>(8).fill(null));
  /** m_Pieces[team] — the king is kept at index 0 (InsertOrderedByIndex(…, 0) for King). */
  pieces: [ChessPiece[], ChessPiece[]] = [[], []];
  curPlayer = 0;
  lastMoveWasCheck = false;
  enPassantAttackSite: ChessCoord = { x: -1, y: -1 };
  enPassantVictimPos: ChessCoord = { x: -1, y: -1 };

  pieceAt(c: ChessCoord): ChessPiece | null {
    return onBoard(c) ? this.board[c.x][c.y] : null;
  }

  /** GameBoardGrid::CreatePiece @ 004a8e00 (the logic half — the DID is the view's). */
  createPiece(x: number, y: number, player: number, type: ChessPieceType): ChessPiece {
    const piece: ChessPiece = { type, player, moved: false, cur: { x, y }, lastGood: { x, y } };
    this.board[x][y] = piece;
    if (type === ChessPieceType.King) this.pieces[player].unshift(piece);
    else this.pieces[player].push(piece);
    return piece;
  }

  /** TryPiecePos @ 004a8680. */
  protected tryPiecePos(p: ChessPiece | null, to: ChessCoord): void {
    if (!p) return;
    if (onBoard(p.cur) && this.board[p.cur.x][p.cur.y] === p) this.board[p.cur.x][p.cur.y] = null;
    p.cur = { x: to.x, y: to.y };
    if (onBoard(to)) this.board[to.x][to.y] = p;
  }

  /** UndoTryPiecePos @ 004a86f0. */
  protected undoTryPiecePos(p: ChessPiece | null): void {
    if (!p) return;
    if (onBoard(p.cur) && this.board[p.cur.x][p.cur.y] === p) this.board[p.cur.x][p.cur.y] = null;
    p.cur = { x: p.lastGood.x, y: p.lastGood.y };
    if (onBoard(p.cur)) this.board[p.cur.x][p.cur.y] = p;
  }

  /** CommitPiecePos @ 004a8870. */
  protected commitPiecePos(p: ChessPiece | null, to: ChessCoord): void {
    if (!p) return;
    this.tryPiecePos(p, to);
    p.moved = true;
    p.lastGood = { x: p.cur.x, y: p.cur.y };
  }

  /**
   * TestCanGetThere @ 004a88a0. `real` = the move is actually being made
   * (only then may a pawn capture en passant — the victim is trial-moved
   * onto the attack site so the diagonal step reads as a capture).
   */
  testCanGetThere(p: ChessPiece, to: ChessCoord, real: boolean): number {
    if (!onBoard(to)) return ChessResult.BadMoveDestination;
    const dx = to.x - p.cur.x;
    const dy = p.player === 0 ? to.y - p.cur.y : p.cur.y - to.y;
    let enPassant = false;
    let target: ChessPiece | null;
    if (real && to.x === this.enPassantAttackSite.x && to.y === this.enPassantAttackSite.y
      && p.type === ChessPieceType.Pawn && canAttack(p, dx, dy)
      && this.pieceAt(this.enPassantVictimPos)?.type === ChessPieceType.Pawn) {
      const victim = this.pieceAt(this.enPassantVictimPos)!;
      this.tryPiecePos(victim, this.enPassantAttackSite);
      enPassant = true;
      target = victim;
    } else {
      target = this.board[to.x][to.y];
    }
    if (target) {
      if (target.player === p.player) return ChessResult.BadMoveWouldClobber;
      if (!canAttack(p, dx, dy)) return ChessResult.BadMoveDirection;
    } else if (!canGoTo(p, dx, dy)) {
      return ChessResult.BadMoveDirection;
    }
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      const v = moveVector(p.cur, to);
      if (v) {
        const d = DIRECTIONS[v.dir];
        for (let i = 1; i < v.steps; i++) {
          if (this.board[p.cur.x + d.x * i][p.cur.y + d.y * i]) return ChessResult.BadMoveWouldCollide;
        }
      }
    }
    if (!target) return ChessResult.OKMoveToEmptySquare;
    return enPassant ? ChessResult.OKMoveEnPassant : ChessResult.OKMoveToOccupiedSquare;
  }

  /** DoesMoveSelfCheck @ 004a90b0. */
  doesMoveSelfCheck(p: ChessPiece, to: ChessCoord): boolean {
    const occupant = this.board[to.x][to.y];
    this.tryPiecePos(p, to);
    this.tryPiecePos(occupant, HEAVEN);
    const inCheck = this.isPlayerInCheck(p.player);
    this.undoTryPiecePos(p);
    this.undoTryPiecePos(occupant);
    return inCheck;
  }

  /** TestMoveAndSelfCheck @ 004a97e0. */
  testMoveAndSelfCheck(p: ChessPiece, to: ChessCoord): number {
    const r = this.testCanGetThere(p, to, true);
    if (r > 0 && this.doesMoveSelfCheck(p, to)) return ChessResult.BadMoveSelfCheck;
    return r;
  }

  /**
   * IsPlayerInCheck @ 004a9030 — any opponent piece that can reach the king.
   * Pieces parked in HEAVEN can never reach an on-board square with any
   * piece's move rule, so skipping them matches retail exactly.
   */
  isPlayerInCheck(player: number): boolean {
    const king = this.pieces[player === 1 ? 1 : 0][0];
    if (!king) return false;
    for (const opp of this.pieces[player === 0 ? 1 : 0]) {
      if (!onBoard(opp.cur)) continue;
      if (this.testCanGetThere(opp, king.cur, false) > 0) return true;
    }
    return false;
  }

  /**
   * IsPlayerInCheckMate @ 004a9820 — retail's test: the king has no safe
   * step, and no own piece can capture or block the FIRST attacker found
   * along its line (double check is not considered, as in retail).
   */
  isPlayerInCheckMate(player: number): boolean {
    const king = this.pieces[player][0];
    if (!king) return false;
    const kingPos = { x: king.cur.x, y: king.cur.y };
    for (let i = 0; i < 8; i++) {
      const to = { x: kingPos.x + DIRECTIONS[i].x, y: kingPos.y + DIRECTIONS[i].y };
      if (this.testCanGetThere(king, to, true) > 0 && !this.doesMoveSelfCheck(king, to)) return false;
    }
    if (!this.isPlayerInCheck(player)) return false;
    for (const attacker of this.pieces[player === 0 ? 1 : 0]) {
      if (!onBoard(attacker.cur) || this.testCanGetThere(attacker, kingPos, false) <= 0) continue;
      const v = moveVector(attacker.cur, kingPos);
      if (!v) return true;
      const d = DIRECTIONS[v.dir];
      let sq = { x: attacker.cur.x, y: attacker.cur.y };
      for (let step = 0; step < v.steps; step++) {
        for (const own of [...this.pieces[player]]) {
          if (!onBoard(own.cur) || this.testCanGetThere(own, sq, true) <= 0) continue;
          const occupant = this.board[sq.x][sq.y];
          this.tryPiecePos(own, sq);
          this.tryPiecePos(occupant, HEAVEN);
          const stillInCheck = this.isPlayerInCheck(own.player);
          this.undoTryPiecePos(own);
          this.undoTryPiecePos(occupant);
          if (!stillInCheck) return false;
        }
        sq = { x: sq.x + d.x, y: sq.y + d.y };
      }
      return true;
    }
    return false;
  }

  /** ComputeCheckResult @ 004a9c30 — the check / checkmate flag for `player` (the side about to move). */
  computeCheckResult(player: number): number {
    let r: number = ChessResult.NoMoveResult;
    if (this.isPlayerInCheck(player)) {
      r = this.isPlayerInCheckMate(player) ? ChessResult.OKMoveCheckmate : ChessResult.OKMoveCheck;
    }
    this.lastMoveWasCheck = r > ChessResult.OKMoveMask;
    return r;
  }

  /** HandleCastling @ 004a9670. */
  protected handleCastling(king: ChessPiece, to: ChessCoord): number {
    if (this.lastMoveWasCheck) return ChessResult.BadMoveCantCastleOutOfCheck;
    if (king.moved) return ChessResult.BadMoveCantCastleAfterMoving;
    const dir = to.x < king.cur.x ? -1 : 1;
    const y = king.cur.y;
    for (let x = king.cur.x + dir; x >= 0; x += dir) {
      if (x > 7) return ChessResult.BadMoveNoPiece;
      const piece = this.board[x][y];
      if (!piece) continue;
      if (piece.type !== ChessPieceType.Castle || piece.player !== king.player) return ChessResult.BadMoveWouldCollide;
      if (piece.moved) return ChessResult.BadMoveCantCastleAfterMoving;
      const pass = { x: king.cur.x + dir, y };
      const dest = { x: king.cur.x + dir * 2, y };
      if (this.doesMoveSelfCheck(king, pass)) return ChessResult.BadMoveCantCastleThroughCheck;
      if (this.doesMoveSelfCheck(king, dest)) return ChessResult.BadMoveSelfCheck;
      this.commitPiecePos(piece, pass);
      this.commitPiecePos(king, dest);
      return ChessResult.OKMoveToEmptySquare;
    }
    return ChessResult.BadMoveNoPiece;
  }

  /** CChessLogic::Move @ 004a9e40. */
  move(from: ChessCoord, to: ChessCoord): number {
    if (!onBoard(from) || !onBoard(to)) return ChessResult.BadMoveDestination;
    if (!this.sanityCheckBoard()) return ChessResult.BadMoveInvalidBoardState;
    const piece = this.board[from.x][from.y];
    let captured = this.board[to.x][to.y];
    if (!piece) return ChessResult.BadMoveNoPiece;
    if (piece.player !== this.curPlayer) return ChessResult.BadMoveNotYours;
    let r: number;
    if (piece.type === ChessPieceType.King && Math.abs(to.x - from.x) === 2 && to.y === from.y) {
      r = this.handleCastling(piece, to);
    } else {
      r = this.testMoveAndSelfCheck(piece, to);
      if (r < 1) return r;
      if ((r & ChessResult.OKMoveMask) === ChessResult.OKMoveEnPassant) captured = this.pieceAt(this.enPassantVictimPos);
    }
    if (r > 0) {
      this.commitPiecePos(piece, to);
      this.commitPiecePos(captured, HEAVEN);
      this.enPassantAttackSite = { x: HEAVEN.x, y: HEAVEN.y };
      if (piece.type === ChessPieceType.Pawn) {
        if (Math.abs(to.y - from.y) === 2) {
          this.enPassantAttackSite = { x: from.x, y: Math.trunc((from.y + to.y) / 2) };
          this.enPassantVictimPos = { x: to.x, y: to.y };
        }
        if (to.y === 0 || to.y === 7) r |= ChessResult.OKMovePromotion;
      }
      this.curPlayer = this.curPlayer === 0 ? 1 : 0;
      r |= this.computeCheckResult(this.curPlayer);
    }
    return r;
  }

  /** SanityCheckBoard @ 004a7f10 — both sides still have a king at index 0. */
  protected sanityCheckBoard(): boolean {
    return this.pieces[0][0]?.type === ChessPieceType.King && this.pieces[1][0]?.type === ChessPieceType.King;
  }
}

/** A drawn list-box item (UIElement_ListBox item from template 0x10000178). */
export interface ChessBoardCell {
  /** The piece on this item, or null (retail hides the item: SetVisible(0)). */
  piece: { type: ChessPieceType; player: number } | null;
  /** The selection overlay child 0x10000179 is shown. */
  selected: boolean;
}

/** GameBoardGrid::Reset @ 004a92b0 — the 32 (x, y, team, type) quadruples. */
const BACK_RANK: ChessPieceType[] = [
  ChessPieceType.Castle, ChessPieceType.Knight, ChessPieceType.Bishop, ChessPieceType.Queen,
  ChessPieceType.King, ChessPieceType.Bishop, ChessPieceType.Knight, ChessPieceType.Castle,
];

/**
 * The 64-item list box index a board square is drawn in (GameBoardGrid::Draw
 * @ 004a7d40): team 0 sees rank 0 at the bottom (row 7), any other team
 * (black, or -1 when not playing) the board rotated 180°.
 */
export function chessListIndex(x: number, y: number, team: number): number {
  return team === 0 ? x + (7 - y) * 8 : (7 - x) + y * 8;
}

/**
 * Index into the list box's p0x10000021 piece-DID array (GameBoardGrid ctor
 * @ 004a8bd0: 0 pawn, 1 bishop, 2 knight, 3 rook, 4 queen, 5 king for team
 * 0; 6…11 the same for team 1).
 */
export function chessPieceDidIndex(type: ChessPieceType, player: number): number {
  const byType: Record<ChessPieceType, number> = {
    [ChessPieceType.Pawn]: 0,
    [ChessPieceType.Bishop]: 1,
    [ChessPieceType.Knight]: 2,
    [ChessPieceType.Castle]: 3,
    [ChessPieceType.Queen]: 4,
    [ChessPieceType.King]: 5,
  };
  return byType[type] + (player === 0 ? 0 : 6);
}

/** The inverse — HandleMousePresses @ 004aa620 turns the clicked item back into a square. */
export function chessSquareOfListIndex(index: number, team: number): ChessCoord {
  const col = index % 8, row = Math.trunc(index / 8);
  return team === 0 ? { x: col, y: 7 - row } : { x: 7 - col, y: row };
}

interface LogicSnapshot {
  board: (ChessPiece | null)[][];
  pieces: [ChessPiece[], ChessPiece[]];
  curPlayer: number;
  lastMoveWasCheck: boolean;
  enPassantAttackSite: ChessCoord;
  enPassantVictimPos: ChessCoord;
}

/** Port of GameBoardGrid (the logic + list box of gmMiniGameUI). */
export class ChessBoardGrid extends ChessLogic {
  selected: ChessCoord = { x: -1, y: -1 };
  /** The list box as last drawn (Draw only runs where retail calls it). */
  cells: ChessBoardCell[] = Array.from({ length: 64 }, () => ({ piece: null, selected: false }));
  private snapshot: LogicSnapshot | null = null;

  /** ClearAllPieces @ 004a8b40. */
  clearAllPieces(): void {
    this.board = Array.from({ length: 8 }, () => Array<ChessPiece | null>(8).fill(null));
    this.pieces = [[], []];
    this.snapshot = null;
  }

  /** Reset @ 004a92b0 — the standard opening position, then Draw. */
  reset(team: number): void {
    this.clearAllPieces();
    for (let x = 0; x < 8; x++) this.createPiece(x, 0, 0, BACK_RANK[x]);
    for (let x = 0; x < 8; x++) this.createPiece(x, 1, 0, ChessPieceType.Pawn);
    for (let x = 0; x < 8; x++) this.createPiece(x, 6, 1, ChessPieceType.Pawn);
    for (let x = 0; x < 8; x++) this.createPiece(x, 7, 1, BACK_RANK[x]);
    this.draw(team);
  }

  /**
   * PrepareNewMove @ 004a7b60 — remember the position before a move is
   * tried. Retail copies only the board array (so its UndoMoves leaves the
   * pieces' coords / m_CurPlayer advanced); this snapshot restores the whole
   * logic state so a server-rejected move leaves a playable board.
   */
  prepareNewMove(): void {
    const clone = new Map<ChessPiece, ChessPiece>();
    const c = (p: ChessPiece | null): ChessPiece | null => {
      if (!p) return null;
      let q = clone.get(p);
      if (!q) { q = { ...p, cur: { ...p.cur }, lastGood: { ...p.lastGood } }; clone.set(p, q); }
      return q;
    };
    this.snapshot = {
      board: this.board.map((col) => col.map(c)),
      pieces: [this.pieces[0].map((p) => c(p)!), this.pieces[1].map((p) => c(p)!)],
      curPlayer: this.curPlayer,
      lastMoveWasCheck: this.lastMoveWasCheck,
      enPassantAttackSite: { ...this.enPassantAttackSite },
      enPassantVictimPos: { ...this.enPassantVictimPos },
    };
  }

  /** UndoMoves @ 004a8090 — back to the PrepareNewMove position, then Draw. */
  undoMoves(team: number): void {
    const s = this.snapshot;
    if (s) {
      this.board = s.board;
      this.pieces = s.pieces;
      this.curPlayer = s.curPlayer;
      this.lastMoveWasCheck = s.lastMoveWasCheck;
      this.enPassantAttackSite = s.enPassantAttackSite;
      this.enPassantVictimPos = s.enPassantVictimPos;
      this.snapshot = null;
    }
    this.draw(team);
  }

  /** CommitMoves @ 004a8a90 — drop captured pieces, clear the selection, Draw. */
  commitMoves(team: number): void {
    this.pieces = [this.pieces[0].filter((p) => onBoard(p.cur)), this.pieces[1].filter((p) => onBoard(p.cur))];
    this.snapshot = null;
    this.selected = { x: -1, y: -1 };
    this.draw(team);
  }

  /** DoPromotion @ 004a9d10 — the pawn on (x, y) becomes a queen; recompute the opponent's check. */
  doPromotion(x: number, y: number, result: number): number {
    const pawn = this.board[x][y];
    if (!pawn) return result;
    const list = this.pieces[pawn.player];
    list.splice(list.indexOf(pawn), 1);
    this.board[x][y] = null;
    this.createPiece(x, y, pawn.player, ChessPieceType.Queen);
    return result | this.computeCheckResult(pawn.player === 0 ? 1 : 0);
  }

  /** Draw @ 004a7d40 — fill the 64 list-box items for `team`'s orientation. */
  draw(team: number): void {
    const sel = this.selected;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const p = this.board[x][y];
        this.cells[chessListIndex(x, y, team)] = {
          piece: p ? { type: p.type, player: p.player } : null,
          selected: onBoard(sel) && sel.x === x && sel.y === y,
        };
      }
    }
  }

  /** GotoDefaultState's reset of the grid's logic fields (@004aa5a0). */
  resetLogicState(): void {
    this.curPlayer = 0;
    this.lastMoveWasCheck = false;
    this.enPassantAttackSite = { x: -1, y: -1 };
    this.enPassantVictimPos = { x: -1, y: -1 };
    this.selected = { x: -1, y: -1 };
  }
}

/** gmMiniGameUI::m_state (GS_* values from the annotated decomp). */
export enum MiniGameState {
  NotPlaying = 0,
  AttemptingToJoinGame = 1,
  WaitingForStart = 2,
  PlayingMyTurn = 3,
  PlayingTryingToMove = 4,
  PlayingOpponentsTurn = 5,
}

/** What the session needs from its host (GameUI / the network layer). */
export interface MiniGameHost {
  /** CM_Game::Event_Join(board, 0xffffffff). */
  sendJoin(boardGuid: number): void;
  /** CM_Game::Event_Move(fromX, fromY, toX, toY). */
  sendMove(fromX: number, fromY: number, toX: number, toY: number): void;
  /** CM_Game::Event_MovePass. */
  sendMovePass(): void;
  /** CM_Game::Event_Quit. */
  sendQuit(): void;
  /** CM_Game::Event_Stalemate(on). */
  sendStalemate(on: boolean): void;
  /** SetInfoText → ClientSystem::AddTextToScroll(text, 0, true, 0): a chat line. */
  infoText(text: string): void;
  /** ECM_UI::SendNotice_DisplayStringInfo(0x1a, …). */
  displayStringInfo(text: string): void;
  /** The panel's UIElement::SetVisible. */
  setVisible(visible: boolean): void;
  /** CM_Game::SendNotice_EndGame — every EndGame listener (the panel hides, the indicator ghosts). */
  endGame(): void;
  /** The list box changed (after a Draw). */
  redraw(): void;
  /** DialogFactory::MakeCallbackDialogInCurrentUI — a yes/no confirmation. */
  confirm(text: string, onResponse: (accepted: boolean) => void): void;
  /** A button's UIElement::SetState (resign 0x10000175 / stalemate 0x10000177 → 1). */
  setButtonState?(elementId: number, state: number): void;
}

/** "To join a game, select and use the game board.\n" (GameOver / TryToQuitGame). */
const JOIN_HINT = 'To join a game, select and use the game board.\n';

/** ShowMoveResult @ 004aa240's rejection texts. */
const MOVE_REJECTION_TEXT: Record<number, string> = {
  [-110]: 'You cannot castle after moving the King or Rook',
  [-109]: 'You cannot castle through check',
  [-108]: 'You cannot castle out of check',
  [-107]: 'You can only move through empty squares',
  [-106]: 'That move would put you in check',
  [-105]: 'You cannot attack your own pieces',
  [-104]: 'You cannot move off the board',
  [-103]: 'The selected piece is not yours',
  [-102]: 'You tried to move an empty square',
  [-101]: 'The selected piece cannot move that far',
  [-100]: 'The selected piece cannot move that direction',
};

/** ShowMoveResult @ 004aa240 — the chat line after the player's own move attempt. */
export function chessMoveResultInfoText(result: number): string {
  if (result < 1) {
    if (result === ChessResult.BadMoveNotYourTurn) return 'Its not your turn, please wait for your opponents move.\n';
    return `${MOVE_REJECTION_TEXT[result] ?? 'That move is invalid'}, try again.  It is your turn to move.\n`;
  }
  if (result & ChessResult.OKMoveCheckmate) return 'You have checkmated your opponent!\n';
  return 'Move in progress.' + ((result & ChessResult.OKMoveCheck) ? '  Your opponent is in Check.\n' : '\n');
}

/** ShowOpponentMoveResult @ 004aa4d0. */
export function chessOpponentMoveResultInfoText(result: number): string {
  if (result & ChessResult.OKMoveCheckmate) return 'You have been checkmated!\n';
  return ((result & ChessResult.OKMoveCheck) ? 'You are in check!  ' : '') + 'It is your turn to move.\n';
}

/** Port of gmMiniGameUI's game state + notice handlers. */
export class MiniGameSession {
  readonly grid = new ChessBoardGrid();
  state = MiniGameState.NotPlaying;
  gameId = 0;
  team = -1;
  stalemate = false;
  private resignDialogOpen = false;

  constructor(private readonly host: MiniGameHost) {}

  private draw(): void {
    this.grid.draw(this.team);
    this.host.redraw();
  }

  /** RecvNotice_BeginGame @ 004aa890 — SetVisible(1), then TryToJoinGame. */
  beginGame(boardGuid: number): boolean {
    this.host.setVisible(true);
    return this.tryToJoinGame(boardGuid);
  }

  /** RecvNotice_EndGame @ 004a7cf0 — SetVisible(0). */
  endGame(): void {
    this.host.setVisible(false);
  }

  /** TryToJoinGame @ 004aa120. */
  tryToJoinGame(boardGuid: number): boolean {
    if (this.gameId === boardGuid) {
      this.host.displayStringInfo('You are already playing this game.');
      return false;
    }
    if (this.gameId !== 0) {
      this.host.displayStringInfo('You are already playing another game.');
      return false;
    }
    this.gameId = boardGuid;
    this.state = MiniGameState.AttemptingToJoinGame;
    this.host.sendJoin(boardGuid);
    this.host.setButtonState?.(0x10000175, 1);
    this.host.infoText('Attempting to join game, please wait...\n');
    return true;
  }

  /** RecvNotice_JoinGameResponse @ 004aa060. */
  joinGameResponse(boardGuid: number, team: number): void {
    if (boardGuid !== this.gameId || this.state !== MiniGameState.AttemptingToJoinGame) return;
    if (team === -1) {
      this.host.infoText('You could not join that game.\n');
      this.gameId = 0;
      this.state = MiniGameState.NotPlaying;
      return;
    }
    this.host.infoText('You have joined the game, waiting for all players to be ready.\n');
    this.state = MiniGameState.WaitingForStart;
    this.team = team;
    this.grid.reset(team);
    this.host.redraw();
    this.stalemate = false;
  }

  /** RecvNotice_StartGame @ 004aa0d0 — `firstTeam` moves first. */
  startGame(boardGuid: number, firstTeam: number): void {
    if (boardGuid !== this.gameId || this.state !== MiniGameState.WaitingForStart) return;
    if (firstTeam === this.team) {
      this.state = MiniGameState.PlayingMyTurn;
      this.host.infoText('The game has begun, it is your turn to move.\n');
    } else {
      this.state = MiniGameState.PlayingOpponentsTurn;
      this.host.infoText('The game has begun, waiting for your opponent to move.\n');
    }
  }

  /** GameBoardGrid::HandleMousePresses @ 004aa620 — a click on list-box item `index`. */
  clickSquare(index: number): void {
    if (index < 0 || index > 63 || this.state !== MiniGameState.PlayingMyTurn) return;
    const g = this.grid;
    const to = chessSquareOfListIndex(index, this.team);
    if (onBoard(g.selected)) {
      if (g.selected.x === to.x && g.selected.y === to.y) {
        g.selected = { x: -1, y: -1 };
        this.draw();
        return;
      }
      g.prepareNewMove();
      const from = g.selected;
      let r = g.move(from, to);
      if (r > 0) {
        if (r & ChessResult.OKMovePromotion) r = g.doPromotion(to.x, to.y, r);
        // gmMiniGameUI::DoMove @ 004a7d10.
        this.host.sendMove(from.x, from.y, to.x, to.y);
        this.state = MiniGameState.PlayingTryingToMove;
        g.selected = { x: to.x, y: to.y };
      } else {
        g.selected = { x: -1, y: -1 };
      }
      this.host.infoText(chessMoveResultInfoText(r));
      this.draw();
      return;
    }
    const p = g.board[to.x][to.y];
    if (p && p.player === this.team) {
      g.selected = { x: to.x, y: to.y };
      this.draw();
    }
  }

  /** RecvNotice_MoveResponse @ 004aa8c0. */
  moveResponse(boardGuid: number, result: number): void {
    if (boardGuid !== this.gameId || this.state !== MiniGameState.PlayingTryingToMove) return;
    if (result > 0) {
      this.grid.commitMoves(this.team);
      this.host.redraw();
      this.state = MiniGameState.PlayingOpponentsTurn;
      this.host.infoText('Waiting for your opponent to move.\n');
      return;
    }
    this.grid.undoMoves(this.team);
    this.host.redraw();
    this.state = MiniGameState.PlayingMyTurn;
    this.host.infoText(chessMoveResultInfoText(result));
  }

  /** RecvNotice_OpponentTurn @ 004aa920 → GameBoardGrid::OpponentMove @ 004aa810. */
  opponentTurn(boardGuid: number, from: ChessCoord, to: ChessCoord): void {
    if (boardGuid !== this.gameId || this.state !== MiniGameState.PlayingOpponentsTurn) return;
    const g = this.grid;
    g.prepareNewMove();
    let r = g.move(from, to);
    g.commitMoves(this.team);
    if (r > 0) {
      if (r & ChessResult.OKMovePromotion) r = g.doPromotion(to.x, to.y, r);
      this.host.infoText(chessOpponentMoveResultInfoText(r));
      g.draw(this.team);
    }
    this.host.redraw();
    this.state = MiniGameState.PlayingMyTurn;
  }

  /** RecvNotice_OpponentOffersStalemate @ 004a9c80. */
  opponentOffersStalemate(boardGuid: number, offering: boolean): void {
    if (boardGuid !== this.gameId) return;
    this.host.infoText(offering
      ? 'Your opponent has declared a stalemate.  To agree, press your stalemate button.\n'
      : 'Your opponent has retracted their offer of stalemate.\n');
  }

  /** RecvNotice_GameOver @ 004aa950 — winner -1 stalemate, -2 leave game mode. */
  gameOver(boardGuid: number, winner: number): void {
    if (boardGuid !== this.gameId) return;
    let prefix = '';
    if (winner === -2) this.host.endGame();
    else if (winner === -1) prefix = 'The game has ended in a stalemate.  ';
    else if (winner === this.team) prefix = 'You are victorious!  ';
    else prefix = 'You have been defeated!  ';
    this.gotoDefaultState(prefix + JOIN_HINT);
  }

  /** GotoDefaultState @ 004aa5a0 (no Draw — the finished board stays on screen). */
  private gotoDefaultState(text: string): void {
    this.gameId = 0;
    this.state = MiniGameState.NotPlaying;
    this.team = -1;
    this.stalemate = false;
    this.host.infoText(text);
    this.host.setButtonState?.(0x10000177, 1);
    this.grid.resetLogicState();
  }

  /** ListenToElementMessage @ 004aaa30 — Resign 0x10000175. */
  clickResign(): void {
    if (this.resignDialogOpen) return;
    this.resignDialogOpen = true;
    this.host.confirm(
      'If a game is in progress, resigning will be recorded as your loss. Are you sure you want to resign?',
      (accepted) => this.tryToQuitGame(accepted),
    );
  }

  /** ListenToElementMessage — Pass 0x10000176 (hidden by PostInit, still handled). */
  clickPass(): void {
    if (this.gameId !== 0) this.host.sendMovePass();
    else this.host.displayStringInfo('You are not currently playing a game.');
  }

  /** ListenToElementMessage — Stalemate 0x10000177 toggles the offer. */
  clickStalemate(): void {
    if (this.gameId === 0) {
      this.host.displayStringInfo('You are not currently playing a game.');
      return;
    }
    this.stalemate = !this.stalemate;
    this.host.sendStalemate(this.stalemate);
  }

  /** RecvNotice_TryToQuitGame @ 004aacd0 (the resign dialog's answer). */
  tryToQuitGame(confirmed: boolean): void {
    this.resignDialogOpen = false;
    if (!confirmed) return;
    this.host.sendQuit();
    if (this.gameId !== 0) {
      this.gotoDefaultState(JOIN_HINT);
      this.host.endGame();
    }
  }
}
