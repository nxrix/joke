// room.js - everything that is not game rules: nostr transport, lobby (create/join/seats/kick/bots),
// chat, and the plumbing that connects deck Tables to nostr. Shared by 4p.html and 2p.html.
import * as nxstr from "https://cdn.jsdelivr.net/gh/nxrix/nxstr@1.0.2/index.js";
import { Table } from "./deck.js";

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const KIND = 4242;                                   // regular (stored) kind so late joiners get history
const CORE_KINDS = ["join", "state", "chat", "deck"]; // everything else is a "game message" (trump, discards, ...)
const esc = s => String(s).replace(/[&<>"]/g, c => "&#" + c.charCodeAt() + ";");

export class Room {
  /**
   * seatCount  2 or 4
   * lobbyEl    element that shows the lobby panel
   * logEl      element where log lines / chat are appended
   * chatInput  <input> for chat
   * onStart()  called on every client when the game starts
   * onLobby()  called when the host sends everybody back to the lobby
   */
  constructor({ seatCount, lobbyEl, logEl, chatInput, onStart, onLobby }) {
    Object.assign(this, { seatCount, lobbyEl, logEl, onStart, onLobby });

    // identity = a nostr key kept in localStorage
    nxstr.generateKeys(localStorage.sk || undefined);
    this.secretKey = nxstr.getSecretKey();
    this.me = nxstr.getPublicKey();
    localStorage.sk = this.secretKey;
    this.name = localStorage.nm || "";

    // room id lives in the URL as ?room=<hostPubkey>-<random>; the host is whoever created it
    this.id = new URLSearchParams(location.search).get("room") || "";
    this.hostId = this.id.slice(0, 64);

    this.lobby = { seats: Array(seatCount).fill(null), names: {}, banned: [], status: "lobby", gameId: null, version: 0 };
    this.sockets = {};
    this.seenEvents = new Set();
    this.tables = {};       // my deck Table(s): mine, plus the bots' if I'm the host
    this.deckLog = {};      // handId -> [[from, msg]]  buffered deck messages
    this.gameMsgs = [];     // [{from, p}] every game message received so far
    this.waiters = [];
    this.over = null;
    this.swapSel = null;    // host: seat picked for swapping
    this.startedGame = null;

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

    if (this.isHost && this.id) {            // the creator reloaded the page
      this.lobby.names[this.me] = this.name || "Host";
      this.lobby.seats[0] = this.me;
      this._connect();
    }
    this.renderLobby();
  }

  /* ---------- small getters ---------- */
  get isHost() { return this.hostId === this.me; }
  get seats() { return this.lobby.seats; }
  get gameId() { return this.lobby.gameId; }
  isBot(id) { return !!id && id.startsWith("bot"); }
  nameOf(id) { return esc(this.lobby.names[id] || String(id).slice(0, 6)); }
  rawName(id) { return this.lobby.names[id] || String(id).slice(0, 6); }

  // A log line (html), or a chat message: [name | text] in its own box (the CSS keeps the name left and lets the text pick its direction).
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

  /* ---------- sending ---------- */
  async _publish(payload) {
    const event = await nxstr.sign({
      kind: KIND, created_at: Math.floor(Date.now() / 1000), pubkey: this.me,
      tags: [["r", this.id]], content: JSON.stringify(payload),
    }, this.secretKey);
    const text = JSON.stringify(["EVENT", event]);
    for (const ws of Object.values(this.sockets)) if (ws.readyState === 1) ws.send(text);
  }

  // Send a game message to everybody (and to myself). `as` = a bot id when the host speaks for a bot.
  send(payload, as) {
    if (as) payload.as = as;
    this._publish(payload);
    if (!CORE_KINDS.includes(payload.k)) this._store(as || this.me, payload);
  }

  // Resolves with {from, p} for the first game message (already received or future) where pred(from, p) is true.
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
  // One Table for me, plus one per bot if I'm the host (bots are simulated inside the host's browser).
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

  async _onEvent(event) {
    if (this.seenEvents.has(event.id) || event.pubkey === this.me) return;
    this.seenEvents.add(event.id);
    if (!await nxstr.verify(event)) return;
    let p; try { p = JSON.parse(event.content); } catch { return; }

    let from = event.pubkey;
    if (p.as) {                                   // only the host may speak for bots
      if (from !== this.hostId || !/^bot\d$/.test(p.as)) return;
      from = p.as;
    }
    if (this.lobby.banned.includes(from)) return;
    try { this._handle(from, p); } catch (e) { console.error(e); }
  }

  _handle(from, p) {
    const L = this.lobby;
    switch (p.k) {
      case "join":                                // someone asks the host for a seat
        if (!this.isHost || L.status !== "lobby") return;
        if (!L.seats.includes(from)) {
          const free = L.seats.indexOf(null);
          if (free < 0) return;
          L.seats[free] = from;
        }
        L.names[from] = String(p.n).slice(0, 16);
        this._broadcast(); this.renderLobby();
        break;
      case "state":                               // the host's lobby state
        if (from !== this.hostId || p.version <= L.version) return;
        Object.assign(L, p.state); L.version = p.version;
        if (L.status === "playing" && L.gameId !== this.startedGame && L.seats.includes(this.me)) this._begin();
        else if (L.status === "lobby" && this.startedGame) { this.startedGame = null; this.over = null; this.onLobby(); }
        this.renderLobby();
        break;
      case "chat":
        if (L.names[from] || from === this.hostId) this.chat(from, String(p.t).slice(0, 300));
        break;
      case "deck":                                // deck message: buffer it, hand it to my Tables
        (this.deckLog[p.m.g] ??= []).push([from, p.m]);
        for (const t of Object.values(this.tables)) t.receive(from, p.m);
        break;
      default:
        this._store(from, p);
    }
  }

  _broadcast() {
    const L = this.lobby; L.version++;
    const { seats, names, banned, status, gameId } = L;
    this._publish({ k: "state", version: L.version, state: { seats, names, banned, status, gameId } });
  }
  _begin() {
    this.startedGame = this.lobby.gameId;
    this.over = null;      // (deckLog / gameMsgs are keyed by unique hand ids, and may already hold early messages)
    this.renderLobby();
    this.onStart();
  }
  gameOver(text) { this.over = text; this.renderLobby(); }

  /* ---------- lobby UI ---------- */
  _act(act, i) {
    const L = this.lobby, input = this.lobbyEl.querySelector("input");
    const name = () => { this.name = (input && input.value.trim()) || "Player"; localStorage.nm = this.name; };
    if (act === "create") {
      name();
      this.hostId = this.me; this.id = this.me + "-" + Math.random().toString(36).slice(2, 7);
      const u = new URL(location.href); u.searchParams.set("room", this.id); history.replaceState(null, "", u);
      L.names[this.me] = this.name; L.seats[0] = this.me;
      this._connect();
    } else if (act === "join") {
      name(); this._connect();
      const ask = () => { if (!L.names[this.me] && !L.banned.includes(this.me)) this._publish({ k: "join", n: this.name }); };
      setTimeout(ask, 1500); setInterval(ask, 4000);   // keep asking until the host's state lists me
    } else if (act === "copy") {
      const u = new URL(location.href); u.hash = ""; u.searchParams.set("room", this.id);
      navigator.clipboard.writeText(u.href);
    } else if (act === "swap") {                        // host: click two seats to swap their players
      if (this.swapSel === null) this.swapSel = i;
      else {
        if (this.swapSel !== i) { [L.seats[this.swapSel], L.seats[i]] = [L.seats[i], L.seats[this.swapSel]]; this._broadcast(); }
        this.swapSel = null;
      }
    } else if (act === "kick") {                        // host: remove + ban
      const id = L.seats[i]; L.banned.push(id); L.seats[i] = null; delete L.names[id]; this.swapSel = null; this._broadcast();
    } else if (act === "start") {                       // host: empty seats become bots
      L.seats = L.seats.map((id, n) => id || (L.names["bot" + n] = "Bot " + (n + 1), "bot" + n));
      L.status = "playing"; L.gameId = Math.random().toString(36).slice(2, 8);
      this._broadcast(); this._begin(); return;
    } else if (act === "back") {                        // host: after a finished game
      L.seats = L.seats.map(id => this.isBot(id) ? null : id);
      L.status = "lobby"; this.startedGame = null; this.over = null; this._broadcast(); this.onLobby();
    }
    this.renderLobby();
  }

  renderLobby() {
    const L = this.lobby, host = this.isHost;
    const playing = L.status === "playing" && L.seats.includes(this.me) && !this.over;
    this.lobbyEl.style.display = playing ? "none" : "flex";
    let html;
    if (!this.id) {
      html = `<h2>JOKE</h2><input placeholder="Your name" value="${esc(this.name)}"><button data-act="create">Create room</button>`;
    } else if (!L.names[this.me]) {
      html = L.banned.includes(this.me) ? "You were removed from this room." :
        `<h2>JOKE</h2><input placeholder="Your name" value="${esc(this.name)}"><button data-act="join">Join room</button>` +
        (Object.keys(this.sockets).length ? "<p>Waiting for the host…</p>" : "");
    } else if (this.over) {
      html = `<h2>${this.over}</h2>` + (host ? `<button data-act="back">Back to lobby</button>` : "<p>Waiting for the host…</p>");
    } else {
      // The table as it will look in the game (me at the bottom, partner across in 4p).
      const mySeat = Math.max(0, L.seats.indexOf(this.me)), n = this.seatCount;
      const viewOf = i => (n === 2 ? (i === mySeat ? 0 : 2) : (i - mySeat + 4) % 4);
      const seats = L.seats.map((id, i) => {
        const v = viewOf(i);
        const role = id === this.me ? "you" : v === 2 ? (n === 4 ? "partner" : "opponent") : "";
        const team = n === 4 ? `Team ${i % 2 ? "B" : "A"}` : "";
        return `<div class="seat ${n === 4 ? "team" + (i % 2) : ""} ${this.swapSel === i ? "sel" : ""}" style="grid-area:${["m", "l", "t", "r"][v]}">` +
          (host ? `<button class="sw" data-act="swap" data-i="${i}">⇄</button>` + (id && id !== this.me ? `<button class="kk" data-act="kick" data-i="${i}">✕</button>` : "") : "") +
          `<b>${id ? this.nameOf(id) : "<i>bot</i>"}</b><small>${[team, role].filter(Boolean).join(" · ")}</small></div>`;
      }).join("");
      const areas = n === 4 ? `". t ." "l . r" ". m ."` : `". t ." ". m ."`;
      html = (host ? `<button data-act="copy">Copy invite link</button>` : "") +
        `<div class="table" style="grid-template-areas:${areas}">${seats}</div>` +
        (host ? `<small>Click ⇄ on two seats to swap them. Empty seats get bots.</small><button data-act="start">Start</button>` : "<p>Waiting for the host to start…</p>") +
        (L.status === "playing" ? "<p>Game in progress.</p>" : "");
    }
    this.lobbyEl.innerHTML = `<div class="panel">${html}</div>`;
  }
}
