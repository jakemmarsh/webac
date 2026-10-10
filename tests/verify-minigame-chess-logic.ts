/**
 * GAP.indicator-bar-interactive (mini-game panel) — the retail chess board's
 * move model and state machine, ported from the decompiled EoL client:
 * CChessLogic<CBasePiece> (@004a7f10…@004a9e40), GameBoardGrid
 * (@004a7b60…@004aa810) and gmMiniGameUI's notice handlers
 * (@004a7cf0…@004aacd0). Drives the shipped module directly.
 */
import { describe, it, expect } from 'vitest';
import {
  ChessBoardGrid, ChessPieceType, ChessResult, MiniGameSession, MiniGameState,
  chessListIndex, chessSquareOfListIndex, chessPieceDidIndex, chessMoveResultInfoText,
  chessOpponentMoveResultInfoText, isGameBoardUse,
} from '../packages/renderer/src/ui/MiniGameChess.js';
import type { MiniGameHost } from '../packages/renderer/src/ui/MiniGameChess.js';

const sq = (x: number, y: number) => ({ x, y });

function newGame(): ChessBoardGrid {
  const g = new ChessBoardGrid();
  g.reset(0);
  return g;
}

describe('ChessBoardGrid.reset — GameBoardGrid::Reset @ 004a92b0', () => {
  it('lays out the standard opening with white on rank 0 and each king first in its list', () => {
    const g = newGame();
    expect(g.pieces[0]).toHaveLength(16);
    expect(g.pieces[1]).toHaveLength(16);
    expect(g.pieces[0][0].type).toBe(ChessPieceType.King);
    expect(g.pieces[1][0].type).toBe(ChessPieceType.King);
    expect(g.board[3][0]?.type).toBe(ChessPieceType.Queen);
    expect(g.board[4][0]?.type).toBe(ChessPieceType.King);
    expect(g.board[0][7]).toMatchObject({ type: ChessPieceType.Castle, player: 1 });
    expect(g.board[5][6]).toMatchObject({ type: ChessPieceType.Pawn, player: 1 });
    expect(g.board[4][4]).toBeNull();
  });

  it('draws into the 64-item list box in the viewer team\'s orientation (Draw @ 004a7d40)', () => {
    const g = new ChessBoardGrid();
    g.reset(0);
    // White sees its back rank on the bottom row: a1 rook = item 56.
    expect(g.cells[56].piece).toEqual({ type: ChessPieceType.Castle, player: 0 });
    expect(g.cells[0].piece).toEqual({ type: ChessPieceType.Castle, player: 1 });
    g.draw(1);
    // Black sees the board rotated: a1 rook = item 7, its own h8 rook = item 63.
    expect(g.cells[7].piece).toEqual({ type: ChessPieceType.Castle, player: 0 });
    expect(g.cells[63].piece).toEqual({ type: ChessPieceType.Castle, player: 1 });
    expect(g.cells[3 + 0 * 8].piece).toEqual({ type: ChessPieceType.King, player: 0 });
  });

  it('list index ↔ square round-trips for both teams (HandleMousePresses @ 004aa620)', () => {
    for (const team of [0, 1]) {
      for (let i = 0; i < 64; i++) {
        const s = chessSquareOfListIndex(i, team);
        expect(chessListIndex(s.x, s.y, team)).toBe(i);
      }
    }
    expect(chessListIndex(0, 0, -1)).toBe(7); // not playing → the rotated view
  });

  it('maps pieces onto the p0x10000021 DID array order (GameBoardGrid ctor @ 004a8bd0)', () => {
    expect(chessPieceDidIndex(ChessPieceType.Pawn, 0)).toBe(0);
    expect(chessPieceDidIndex(ChessPieceType.Bishop, 0)).toBe(1);
    expect(chessPieceDidIndex(ChessPieceType.Knight, 0)).toBe(2);
    expect(chessPieceDidIndex(ChessPieceType.Castle, 0)).toBe(3);
    expect(chessPieceDidIndex(ChessPieceType.Queen, 0)).toBe(4);
    expect(chessPieceDidIndex(ChessPieceType.King, 0)).toBe(5);
    expect(chessPieceDidIndex(ChessPieceType.Pawn, 1)).toBe(6);
    expect(chessPieceDidIndex(ChessPieceType.King, 1)).toBe(11);
  });
});

