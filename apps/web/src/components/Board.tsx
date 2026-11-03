import { useEffect, useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square } from 'chess.js';

type Arrow = [Square, Square, string?];
type PieceCode = 'wP' | 'wB' | 'wN' | 'wR' | 'wQ' | 'wK' | 'bP' | 'bB' | 'bN' | 'bR' | 'bQ' | 'bK';

export interface BoardProps {
  id: string;
  fen: string;
  orientation?: 'white' | 'black';
  /** Which side the user may move: a colour, 'both' (analysis), or null (view only). */
  movable: 'w' | 'b' | 'both' | null;
  /** Called with a UCI move ("e2e4", "e7e8q"); return true if it was accepted. */
  onMove: (uci: string) => boolean;
  lastMove?: { from: string; to: string } | null;
  arrows?: Arrow[];
  /** Let the player queue one move during the opponent's turn. */
  premoves?: boolean;
}

const LIGHT = '#e9dfc9';
const DARK = '#7b8c6e';

function safeChess(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/**
 * Chessboard with drag-and-drop AND click-to-move, legal-move hints, a
 * promotion picker, and premoves. Moves are checked with chess.js before
 * being handed on, so an illegal drop snaps straight back.
 */
export function Board({ id, fen, orientation = 'white', movable, onMove, lastMove, arrows, premoves }: BoardProps) {
  const chess = useMemo(() => safeChess(fen), [fen]);
  const turn = chess?.turn() ?? 'w';
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [premove, setPremove] = useState<{ from: Square; to: Square } | null>(null);

  // A new position clears the selection; it may also make a queued premove playable.
  useEffect(() => {
    setSelected(null);
    setPromotion(null);
    if (!premove || !chess || movable === null || movable === 'both' || turn !== movable) return;
    const pm = premove;
    setPremove(null);
    const moving = chess.get(pm.from);
    const isPromo = moving?.type === 'p' && (pm.to[1] === '8' || pm.to[1] === '1');
    const uci = `${pm.from}${pm.to}${isPromo ? 'q' : ''}`;
    if (isLegal(chess, uci)) onMove(uci);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen]);

  const mayMoveColor = (color: 'w' | 'b', allowPremove: boolean) => {
    if (movable === null) return false;
    if (movable === 'both') return color === turn;
    if (color !== movable) return false;
    return color === turn || (allowPremove && !!premoves);
  };

  const targets = useMemo(() => {
    if (!chess || !selected) return [] as Square[];
    return chess.moves({ square: selected, verbose: true }).map((m) => m.to as Square);
  }, [chess, selected]);

  function isLegal(c: Chess, uci: string): boolean {
    const probe = new Chess(c.fen());
    try {
      probe.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      return true;
    } catch {
      return false;
    }
  }

  function isPromotionMove(from: Square, to: Square): boolean {
    const piece = chess?.get(from);
    return piece?.type === 'p' && (to[1] === '8' || to[1] === '1');
  }

  /** Common path for drag and click. Returns true if the move was played or queued. */
  function attempt(from: Square, to: Square, promo?: string): boolean {
    if (!chess) return false;
    const piece = chess.get(from);
    if (!piece) return false;
    if (piece.color !== turn) {
      // Not this side's turn: queue a premove if allowed.
      if (mayMoveColor(piece.color, true)) {
        setPremove({ from, to });
        return true;
      }
      return false;
    }
    const uci = `${from}${to}${promo ?? ''}`;
    if (!isLegal(chess, uci)) return false;
    return onMove(uci);
  }

  function handleDrop(from: Square, to: Square): boolean {
    setSelected(null);
    return attempt(from, to);
  }

  function handleSquareClick(square: Square) {
    if (!chess) return;
    if (selected && targets.includes(square)) {
      if (isPromotionMove(selected, square)) {
        setPromotion({ from: selected, to: square });
        return;
      }
      attempt(selected, square);
      setSelected(null);
      return;
    }
    const piece = chess.get(square);
    if (piece && mayMoveColor(piece.color, false)) setSelected(square);
    else {
      setSelected(null);
      if (premove) setPremove(null); // clicking elsewhere cancels a premove
    }
  }

  function handlePromotionSelect(piece?: string, from?: Square, to?: Square): boolean {
    const src = from ?? promotion?.from;
    const dst = to ?? promotion?.to;
    setPromotion(null);
    setSelected(null);
    if (!piece || !src || !dst) return false;
    return attempt(src, dst, piece[1]!.toLowerCase());
  }

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (lastMove) {
      styles[lastMove.from] = { background: 'rgba(242, 184, 75, 0.38)' };
      styles[lastMove.to] = { background: 'rgba(242, 184, 75, 0.5)' };
    }
    if (chess?.inCheck()) {
      const kingSquare = chess
        .board()
        .flat()
        .find((p) => p && p.type === 'k' && p.color === chess.turn())?.square;
      if (kingSquare) styles[kingSquare] = { background: 'radial-gradient(circle, rgba(224,86,91,0.9) 0%, rgba(224,86,91,0) 75%)' };
    }
    if (selected) styles[selected] = { ...styles[selected], boxShadow: 'inset 0 0 0 3px rgba(242,184,75,0.9)' };
    for (const t of targets) {
      const occupied = !!chess?.get(t);
      styles[t] = {
        ...styles[t],
        background: occupied
          ? 'radial-gradient(circle, transparent 58%, rgba(15,19,27,0.35) 60%)'
          : 'radial-gradient(circle, rgba(15,19,27,0.35) 22%, transparent 24%)',
      };
    }
    if (premove) {
      styles[premove.from] = { background: 'rgba(95, 140, 200, 0.55)' };
      styles[premove.to] = { background: 'rgba(95, 140, 200, 0.7)' };
    }
    return styles;
  }, [lastMove, chess, selected, targets, premove]);

  return (
    <Chessboard
      id={id}
      position={fen}
      boardOrientation={orientation}
      onPieceDrop={handleDrop}
      onSquareClick={handleSquareClick}
      onPromotionPieceSelect={handlePromotionSelect}
      showPromotionDialog={promotion !== null}
      promotionToSquare={promotion?.to ?? null}
      isDraggablePiece={({ piece }: { piece: PieceCode }) => mayMoveColor(piece[0] as 'w' | 'b', true)}
      customSquareStyles={squareStyles}
      customArrows={arrows}
      customLightSquareStyle={{ backgroundColor: LIGHT }}
      customDarkSquareStyle={{ backgroundColor: DARK }}
      customBoardStyle={{ borderRadius: '6px', boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}
      animationDuration={150}
      arePremovesAllowed={false}
    />
  );
}
