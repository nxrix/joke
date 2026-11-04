// room.js — nostr transport, lobby (create/join/seats/spectators/kick/bots), chat, deck plumbing,
// and everything needed to RECONNECT in the middle of a game.
//
// How reconnecting works (no server, so everything is rebuilt from the relays + this browser):
//   * your identity is the secret key in localStorage, so a reload is the same player/seat/spectator.
//   * the host's lobby (seats, names, spectators, score summary) is saved in localStorage too.
//   * every game message you send is kept in a small local outbox AND is re-published until a relay
//     confirms it, so nothing is lost if a relay drops it or you go offline for a bit.
//   * the secrets of the current hand (deck key, shuffle seed, commit-reveal values) are saved BEFORE
//     they are used, so after a reload the deck code can re-derive its own messages.
//   * on reload the relays replay the room history; hokm.js re-runs the current hand from that log.
import * as nxstr from "https://cdn.jsdelivr.net/gh/nxrix/nxstr@1.0.2/index.js";
import { Table } from "./deck.js?v=12";

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const KIND = 4242;
const HISTORY = 12 * 3600;                 // how far back we ask the relays to replay
const MAX_SPECTATORS = 40;
const LOBBY_ONLY_CORE = ["hi", "join", "leave", "sit", "stand", "state"];
const esc = s => String(s).replace(/[&<>"']/g, c => "&#" + c.charCodeAt() + ";");
const rid = () => Math.random().toString(36).slice(2, 8);

// `?u=2` gives a separate identity, so you can test with two tabs of the SAME browser.
const U = new URLSearchParams(location.search).get("u") || "";
const ls = {
  get: k => { try { return localStorage.getItem(k + U); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k + U, v); } catch {} },
  del: k => { try { localStorage.removeItem(k + U); } catch {} },
};
const lsRaw = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: k => { try { localStorage.removeItem(k); } catch {} },
  keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
};

