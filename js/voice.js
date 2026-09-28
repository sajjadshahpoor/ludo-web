/*
 * Voice chat for online games: audio goes directly between players' browsers (WebRTC),
 * with Firebase only carrying the few setup messages needed to connect them.
 *
 * Every pair of players shares one connection (at most 3 per player). Each connection
 * starts with an audio slot, so turning the mic on or off just swaps the track in that
 * slot — no reconnecting. Setup messages go to rooms/{CODE}/players/{from}/rtc/{to},
 * which each player can already write under the existing database rules.
 *
 * Of each pair, the player with the smaller uid places the call; the other answers.
 */
(function () {
  'use strict';

  const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
  const SPEAK_LEVEL = 0.035;   // RMS above this counts as talking
  const SPEAK_HOLD = 450;      // keep the "talking" glow briefly after the voice drops
  const MAX_RETRIES = 3;

  const supported = !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  let ctx = null;              // { key, roomRef, uid, onChange, peers: Map(uid -> peer) }
  let micStream = null;
  let micOn = false;
  let hear = true;
  let needsTap = false;        // browser blocked audio playback until the next tap
  let audioCtx = null;
  let self = { speaking: false, meter: null };
  let meterTimer = null;

  const changed = () => { if (ctx && ctx.onChange) ctx.onChange(); };
  const newSid = () => Math.random().toString(36).slice(2, 10);
  const outbox = to => ctx.roomRef.child(`players/${ctx.uid}/rtc/${to}`);

  // ---------- Peers ----------

  // Start voice for this game, or update who is in it (someone left, someone rejoined).
  function sync({ key, roomRef, uid, peers, onChange }) {
    if (!supported) return;
    if (ctx && (ctx.key !== key || ctx.uid !== uid)) stop();
    if (!ctx) {
      ctx = { key, roomRef, uid, onChange, peers: new Map(), inst: newSid() };
      startMeters();
    }
    ctx.onChange = onChange;
    const wanted = new Set(peers.map(p => p.uid));
    ctx.peers.forEach((peer, id) => { if (!wanted.has(id)) removePeer(peer); });
    peers.forEach(p => { if (!ctx.peers.has(p.uid)) addPeer(p); });
  }

  function addPeer({ uid: id, color }) {
    const peer = {
      uid: id, color, pc: null, sid: null, status: 'connecting', speaking: false,
      audio: null, meter: null, pending: [], retries: 0, startedAt: 0,
      caller: ctx.uid < id,
      helloFrom: null,          // session id of the other side we last called back
    };
    ctx.peers.set(id, peer);
    peer.inbox = ctx.roomRef.child(`players/${id}/rtc/${ctx.uid}`);
    // Clear what we sent in earlier sessions, then either call or say hello so the caller calls us.
    outbox(id).remove().catch(() => {}).then(() => {
      if (!ctx || ctx.peers.get(id) !== peer) return;
      peer.inbox.on('child_added', s => onSignal(peer, s.val()));
      if (peer.caller) call(peer);
      else send(peer, { type: 'hello', inst: ctx.inst });
    });
  }

  function removePeer(peer) {
    if (peer.inbox) peer.inbox.off();
    closePc(peer);
    if (peer.audio) peer.audio.remove();
    ctx.peers.delete(peer.uid);
    changed();
  }

  function closePc(peer) {
    if (peer.pc) {
      peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
      try { peer.pc.close(); } catch (e) { /* already closed */ }
    }
    peer.pc = null;
    peer.pending = [];
  }

  function newPc(peer) {
    closePc(peer);
    const pc = new RTCPeerConnection(ICE);
    peer.pc = pc;
    peer.status = 'connecting';
    peer.startedAt = Date.now();
    pc.onicecandidate = e => { if (e.candidate) send(peer, { type: 'cand', sid: peer.sid, c: e.candidate.toJSON() }); };
    pc.ontrack = e => attachAudio(peer, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (peer.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') { peer.status = 'connected'; peer.retries = 0; }
      else if (s === 'failed') {
        peer.status = 'failed';
        if (peer.caller && peer.retries < MAX_RETRIES) {
          peer.retries++;
          setTimeout(() => { if (ctx && ctx.peers.get(peer.uid) === peer) call(peer); }, 2000);
        }
      } else if (s === 'disconnected') peer.status = 'connecting';
      changed();
    };
    return pc;
  }

  async function call(peer) {
    peer.sid = newSid();
    const pc = newPc(peer);
    const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (micStream) await tr.sender.replaceTrack(micStream.getAudioTracks()[0]);
    await pc.setLocalDescription(await pc.createOffer());
    send(peer, { type: 'offer', sid: peer.sid, sdp: pc.localDescription.sdp });
    changed();
  }

  async function onSignal(peer, m) {
    if (!ctx || !m || ctx.peers.get(peer.uid) !== peer) return;
    try {
      if (m.type === 'hello') {
        // The other side (re)joined with a new session: call it.
        if (!peer.caller || m.inst === peer.helloFrom) return;
        peer.helloFrom = m.inst;
        return call(peer);
      }
      if (m.type === 'offer' && !peer.caller) {
        if (peer.sid !== m.sid) { peer.sid = m.sid; newPc(peer); }
        const pc = peer.pc;
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const tr = pc.getTransceivers()[0];
        if (tr) {
          tr.direction = 'sendrecv';
          if (micStream) await tr.sender.replaceTrack(micStream.getAudioTracks()[0]);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        send(peer, { type: 'answer', sid: peer.sid, sdp: pc.localDescription.sdp });
        return flush(peer);
      }
      if (m.type === 'answer' && peer.caller) {
        if (m.sid !== peer.sid || !peer.pc || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        return flush(peer);
      }
      if (m.type === 'cand') {
        if (m.sid !== peer.sid || !peer.pc) return;
        if (!peer.pc.remoteDescription) peer.pending.push(m.c);
        else await peer.pc.addIceCandidate(m.c);
      }
    } catch (e) {
      console.warn('Voice setup message failed', m.type, e);
    }
  }

  async function flush(peer) {
    const list = peer.pending;
    peer.pending = [];
    for (const c of list) {
      try { await peer.pc.addIceCandidate(c); } catch (e) { /* stale candidate */ }
    }
  }

  function send(peer, msg) {
    if (!ctx) return;
    outbox(peer.uid).push(msg).catch(e => console.warn('Voice signal not sent', e));
  }

  // ---------- Audio out ----------
  function attachAudio(peer, stream) {
    if (!peer.audio) {
      peer.audio = document.createElement('audio');
      peer.audio.autoplay = true;
      peer.audio.setAttribute('playsinline', '');
      audioBox().appendChild(peer.audio);
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = !hear;
    playAudio(peer.audio);
    peer.meter = makeMeter(stream);
    changed();
  }

  function audioBox() {
    let box = document.getElementById('voiceAudio');
    if (!box) {
      box = document.createElement('div');
      box.id = 'voiceAudio';
      box.hidden = true;
      document.body.appendChild(box);
    }
    return box;
  }

  function playAudio(el) {
    const p = el.play();
    if (p && p.catch) {
      p.catch(() => {
        if (!needsTap) { needsTap = true; changed(); }
      });
    }
  }

  // Browsers may block sound until the player taps something; call this from a tap.
  function unlock() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (ctx) ctx.peers.forEach(peer => { if (peer.audio) playAudio(peer.audio); });
    if (needsTap) { needsTap = false; changed(); }
  }

  function setHear(on) {
    hear = on;
    if (ctx) ctx.peers.forEach(peer => { if (peer.audio) peer.audio.muted = !on; });
    unlock();
    changed();
  }

  // ---------- Microphone ----------
  async function setMic(on) {
    if (!ctx) return;
    if (on && !micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = micStream.getAudioTracks()[0];
      ctx.peers.forEach(peer => {
        const tr = peer.pc && peer.pc.getTransceivers()[0];
        if (tr && tr.sender) tr.sender.replaceTrack(track).catch(() => {});
      });
      self.meter = makeMeter(micStream);
    }
    if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = on; });
    micOn = on;
    ctx.roomRef.child(`players/${ctx.uid}/mic`).set(on).catch(() => {});
    unlock();
    changed();
  }

  // ---------- Talking indicator ----------
  function makeMeter(stream) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      return { analyser, data: new Float32Array(analyser.fftSize), lastLoud: 0 };
    } catch (e) {
      return null;
    }
  }

  function isLoud(meter) {
    if (!meter) return false;
    meter.analyser.getFloatTimeDomainData(meter.data);
    let sum = 0;
    for (let i = 0; i < meter.data.length; i++) sum += meter.data[i] * meter.data[i];
    const now = Date.now();
    if (Math.sqrt(sum / meter.data.length) > SPEAK_LEVEL) meter.lastLoud = now;
    return now - meter.lastLoud < SPEAK_HOLD;
  }

  function startMeters() {
    clearInterval(meterTimer);
    meterTimer = setInterval(() => {
      if (!ctx) return;
      let dirty = false;
      const me = micOn && isLoud(self.meter);
      if (me !== self.speaking) { self.speaking = me; dirty = true; }
      ctx.peers.forEach(peer => {
        const s = hear && peer.status === 'connected' && isLoud(peer.meter);
        if (s !== peer.speaking) { peer.speaking = s; dirty = true; }
      });
      if (dirty) changed();
    }, 150);
  }

  // ---------- Leaving ----------
  function stop() {
    if (!ctx) return;
    const old = ctx;
    old.peers.forEach(peer => removePeer(peer));
    old.roomRef.child(`players/${old.uid}/rtc`).remove().catch(() => {});
    if (micOn) old.roomRef.child(`players/${old.uid}/mic`).set(false).catch(() => {});
    ctx = null;
    clearInterval(meterTimer);
    if (micStream) micStream.getTracks().forEach(t => t.stop()); // turns off the browser's mic indicator
    micStream = null;
    micOn = false;
    self = { speaking: false, meter: null };
    needsTap = false;
  }

  function peerInfo(id) {
    const peer = ctx && ctx.peers.get(id);
    return peer ? { status: peer.status, speaking: peer.speaking } : null;
  }

  window.LudoVoice = {
    supported,
    sync,
    stop,
    setMic,
    setHear,
    unlock,
    peerInfo,
    get active() { return !!ctx; },
    get micOn() { return micOn; },
    get hear() { return hear; },
    get needsTap() { return needsTap; },
    get selfSpeaking() { return self.speaking; },
  };
})();
