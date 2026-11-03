// room.js — nostr transport, lobby (create/join/seats/kick/bots), chat, deck plumbing.
import * as nxstr from "https://cdn.jsdelivr.net/gh/nxrix/nxstr@1.0.2/index.js";
import { Table } from "./deck.js";

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const KIND = 4242;
const CORE_KINDS = ["join", "state", "chat", "deck"];
const esc = s => String(s).replace(/[&<>"]/g, c => "&#" + c.charCodeAt() + ";");

export class Room {
  constructor({ seatCount, lobbyEl, logEl, chatInput, onStart, onLobby, onModeChange }) {
    Object.assign(this, { seatCount, lobbyEl, logEl, onStart, onLobby, onModeChange });

    nxstr.generateKeys(localStorage.sk || undefined);
    this.secretKey = nxstr.getSecretKey();
    this.me = nxstr.getPublicKey();
    localStorage.sk = this.secretKey;
    this.name = localStorage.nm || "";

    this.id = new URLSearchParams(location.search).get("room") || "";
    this.hostId = this.id.slice(0, 64);

    this.lobby = { seats: Array(seatCount).fill(null), names: {}, banned: [], status: "lobby", gameId: null, version: 0, seatCount };
    this.sockets = {};
    this.seenEvents = new Set();
    this.tables = {};
    this.deckLog = {};
    this.gameMsgs = [];
    this.waiters = [];
    this.over = null;
    this.swapSel = null;
    this.startedGame = null;
    this._joinTimer = null;
    // Opened a room URL this page load — don't auto-start a mid-game session on first state sync
    this.skipStart = !!this.id;
    this.nameError = "";

    chatInput.form.addEventListener("submit", e => {
      e.preventDefault();
      const text = chatInput.value.trim().slice(0, 300);
      if (!text || !this.id) return;
      chatInput.value = "";
      this.chat(this.me, text);
      this._publish({ k: "chat", t: text });
    });
    lobbyEl.addEventListener("click", e => {
      const b = e.target.closest("[data-act]");
      if (b) this._act(b.dataset.act, Number(b.dataset.i));
    });

    if (this.id) {
      if (this.isHost) {
        this._restoreHostLobby();
        this._connect();
        // Push restored state so other clients resync after our reload
        setTimeout(() => { if (this.isHost && this.id) this._broadcast(); }, 600);
      } else {
        this._connect();
        // Only auto-rejoin if this browser already joined this room before (reload)
        if (this.name && localStorage.lastRoom === this.id) this._startJoinLoop();
      }
    }
    this.renderLobby();
  }

  get isHost() { return this.hostId === this.me; }
  get seats() { return this.lobby.seats; }
  get gameId() { return this.lobby.gameId; }
  isBot(id) { return !!id && id.startsWith("bot"); }
  nameOf(id) { return esc(this.lobby.names[id] || String(id).slice(0, 6)); }
  rawName(id) { return this.lobby.names[id] || String(id).slice(0, 6); }

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
  _saveHostLobby() {
    if (!this.isHost || !this.id) return;
    try {
      localStorage.lobbySnap = JSON.stringify({ id: this.id, lobby: this.lobby });
    } catch {}
  }
  _restoreHostLobby() {
    let restored = false;
    try {
      const snap = JSON.parse(localStorage.lobbySnap || "null");
      if (snap && snap.id === this.id && snap.lobby) {
        Object.assign(this.lobby, snap.lobby);
        if (!Array.isArray(this.lobby.seats) || this.lobby.seats.length !== this.seatCount) {
          this.lobby.seats = Array(this.seatCount).fill(null);
        }
        restored = true;
      }
    } catch {}
    if (!this.lobby.seats.includes(this.me)) {
      const free = this.lobby.seats.indexOf(null);
      this.lobby.seats[free >= 0 ? free : 0] = this.me;
    }
    this.lobby.names[this.me] = this.name || this.lobby.names[this.me] || "Host";
    if (this.lobby.seatCount) this.seatCount = this.lobby.seatCount;
    return restored;
  }

  /* ---------- sending ---------- */
  async _publish(payload) {
    const event = await nxstr.sign({
      kind: KIND, created_at: Math.floor(Date.now() / 1000), pubkey: this.me,
      tags: [["r", this.id]], content: JSON.stringify(payload),
    }, this.secretKey);
    const text = JSON.stringify(["EVENT", event]);
    for (const ws of Object.values(this.sockets)) if (ws.readyState === 1) ws.send(text);
  }

  send(payload, as) {
    if (as) payload.as = as;
    this._publish(payload);
    if (!CORE_KINDS.includes(payload.k)) this._store(as || this.me, payload);
  }

  waitFor(pred) {
    const hit = this.gameMsgs.find(m => pred(m.from, m.p));
    if (hit) return Promise.resolve(hit);
    return new Promise(resolve => this.waiters.push({ pred, resolve }));
  }
  _store(from, p) {
    const m = { from, p };
    this.gameMsgs.push(m);
    this.waiters = this.waiters.filter(w => (w.pred(from, p) ? (w.resolve(m), false) : true));
  }

  /* ---------- deck plumbing ---------- */
  createTables(handId, { onOpen, onCheat }) {
    this.tables = {};
    const seats = this.seats.slice();
    for (const id of seats) {
      if (id === this.me || (this.isHost && this.isBot(id))) {
        this.tables[id] = new Table({
          id: handId, players: seats, me: id, send: this._deckSender(id),
          onOpen: id === this.me ? onOpen : null, onCheat,
        });
      }
    }
    for (const [from, msg] of this.deckLog[handId] || []) Object.values(this.tables).forEach(t => t.receive(from, msg));
    return this.tables;
  }
  _deckSender(playerId) {
    return msg => {
      this._publish({ k: "deck", m: msg, as: playerId === this.me ? undefined : playerId });
      for (const t of Object.values(this.tables)) if (t.me !== playerId) t.receive(playerId, msg);
    };
  }

  /* ---------- nostr ---------- */
  _connect() {
    for (const url of RELAYS) {
      if (this.sockets[url] && (this.sockets[url].readyState === 0 || this.sockets[url].readyState === 1)) continue;
      const open = () => {
        const ws = this.sockets[url] = new WebSocket(url);
        ws.onopen = () => ws.send(JSON.stringify(["REQ", "sub", {
          kinds: [KIND], "#r": [this.id], since: Math.floor(Date.now() / 1000) - 1800 }]));
        ws.onmessage = m => {
          try { const [type, , ev] = JSON.parse(m.data); if (type === "EVENT") this._onEvent(ev); } catch {}
        };
        ws.onclose = () => setTimeout(open, 3000);
      };
      open();
    }
  }

  _startJoinLoop() {
    if (this._joinTimer || !this.name) return;
    const ask = () => {
      if (!this.id || this.lobby.banned.includes(this.me)) return;
      if (this.lobby.names[this.me]) {
        clearInterval(this._joinTimer); this._joinTimer = null;
        localStorage.lastRoom = this.id;
        return;
      }
      this._publish({ k: "join", n: this.name });
    };
    setTimeout(ask, 500);
    this._joinTimer = setInterval(ask, 3000);
  }

  async _onEvent(event) {
    if (this.seenEvents.has(event.id) || event.pubkey === this.me) return;
    this.seenEvents.add(event.id);
    if (!await nxstr.verify(event)) return;
    let p; try { p = JSON.parse(event.content); } catch { return; }

    let from = event.pubkey;
    if (p.as) {
      if (from !== this.hostId || !/^bot\d$/.test(p.as)) return;
      from = p.as;
    }
    if (this.lobby.banned.includes(from)) return;
    try { this._handle(from, p); } catch (e) { console.error(e); }
  }

  _handle(from, p) {
    const L = this.lobby;
    switch (p.k) {
      case "join":
        if (!this.isHost || L.status !== "lobby") return;
        if (!L.seats.includes(from)) {
          const free = L.seats.indexOf(null);
          if (free < 0) return;
          L.seats[free] = from;
        }
        L.names[from] = String(p.n || "Player").slice(0, 16);
        this._broadcast(); this.renderLobby();
        break;
      case "state":
        if (from !== this.hostId || p.version <= L.version) return;
        Object.assign(L, p.state); L.version = p.version;
        if (L.seatCount && L.seatCount !== this.seatCount) {
          this.seatCount = L.seatCount;
          const u = new URL(location.href);
          if (L.seatCount === 2) u.searchParams.set("p", "2"); else u.searchParams.delete("p");
          history.replaceState(null, "", u);
          if (this.onModeChange) this.onModeChange(L.seatCount);
        }
        if (L.names[this.me]) {
          localStorage.lastRoom = this.id;
          if (L.status === "lobby") this.skipStart = false;
        }
        if (L.status === "playing" && L.gameId !== this.startedGame && L.seats.includes(this.me)) {
          if (this.skipStart) {
            // Reloaded mid-game: do not start a second parallel game
            this.skipStart = false;
          } else {
            this._begin();
          }
        } else if (L.status === "lobby" && this.startedGame) {
          this.startedGame = null; this.over = null; this.onLobby();
        }
        this.renderLobby();
        break;
      case "chat":
        if (L.names[from] || from === this.hostId) this.chat(from, String(p.t).slice(0, 300));
        break;
      case "deck":
        (this.deckLog[p.m.g] ??= []).push([from, p.m]);
        for (const t of Object.values(this.tables)) t.receive(from, p.m);
        break;
      default:
        this._store(from, p);
    }
  }

  _broadcast() {
    const L = this.lobby; L.version++;
    const { seats, names, banned, status, gameId, seatCount } = L;
    this._publish({ k: "state", version: L.version, state: { seats, names, banned, status, gameId, seatCount } });
    this._saveHostLobby();
  }
  _begin() {
    this.startedGame = this.lobby.gameId;
    this.over = null;
    this.skipStart = false;
    this.renderLobby();
    this.onStart();
  }

  gameOver(text) { this.over = text; this.renderLobby(); this._saveHostLobby(); }

  leave() {
    if (this._joinTimer) { clearInterval(this._joinTimer); this._joinTimer = null; }
    for (const ws of Object.values(this.sockets)) try { ws.close(); } catch {}
    this.sockets = {};
    if (localStorage.lastRoom === this.id) delete localStorage.lastRoom;
    const u = new URL(location.href);
    u.searchParams.delete("room");
    history.replaceState(null, "", u);
    this.id = "";
    this.hostId = "";
    this.lobby = { seats: Array(this.seatCount).fill(null), names: {}, banned: [], status: "lobby", gameId: null, version: 0, seatCount: this.seatCount };
    this.seenEvents = new Set();
    this.tables = {};
    this.deckLog = {};
    this.gameMsgs = [];
    this.waiters = [];
    this.over = null;
    this.startedGame = null;
    this.skipStart = false;
    this.nameError = "";
    this.onLobby();
    this.renderLobby();
  }

  _readName() {
    const input = this.lobbyEl.querySelector("input");
    const v = (input && input.value.trim()) || "";
    if (!v) {
      this.nameError = "Enter a name first";
      this.renderLobby();
      return false;
    }
    this.name = v.slice(0, 16);
    localStorage.nm = this.name;
    this.nameError = "";
    return true;
  }

  _act(act, i) {
    const L = this.lobby;
    if (act === "mode2" || act === "mode4") {
      const n = act === "mode2" ? 2 : 4;
      if (n === this.seatCount || this.id) return;
      this.seatCount = n;
      this.lobby.seats = Array(n).fill(null);
      this.lobby.seatCount = n;
      const u = new URL(location.href);
      if (n === 2) u.searchParams.set("p", "2"); else u.searchParams.delete("p");
      history.replaceState(null, "", u);
      if (this.onModeChange) this.onModeChange(n);
      this.renderLobby();
      return;
    } else if (act === "create") {
      if (!this._readName()) return;
      this.hostId = this.me; this.id = this.me + "-" + Math.random().toString(36).slice(2, 7);
      const u = new URL(location.href); u.searchParams.set("room", this.id); history.replaceState(null, "", u);
      L.names[this.me] = this.name; L.seats[0] = this.me; L.seatCount = this.seatCount;
      localStorage.lastRoom = this.id;
      this._connect();
      this._saveHostLobby();
    } else if (act === "join") {
      if (!this._readName()) return;
      this._connect();
      this._startJoinLoop();
    } else if (act === "copy") {
      const u = new URL(location.href); u.hash = ""; u.searchParams.set("room", this.id);
      navigator.clipboard.writeText(u.href);
    } else if (act === "leave") {
      this.leave();
      return;
    } else if (act === "swap") {
      if (this.swapSel === null) this.swapSel = i;
      else {
        if (this.swapSel !== i) { [L.seats[this.swapSel], L.seats[i]] = [L.seats[i], L.seats[this.swapSel]]; this._broadcast(); }
        this.swapSel = null;
      }
    } else if (act === "kick") {
      const id = L.seats[i]; L.banned.push(id); L.seats[i] = null; delete L.names[id]; this.swapSel = null; this._broadcast();
    } else if (act === "start") {
      L.seats = L.seats.map((id, n) => id || (L.names["bot" + n] = "Bot " + (n + 1), "bot" + n));
      L.status = "playing"; L.gameId = Math.random().toString(36).slice(2, 8);
      this._broadcast(); this._begin(); return;
    } else if (act === "back") {
      L.seats = L.seats.map(id => this.isBot(id) ? null : id);
      L.status = "lobby"; this.startedGame = null; this.over = null; this._broadcast(); this.onLobby();
    }
    this.renderLobby();
  }

  renderLobby() {
    const L = this.lobby, host = this.isHost;
    // Only hide lobby when THIS session is actually in the running game
    const inLiveGame = L.status === "playing" && L.seats.includes(this.me) && !this.over && this.startedGame;
    this.lobbyEl.style.display = inLiveGame ? "none" : "flex";
    let html;
    if (!this.id) {
      html = `<h2>JOKE</h2>
        <div class="mode">
          <button data-act="mode2" class="${this.seatCount === 2 ? "on" : ""}">2 players</button>
          <button data-act="mode4" class="${this.seatCount === 4 ? "on" : ""}">4 players</button>
        </div>
        <input placeholder="Your name" value="${esc(this.name)}">
        ${this.nameError ? `<p style="color:#de1b45">${esc(this.nameError)}</p>` : ""}
        <button data-act="create">Create room</button>`;
    } else if (!L.names[this.me]) {
      html = L.banned.includes(this.me) ? "You were removed from this room." :
        `<h2>JOKE</h2>
        <input placeholder="Your name" value="${esc(this.name)}">
        ${this.nameError ? `<p style="color:#de1b45">${esc(this.nameError)}</p>` : ""}
        <button data-act="join">Join room</button>
        <button data-act="leave" class="leave">Leave</button>`;
    } else if (this.over) {
      html = `<h2>${this.over}</h2>` + (host ? `<button data-act="back">Back to lobby</button>` : "<p>Waiting for the host…</p>") +
        `<button data-act="leave" class="leave">Leave</button>`;
    } else if (L.status === "playing" && !this.startedGame) {
      html = `<h2>Game in progress</h2>
        <p>You reconnected while a hand was already going. Mid-hand reconnect isn’t supported — wait for the host to finish, or leave.</p>
        <button data-act="leave" class="leave">Leave</button>`;
    } else {
      const mySeat = Math.max(0, L.seats.indexOf(this.me)), n = this.seatCount;
      const viewOf = i => (n === 2 ? (i === mySeat ? 0 : 2) : (i - mySeat + 4) % 4);
      const seats = L.seats.map((id, i) => {
        const v = viewOf(i);
        const role = id === this.me ? "you" : v === 2 ? (n === 4 ? "partner" : "opponent") : "";
        const team = n === 4 ? `Team ${i % 2 ? "B" : "A"}` : "";
        return `<div class="seat ${n === 4 ? "team" + (i % 2) : ""} ${this.swapSel === i ? "sel" : ""}" style="grid-area:${["m", "l", "t", "r"][v]}">` +
          (host ? `<button class="sw" data-act="swap" data-i="${i}">⇄</button>` + (id && id !== this.me ? `<button class="kk" data-act="kick" data-i="${i}">✕</button>` : "") + "") +
          `<b>${id ? this.nameOf(id) : "<i>empty</i>"}</b><small>${[team, role].filter(Boolean).join(" · ")}</small></div>`;
      }).join("");
      const areas = n === 4 ? `". t ." "l . r" ". m ."` : `". t ." ". m ."`;
      html = (host ? `<button data-act="copy">Copy invite link</button>` : "") +
        `<div class="table" style="grid-template-areas:${areas}">${seats}</div>` +
        (host ? `<small>Click ⇄ on two seats to swap them. Empty seats get bots.</small><button data-act="start">Start</button>` : "<p>Waiting for the host to start…</p>") +
        `<button data-act="leave" class="leave">Leave</button>`;
    }
    this.lobbyEl.innerHTML = `<div class="panel">${html}</div>`;
  }
}