export class Room {
  constructor({ seatCount, lobbyEl, logEl, chatInput, onStart, onLobby, onModeChange, onNet }) {
    Object.assign(this, { seatCount, lobbyEl, logEl, onStart, onLobby, onModeChange, onNet });

    nxstr.generateKeys(ls.get("sk") || undefined);
    this.secretKey = nxstr.getSecretKey();
    this.me = nxstr.getPublicKey();
    ls.set("sk", this.secretKey);
    this.me8 = this.me.slice(0, 8);
    this.name = ls.get("nm") || "";
    this.draftName = null;

    this.id = new URLSearchParams(location.search).get("room") || "";
    this.hostId = this.id ? this.id.split("-")[0].toLowerCase() : "";

    this._reset();

    chatInput.form.addEventListener("submit", e => {
      e.preventDefault();
      const text = chatInput.value.trim().slice(0, 300);
      if (!text || !this.id || !this.inRoom) return;
      chatInput.value = "";
      this.chat(this.me, text);
      this._publish({ k: "chat", t: text }, { retry: true });
    });
    lobbyEl.addEventListener("click", e => {
      const b = e.target.closest("[data-act]");
      if (b) this._act(b.dataset.act, Number(b.dataset.i));
    });
    lobbyEl.addEventListener("input", e => { if (e.target.matches("input")) this.draftName = e.target.value; });
    lobbyEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.matches("input")) {
        const b = lobbyEl.querySelector("[data-act=create],[data-act=join]");
        if (b) b.click();
      }
    });
    addEventListener("online", () => { this._connect(); this._flush(); });
    addEventListener("visibilitychange", () => { if (!document.hidden) { this._connect(); this._flush(); } });

    setInterval(() => this._tick(), 3000);

    if (this.id) {
      this._loadOutbox();
      if (this.isHost) {
        this._restoreHostLobby();
        this._connect();
        setTimeout(() => this._broadcast(), 500);
        // host reloaded in the middle of a game → pick the game back up
        if (this.lobby.status === "playing") setTimeout(() => this._begin(true), 0);
      } else {
        this._connect();
        this._startHiLoop();
        // we were in this room before (reload) → rejoin automatically once the host answers
        this.autoJoin = !!this.name && ls.get("lastRoom") === this.id;
      }
    }
    this.renderLobby();
  }

  _reset() {
    this.lobby = { seats: Array(this.seatCount).fill(null), names: {}, spectators: [], banned: [], status: "lobby",
      gameId: null, version: 0, seatCount: this.seatCount, game: null };
    this.sockets = {};
    this.gen = (this.gen || 0) + 1;           // lets old socket callbacks know they are stale
    this.seen = new Set();
    this.sentIds = new Set();
    this.outbox = new Map();
    this.tables = {};
    this.deckLog = {};
    this.gameMsgs = [];
    this.gameMsgKeys = new Set();
    this.waiters = [];
    this.over = null;
    this.swapSel = null;
    this.startedGame = null;
    this.sawLobby = false;
    this.gotState = false;
    this.eose = false;
    this.menuOpen = false;
    this.pendingChat = [];
    this.nameError = "";
    this._q = Promise.resolve();
    this._qn = 0;
    this._hiTimer = null;
    this._joinTimer = null;
    this._lastHiReply = 0;
    this._obSave = null;
    this.autoJoin = false;
    this.connectedAt = Date.now();
  }

  get isHost() { return !!this.id && this.hostId === this.me; }
  get seats() { return this.lobby.seats; }
  get gameId() { return this.lobby.gameId; }
  get mySeat() { return this.lobby.seats.indexOf(this.me); }
  get isSpectator() { return this.lobby.spectators.includes(this.me); }
  get inRoom() { return !!this.lobby.names[this.me]; }
  isBot(id) { return !!id && String(id).startsWith("bot"); }
  nameOf(id) { return esc(this.rawName(id)); }
  rawName(id) { return this.lobby.names[id] || String(id).slice(0, 6); }
  _live() { const L = this.lobby; return L.status === "playing" && this.inRoom && !!this.startedGame && !this.over; }
  _net() { if (this.onNet) this.onNet(this.online, this._live()); }
  setGameInfo(info) { if (this.isHost) { this.lobby.game = info; this._broadcast(); } }

  log(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    this._push(d);
  }
  chat(id, text) {
    const d = document.createElement("div"), n = document.createElement("span"), t = document.createElement("span");
    d.className = "msg"; n.className = "n"; t.className = "t";
    n.textContent = this.rawName(id); t.textContent = text;
    d.append(n, t);
    this._push(d);
  }
  _push(el) { this.logEl.appendChild(el); this.logEl.scrollTop = this.logEl.scrollHeight; }

  /* ---------- host lobby persistence (survives reload) ---------- */
  _ensureHostSeat() {
    if (!this.isHost) return;
    const L = this.lobby;
    L.spectators = L.spectators.filter(x => x !== this.me);
    if (!L.seats.includes(this.me)) {
      const free = L.seats.indexOf(null);
      if (free >= 0) L.seats[free] = this.me;
      else L.seats[0] = this.me;              // (only possible with a corrupt snapshot)
    }
    L.names[this.me] = this.name || L.names[this.me] || "Host";
  }
  _saveHostLobby() {
    if (!this.isHost) return;
    try { ls.set("lobbySnap", JSON.stringify({ id: this.id, lobby: this.lobby })); } catch {}
  }
  _restoreHostLobby() {
    try {
      const snap = JSON.parse(ls.get("lobbySnap") || "null");
      if (snap && snap.id === this.id && snap.lobby) {
        const S = snap.lobby, n = S.seatCount || this.seatCount;
        this.seatCount = n;
        const seats = Array.isArray(S.seats) ? S.seats.slice(0, n) : [];
        while (seats.length < n) seats.push(null);
        Object.assign(this.lobby, {
          seats, seatCount: n, names: { ...(S.names || {}) }, spectators: (S.spectators || []).slice(),
          banned: (S.banned || []).slice(), status: S.status || "lobby", gameId: S.gameId ?? null,
          version: S.version || 0, game: S.game || null,
        });
        const u = new URL(location.href);
        if (n === 2) u.searchParams.set("p", "2"); else u.searchParams.delete("p");
        history.replaceState(null, "", u);
        if (this.onModeChange) this.onModeChange(n);
      } else {
        this.lobby.names[this.me] = this.name || "Host";
      }
    } catch {}
    this._ensureHostSeat();
  }

  /* ---------- local outbox (my own game messages, kept across reloads) ---------- */
  get _obKey() { return "ob|" + this.id + "|" + this.me8; }
  _loadOutbox() {
    let list = [];
    try { list = JSON.parse(lsRaw.get(this._obKey) || "[]"); } catch {}
    for (const ev of list) {
      let p; try { p = JSON.parse(ev.content); } catch { continue; }
      this.seen.add(ev.id); this.sentIds.add(ev.id);
      this.outbox.set(ev.id, { ev, acked: false, t0: Date.now(), persist: true, retry: true });
      this._ingestOwn(p);
    }
  }
  _ingestOwn(p) {
    const from = p.as || this.me;
    if (p.k === "deck") this._handle(from, p, true);
    else if (!LOBBY_ONLY_CORE.includes(p.k) && p.k !== "chat") this._handle(from, p, true);
  }
  _saveOutbox() {
    if (this._obSave) return;
    this._obSave = setTimeout(() => {
      this._obSave = null;
      if (!this.id) return;
      const list = [...this.outbox.values()].filter(o => o.persist).map(o => o.ev);
      if (!lsRaw.set(this._obKey, JSON.stringify(list))) {            // quota → drop oldest half
        lsRaw.set(this._obKey, JSON.stringify(list.slice(Math.floor(list.length / 2))));
      }
    }, 400);
  }
  _purgeHandData(keepHandId) {
    // forget secrets / messages of FINISHED hands (and of other games) – keeps localStorage small.
    // Hand ids look like "<gameId>.<n>"; hands that haven't started yet are kept (peers can be ahead of us).
    const [kg, kn] = keepHandId.split("."), older = id => { const [g, n] = String(id).split("."); return g !== kg || +n < +kn; };
    for (const k of lsRaw.keys()) {
      if (k.startsWith("sec|")) {
        const [, hid, , me8] = k.split("|");
        if (me8 === this.me8 && older(hid)) lsRaw.del(k);
      }
    }
    for (const [id, o] of this.outbox) {
      if (!o.persist) continue;
      let p; try { p = JSON.parse(o.ev.content); } catch { continue; }
      const g = p.k === "deck" ? p.m?.g : p.g;
      if (g === undefined || older(g)) this.outbox.delete(id);
    }
    for (const g of Object.keys(this.deckLog)) if (older(g)) delete this.deckLog[g];
    this.gameMsgs = this.gameMsgs.filter(m => !older(m.p.g));
    this.gameMsgKeys = new Set(this.gameMsgs.map(m => m.key));
    this._saveOutbox();
  }
  _loadSecrets(handId, tableId) {
    try { return JSON.parse(lsRaw.get(`sec|${handId}|${tableId}|${this.me8}`) || "{}"); } catch { return {}; }
  }
  _saveSecrets(handId, tableId, sec) { lsRaw.set(`sec|${handId}|${tableId}|${this.me8}`, JSON.stringify(sec)); }
  _wipeStorage() {
    for (const k of lsRaw.keys()) if ((k.startsWith("sec|") || k.startsWith("ob|")) && k.endsWith("|" + this.me8) || k.startsWith("ob|" + this.id)) lsRaw.del(k);
  }

  /* ---------- sending ---------- */
  async _publish(payload, { retry = false, persist = false } = {}) {
    if (!this.id) return;
    const event = await nxstr.sign({
      kind: KIND, created_at: Math.floor(Date.now() / 1000), pubkey: this.me,
      tags: [["r", this.id]], content: JSON.stringify(payload),
    }, this.secretKey);
    this.sentIds.add(event.id); this.seen.add(event.id);
    if (retry || persist) {
      this.outbox.set(event.id, { ev: event, acked: false, t0: Date.now(), persist, retry: true });
      if (persist) this._saveOutbox();
    }
    this._sendRaw(JSON.stringify(["EVENT", event]));
    return event;
  }
  _sendRaw(text) { for (const ws of Object.values(this.sockets)) if (ws && ws.readyState === 1) ws.send(text); }
  get online() { return Object.values(this.sockets).some(ws => ws && ws.readyState === 1); }

  // re-send everything a relay hasn't confirmed yet (relays drop things, wifi drops out…)
  _flush() {
    const now = Date.now();
    for (const [id, o] of this.outbox) {
      if (o.acked) continue;
      if (now - o.t0 > 15 * 60e3 && !o.persist) { this.outbox.delete(id); continue; }
      this._sendRaw(JSON.stringify(["EVENT", o.ev]));
    }
  }
  _tick() {
    if (!this.id) return;
    this._connect();
    this._flush();
    if (this.isHost && Date.now() - (this._lastBroadcast || 0) > 12000) this._broadcast();   // heartbeat
    this._net();
    if (!this.gotState && !this.isHost) this.renderLobby();        // refresh the "connecting…" text
  }

  // Game messages (trump / discard / keep…) — stored locally at once, published reliably.
  send(payload, as) {
    if (as) payload.as = as;
    this._publish(payload, { persist: true });
    this._store(as || this.me, payload);
  }

  find(pred) { return this.gameMsgs.find(m => pred(m.from, m.p)); }
  waitFor(pred) {
    const hit = this.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise(resolve => this.waiters.push({ pred, resolve }));
  }
  _store(from, p) {
    const key = from + "|" + JSON.stringify(p);
    if (this.gameMsgKeys.has(key)) return;
    this.gameMsgKeys.add(key);
    const m = { from, p, key };
    this.gameMsgs.push(m);
    this.waiters = this.waiters.filter(w => (w.pred(from, p) ? (w.resolve(m), false) : true));
  }

  // resolves when the relays have replayed the room history and every received event was handled
  settled(ms = 5000) {
    return new Promise(res => {
      const t0 = Date.now();
      const chk = () => ((this.eose && this._qn === 0) || Date.now() - t0 > ms ? res() : setTimeout(chk, 60));
      chk();
    });
  }

  /* ---------- deck plumbing ---------- */
  createTables(handId, { onOpen, onCheat }) {
    this._purgeHandData(handId);
    this.tables = {};
    const seats = this.seats.slice();
    const mk = (id, observer) => new Table({
      id: handId, players: seats, me: observer ? null : id, send: observer ? null : this._deckSender(id),
      onOpen: id === this.me ? onOpen : null, onCheat,
      secrets: observer ? {} : this._loadSecrets(handId, id), onSecret: observer ? null : sec => this._saveSecrets(handId, id, sec),
    });
    for (const id of seats) {
      if (id === this.me || (this.isHost && this.isBot(id))) this.tables[id] = mk(id, false);
    }
    if (!seats.includes(this.me)) this.tables[this.me] = mk(this.me, true);     // spectator: observer table
    for (const [from, msg] of this.deckLog[handId] || []) Object.values(this.tables).forEach(t => t.receive(from, msg, true));
    return this.tables;
  }
  _deckSender(playerId) {
    return msg => {
      (this.deckLog[msg.g] ??= []).push([playerId, msg]);
      this._publish({ k: "deck", m: msg, as: playerId === this.me ? undefined : playerId }, { persist: true });
      for (const t of Object.values(this.tables)) if (t.me !== playerId) t.receive(playerId, msg);
    };
  }

  /* ---------- nostr ---------- */
  _connect() {
    if (!this.id) return;
    const gen = this.gen;
    for (const url of RELAYS) {
      const cur = this.sockets[url];
      if (cur && (cur.readyState === 0 || cur.readyState === 1)) continue;
      let ws;
      try { ws = this.sockets[url] = new WebSocket(url); } catch { continue; }
      ws.onopen = () => {
        if (gen !== this.gen) return ws.close();
        ws.send(JSON.stringify(["REQ", "sub", { kinds: [KIND], "#r": [this.id], since: Math.floor(Date.now() / 1000) - HISTORY }]));
        this._flush();
        this._net();
      };
      ws.onmessage = m => {
        try {
          const a = JSON.parse(m.data);
          if (a[0] === "EVENT") this._enqueue(a[2]);
          else if (a[0] === "EOSE") this.eose = true;
          else if (a[0] === "OK" && a[2]) { const o = this.outbox.get(a[1]); if (o) o.acked = true; }
        } catch {}
      };
      ws.onclose = () => { if (gen === this.gen) { this._net(); setTimeout(() => this._connect(), 2000 + Math.random() * 1500); } };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
  }
  _closeSockets() {
    this.gen++;
    for (const ws of Object.values(this.sockets)) try { ws.close(); } catch {}
    this.sockets = {};
  }

  // Events are handled strictly one after another, in arrival order (signature checks are async,
  // so without this queue two events could overtake each other).
  _enqueue(ev) {
    this._qn++;
    this._q = this._q.then(() => this._process(ev)).catch(e => console.error(e)).then(() => { this._qn--; });
  }
  async _process(ev) {
    if (!ev || typeof ev.id !== "string" || !Array.isArray(ev.tags)) return;
    const ob = this.outbox.get(ev.id); if (ob) ob.acked = true;           // a relay echoed it → delivered
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (ev.kind !== KIND || !ev.tags.some(t => t[0] === "r" && t[1] === this.id)) return;
    let ok = false; try { ok = await nxstr.verify(ev); } catch {}
    if (!ok) return;
    let p; try { p = JSON.parse(ev.content); } catch { return; }
    if (!p || typeof p !== "object") return;

    const mine = ev.pubkey === this.me;
    let from = ev.pubkey;
    if (p.as) {
      if (from !== this.hostId || !/^bot\d$/.test(p.as)) return;
      from = p.as;
    }
    // my own events from an earlier page load: only game data and chat are meaningful
    if (mine && LOBBY_ONLY_CORE.includes(p.k)) return;
    if (this.lobby.banned.includes(from)) return;
    try { this._handle(from, p, mine); } catch (e) { console.error(e); }
  }

  /* ---------- message handling ---------- */
  _handle(from, p, mine = false) {
    const L = this.lobby;
    switch (p.k) {
      case "hi":
        if (this.isHost && Date.now() - this._lastHiReply > 1200) { this._lastHiReply = Date.now(); this._broadcast(); }
        break;
      case "join": case "sit": case "stand": case "leave":
        if (this.isHost) this._hostHandle(from, p);
        break;
      case "state": this._onState(from, p); break;
      case "chat": {
        const t = String(p.t || "").slice(0, 300);
        if (!t) break;
        if (!this.gotState) this.pendingChat.push([from, t]);
        else if (L.names[from]) this.chat(from, t);
        break;
      }
      case "deck": {
        const m = p.m;
        if (!m || typeof m.g !== "string") return;
        (this.deckLog[m.g] ??= []).push([from, m]);
        for (const t of Object.values(this.tables)) t.receive(from, m, mine);
        break;
      }
      default:
        this._store(from, p);
    }
  }

  // ----- host side -----
  _hostHandle(from, p) {
    const L = this.lobby, n = L.seatCount || this.seatCount;
    if (from === this.me || this.isBot(from)) return;
    const inSeat = L.seats.includes(from), inSpec = L.spectators.includes(from);
    if (p.k === "join") {
      const name = String(p.n || "Player").trim().slice(0, 16) || "Player";
      if (inSeat || inSpec) { L.names[from] = name; if (p.spec && L.status === "lobby" && inSeat) this._moveToSpectators(from); }
      else {
        const free = L.seats.indexOf(null);
        if (L.status === "lobby" && !p.spec && free >= 0) L.seats[free] = from;
        else if (L.spectators.length < MAX_SPECTATORS) L.spectators.push(from);
        else return;
        L.names[from] = name;
      }
    } else if (p.k === "sit") {
      if (L.status !== "lobby" || !inSpec) return;
      const free = L.seats.indexOf(null);
      if (free < 0) return;
      L.spectators = L.spectators.filter(x => x !== from); L.seats[free] = from;
    } else if (p.k === "stand") {
      if (L.status !== "lobby" || !inSeat) return;
      this._moveToSpectators(from);
    } else if (p.k === "leave") {
      if (inSpec) { L.spectators = L.spectators.filter(x => x !== from); delete L.names[from]; }
      else if (inSeat && L.status === "lobby") { L.seats[L.seats.indexOf(from)] = null; delete L.names[from]; }
      else if (inSeat) this.log(`<i>${this.nameOf(from)} left the room (their seat is kept for a rejoin)</i>`);
    }
    while (L.seats.length < n) L.seats.push(null);
    this._broadcast();
  }
  _moveToSpectators(id) {
    const L = this.lobby;
    L.seats[L.seats.indexOf(id)] = null;
    if (!L.spectators.includes(id)) L.spectators.push(id);
  }

  // ----- everyone else -----
  _onState(from, p) {
    const L = this.lobby;
    if (from !== this.hostId || this.isHost) return;
    const S = p.state;
    if (!S || !Array.isArray(S.seats) || typeof p.version !== "number" || p.version <= L.version) return;
    L.seats = S.seats.map(x => (typeof x === "string" ? x : null));
    L.names = { ...(S.names || {}) };
    L.spectators = Array.isArray(S.spectators) ? S.spectators.slice() : [];
    L.banned = (S.banned || []).slice();
    L.status = S.status === "playing" ? "playing" : "lobby";
    L.gameId = S.gameId ?? null;
    L.game = S.game || null;
    L.seatCount = S.seatCount || L.seats.length || this.seatCount;
    L.version = p.version;
    this.gotState = true;
    if (this._hiTimer) { clearInterval(this._hiTimer); this._hiTimer = null; }

    if (L.seatCount !== this.seatCount) {
      this.seatCount = L.seatCount;
      const u = new URL(location.href);
      if (L.seatCount === 2) u.searchParams.set("p", "2"); else u.searchParams.delete("p");
      history.replaceState(null, "", u);
      if (this.onModeChange) this.onModeChange(L.seatCount);
    }

    if (this.pendingChat.length) {
      const q = this.pendingChat; this.pendingChat = [];
      for (const [f, t] of q) if (L.names[f]) this.chat(f, t);
    }

    if (this.inRoom) {
      ls.set("lastRoom", this.id);
      if (this._joinTimer) { clearInterval(this._joinTimer); this._joinTimer = null; }
      if (L.status === "lobby") this.sawLobby = true;
    } else if (this.autoJoin && !L.banned.includes(this.me)) {
      this.autoJoin = false;                      // reloaded browser that had joined before → rejoin quietly
      this._startJoinLoop(false);
    }

    if (L.status === "playing") {
      if (this.inRoom && L.gameId !== this.startedGame) this._begin(!this.sawLobby);
    } else if (this.startedGame) {
      this.startedGame = null; this.over = null; this.menuOpen = false; this.onLobby();
    }
    this.renderLobby();
  }

  async _broadcast() {
    if (!this.isHost) return;
    this._ensureHostSeat();
    const L = this.lobby, n = L.seatCount || this.seatCount;
    while (L.seats.length < n) L.seats.push(null);
    if (L.seats.length > n) L.seats.length = n;
    L.version = Math.max(L.version + 1, Date.now());        // always increasing, even after losing local data
    this._lastBroadcast = Date.now();
    const state = {
      seats: L.seats.slice(), names: { ...L.names }, spectators: L.spectators.slice(),
      banned: L.banned.slice(), status: L.status, gameId: L.gameId, seatCount: n, game: L.game,
    };
    this._saveHostLobby();
    this.renderLobby();
    await this._publish({ k: "state", version: L.version, state });
  }

  _begin(resume = false) {
    this.startedGame = this.lobby.gameId;
    this.over = null;
    this.menuOpen = false;
    this._wipeOldGames();
    this.renderLobby();
    this.onStart(resume);
  }
  _wipeOldGames() {
    const g = this.lobby.gameId + ".";
    for (const k of lsRaw.keys()) if (k.startsWith("sec|") && k.endsWith("|" + this.me8) && !k.startsWith("sec|" + g)) lsRaw.del(k);
  }

  gameOver(text) { this.over = text; this.menuOpen = false; this.renderLobby(); this._saveHostLobby(); }

  /* ---------- joining ---------- */
  _startHiLoop() {
    if (this._hiTimer) return;
    let n = 0;
    const ask = () => { if (this.id && !this.gotState && this.online) this._publish({ k: "hi", n: n++ }); };
    setTimeout(ask, 400);
    this._hiTimer = setInterval(ask, 2500);
  }
  _startJoinLoop(spec) {
    if (this._joinTimer || !this.name) return;
    this._joinSpec = !!spec;
    let n = 0;
    const ask = () => {
      if (!this.id || this.lobby.banned.includes(this.me)) return;
      if (this.inRoom) { clearInterval(this._joinTimer); this._joinTimer = null; ls.set("lastRoom", this.id); return; }
      if (!this.online) return;
      this._publish({ k: "join", n: this.name, spec: this._joinSpec, t: n++ });
    };
    setTimeout(ask, 200);
    this._joinTimer = setInterval(ask, 2000);
  }

  leave() {
    if (this._hiTimer) clearInterval(this._hiTimer);
    if (this._joinTimer) clearInterval(this._joinTimer);
    this._closeSockets();
    this._wipeStorage();
    if (ls.get("lastRoom") === this.id) ls.del("lastRoom");
    if (this.isHost) ls.del("lobbySnap");
    const u = new URL(location.href);
    u.searchParams.delete("room");
    history.replaceState(null, "", u);
    this.id = ""; this.hostId = "";
    this._reset();
    this.onLobby();
    this.renderLobby();
  }

  _readName() {
    const input = this.lobbyEl.querySelector("input");
    const v = ((input && input.value) || this.draftName || "").trim();
    if (!v) {
      this.nameError = "Enter a name first";
      this.renderLobby();
      return false;
    }
    this.name = v.slice(0, 16);
    this.draftName = null;
    ls.set("nm", this.name);
    this.nameError = "";
    return true;
  }

  /* ---------- buttons ---------- */
  async _act(act, i) {
    const L = this.lobby, host = this.isHost, inLobby = L.status === "lobby";
    if (act === "mode2" || act === "mode4") {
      const n = act === "mode2" ? 2 : 4;
      if (n === this.seatCount || this.id) return;
      this.seatCount = n;
      L.seats = Array(n).fill(null);
      L.seatCount = n;
      const u = new URL(location.href);
      if (n === 2) u.searchParams.set("p", "2"); else u.searchParams.delete("p");
      history.replaceState(null, "", u);
      if (this.onModeChange) this.onModeChange(n);
    } else if (act === "create") {
      if (!this._readName()) return;
      this.hostId = this.me; this.id = this.me + "-" + rid();
      const u = new URL(location.href); u.searchParams.set("room", this.id); history.replaceState(null, "", u);
      L.names = { [this.me]: this.name };
      L.seats = Array(this.seatCount).fill(null);
      L.seats[0] = this.me;
      L.spectators = [];
      L.seatCount = this.seatCount;
      L.status = "lobby"; L.gameId = null; L.game = null; L.version = 0; L.banned = [];
      this.gotState = true; this.sawLobby = true;
      ls.set("lastRoom", this.id);
      this._connect();
      this._broadcast();
      const again = setInterval(() => { if (!this.id || this.online) { clearInterval(again); this._broadcast(); } }, 400);
    } else if (act === "join" || act === "watch") {
      if (!this._readName()) return;
      this._connect();
      this._joinTimer && clearInterval(this._joinTimer); this._joinTimer = null;
      this._startJoinLoop(act === "watch");
    } else if (act === "copy") {
      const u = new URL(location.href); u.hash = "";
      u.searchParams.delete("u");
      u.searchParams.set("room", this.id);
      if (this.seatCount === 2) u.searchParams.set("p", "2"); else u.searchParams.delete("p");
      try { await navigator.clipboard.writeText(u.href); this.copied = true; }
      catch { prompt("Copy this invite link:", u.href); }
      this.renderLobby();
      setTimeout(() => { this.copied = false; this.renderLobby(); }, 1500);
      return;
    } else if (act === "leave") {
      if (!host && this.inRoom) { await this._publish({ k: "leave" }); await new Promise(r => setTimeout(r, 200)); }
      this.leave();
      return;
    } else if (act === "menu") {
      this.menuOpen = !this.menuOpen;
    } else if (act === "sit") {
      this._publish({ k: "sit" });
    } else if (act === "stand") {
      this._publish({ k: "stand" });
    } else if (!host) {
      return;
    } else if (act === "swap" && inLobby) {
      if (this.swapSel === null) this.swapSel = i;
      else {
        if (this.swapSel !== i) { [L.seats[this.swapSel], L.seats[i]] = [L.seats[i], L.seats[this.swapSel]]; this._broadcast(); }
        this.swapSel = null;
      }
    } else if (act === "seatspec" && inLobby) {          // host puts a spectator into a seat
      const id = L.spectators[i]; if (!id) return;
      let free = L.seats.indexOf(null);
      if (free < 0 && this.swapSel !== null && L.seats[this.swapSel] !== this.me) {   // swap with the selected seat
        free = this.swapSel; this._moveToSpectators(L.seats[free]);
      }
      if (free < 0) return;
      L.spectators = L.spectators.filter(x => x !== id); L.seats[free] = id; this.swapSel = null; this._broadcast();
    } else if (act === "kick") {
      const id = L.seats[i]; if (!id || id === this.me || (!inLobby && this.isBot(id))) return;
      if (!inLobby) return;
      L.banned.push(id); L.seats[i] = null; delete L.names[id]; this.swapSel = null; this._broadcast();
    } else if (act === "kickspec") {
      const id = L.spectators[i]; if (!id) return;
      L.banned.push(id); L.spectators.splice(i, 1); delete L.names[id]; this._broadcast();
    } else if (act === "start" && inLobby) {
      L.seats = L.seats.map((id, n) => id || (L.names["bot" + n] = "Bot " + (n + 1), "bot" + n));
      L.status = "playing"; L.gameId = rid(); L.game = null; this.swapSel = null;
      this._broadcast(); this._begin(false); return;
    } else if (act === "back" || act === "end") {
      if (act === "end" && !confirm("End the current game for everyone?")) return;
      L.seats = L.seats.map(id => (this.isBot(id) ? null : id));
      for (const k of Object.keys(L.names)) if (this.isBot(k)) delete L.names[k];
      L.status = "lobby"; L.game = null; L.gameId = null;
      this.startedGame = null; this.over = null; this.menuOpen = false;
      this._broadcast(); this.onLobby();
    }
    this.renderLobby();
  }

  /* ---------- rendering ---------- */
  renderLobby() {
    const L = this.lobby, host = this.isHost;
    const live = L.status === "playing" && this.inRoom && !!this.startedGame && !this.over;
    this.lobbyEl.style.display = live && !this.menuOpen ? "none" : "flex";
    this._net();

    // keep what the user is typing while the screen refreshes
    const cur = this.lobbyEl.querySelector("input");
    if (cur) this.draftName = cur.value;
    const hadFocus = cur && document.activeElement === cur, caret = hadFocus ? cur.selectionStart : 0;
    const nameVal = esc(this.draftName ?? this.name);

    let html;
    if (!this.id) {
      html = `<h2>JOKE</h2>
        <div class="mode">
          <button data-act="mode2" class="${this.seatCount === 2 ? "on" : ""}">2 players</button>
          <button data-act="mode4" class="${this.seatCount === 4 ? "on" : ""}">4 players</button>
        </div>
        <input placeholder="Your name" value="${nameVal}" maxlength="16">
        ${this.nameError ? `<p class="err">${esc(this.nameError)}</p>` : ""}
        <button data-act="create">Create room</button>`;
    } else if (L.banned.includes(this.me)) {
      html = `<p>You were removed from this room.</p><button data-act="leave" class="leave">Leave</button>`;
    } else if (!this.gotState) {
      const waited = (Date.now() - this.connectedAt) / 1000;
      html = `<h2>JOKE</h2><p>${this.online ? "Looking for the host…" : "Connecting to relays…"}</p>` +
        (waited > 10 ? `<small>The host has to be online for the room to answer. Still trying…</small>` : "") +
        `<button data-act="leave" class="leave">Leave</button>`;
    } else if (!this.inRoom) {
      const playing = L.status === "playing";
      html = `<h2>${esc(this.rawName(this.hostId))}'s room</h2>
        <p>${this._count()}</p>
        ${this._rosterHtml(false)}
        <input placeholder="Your name" value="${nameVal}" maxlength="16">
        ${this.nameError ? `<p class="err">${esc(this.nameError)}</p>` : ""}
        ${playing ? `<small>A game is in progress. You can watch it.</small><button data-act="watch">Watch game</button>`
          : `<button data-act="join">Join room</button><button data-act="watch" class="ghost">Just watch</button>`}
        <button data-act="leave" class="leave">Leave</button>`;
    } else if (this.over) {
      html = `<h2>${this.over}</h2>` + (host ? `<button data-act="back">Back to lobby</button>` : "<p>Waiting for the host…</p>") +
        `<button data-act="leave" class="leave">Leave</button>`;
    } else if (L.status === "playing" && !this.startedGame) {
      html = `<h2>Reconnecting…</h2><p>Picking the game back up.</p><button data-act="leave" class="leave">Leave</button>`;
    } else {
      const playing = L.status === "playing";
      html = (this.copied ? `<button data-act="copy" class="ok">Copied ✓</button>` : `<button data-act="copy">Copy invite link</button>`) +
        this._rosterHtml(true) + this._spectatorsHtml() + this._footerHtml(playing);
    }
    const close = live && this.menuOpen ? `<button class="x" data-act="menu" title="Close">✕</button>` : "";
    this.lobbyEl.innerHTML = `<div class="panel">${close}${html}</div>`;

    if (hadFocus) {
      const inp = this.lobbyEl.querySelector("input");
      if (inp) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch {} }
    }
  }

  _count() {
    const L = this.lobby, p = L.seats.filter(Boolean).length, s = L.spectators.length;
    return `${p}/${this.seatCount} seated${s ? ` · ${s} watching` : ""}`;
  }

  // the table, drawn from the viewer's point of view (me at the bottom; spectators see seat 0 there)
  _rosterHtml(interactive) {
    const L = this.lobby, n = this.seatCount, host = this.isHost, inLobby = L.status === "lobby";
    while (L.seats.length < n) L.seats.push(null);
    const ref = Math.max(0, L.seats.indexOf(this.me));
    const viewOf = i => (n === 2 ? (i === ref ? 0 : 2) : (i - ref + 4) % 4);
    const seats = L.seats.slice(0, n).map((id, i) => {
      const v = viewOf(i);
      const roles = [id === this.me ? "you" : "", id === this.hostId ? "host" : "",
        id !== this.me && this.mySeat >= 0 && id ? (n === 4 ? (v === 2 ? "partner" : "") : "opponent") : ""].filter(Boolean);
      const team = n === 4 ? `Team ${i % 2 ? "B" : "A"}` : "";
      const label = id ? this.nameOf(id) : "<i>empty</i>";
      const tools = interactive && host && inLobby
        ? `<button class="sw" data-act="swap" data-i="${i}">⇄</button>` + (id && id !== this.me ? `<button class="kk" data-act="kick" data-i="${i}">✕</button>` : "") : "";
      return `<div class="seat ${n === 4 ? "team" + (i % 2) : ""} ${this.swapSel === i ? "sel" : ""} ${id && this.isBot(id) ? "bot" : ""}" style="grid-area:${["m", "l", "t", "r"][v]}">` +
        tools + `<b>${label}</b><small>${[team, ...roles].filter(Boolean).join(" · ")}</small></div>`;
    }).join("");
    return `<div class="table t${n}">${seats}</div>`;
  }

  _spectatorsHtml() {
    const L = this.lobby, host = this.isHost, inLobby = L.status === "lobby";
    if (!L.spectators.length) return "";
    const rows = L.spectators.map((id, i) =>
      `<span class="chip">${id === this.me ? "<b>" : ""}${this.nameOf(id)}${id === this.me ? " (you)</b>" : ""}` +
      (host && inLobby ? ` <button data-act="seatspec" data-i="${i}" title="Give a seat">🪑</button>` : "") +
      (host ? ` <button data-act="kickspec" data-i="${i}" title="Remove">✕</button>` : "") + `</span>`).join("");
    return `<div class="spec"><small>👁 Watching (${L.spectators.length})</small><div>${rows}</div></div>`;
  }

  _footerHtml(playing) {
    const L = this.lobby, host = this.isHost;
    let h = "";
    if (host && !playing) h += `<small>⇄ swaps two seats · empty seats get bots · extra people can watch.</small><button data-act="start">Start</button>`;
    else if (host && playing) h += `<button data-act="end" class="ghost">End game (back to lobby)</button>`;
    else if (!playing) {
      const free = L.seats.includes(null);
      h += this.isSpectator
        ? `<small>You are watching.</small>${free ? `<button data-act="sit">Take a free seat</button>` : `<small>No free seats.</small>`}`
        : `<small>Waiting for the host to start…</small><button data-act="stand" class="ghost">Watch instead of playing</button>`;
    } else if (this.isSpectator) h += `<small>You are watching this game.</small>`;
    return h + `<button data-act="leave" class="leave">Leave</button>`;
  }
}