describe('ChessLogic.move — CChessLogic::Move @ 004a9e40', () => {
  it('accepts a pawn double step and arms the en-passant site', () => {
    const g = newGame();
    expect(g.move(sq(4, 1), sq(4, 3))).toBe(ChessResult.OKMoveToEmptySquare);
    expect(g.board[4][3]?.type).toBe(ChessPieceType.Pawn);
    expect(g.enPassantAttackSite).toEqual(sq(4, 2));
    expect(g.enPassantVictimPos).toEqual(sq(4, 3));
    expect(g.curPlayer).toBe(1);
  });

  it('returns retail\'s rejection codes', () => {
    const g = newGame();
    expect(g.move(sq(4, 1), sq(4, 4))).toBe(ChessResult.BadMoveDirection);
    expect(g.move(sq(4, 6), sq(4, 5))).toBe(ChessResult.BadMoveNotYours);
    expect(g.move(sq(4, 4), sq(4, 5))).toBe(ChessResult.BadMoveNoPiece);
    expect(g.move(sq(0, 0), sq(0, 1))).toBe(ChessResult.BadMoveWouldClobber);
    expect(g.move(sq(2, 0), sq(4, 2))).toBe(ChessResult.BadMoveWouldCollide);
    expect(g.move(sq(0, 0), sq(8, 0))).toBe(ChessResult.BadMoveDestination);
    // Knights jump.
    expect(g.move(sq(6, 0), sq(5, 2))).toBe(ChessResult.OKMoveToEmptySquare);
  });

  it('captures (OKMoveToOccupiedSquare) and captures en passant (OKMoveEnPassant)', () => {
    const g = newGame();
    g.move(sq(4, 1), sq(4, 3)); // e4
    g.move(sq(3, 6), sq(3, 4)); // d5
    expect(g.move(sq(4, 3), sq(3, 4))).toBe(ChessResult.OKMoveToOccupiedSquare); // exd5
    g.commitMoves(0);
    expect(g.pieces[1]).toHaveLength(15);
    g.move(sq(2, 6), sq(2, 4)); // c5 (double step beside the d5 pawn)
    const r = g.move(sq(3, 4), sq(2, 5)); // dxc6 e.p.
    expect(r).toBe(ChessResult.OKMoveEnPassant);
    g.commitMoves(0);
    expect(g.board[2][4]).toBeNull();
    expect(g.board[2][5]).toMatchObject({ type: ChessPieceType.Pawn, player: 0 });
    expect(g.pieces[1]).toHaveLength(14);
  });

  it('castles king side, and refuses once the king has moved', () => {
    const g = newGame();
    g.board[5][0] = null; g.board[6][0] = null;
    g.pieces[0] = g.pieces[0].filter((p) => !(p.cur.y === 0 && (p.cur.x === 5 || p.cur.x === 6)));
    expect(g.move(sq(4, 0), sq(6, 0))).toBe(ChessResult.OKMoveToEmptySquare);
    expect(g.pieceAt(sq(6, 0))?.type).toBe(ChessPieceType.King);
    expect(g.pieceAt(sq(5, 0))?.type).toBe(ChessPieceType.Castle);

    const h = newGame();
    h.board[5][0] = null; h.board[6][0] = null;
    h.pieces[0] = h.pieces[0].filter((p) => !(p.cur.y === 0 && (p.cur.x === 5 || p.cur.x === 6)));
    h.move(sq(4, 0), sq(5, 0)); h.move(sq(0, 6), sq(0, 5));
    h.move(sq(5, 0), sq(4, 0)); h.move(sq(0, 5), sq(0, 4));
    expect(h.move(sq(4, 0), sq(6, 0))).toBe(ChessResult.BadMoveCantCastleAfterMoving);
  });

  it('flags check and checkmate (fool\'s mate) and refuses self-check', () => {
    const g = newGame();
    g.move(sq(5, 1), sq(5, 2)); // f3
    g.move(sq(4, 6), sq(4, 4)); // e5
    g.move(sq(6, 1), sq(6, 3)); // g4
    const r = g.move(sq(3, 7), sq(7, 3)); // Qh4#
    expect(r & ChessResult.OKMoveCheckmate).toBeTruthy();
    expect(r & ChessResult.OKMoveMask).toBe(ChessResult.OKMoveToEmptySquare);

    const s = newGame();
    s.move(sq(4, 1), sq(4, 3)); // e4
    s.move(sq(5, 6), sq(5, 5)); // f6
    s.move(sq(3, 0), sq(7, 4)); // Qh5+
    expect(s.lastMoveWasCheck).toBe(true);
    // Black's g-pawn blocks; moving the f-pawn instead leaves the king in check.
    expect(s.move(sq(0, 6), sq(0, 5))).toBe(ChessResult.BadMoveSelfCheck);
    expect(s.move(sq(6, 6), sq(6, 5))).toBe(ChessResult.OKMoveToEmptySquare);
  });

  it('promotes a pawn reaching the last rank to a queen (DoPromotion @ 004a9d10)', () => {
    const g = new ChessBoardGrid();
    g.clearAllPieces();
    g.createPiece(4, 0, 0, ChessPieceType.King);
    g.createPiece(0, 7, 1, ChessPieceType.King);
    g.createPiece(7, 6, 0, ChessPieceType.Pawn);
    let r = g.move(sq(7, 6), sq(7, 7));
    expect(r & ChessResult.OKMovePromotion).toBeTruthy();
    r = g.doPromotion(7, 7, r);
    expect(g.board[7][7]).toMatchObject({ type: ChessPieceType.Queen, player: 0 });
    expect(r & ChessResult.OKMoveCheck).toBeTruthy(); // the new queen checks along rank 7
  });

  it('undoMoves restores the prepared position after a rejected move', () => {
    const g = newGame();
    g.prepareNewMove();
    g.move(sq(4, 1), sq(4, 3));
    g.undoMoves(0);
    expect(g.board[4][1]?.type).toBe(ChessPieceType.Pawn);
    expect(g.board[4][3]).toBeNull();
    expect(g.curPlayer).toBe(0);
    expect(g.move(sq(4, 1), sq(4, 3))).toBe(ChessResult.OKMoveToEmptySquare);
  });
});

