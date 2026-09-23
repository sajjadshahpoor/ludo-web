/* Ludo UI — renders the board, handles input and drives computer players. */
(function () {
  'use strict';

  const L = window.Ludo;
  const $ = sel => document.querySelector(sel);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const COLOR_HEX = { red: '#e53935', green: '#43a047', yellow: '#fbc02d', blue: '#1e88e5' };
  const COLOR_SOFT = { red: '#ffcdd2', green: '#c8e6c9', yellow: '#fff3c4', blue: '#bbdefb' };
  const LABEL = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };
  const BASE_ORIGIN = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] }; // [x, y]
  const BASE_SPOTS = [[2, 2], [4, 2], [2, 4], [4, 4]];
  const FINISH_SPOT = { red: [6.55, 7.5], green: [7.5, 6.55], yellow: [8.45, 7.5], blue: [7.5, 8.45] };

  const STEP_MS = 150;
  const CPU_ROLL_DELAY = 650;
  const CPU_MOVE_DELAY = 450;
  const AUTO_ROLL_DELAY = 700;

  const PRESETS = {
    cpu1: [['human', 'You'], ['off'], ['cpu', 'Computer'], ['off']],
    cpu3: [['human', 'You'], ['cpu', 'Green'], ['cpu', 'Yellow'], ['cpu', 'Blue']],
    friends2: [['human', 'Player 1'], ['off'], ['human', 'Player 2'], ['off']],
    friends4: [['human', 'Red'], ['human', 'Green'], ['human', 'Yellow'], ['human', 'Blue']],
  };

  // ---------- Persistence (best effort) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  // ---------- Sound ----------
  let muted = store.get('ludo.muted', false);
  let autoRoll = store.get('ludo.autoRoll', false);
  let audioCtx = null;
  function tone(freq, duration, type = 'sine', delay = 0, volume = 0.08) {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + delay;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + duration);
    } catch (e) { /* audio unavailable */ }
  }
  const sfx = {
    roll() { for (let i = 0; i < 4; i++) tone(300 + Math.random() * 300, 0.05, 'square', i * 0.07, 0.03); },
    step() { tone(660, 0.05, 'triangle', 0, 0.05); },
    capture() { tone(500, 0.12, 'sawtooth', 0, 0.05); tone(250, 0.25, 'sawtooth', 0.1, 0.05); },
    home() { [523, 659, 784].forEach((f, i) => tone(f, 0.15, 'triangle', i * 0.08)); },
    win() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', i * 0.12)); },
  };

  // ---------- Setup screen ----------
  let seats = store.get('ludo.seats', null) || PRESETS.cpu1.map((s, i) => ({
    color: L.COLORS[i], type: s[0], name: s[1] || LABEL[L.COLORS[i]],
  }));

  function renderSeats() {
    const wrap = $('#seats');
    wrap.innerHTML = '';
    seats.forEach((seat, i) => {
      const row = document.createElement('div');
      row.className = 'seat' + (seat.type === 'off' ? ' off' : '');
      row.innerHTML = `
        <span class="dot ${seat.color}"></span>
        <input type="text" maxlength="16" aria-label="${LABEL[seat.color]} player name">
        <select aria-label="${LABEL[seat.color]} player type">
          <option value="human">Player</option>
          <option value="cpu">Computer</option>
          <option value="off">Off</option>
        </select>`;
      const input = row.querySelector('input');
      const select = row.querySelector('select');
      input.value = seat.name;
      input.disabled = seat.type === 'off';
      select.value = seat.type;
      input.addEventListener('input', () => { seat.name = input.value; clearPresetHighlight(); });
      select.addEventListener('change', () => {
        seat.type = select.value;
        if (seat.type === 'cpu' && (seat.name === 'You' || /^Player \d$/.test(seat.name))) seat.name = LABEL[seat.color];
        clearPresetHighlight();
        renderSeats();
      });
      wrap.appendChild(row);
    });
  }

  function clearPresetHighlight() {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
  }

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      seats = preset.map((s, i) => ({ color: L.COLORS[i], type: s[0], name: s[1] || LABEL[L.COLORS[i]] }));
      renderSeats();
      clearPresetHighlight();
      btn.classList.add('active');
      $('#setupError').textContent = '';
    });
  });

  $('#startBtn').addEventListener('click', () => {
    const active = seats.filter(s => s.type !== 'off');
    if (active.length < 2) {
      $('#setupError').textContent = 'You need at least 2 players.';
      return;
    }
    $('#setupError').textContent = '';
    seats.forEach(s => { s.name = (s.name || '').trim() || LABEL[s.color]; });
    store.set('ludo.seats', seats);
    startGame();
  });

  // ---------- Board drawing ----------
  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    if (parent) parent.appendChild(el);
    return el;
  }

  function cellRect(svg, x, y, fill) {
    svgEl('rect', { x, y, width: 1, height: 1, fill, stroke: '#b9b4aa', 'stroke-width': 0.035 }, svg);
  }

  function drawBoard() {
    const svg = $('#boardSvg');
    svg.innerHTML = '';
    svgEl('rect', { x: 0, y: 0, width: 15, height: 15, fill: '#ffffff' }, svg);

    // Yards
    L.COLORS.forEach(color => {
      const [bx, by] = BASE_ORIGIN[color];
      svgEl('rect', { x: bx, y: by, width: 6, height: 6, fill: COLOR_HEX[color] }, svg);
      svgEl('rect', { x: bx + 0.8, y: by + 0.8, width: 4.4, height: 4.4, rx: 0.5, fill: '#ffffff' }, svg);
      BASE_SPOTS.forEach(([sx, sy]) => {
        svgEl('circle', { cx: bx + sx, cy: by + sy, r: 0.62, fill: COLOR_SOFT[color], stroke: COLOR_HEX[color], 'stroke-width': 0.06 }, svg);
      });
    });

    // Shared track
    L.TRACK.forEach(([row, col], idx) => {
      const startOf = L.COLORS.find(c => L.START_INDEX[c] === idx);
      cellRect(svg, col, row, startOf ? COLOR_HEX[startOf] : '#ffffff');
      if (L.SAFE_INDEXES.has(idx)) {
        const star = svgEl('text', {
          x: col + 0.5, y: row + 0.56, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': 0.72, fill: startOf ? 'rgba(255,255,255,.9)' : '#a39e94',
        }, svg);
        star.textContent = '★';
      }
    });

    // Home columns
    L.COLORS.forEach(color => {
      L.HOME_COLUMN[color].forEach(([row, col]) => cellRect(svg, col, row, COLOR_HEX[color]));
    });

    // Centre triangles
    const tri = (pts, fill) => svgEl('polygon', { points: pts, fill, stroke: '#ffffff', 'stroke-width': 0.04 }, svg);
    tri('6,6 7.5,7.5 6,9', COLOR_HEX.red);
    tri('6,6 9,6 7.5,7.5', COLOR_HEX.green);
    tri('9,6 9,9 7.5,7.5', COLOR_HEX.yellow);
    tri('6,9 9,9 7.5,7.5', COLOR_HEX.blue);
  }

  // ---------- Game state ----------
  let game = null;
  let gameId = 0;
  let busy = false;
  let movable = [];
  const overrides = {}; // "pi-ti" -> progress shown while animating
  const tokenEls = {};

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const current = () => game.players[game.current];

  function tokenCenter(color, progress, ti) {
    if (progress === -1) {
      const [bx, by] = BASE_ORIGIN[color];
      const [sx, sy] = BASE_SPOTS[ti];
      return [bx + sx, by + sy];
    }
    if (progress === L.HOME) return FINISH_SPOT[color];
    const [row, col] = progress <= L.LAST_TRACK
      ? L.TRACK[L.trackIndex(color, progress)]
      : L.HOME_COLUMN[color][progress - L.LAST_TRACK - 1];
    return [col + 0.5, row + 0.5];
  }

  function createTokens() {
    const layer = $('#tokens');
    layer.innerHTML = '';
    Object.keys(tokenEls).forEach(k => delete tokenEls[k]);
    game.players.forEach((p, pi) => {
      p.tokens.forEach((_, ti) => {
        const el = document.createElement('button');
        el.className = `token ${p.color}`;
        el.setAttribute('aria-label', `${LABEL[p.color]} token ${ti + 1}`);
        el.addEventListener('click', () => onTokenClick(pi, ti));
        layer.appendChild(el);
        tokenEls[`${pi}-${ti}`] = el;
      });
    });
  }

  function layoutTokens() {
    const groups = {};
    game.players.forEach((p, pi) => {
      p.tokens.forEach((pos, ti) => {
        const key = `${pi}-${ti}`;
        const progress = key in overrides ? overrides[key] : pos;
        const [x, y] = tokenCenter(p.color, progress, ti);
        const cell = `${x.toFixed(2)},${y.toFixed(2)}`;
        (groups[cell] = groups[cell] || []).push({ key, x, y });
      });
    });

    Object.values(groups).forEach(list => {
      const n = list.length;
      list.forEach((t, i) => {
        let { x, y } = t;
        if (n > 1) {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 4;
          x += Math.cos(angle) * 0.24;
          y += Math.sin(angle) * 0.24;
        }
        const el = tokenEls[t.key];
        el.style.left = `${(x / 15) * 100}%`;
        el.style.top = `${(y / 15) * 100}%`;
        el.classList.toggle('small', n > 1);
      });
    });
  }

  function setMovable(list) {
    movable = list;
    Object.values(tokenEls).forEach(el => el.classList.remove('movable'));
    list.forEach(ti => tokenEls[`${game.current}-${ti}`].classList.add('movable'));
  }

  // ---------- Panel ----------
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  function showDice(value) {
    const dice = $('#dice');
    if (!value) {
      dice.innerHTML = '<span class="dice-label">ROLL</span>';
      return;
    }
    let html = '';
    for (let i = 0; i < 9; i++) html += PIPS[value].includes(i) ? '<span class="pip"></span>' : '<span></span>';
    dice.innerHTML = html;
    dice.setAttribute('aria-label', `Dice shows ${value}`);
  }

  function setStatus(text) { $('#status').textContent = text; }

  function setDiceEnabled(enabled) {
    const dice = $('#dice');
    dice.disabled = !enabled;
    dice.classList.toggle('ready', enabled);
    if (enabled) dice.setAttribute('aria-label', 'Roll dice');
  }

  function renderPanel() {
    const p = current();
    document.body.style.setProperty('--turn-color', COLOR_HEX[p.color]);
    $('#turnDot').className = `dot ${p.color}`;
    $('#turnName').textContent = p.type === 'cpu' ? `${p.name} (computer)` : p.name;

    const list = $('#playerList');
    list.innerHTML = '';
    game.players.forEach((pl, pi) => {
      const li = document.createElement('li');
      if (pi === game.current) li.className = 'active';
      const home = pl.tokens.filter(t => t === L.HOME).length;
      li.innerHTML = `<span class="dot ${pl.color}"></span>
        <span class="pname"></span>
        <span class="home-count" title="Tokens home">🏠 ${home}/4</span>`;
      li.querySelector('.pname').textContent = pl.name;
      if (pl.type === 'cpu') li.querySelector('.pname').insertAdjacentHTML('beforeend', '<span class="ptype">CPU</span>');
      list.appendChild(li);
    });
  }

  // ---------- Turn flow ----------
  function startGame() {
    gameId++;
    busy = false;
    game = L.createGame(seats.filter(s => s.type !== 'off'));
    Object.keys(overrides).forEach(k => delete overrides[k]);
    $('#setup').classList.add('hidden');
    $('#winModal').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#newGameBtn').classList.remove('hidden');
    drawBoard();
    createTokens();
    layoutTokens();
    startTurn();
  }

  function showSetup() {
    gameId++; // cancels any pending computer moves
    game = null;
    $('#game').classList.add('hidden');
    $('#winModal').classList.add('hidden');
    $('#newGameBtn').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    renderSeats();
  }

  function startTurn(extra) {
    const id = gameId;
    const p = current();
    renderPanel();
    setMovable([]);
    showDice(game.dice && extra ? game.dice : null);

    if (p.type === 'cpu') {
      setDiceEnabled(false);
      setStatus(extra ? `${p.name} rolls again…` : `${p.name} is thinking…`);
      setTimeout(() => { if (id === gameId) rollDice(); }, CPU_ROLL_DELAY);
    } else {
      setDiceEnabled(true);
      if (autoRoll) {
        setStatus(extra ? 'Rolling again…' : 'Your turn — rolling…');
        scheduleAutoRoll();
      } else {
        setStatus(extra ? 'Roll again!' : 'Your turn — roll the dice.');
      }
    }
  }

  // Rolls for the current human player if auto-roll is on and they still need to roll.
  function scheduleAutoRoll() {
    const id = gameId;
    setTimeout(() => {
      if (id !== gameId || !autoRoll || busy || game.phase !== 'roll' || current().type !== 'human') return;
      rollDice();
    }, AUTO_ROLL_DELAY);
  }

  async function rollDice() {
    if (!game || busy || game.phase !== 'roll') return;
    const id = gameId;
    busy = true;
    setDiceEnabled(false);

    const dice = $('#dice');
    dice.classList.add('rolling');
    sfx.roll();
    for (let i = 0; i < 6; i++) {
      showDice(1 + Math.floor(Math.random() * 6));
      await sleep(70);
    }
    dice.classList.remove('rolling');
    if (id !== gameId) return;

    const p = current();
    const result = L.roll(game);
    showDice(result.dice);

    if (result.forfeit) {
      setStatus(`Three 6s in a row — ${p.name} loses the turn.`);
      await sleep(1200);
      return endTurn(id);
    }
    if (!result.movable.length) {
      setStatus(`Rolled ${result.dice}. No moves available.`);
      await sleep(1000);
      return endTurn(id);
    }

    if (p.type === 'cpu') {
      setStatus(`${p.name} rolled ${result.dice}.`);
      await sleep(CPU_MOVE_DELAY);
      if (id !== gameId) return;
      busy = false;
      return doMove(L.chooseMove(game));
    }

    // Human: auto-move when there's no real choice.
    const positions = new Set(result.movable.map(ti => p.tokens[ti]));
    busy = false;
    if (positions.size === 1) {
      setStatus(`Rolled ${result.dice}.`);
      setMovable(result.movable);
      await sleep(350);
      if (id !== gameId) return;
      return doMove(result.movable[0]);
    }
    setStatus(`Rolled ${result.dice} — pick a token to move.`);
    setMovable(result.movable);
  }

  function onTokenClick(pi, ti) {
    if (!game || busy || pi !== game.current || current().type !== 'human') return;
    if (game.phase !== 'move' || !movable.includes(ti)) return;
    doMove(ti);
  }

  async function doMove(ti) {
    if (busy) return;
    const id = gameId;
    busy = true;
    setMovable([]);

    const pi = game.current;
    const p = current();
    const before = game.players.map(pl => pl.tokens.slice());
    const res = L.move(game, ti);
    const key = `${pi}-${ti}`;

    // Keep captured tokens in place until the mover lands on them.
    res.captured.forEach(c => { overrides[`${c.player}-${c.token}`] = before[c.player][c.token]; });

    const el = tokenEls[key];
    el.classList.add('moving');
    for (const step of res.path) {
      overrides[key] = step;
      layoutTokens();
      sfx.step();
      await sleep(STEP_MS);
      if (id !== gameId) return;
    }
    delete overrides[key];
    el.classList.remove('moving');

    if (res.captured.length) {
      sfx.capture();
      res.captured.forEach(c => {
        const k = `${c.player}-${c.token}`;
        tokenEls[k].classList.add('returning');
        delete overrides[k];
      });
      layoutTokens();
      const victims = [...new Set(res.captured.map(c => game.players[c.player].name))].join(' & ');
      setStatus(`${p.name} captured ${victims}!`);
      await sleep(550);
      if (id !== gameId) return;
      res.captured.forEach(c => tokenEls[`${c.player}-${c.token}`].classList.remove('returning'));
    } else {
      layoutTokens();
    }

    if (res.reachedHome) sfx.home();
    renderPanel();

    if (res.won) {
      busy = false;
      return showWinner(pi);
    }
    if (res.extraTurn) {
      await sleep(res.captured.length ? 500 : 250);
      if (id !== gameId) return;
      busy = false;
      return startTurn(true);
    }
    await sleep(200);
    endTurn(id);
  }

  function endTurn(id) {
    if (id !== gameId) return;
    busy = false;
    L.nextTurn(game);
    startTurn(false);
  }

  function showWinner(pi) {
    const p = game.players[pi];
    const humans = game.players.filter(pl => pl.type === 'human').length;
    sfx.win();
    setDiceEnabled(false);
    setStatus(`${p.name} wins!`);
    $('#winTitle').textContent = p.name === 'You' ? 'You win!' : `${p.name} wins!`;
    $('#winText').textContent = p.type === 'cpu'
      ? (humans === 1 ? 'The computer got there first. Try again?' : 'The computer got there first.')
      : 'All four tokens made it home. Well played!';
    $('#winModal').classList.remove('hidden');
    $('#againBtn').focus();
  }

  // ---------- Controls ----------
  $('#dice').addEventListener('click', () => {
    if (game && current().type === 'human') rollDice();
  });
  $('#againBtn').addEventListener('click', startGame);
  $('#setupBtn').addEventListener('click', showSetup);
  $('#newGameBtn').addEventListener('click', () => {
    if (!game || game.phase === 'over' || confirm('Leave this game and start a new one?')) showSetup();
  });

  $('#autoRoll').checked = autoRoll;
  $('#autoRoll').addEventListener('change', e => {
    autoRoll = e.target.checked;
    store.set('ludo.autoRoll', autoRoll);
    e.target.blur(); // keep Space for rolling, not toggling
    if (autoRoll && game && game.phase === 'roll' && current().type === 'human') scheduleAutoRoll();
  });

  function renderSoundBtn() { $('#soundBtn').textContent = muted ? '🔇' : '🔊'; }
  $('#soundBtn').addEventListener('click', () => {
    muted = !muted;
    store.set('ludo.muted', muted);
    renderSoundBtn();
  });

  document.addEventListener('keydown', e => {
    if (!game || e.target.matches('input, select, textarea')) return;
    if (!$('#winModal').classList.contains('hidden')) return;
    if ((e.code === 'Space' || e.key === 'Enter') && !$('#dice').disabled) {
      e.preventDefault();
      rollDice();
    } else if (/^[1-4]$/.test(e.key)) {
      onTokenClick(game.current, Number(e.key) - 1);
    }
  });

  window.addEventListener('resize', () => { if (game) layoutTokens(); });

  renderSoundBtn();
  renderSeats();
})();
