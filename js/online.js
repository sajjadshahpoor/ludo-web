/*
 * Online play: rooms in Firebase Realtime Database that friends join with a code or link.
 *
 * rooms/{CODE}
 *   host        uid of the player who created the room
 *   status      'lobby' | 'playing' | 'closed'
 *   round       increases every time a new game starts in the room
 *   seats/{color}   { type: 'open' | 'human' | 'cpu' | 'off', uid?, name? }
 *   players/{uid}   { name, online, mic?, reaction?: { e: emoji, at: time }, rtc?: voice setup messages }
 *   actions/{round}/{00000..}   every roll and move, in order: { t: 'roll', v } | { t: 'move', k }
 *
 * Each device replays the same actions through the same engine, so every board stays identical.
 * The player whose turn it is sends the action; the host also sends actions for computer seats.
 */
(function () {
  'use strict';

  const L = window.Ludo;
  const App = window.LudoApp;
  const Voice = window.LudoVoice;
  const $ = sel => document.querySelector(sel);
  const cfg = window.LUDO_FIREBASE_CONFIG;
  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I lookalikes
  const CODE_LEN = 5;
  const JOIN_ORDER = ['yellow', 'green', 'blue', 'red']; // opposite corner first, like a real board
  const LABEL = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };

  const panel = $('#onlinePanel');
  const configured = !!(cfg && cfg.apiKey && cfg.databaseURL);

  let db = null;
  let uid = null;
  let code = null;         // room we're in
  let room = null;         // latest room snapshot
  let roomRef = null;
  let connRef = null;
  let actionsRef = null;
  let session = null;      // game session handed to the UI while playing
  let playingRound = 0;
  let seenReactions = {};  // uid -> timestamp of the last reaction already shown
  let notice = '';         // message shown on the online home screen
  let working = false;

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(5, '0');
  const isHost = () => !!room && room.host === uid;
  const myColors = () => L.COLORS.filter(c => room && room.seats && room.seats[c] && room.seats[c].uid === uid);
  const inviteLink = () => `${location.origin}${location.pathname}?join=${code}`;

  // ---------- Firebase connection ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function connect() {
    if (db) return;
    if (!window.firebase) {
      for (const f of ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-database-compat.js']) {
        await loadScript(SDK + f);
      }
    }
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    const auth = firebase.auth();
    // Wait for a saved sign-in first, so a reload keeps the same identity (and seat).
    let user = await new Promise(resolve => {
      const off = auth.onAuthStateChanged(u => { off(); resolve(u); });
    });
    if (!user) user = (await auth.signInAnonymously()).user;
    uid = user.uid;
    db = firebase.database();
  }

  // ---------- Rooms ----------
  function newCode() {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }

  function playerName() {
    const input = $('#onName');
    const name = (input ? input.value : store.get('ludo.onlineName', '')).trim();
    if (name) store.set('ludo.onlineName', name);
    return name;
  }

  async function createRoom() {
    const name = playerName();
    if (!name) return showError('Enter your name first.', '#onName');
    await withBusy(async () => {
      await connect();
      let c;
      for (let tries = 0; tries < 5; tries++) {
        c = newCode();
        const snap = await db.ref(`rooms/${c}/host`).once('value');
        if (!snap.exists()) break;
      }
      const seats = { red: { type: 'human', uid, name } };
      JOIN_ORDER.filter(col => col !== 'red').forEach(col => { seats[col] = { type: 'open' }; });
      await db.ref(`rooms/${c}`).set({ host: uid, status: 'lobby', round: 0, createdAt: Date.now(), seats });
      enterRoom(c);
    });
  }

  async function joinRoom(rawCode) {
    const c = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== CODE_LEN) return showError(`Room codes have ${CODE_LEN} characters.`, '#joinCode');
    const name = playerName();
    if (!name) return showError('Enter your name to join.', '#onName');
    await withBusy(async () => {
      await connect();
      const snap = await db.ref(`rooms/${c}`).once('value');
      const r = snap.val();
      if (!r || r.status === 'closed') return showError(`There's no open room with code ${c}.`);

      const seats = r.seats || {};
      if (L.COLORS.some(col => seats[col] && seats[col].uid === uid)) return enterRoom(c); // rejoining
      if (r.status !== 'lobby') return showError('That game has already started.');

      for (const col of JOIN_ORDER) {
        if (!seats[col] || seats[col].type !== 'open') continue;
        const res = await db.ref(`rooms/${c}/seats/${col}`).transaction(cur =>
          cur === null || cur.type === 'open' ? { type: 'human', uid, name } : undefined);
        if (res.committed) return enterRoom(c);
      }
      showError('That room is full.');
    });
  }

  function enterRoom(c) {
    code = c;
    notice = '';
    roomRef = db.ref(`rooms/${c}`);
    setUrlCode(c);

    // Presence: mark ourselves offline automatically if the connection drops.
    const me = roomRef.child(`players/${uid}`);
    connRef = db.ref('.info/connected');
    connRef.on('value', snap => {
      if (snap.val() !== true) return;
      me.onDisconnect().update({ online: false });
      me.update({ name: playerName() || 'Player', online: true });
    });

    roomRef.on('value', snap => onRoom(snap.val()));
  }

  function onRoom(r) {
    if (!code) return;
    if (!r || r.status === 'closed') return leaveLocal(isHost() ? '' : 'The host closed the room.');
    room = r;
    const mine = myColors();
    if (!mine.length && r.host !== uid) {
      return leaveLocal(r.status === 'lobby' ? 'The host removed you from the room.' : 'You left the game.');
    }

    if (r.status === 'playing') {
      if (playingRound !== r.round) return startRound(r);
      // Players who left mid-game are taken over by the computer.
      L.COLORS.forEach(c => { if (r.seats[c] && r.seats[c].type === 'cpu') App.setPlayerType(c, 'cpu'); });
      showNewReactions(r);
      syncVoice();
      App.refreshPanel();
      return;
    }

    // Lobby
    if (session) {
      session = null;
      playingRound = 0;
      detachActions();
      if (Voice) Voice.stop();
      App.showSetup();
    }
    App.showTab('online');
    render();
  }

  async function startRound(r) {
    detachActions();
    playingRound = r.round;
    const round = r.round;
    const seats = L.COLORS.map(c => {
      const s = r.seats[c] || { type: 'off' };
      const type = s.type === 'human' || s.type === 'cpu' ? s.type : 'off';
      return { color: c, type, name: type === 'human' ? s.name : LABEL[c] };
    });

    // Only show reactions sent from now on, not ones left over from earlier.
    seenReactions = {};
    reactionsOf(r).forEach(x => { seenReactions[x.uid] = x.at; });

    const ref = roomRef.child(`actions/${round}`);
    const snap = await ref.once('value');
    if (playingRound !== round || !code) return;
    const saved = snap.val() || {};
    const keys = Object.keys(saved).sort();

    session = {
      isHost: r.host === uid,
      myColors: new Set(myColors()),
      send(index, action) {
        ref.child(pad(index)).transaction(cur => (cur === null ? action : undefined), null, false)
          .then(res => { if (!res.committed) App.clearPending(); })
          .catch(err => { console.error(err); App.clearPending(); });
      },
      playAgain() { if (isHost()) roomRef.update({ round: room.round + 1 }); },
      leaveGame() {
        if (isHost()) roomRef.update({ status: 'lobby' });
        else leaveRoom();
      },
      leaveRoom,
      voice: Voice && Voice.supported ? {
        toggleMic: () => Voice.setMic(!Voice.micOn),
        toggleHear: () => Voice.setHear(!Voice.hear),
        unlock: () => Voice.unlock(),
        get micOn() { return Voice.micOn; },
        get hear() { return Voice.hear; },
        get needsTap() { return Voice.needsTap; },
        info: voiceInfo,
      } : null,
      react(emoji) {
        roomRef.child(`players/${uid}/reaction`).set({ e: emoji, at: Date.now() }).catch(err => console.error(err));
      },
      isOnline(color) {
        const seat = room && room.seats[color];
        const p = seat && seat.uid && room.players && room.players[seat.uid];
        return !p || p.online !== false;
      },
    };

    App.startGame(seats, session, keys.map(k => saved[k]));
    syncVoice();

    actionsRef = ref;
    ref.on('child_added', s => {
      if (Number(s.key) < keys.length) return; // already replayed
      App.enqueue(s.val());
    });
  }

  // ---------- Voice ----------
  // Connect voice with every other person playing (not computer seats).
  function syncVoice() {
    if (!Voice || !Voice.supported || !session || !room) return;
    const peers = L.COLORS
      .map(color => ({ color, seat: room.seats[color] }))
      .filter(x => x.seat && x.seat.type === 'human' && x.seat.uid && x.seat.uid !== uid)
      .map(x => ({ uid: x.seat.uid, color: x.color }));
    Voice.sync({ key: code, roomRef, uid, peers, onChange: () => App.refreshPanel() });
  }

  // Mic / talking / connection state for one color, for the player chips.
  function voiceInfo(color) {
    const seat = room && room.seats[color];
    if (!seat || seat.type !== 'human' || !seat.uid) return null;
    if (seat.uid === uid) return { me: true, mic: Voice.micOn, speaking: Voice.selfSpeaking, status: 'connected' };
    const p = room.players && room.players[seat.uid];
    const peer = Voice.peerInfo(seat.uid);
    return {
      me: false,
      mic: !!(p && p.mic && p.online !== false),
      speaking: !!(peer && peer.speaking),
      status: peer ? peer.status : 'connecting',
    };
  }

  function reactionsOf(r) {
    const list = [];
    L.COLORS.forEach(color => {
      const seat = r.seats && r.seats[color];
      const p = seat && seat.uid && r.players && r.players[seat.uid];
      if (p && p.reaction && typeof p.reaction.at === 'number') list.push({ color, uid: seat.uid, ...p.reaction });
    });
    return list;
  }

  function showNewReactions(r) {
    reactionsOf(r).forEach(x => {
      if (x.at <= (seenReactions[x.uid] || 0)) return;
      seenReactions[x.uid] = x.at;
      App.showReaction(x.color, x.e);
    });
  }

  function detachActions() {
    if (actionsRef) actionsRef.off();
    actionsRef = null;
  }

  async function leaveRoom() {
    if (!code) return;
    try {
      if (isHost()) {
        await roomRef.update({ status: 'closed' });
      } else {
        const updates = {};
        myColors().forEach(c => {
          // In the lobby free the seat; mid-game hand our tokens to the computer.
          updates[`seats/${c}`] = room.status === 'playing' ? { type: 'cpu' } : { type: 'open' };
        });
        updates[`players/${uid}/online`] = false;
        await roomRef.update(updates);
      }
    } catch (e) {
      console.error(e);
    }
    leaveLocal('');
  }

  function leaveLocal(message) {
    if (Voice) Voice.stop();
    if (roomRef) roomRef.off();
    if (connRef) connRef.off();
    if (roomRef && uid) roomRef.child(`players/${uid}`).onDisconnect().cancel();
    detachActions();
    roomRef = connRef = null;
    code = room = session = null;
    playingRound = 0;
    notice = message;
    setUrlCode(null);
    if (App.inGame) App.showSetup();
    App.showTab('online');
    render();
  }

  function setUrlCode(c) {
    try {
      const url = new URL(location.href);
      if (c) url.searchParams.set('join', c);
      else url.searchParams.delete('join');
      history.replaceState(null, '', url);
    } catch (e) { /* ignore */ }
  }

  // ---------- Host lobby actions ----------
  function setSeat(color, type) {
    if (!isHost()) return;
    roomRef.child(`seats/${color}`).set({ type });
  }

  function startOnlineGame() {
    const seats = {};
    L.COLORS.forEach(c => {
      const s = room.seats[c] || { type: 'off' };
      seats[c] = s.type === 'open' ? { type: 'off' } : s;
    });
    const active = L.COLORS.filter(c => seats[c].type === 'human' || seats[c].type === 'cpu');
    if (active.length < 2) return showError('Wait for a friend to join, or add a computer player.');
    roomRef.update({ seats, status: 'playing', round: (room.round || 0) + 1 });
  }

  // ---------- Rendering ----------
  function render() {
    if (!configured) {
      panel.innerHTML = `<p class="muted">Online play isn't set up on this site yet.</p>`;
      return;
    }
    if (code && room && room.status === 'lobby') return renderLobby();
    if (!code) return renderHome();
  }

  function renderHome() {
    const params = new URLSearchParams(location.search);
    panel.innerHTML = `
      <p class="muted">Play with friends on their own phones or computers.</p>
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      <label class="field">
        <span>Your name</span>
        <input id="onName" type="text" maxlength="16" autocomplete="nickname" placeholder="e.g. Sajjad">
      </label>
      <button id="createBtn" class="primary">Create a room</button>
      <div class="or"><span>or join a friend's room</span></div>
      <div class="join-row">
        <input id="joinCode" type="text" maxlength="${CODE_LEN}" placeholder="CODE" autocapitalize="characters"
          autocomplete="off" spellcheck="false" aria-label="Room code">
        <button id="joinBtn" class="secondary">Join</button>
      </div>
      <p id="onError" class="error" role="alert"></p>`;
    $('#onName').value = store.get('ludo.onlineName', '');
    $('#joinCode').value = params.get('join') || '';
    $('#createBtn').addEventListener('click', createRoom);
    $('#joinBtn').addEventListener('click', () => joinRoom($('#joinCode').value));
    $('#joinCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
    $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(e.target.value); });
    setWorking(working);
  }

  function seatRow(color) {
    const s = room.seats[color] || { type: 'off' };
    const host = isHost();
    const me = s.uid === uid;
    let label;
    if (s.type === 'human') {
      const online = !room.players || !room.players[s.uid] || room.players[s.uid].online !== false;
      label = `${esc(s.name)}${me ? ' <span class="tag">you</span>' : ''}${s.uid === room.host ? ' <span class="tag">host</span>' : ''}${online ? '' : ' <span class="tag off">offline</span>'}`;
    } else if (s.type === 'open') {
      label = '<span class="muted">Waiting for a friend…</span>';
    } else if (s.type === 'cpu') {
      label = 'Computer';
    } else {
      label = '<span class="muted">Empty</span>';
    }

    let control = '';
    if (host && !me) {
      const opts = [];
      if (s.type === 'human') opts.push(`<option value="keep" selected>${esc(s.name)}</option>`);
      opts.push(`<option value="open"${s.type === 'open' ? ' selected' : ''}>${s.type === 'human' ? 'Remove' : 'Friend'}</option>`);
      opts.push(`<option value="cpu"${s.type === 'cpu' ? ' selected' : ''}>Computer</option>`);
      opts.push(`<option value="off"${s.type === 'off' ? ' selected' : ''}>Off</option>`);
      control = `<select data-color="${color}" aria-label="${LABEL[color]} seat">${opts.join('')}</select>`;
    }
    return `<div class="seat online-seat${s.type === 'off' ? ' off' : ''}">
      <span class="dot ${color}"></span><span class="seat-name">${label}</span>${control}</div>`;
  }

  function renderLobby() {
    const host = isHost();
    const humans = L.COLORS.filter(c => room.seats[c] && room.seats[c].type === 'human').length;
    panel.innerHTML = `
      <div class="room-code">
        <span class="muted">Room code</span>
        <strong id="roomCode">${code}</strong>
      </div>
      <div class="share-row">
        <button id="shareBtn" class="secondary">Share invite</button>
        <button id="copyBtn" class="secondary">Copy link</button>
      </div>
      <p class="muted small">Friends open the link, or tap <b>Online with friends</b> and type the code.</p>
      <div class="seats">${L.COLORS.map(seatRow).join('')}</div>
      <p id="onError" class="error" role="alert"></p>
      ${host
        ? `<button id="startOnline" class="primary">Start game${humans > 1 ? ` with ${humans} players` : ''}</button>`
        : `<p class="waiting">Waiting for the host to start the game…</p>`}
      <button id="leaveBtn" class="link-btn">Leave room</button>`;

    $('#shareBtn').addEventListener('click', share);
    $('#copyBtn').addEventListener('click', () => copyLink($('#copyBtn')));
    $('#leaveBtn').addEventListener('click', () => {
      if (!host || confirm('Close this room for everyone?')) leaveRoom();
    });
    panel.querySelectorAll('select[data-color]').forEach(sel => {
      sel.addEventListener('change', () => { if (sel.value !== 'keep') setSeat(sel.dataset.color, sel.value); });
    });
    if (host) $('#startOnline').addEventListener('click', startOnlineGame);
  }

  async function share() {
    const data = { title: 'Ludo', text: `Join my Ludo game! Room code: ${code}`, url: inviteLink() };
    if (navigator.share) {
      try { await navigator.share(data); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    copyLink($('#shareBtn'));
  }

  async function copyLink(btn) {
    const link = inviteLink();
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch (e) { /* fall back below */ }
    if (!ok) {
      window.prompt('Copy this link and send it to your friends:', link);
      return;
    }
    const text = btn.textContent;
    btn.textContent = 'Link copied!';
    setTimeout(() => { btn.textContent = text; }, 1500);
  }

  function showError(message, focusSel) {
    const el = $('#onError');
    if (el) el.textContent = message;
    if (focusSel && $(focusSel)) $(focusSel).focus();
  }

  function setWorking(on) {
    working = on;
    ['#createBtn', '#joinBtn'].forEach(sel => { if ($(sel)) $(sel).disabled = on; });
  }

  async function withBusy(fn) {
    if (working) return;
    setWorking(true);
    showError('');
    try {
      await fn();
    } catch (e) {
      console.error(e);
      showError(/permission/i.test(e.message)
        ? 'The server refused that request. Try again, or create a new room.'
        : 'Could not reach the game server. Check your connection and try again.');
    } finally {
      setWorking(false);
    }
  }

  // ---------- Start-up ----------
  document.addEventListener('ludo:tab', e => { if (e.detail === 'online') render(); });

  const joinParam = new URLSearchParams(location.search).get('join');
  if (!configured) {
    document.querySelector('.tab[data-tab="online"]').title = 'Online play is not set up yet';
  } else if (joinParam) {
    App.showTab('online');
    if (store.get('ludo.onlineName', '')) joinRoom(joinParam);
    else showError('Enter your name, then tap Join.', '#onName');
  }
})();