describe('chat text — ShowMoveResult @ 004aa240 / ShowOpponentMoveResult @ 004aa4d0', () => {
  it('matches the decompiled strings', () => {
    expect(chessMoveResultInfoText(-106)).toBe('That move would put you in check, try again.  It is your turn to move.\n');
    expect(chessMoveResultInfoText(-3)).toBe('Its not your turn, please wait for your opponents move.\n');
    expect(chessMoveResultInfoText(-111)).toBe('That move is invalid, try again.  It is your turn to move.\n');
    expect(chessMoveResultInfoText(1)).toBe('Move in progress.\n');
    expect(chessMoveResultInfoText(0x401)).toBe('Move in progress.  Your opponent is in Check.\n');
    expect(chessMoveResultInfoText(0x801)).toBe('You have checkmated your opponent!\n');
    expect(chessOpponentMoveResultInfoText(2)).toBe('It is your turn to move.\n');
    expect(chessOpponentMoveResultInfoText(0x402)).toBe('You are in check!  It is your turn to move.\n');
    expect(chessOpponentMoveResultInfoText(0x801)).toBe('You have been checkmated!\n');
  });

  it('isGameBoardUse — DetermineUseResult case 7 is the unowned TYPE_GAMEBOARD', () => {
    expect(isGameBoardUse(0x80000000, false)).toBe(true);
    expect(isGameBoardUse(0x80000000 | 0, false)).toBe(true);
    expect(isGameBoardUse(0x80000000, true)).toBe(false);
    expect(isGameBoardUse(0x00000010, false)).toBe(false);
    expect(isGameBoardUse(undefined, false)).toBe(false);
  });
});

