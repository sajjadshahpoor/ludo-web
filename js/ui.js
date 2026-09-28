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

  const REACTIONS = ['👍', '😂', '😮', '😡', '🎉', '👋'];
  const REACTION_COOLDOWN = 1200;

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
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };
  const SAVE_KEY = 'ludo.savedGame';

  // ---------- Sound ----------
  let muted = store.get('ludo.muted', false);
  let autoRoll = store.get('ludo.autoRoll', false);
  let audioCtx = null;
  function tone(freq, duration, type = 'sine', delay = 0, volume = 0.08) {
    if (muted || fast) return;
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
    startGame(seats);
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $('#localPanel').classList.toggle('hidden', name !== 'local');
    $('#onlinePanel').classList.toggle('hidden', name !== 'online');
    document.dispatchEvent(new CustomEvent('ludo:tab', { detail: name }));
  }

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
  let movable = [];
  const overrides = {}; // "pi-ti" -> progress shown while animating
  const tokenEls = {};
  const hintEls = {};     // token index -> its landing marker

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
        ['mouseenter', 'focus'].forEach(ev => el.addEventListener(ev, () => focusHint(pi, ti, true)));
        ['mouseleave', 'blur'].forEach(ev => el.addEventListener(ev, () => focusHint(pi, ti, false)));
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
    renderHints(list);
  }

  // Mark where each movable token would land. Tapping a marker moves that token.
  function renderHints(list) {
    const layer = $('#hints');
    layer.innerHTML = '';
    Object.keys(hintEls).forEach(k => delete hintEls[k]);
    if (!list.length) return;
    const pi = game.current;
    const p = game.players[pi];
    const bySpot = {};
    list.forEach(ti => {
      const from = p.tokens[ti];
      const to = from === -1 ? 0 : from + game.dice;
      const [x, y] = tokenCenter(p.color, to, ti);
      const spot = `${x},${y}`;
      if (bySpot[spot]) { hintEls[ti] = bySpot[spot]; return; } // tokens stacked together share one marker
      const capture = L.capturesAt(game, pi, to).length > 0;
      const el = document.createElement('button');
      el.className = `hint ${p.color}${capture ? ' capture' : ''}${to === L.HOME ? ' home' : ''}`;
      el.style.left = `${(x / 15) * 100}%`;
      el.style.top = `${(y / 15) * 100}%`;
      el.setAttribute('aria-label', `Move token ${ti + 1} here${capture ? ' and capture' : ''}`);
      el.title = capture ? 'Lands here and captures!' : to === L.HOME ? 'Reaches home!' : 'Lands here';
      el.addEventListener('click', () => onTokenClick(pi, ti));
      layer.appendChild(el);
      hintEls[ti] = bySpot[spot] = el;
    });
  }

  function focusHint(pi, ti, on) {
    if (!game || pi !== game.current || !movable.includes(ti) || !hintEls[ti]) return;
    hintEls[ti].classList.toggle('focus', on);
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
    $('#turnName').textContent = p.type === 'cpu' ? `${p.name} (computer)` : net && isMine(p) ? `${p.name} (you)` : p.name;

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
      if (net && isMine(pl)) li.querySelector('.pname').insertAdjacentHTML('beforeend', '<span class="ptype">you</span>');
      if (net && pl.type === 'human' && !net.isOnline(pl.color)) {
        li.classList.add('offline');
        li.title = `${pl.name} is offline`;
      }
      if (pl.type === 'cpu') li.querySelector('.pname').insertAdjacentHTML('beforeend', '<span class="ptype">CPU</span>');
      list.appendChild(li);
    });
  }

  // ---------- Turn flow ----------
  // Every roll and move is an action: { t: 'roll', v } or { t: 'move', k }.
  // On one device act() queues it right away. Online, act() sends it to the room and
  // every device (this one included) applies it when it arrives, so all boards stay in sync.
  let net = null;         // online session from online.js, or null for same-device play
  let queue = [];
  let processing = false;
  let applied = 0;        // actions applied in this game
  let pending = false;    // this device sent an action that hasn't come back yet
  let fast = false;       // replaying history after (re)joining: skip animations and sound
  let extraRoll = false;  // current player is on a bonus roll
  let gameSeats = [];     // seats the current game started with
  let actionLog = [];     // actions applied so far (saved so a local game survives a reload)

  const wait = ms => (fast ? Promise.resolve() : sleep(ms));

  // Does this device control player p? (Online, other people's colors are not ours.)
  function isMine(p) {
    return p.type === 'human' && (!net || net.myColors.has(p.color));
  }
  // Should this device make the decisions for the current player?
  function iDrive() {
    const p = current();
    return p.type === 'cpu' ? (!net || net.isHost) : isMine(p);
  }
  function idle(id) {
    return game && id === gameId && !processing && !queue.length && !pending;
  }

  function act(action) {
    if (pending) return;
    pending = true;
    if (net) net.send(applied, action);
    else enqueue(action);
  }

  function enqueue(action) {
    queue.push(action);
    if (!processing) processQueue();
  }

  async function processQueue() {
    const id = gameId;
    processing = true;
    while (queue.length) {
      const action = queue.shift();
      applied++;
      pending = false;
      // Save before animating, so a reload mid-move still replays this action.
      actionLog.push(action);
      saveGame();
      await applyAction(action);
      if (id !== gameId) return;
      if (game.phase === 'over') saveGame(); // finished games aren't offered for resume
    }
    processing = false;
    decide();
  }

  async function applyAction(a) {
    try {
      if (a.t === 'roll') await applyRoll(a.v);
      else if (a.t === 'move') await applyMove(a.k);
    } catch (e) {
      console.error('Could not apply action', a, e);
    }
  }

  // Local games are saved after every action; online games live in the room instead.
  function saveGame() {
    if (net) return;
    if (!game || game.phase === 'over') store.remove(SAVE_KEY);
    else store.set(SAVE_KEY, { seats: gameSeats, actions: actionLog, savedAt: Date.now() });
  }

  function startGame(list, session, past) {
    gameId++;
    const id = gameId;
    net = session || null;
    gameSeats = list;
    actionLog = past ? past.slice() : [];
    queue = [];
    applied = 0;
    pending = false;
    processing = false;
    extraRoll = false;
    game = L.createGame(list.filter(s => s.type !== 'off'));
    Object.keys(overrides).forEach(k => delete overrides[k]);
    $('#setup').classList.add('hidden');
    $('#winModal').classList.add('hidden');
    $('#game').classList.remove('hidden');
    document.body.classList.add('playing');
    $('#newGameBtn').classList.remove('hidden');
    drawBoard();
    createTokens();
    layoutTokens();
    $('#bubbles').innerHTML = '';
    renderReactionBar();
    showTurn(false);

    if (past && past.length) {
      // Catch up on moves made before we (re)joined.
      processing = true;
      fast = true;
      (async () => {
        for (const a of past) {
          applied++;
          await applyAction(a);
          if (id !== gameId) return;
        }
        fast = false;
        layoutTokens();
        processing = false;
        if (queue.length) processQueue();
        else decide();
      })();
    } else {
      saveGame();
      decide();
    }
  }

  function showSetup() {
    gameId++; // cancels any pending moves
    game = null;
    net = null;
    queue = [];
    $('#game').classList.add('hidden');
    document.body.classList.remove('playing');
    $('#winModal').classList.add('hidden');
    $('#newGameBtn').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    renderSeats();
    renderResume();
  }

  // Offer to continue a local game that was interrupted (reload, closed tab, phone locked).
  function renderResume() {
    const box = $('#resumeBox');
    const saved = store.get(SAVE_KEY, null);
    const valid = saved && Array.isArray(saved.seats) && Array.isArray(saved.actions) && saved.actions.length;
    box.classList.toggle('hidden', !valid);
    if (!valid) return;
    const names = saved.seats.filter(s => s.type !== 'off').map(s => s.name).join(', ');
    const moves = saved.actions.filter(a => a.t === 'move').length;
    const mins = Math.round((Date.now() - (saved.savedAt || Date.now())) / 60000);
    const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
    $('#resumeText').textContent = `${names} · ${moves} move${moves === 1 ? '' : 's'} · ${when}`;
  }

  function showTurn(extra) {
    extraRoll = extra;
    renderPanel();
    setMovable([]);
    setDiceEnabled(false);
    showDice(extra ? game.dice : null);
  }

  // Called whenever no action is being applied: works out what should happen next.
  function decide() {
    if (!game || game.phase === 'over') return;
    const id = gameId;
    const p = current();
    const later = (ms, fn) => setTimeout(() => { if (idle(id)) fn(); }, ms);

    if (game.phase === 'roll') {
      if (p.type === 'cpu') {
        setDiceEnabled(false);
        setStatus(extraRoll ? `${p.name} rolls again…` : `${p.name} is thinking…`);
        if (iDrive()) later(CPU_ROLL_DELAY, () => act({ t: 'roll', v: randomDie() }));
      } else if (isMine(p)) {
        setDiceEnabled(true);
        if (autoRoll) {
          setStatus(extraRoll ? 'Rolling again…' : 'Your turn — rolling…');
          scheduleAutoRoll();
        } else {
          setStatus(extraRoll ? 'Roll again!' : 'Your turn — roll the dice.');
        }
      } else {
        setDiceEnabled(false);
        setStatus(extraRoll ? `${p.name} rolls again…` : `Waiting for ${p.name} to roll…`);
      }
      return;
    }

    // phase === 'move'
    const options = L.movableTokens(game, game.current, game.dice);
    if (p.type === 'cpu') {
      setStatus(`${p.name} rolled ${game.dice}.`);
      if (iDrive()) later(CPU_MOVE_DELAY, () => act({ t: 'move', k: L.chooseMove(game) }));
    } else if (isMine(p)) {
      setMovable(options);
      const positions = new Set(options.map(ti => p.tokens[ti]));
      if (positions.size === 1) {
        // No real choice, so move for the player.
        setStatus(`Rolled ${game.dice}.`);
        later(350, () => act({ t: 'move', k: options[0] }));
      } else {
        setStatus(`Rolled ${game.dice} — pick a token to move.`);
      }
    } else {
      setStatus(`${p.name} rolled ${game.dice} — choosing a token…`);
    }
  }

  function randomDie() { return 1 + Math.floor(Math.random() * 6); }

  // Rolls for this device's player if auto-roll is on and they still need to roll.
  function scheduleAutoRoll() {
    const id = gameId;
    setTimeout(() => {
      if (!autoRoll || !idle(id) || game.phase !== 'roll' || !isMine(current())) return;
      act({ t: 'roll', v: randomDie() });
    }, AUTO_ROLL_DELAY);
  }

  // Player pressed the dice (or Space).
  function rollDice() {
    if (!game || !idle(gameId) || game.phase !== 'roll' || !isMine(current())) return;
    setDiceEnabled(false);
    act({ t: 'roll', v: randomDie() });
  }

  function onTokenClick(pi, ti) {
    if (!game || !idle(gameId) || pi !== game.current || !isMine(current())) return;
    if (game.phase !== 'move' || !movable.includes(ti)) return;
    setMovable([]);
    act({ t: 'move', k: ti });
  }

  async function applyRoll(value) {
    if (game.phase !== 'roll') throw new Error('Out-of-turn roll');
    setDiceEnabled(false);
    setMovable([]);

    if (!fast) {
      const dice = $('#dice');
      dice.classList.add('rolling');
      sfx.roll();
      for (let i = 0; i < 6; i++) {
        showDice(randomDie());
        await sleep(70);
      }
      dice.classList.remove('rolling');
    }

    const p = current();
    const result = L.roll(game, value);
    showDice(result.dice);

    if (result.forfeit) {
      setStatus(`Three 6s in a row — ${p.name} loses the turn.`);
      await wait(1200);
      return nextTurn();
    }
    if (!result.movable.length) {
      setStatus(`${isMine(p) ? 'Rolled' : `${p.name} rolled`} ${result.dice}. No moves available.`);
      await wait(1000);
      return nextTurn();
    }
  }

  async function applyMove(ti) {
    const id = gameId;
    setMovable([]);

    const pi = game.current;
    const p = current();
    const before = game.players.map(pl => pl.tokens.slice());
    const res = L.move(game, ti);
    const key = `${pi}-${ti}`;

    if (!fast) {
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
    }

    if (res.captured.length) {
      if (!fast) {
        sfx.capture();
        res.captured.forEach(c => {
          const k = `${c.player}-${c.token}`;
          tokenEls[k].classList.add('returning');
          delete overrides[k];
        });
      }
      layoutTokens();
      const victims = [...new Set(res.captured.map(c => game.players[c.player].name))].join(' & ');
      setStatus(`${p.name} captured ${victims}!`);
      await wait(550);
      if (id !== gameId) return;
      res.captured.forEach(c => tokenEls[`${c.player}-${c.token}`].classList.remove('returning'));
    } else if (!fast) {
      layoutTokens();
    }

    if (res.reachedHome && !fast) sfx.home();
    renderPanel();

    if (res.won) return showWinner(pi);
    if (res.extraTurn) {
      await wait(res.captured.length ? 500 : 250);
      return showTurn(true);
    }
    await wait(200);
    nextTurn();
  }

  // ---------- Reactions (online) ----------
  let lastReactionAt = 0;
  function renderReactionBar() {
    const bar = $('#reactions');
    bar.classList.toggle('hidden', !net);
    if (!net || bar.childElementCount) return;
    REACTIONS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.setAttribute('aria-label', `Send ${emoji}`);
      btn.addEventListener('click', () => {
        if (!net || Date.now() - lastReactionAt < REACTION_COOLDOWN) return;
        lastReactionAt = Date.now();
        net.react(emoji);
        btn.blur();
      });
      bar.appendChild(btn);
    });
  }

  // Float an emoji up from a player's yard, with their name.
  function showReaction(color, emoji) {
    if (!game || !REACTIONS.includes(emoji)) return;
    const p = game.players.find(pl => pl.color === color);
    if (!p) return;
    const [bx, by] = BASE_ORIGIN[color];
    const el = document.createElement('div');
    el.className = `bubble ${color}`;
    el.style.left = `${((bx + 3) / 15) * 100}%`;
    el.style.top = `${((by + 3) / 15) * 100}%`;
    el.innerHTML = '<span class="bubble-emoji"></span><span class="bubble-name"></span>';
    el.firstChild.textContent = emoji;
    el.lastChild.textContent = net && isMine(p) ? 'You' : p.name;
    $('#bubbles').appendChild(el);
    if (!fast) tone(880, 0.08, 'sine', 0, 0.04);
    setTimeout(() => el.remove(), 2600);
  }

  function nextTurn() {
    L.nextTurn(game);
    showTurn(false);
  }

  function showWinner(pi) {
    const p = game.players[pi];
    const humans = game.players.filter(pl => pl.type === 'human').length;
    const mine = net ? isMine(p) : p.name === 'You';
    if (!fast) sfx.win();
    setDiceEnabled(false);
    setStatus(`${p.name} wins!`);
    $('#winTitle').textContent = mine ? 'You win!' : `${p.name} wins!`;
    let text = p.type === 'cpu'
      ? (humans === 1 ? 'The computer got there first. Try again?' : 'The computer got there first.')
      : 'All four tokens made it home. Well played!';
    if (net && !net.isHost) text += ' Waiting for the host to start another game…';
    $('#winText').textContent = text;
    $('#againBtn').classList.toggle('hidden', !!net && !net.isHost);
    $('#setupBtn').textContent = !net ? 'Change players' : net.isHost ? 'Back to lobby' : 'Leave room';
    $('#winModal').classList.remove('hidden');
    if (!net || net.isHost) $('#againBtn').focus();
  }

  // Online sessions call this if their action was rejected (someone else acted first).
  function clearPending() {
    pending = false;
    if (idle(gameId)) decide();
  }

  window.LudoApp = {
    startGame,
    showSetup,
    enqueue,
    clearPending,
    showReaction,
    refreshPanel() { if (game) renderPanel(); },
    // A player left an online game: the computer takes over their tokens.
    setPlayerType(color, type) {
      const p = game && game.players.find(pl => pl.color === color);
      if (!p || p.type === type) return;
      p.type = type;
      renderPanel();
      if (idle(gameId)) decide();
    },
    get inGame() { return !!game; },
    showTab,
  };

  // ---------- Controls ----------
  $('#dice').addEventListener('click', rollDice);
  $('#againBtn').addEventListener('click', () => {
    if (net) net.playAgain();
    else startGame(seats);
  });
  $('#setupBtn').addEventListener('click', () => {
    if (net) net.leaveGame(); // back to the online lobby (host) or out of the room (guest)
    else showSetup();
  });
  $('#newGameBtn').addEventListener('click', () => {
    if (net) {
      if (confirm('Leave this online game?')) net.leaveRoom();
    } else if (!game || game.phase === 'over') {
      showSetup();
    } else if (confirm('Leave this game? You can resume it later from the setup screen.')) {
      showSetup();
    }
  });

  $('#autoRoll').checked = autoRoll;
  $('#autoRoll').addEventListener('change', e => {
    autoRoll = e.target.checked;
    store.set('ludo.autoRoll', autoRoll);
    e.target.blur(); // keep Space for rolling, not toggling
    if (autoRoll && game && game.phase === 'roll' && isMine(current())) scheduleAutoRoll();
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

  // Nothing on the game screen scrolls, so swallow touch drags and pinches there.
  // This stops the page bouncing, pull-to-refresh and accidental zoom mid-game.
  document.addEventListener('touchmove', e => {
    if (document.body.classList.contains('playing')) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', e => {
    if (document.body.classList.contains('playing')) e.preventDefault();
  });

  $('#resumeBtn').addEventListener('click', () => {
    const saved = store.get(SAVE_KEY, null);
    if (saved) startGame(saved.seats, null, saved.actions);
  });
  $('#discardBtn').addEventListener('click', () => {
    store.remove(SAVE_KEY);
    renderResume();
  });

  renderSoundBtn();
  renderSeats();
  renderResume();
})();
