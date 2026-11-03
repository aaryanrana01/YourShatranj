import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { detectEnd, hasMatingMaterial, replay, tryMove } from '../src/game/rules.js';

describe('rules', () => {
  it('rejects illegal and malformed moves', () => {
    const chess = new Chess();
    expect(tryMove(chess, 'e2e5')).toBeNull();
    expect(tryMove(chess, 'e7e5')).toBeNull(); // black piece on white's turn
    expect(tryMove(chess, 'e2e4q')).toBeNull(); // promotion letter on a normal move
    expect(tryMove(chess, 'e2e4')?.san).toBe('e4');
  });

  it('requires the promotion piece to be named', () => {
    const chess = new Chess('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
    expect(tryMove(chess, 'e7e8')).toBeNull();
    expect(tryMove(chess, 'e7e8n')?.san).toBe('e8=N+'); // the knight on e8 checks the king on g7
  });

  it('detects checkmate (fool’s mate)', () => {
    const chess = replay(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(detectEnd(chess)).toEqual({ result: '0-1', reason: 'checkmate' });
  });

  it('auto-draws on threefold repetition', () => {
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const chess = replay([...shuffle, ...shuffle]);
    expect(detectEnd(chess)).toEqual({ result: '1/2-1/2', reason: 'repetition' });
  });

  it('detects stalemate', () => {
    const chess = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(detectEnd(chess)).toEqual({ result: '1/2-1/2', reason: 'stalemate' });
  });

  it('knows a lone king or single minor piece cannot mate', () => {
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/8/4K3 w - - 0 1'), 'w')).toBe(false);
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/8/3NK3 w - - 0 1'), 'w')).toBe(false);
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/8/2RNK3 w - - 0 1'), 'w')).toBe(true);
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1'), 'w')).toBe(true);
  });
});