function fakeHost() {
  const log: string[] = [];
  const host: MiniGameHost & { log: string[]; confirmAnswer: boolean } = {
    log,
    confirmAnswer: true,
    sendJoin: (b) => log.push(`join ${b}`),
    sendMove: (a, b, c, d) => log.push(`move ${a},${b}->${c},${d}`),
    sendMovePass: () => log.push('pass'),
    sendQuit: () => log.push('quit'),
    sendStalemate: (on) => log.push(`stalemate ${on}`),
    infoText: (t) => log.push(`info ${t}`),
    displayStringInfo: (t) => log.push(`error ${t}`),
    setVisible: (v) => log.push(`visible ${v}`),
    endGame: () => log.push('endGame'),
    redraw: () => log.push('redraw'),
    confirm: (t, cb) => { log.push(`confirm ${t}`); cb(host.confirmAnswer); },
  };
  return host;
}

const BOARD = 0x7a000123;

describe('MiniGameSession — gmMiniGameUI notice handlers', () => {
  it('BeginGame shows the panel and joins; a second BeginGame on the same board is refused', () => {
    const host = fakeHost();
    const s = new MiniGameSession(host);
    expect(s.beginGame(BOARD)).toBe(true);
    expect(host.log).toEqual(['visible true', `join ${BOARD}`, 'info Attempting to join game, please wait...\n']);
    expect(s.state).toBe(MiniGameState.AttemptingToJoinGame);
    expect(s.beginGame(BOARD)).toBe(false);
    expect(host.log).toContain('error You are already playing this game.');
    expect(s.beginGame(BOARD + 1)).toBe(false);
    expect(host.log).toContain('error You are already playing another game.');
  });

  it('a failed join returns to not playing', () => {
    const host = fakeHost();
    const s = new MiniGameSession(host);
    s.beginGame(BOARD);
    s.joinGameResponse(BOARD, -1);
    expect(host.log).toContain('info You could not join that game.\n');
    expect(s.gameId).toBe(0);
    expect(s.state).toBe(MiniGameState.NotPlaying);
  });

  it('plays a turn: join → start → select + move → server OK → opponent reply', () => {
    const host = fakeHost();
    const s = new MiniGameSession(host);
    s.beginGame(BOARD);
    s.joinGameResponse(BOARD, 0);
    expect(host.log).toContain('info You have joined the game, waiting for all players to be ready.\n');
    expect(s.grid.cells.filter((c) => c.piece).length).toBe(32);
    s.startGame(BOARD, 0);
    expect(s.state).toBe(MiniGameState.PlayingMyTurn);
    expect(host.log).toContain('info The game has begun, it is your turn to move.\n');

    s.clickSquare(chessListIndex(4, 1, 0)); // select e2
    expect(s.grid.cells[chessListIndex(4, 1, 0)].selected).toBe(true);
    s.clickSquare(chessListIndex(4, 3, 0)); // e4
    expect(host.log).toContain('move 4,1->4,3');
    expect(host.log).toContain('info Move in progress.\n');
    expect(s.state).toBe(MiniGameState.PlayingTryingToMove);
    // Retail keeps the moved piece highlighted until the server answers.
    expect(s.grid.cells[chessListIndex(4, 3, 0)].selected).toBe(true);

    s.moveResponse(BOARD, 1);
    expect(s.state).toBe(MiniGameState.PlayingOpponentsTurn);
    expect(host.log).toContain('info Waiting for your opponent to move.\n');
    expect(s.grid.cells.some((c) => c.selected)).toBe(false);

    s.opponentTurn(BOARD, sq(4, 6), sq(4, 4));
    expect(s.state).toBe(MiniGameState.PlayingMyTurn);
    expect(host.log[host.log.length - 2]).toBe('info It is your turn to move.\n');
    expect(s.grid.cells[chessListIndex(4, 4, 0)].piece).toEqual({ type: ChessPieceType.Pawn, player: 1 });
  });

  it('ignores clicks when it is not your turn and rejects illegal moves locally', () => {
    const host = fakeHost();
    const s = new MiniGameSession(host);
    s.beginGame(BOARD);
    s.joinGameResponse(BOARD, 1);
    s.startGame(BOARD, 0);
    expect(s.state).toBe(MiniGameState.PlayingOpponentsTurn);
    s.clickSquare(chessListIndex(4, 6, 1));
    expect(s.grid.cells.some((c) => c.selected)).toBe(false);

    s.opponentTurn(BOARD, sq(4, 1), sq(4, 3));
    s.clickSquare(chessListIndex(4, 6, 1)); // select own e7
    s.clickSquare(chessListIndex(4, 3, 1)); // e7-e4: illegal
    expect(host.log).toContain('info The selected piece cannot move that direction, try again.  It is your turn to move.\n');
    expect(host.log.some((l) => l.startsWith('move '))).toBe(false);
    expect(s.state).toBe(MiniGameState.PlayingMyTurn);
  });

  it('a server-rejected move is undone and reported', () => {
    const host = fakeHost();
    const s = new MiniGameSession(host);
    s.beginGame(BOARD);
    s.joinGameResponse(BOARD, 0);
    s.startGame(BOARD, 0);
    s.clickSquare(chessListIndex(4, 1, 0));
    s.clickSquare(chessListIndex(4, 3, 0));
    s.moveResponse(BOARD, -1);
    expect(s.state).toBe(MiniGameState.PlayingMyTurn);
    expect(s.grid.board[4][1]?.type).toBe(ChessPieceType.Pawn);
    expect(s.grid.board[4][3]).toBeNull();
    expect(host.log).toContain('info That move is invalid, try again.  It is your turn to move.\n');
  });

  it('game over, stalemate offers, stalemate button, resign', () => {
    const host = fakeHost();
    const s = new MiniGameSession(host);
    s.clickStalemate();
    expect(host.log).toContain('error You are not currently playing a game.');
    s.beginGame(BOARD);
    s.joinGameResponse(BOARD, 1);
    s.opponentOffersStalemate(BOARD, true);
    expect(host.log).toContain('info Your opponent has declared a stalemate.  To agree, press your stalemate button.\n');
    s.opponentOffersStalemate(BOARD, false);
    expect(host.log).toContain('info Your opponent has retracted their offer of stalemate.\n');
    s.opponentOffersStalemate(BOARD + 5, true); // another board: ignored
    s.clickStalemate();
    s.clickStalemate();
    expect(host.log.filter((l) => l.startsWith('stalemate'))).toEqual(['stalemate true', 'stalemate false']);

    s.gameOver(BOARD, 1);
    expect(host.log).toContain('info You are victorious!  To join a game, select and use the game board.\n');
    expect(s.state).toBe(MiniGameState.NotPlaying);
    expect(s.team).toBe(-1);
    // The finished position stays drawn (GotoDefaultState does not Draw).
    expect(s.grid.cells.filter((c) => c.piece).length).toBe(32);

    s.beginGame(BOARD);
    s.joinGameResponse(BOARD, 0);
    s.gameOver(BOARD, -2);
    expect(host.log[host.log.length - 2]).toBe('endGame');
    expect(host.log[host.log.length - 1]).toBe('info To join a game, select and use the game board.\n');

    s.beginGame(BOARD);
    s.clickResign();
    expect(host.log).toContain('confirm If a game is in progress, resigning will be recorded as your loss. Are you sure you want to resign?');
    expect(host.log.slice(-3)).toEqual(['quit', 'info To join a game, select and use the game board.\n', 'endGame']);
    expect(s.gameId).toBe(0);
  });
});
