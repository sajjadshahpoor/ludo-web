/*
 * Ludo game engine — pure game rules, no DOM.
 *
 * Token progress is stored relative to its owner:
 *   -1        in base (yard)
 *   0 .. 50   on the shared track (0 = the player's start square)
 *   51 .. 55  in the player's home column
 *   56        finished (reached home)
 */
(function (global) {
  'use strict';

  const COLORS = ['red', 'green', 'yellow', 'blue'];
  const TRACK_LEN = 52;
  const LAST_TRACK = 50;
  const HOME = 56;
  const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };
  const SAFE_INDEXES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

  // The 52 shared track squares as [row, col] on a 15x15 grid, clockwise from red's start.
  const TRACK = (function () {
    const cells = [];
    for (let c = 1; c <= 5; c++) cells.push([6, c]);
    for (let r = 5; r >= 0; r--) cells.push([r, 6]);
    cells.push([0, 7]);
    for (let r = 0; r <= 5; r++) cells.push([r, 8]);
    for (let c = 9; c <= 14; c++) cells.push([6, c]);
    cells.push([7, 14]);
    for (let c = 14; c >= 9; c--) cells.push([8, c]);
    for (let r = 9; r <= 14; r++) cells.push([r, 8]);
    cells.push([14, 7]);
    for (let r = 14; r >= 9; r--) cells.push([r, 6]);
    for (let c = 5; c >= 0; c--) cells.push([8, c]);
    cells.push([7, 0]);
    cells.push([6, 0]);
    return cells;
  })();

  const HOME_COLUMN = {
    red: [1, 2, 3, 4, 5].map(c => [7, c]),
    green: [1, 2, 3, 4, 5].map(r => [r, 7]),
    yellow: [13, 12, 11, 10, 9].map(c => [7, c]),
    blue: [13, 12, 11, 10, 9].map(r => [r, 7]),
  };

  function trackIndex(color, progress) {
    return (START_INDEX[color] + progress) % TRACK_LEN;
  }

  function isOnTrack(progress) {
    return progress >= 0 && progress <= LAST_TRACK;
  }

  function createGame(seats) {
    // seats: [{ color, type: 'human' | 'cpu', name }] in turn order
    return {
      players: seats.map(s => ({
        color: s.color,
        type: s.type,
        name: s.name || s.color,
        tokens: [-1, -1, -1, -1],
      })),
      current: 0,
      dice: null,
      sixStreak: 0,
      phase: 'roll', // 'roll' | 'move' | 'over'
      winner: null,
    };
  }

  function canMove(progress, dice) {
    if (progress === HOME) return false;
    if (progress === -1) return dice === 6;
    return progress + dice <= HOME;
  }

  function movableTokens(game, playerIdx, dice) {
    const p = game.players[playerIdx];
    const result = [];
    p.tokens.forEach((pos, i) => { if (canMove(pos, dice)) result.push(i); });
    return result;
  }

  // Squares a token passes through when moving, so the UI can animate step by step.
  function movePath(from, dice) {
    if (from === -1) return [0];
    const path = [];
    for (let s = from + 1; s <= from + dice; s++) path.push(s);
    return path;
  }

  // Opponent tokens that would be captured if `color` lands on relative `progress`.
  function capturesAt(game, playerIdx, progress) {
    if (!isOnTrack(progress)) return [];
    const color = game.players[playerIdx].color;
    const idx = trackIndex(color, progress);
    if (SAFE_INDEXES.has(idx)) return [];
    const hits = [];
    game.players.forEach((op, pi) => {
      if (pi === playerIdx) return;
      op.tokens.forEach((pos, ti) => {
        if (isOnTrack(pos) && trackIndex(op.color, pos) === idx) hits.push({ player: pi, token: ti });
      });
    });
    return hits;
  }

  function roll(game, value) {
    if (game.phase !== 'roll') throw new Error('Not time to roll');
    const dice = value || 1 + Math.floor(Math.random() * 6);
    game.dice = dice;
    game.sixStreak = dice === 6 ? game.sixStreak + 1 : 0;

    if (game.sixStreak === 3) {
      // Three sixes in a row forfeits the turn.
      return { dice, movable: [], forfeit: true };
    }
    const movable = movableTokens(game, game.current, dice);
    game.phase = movable.length ? 'move' : 'roll';
    return { dice, movable, forfeit: false };
  }

  // Apply a move. Returns what happened so the UI can animate it.
  function move(game, tokenIdx) {
    if (game.phase !== 'move') throw new Error('Not time to move');
    const pi = game.current;
    const player = game.players[pi];
    const from = player.tokens[tokenIdx];
    if (!canMove(from, game.dice)) throw new Error('Illegal move');

    const to = from === -1 ? 0 : from + game.dice;
    const path = movePath(from, game.dice);
    const captured = capturesAt(game, pi, to);
    captured.forEach(c => { game.players[c.player].tokens[c.token] = -1; });
    player.tokens[tokenIdx] = to;

    const reachedHome = to === HOME;
    const won = player.tokens.every(t => t === HOME);
    let extraTurn = false;

    if (won) {
      game.phase = 'over';
      game.winner = pi;
    } else {
      extraTurn = game.dice === 6 || captured.length > 0 || reachedHome;
      game.phase = 'roll';
    }
    return { player: pi, token: tokenIdx, from, to, path, captured, reachedHome, won, extraTurn };
  }

  function nextTurn(game) {
    game.current = (game.current + 1) % game.players.length;
    game.sixStreak = 0;
    game.dice = null;
    game.phase = 'roll';
  }

  // ---------- Computer player ----------

  // How many opponent tokens could hit relative `progress` of `color` next turn.
  function dangerAt(game, playerIdx, progress) {
    if (!isOnTrack(progress)) return 0;
    const color = game.players[playerIdx].color;
    const idx = trackIndex(color, progress);
    if (SAFE_INDEXES.has(idx)) return 0;
    let danger = 0;
    game.players.forEach((op, pi) => {
      if (pi === playerIdx) return;
      op.tokens.forEach(pos => {
        if (isOnTrack(pos)) {
          const opIdx = trackIndex(op.color, pos);
          const dist = (idx - opIdx + TRACK_LEN) % TRACK_LEN;
          // Opponent must also not have turned into its own home column before reaching us.
          if (dist >= 1 && dist <= 6 && pos + dist <= LAST_TRACK) danger++;
        }
      });
    });
    return danger;
  }

  function scoreMove(game, pi, ti) {
    const player = game.players[pi];
    const from = player.tokens[ti];
    const to = from === -1 ? 0 : from + game.dice;
    let score = 0;

    const caps = capturesAt(game, pi, to);
    if (caps.length) score += 100 + caps.length * 10;
    if (to === HOME) score += 80;
    if (from === -1) score += 60;
    if (from <= LAST_TRACK && to > LAST_TRACK && to !== HOME) score += 50; // into home column

    const dangerBefore = dangerAt(game, pi, from);
    const dangerAfter = dangerAt(game, pi, to);
    score += dangerBefore * 25; // escaping
    score -= dangerAfter * 35;  // walking into danger

    if (isOnTrack(to) && SAFE_INDEXES.has(trackIndex(player.color, to))) score += 20;
    score += to * 0.3; // generally prefer advancing lead tokens
    return score + Math.random(); // tiny tie-breaker
  }

  function chooseMove(game) {
    const movable = movableTokens(game, game.current, game.dice);
    let best = movable[0];
    let bestScore = -Infinity;
    movable.forEach(ti => {
      const s = scoreMove(game, game.current, ti);
      if (s > bestScore) { bestScore = s; best = ti; }
    });
    return best;
  }

  global.Ludo = {
    COLORS, TRACK, HOME_COLUMN, START_INDEX, SAFE_INDEXES, HOME, LAST_TRACK,
    trackIndex, createGame, roll, move, nextTurn, movableTokens, chooseMove, canMove,
  };
})(typeof window !== 'undefined' ? window : this);
