/**
 * deck — hostless shuffled deck for card games (mental poker).
 *
 * No server, no dealer, no transport dependency. You give it:
 *   - players: array of unique ids, SAME order on every client (= seat order)
 *   - me:      your id
 *   - send(msg): broadcast a JSON-serializable object to all other players
 * and you call table.receive(fromId, msg) for every message that arrives.
 * `fromId` must be authenticated by your transport (nostr event pubkey does this).
 *
 * Crypto: ElGamal over secp256k1 with a joint public key (sum of everyone's key).
 *   - each player shuffles + re-randomizes the whole deck once (1 message each)
 *   - cards are dealt by "decryption shares" (1 small message per card per player)
 *   - shares carry Chaum-Pedersen proofs, keys carry Schnorr proofs
 *   - shuffles are checked at the end by revealing seeds (audit), not by ZK proofs
 */
import * as secp from "https://cdn.jsdelivr.net/npm/@noble/secp256k1@3.1.0/index.min.js";

const P = secp.Point, G = P.BASE, Z = P.ZERO;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/* ---------- small helpers ---------- */
const te = new TextEncoder();
const b2h = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const big = b => BigInt("0x" + (typeof b === "string" ? b : b2h(b)));
const sh = x => x.toString(16).padStart(64, "0");
const sha = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? te.encode(s) : s));
const hs = async (...a) => big(await sha(a.join("|"))) % N;
const scalar = () => big(rnd(48)) % (N - 1n) + 1n;
const isHex = (s, len) => typeof s === "string" && /^[0-9a-f]+$/.test(s) && (!len || s.length === len);

const enc = p => p.equals(Z) ? "00" : p.toHex(true);
const dec = h => {
  if (!isHex(h)) throw new Error("bad point");
  if (h === "00") return Z;
  return P.fromHex ? P.fromHex(h) : P.fromBytes(Uint8Array.from(h.match(/../g), x => parseInt(x, 16)));
};
const mul = (p, k) => { k = ((k % N) + N) % N; return (k === 0n || p.equals(Z)) ? Z : p.multiply(k); };
const sub = (a, b) => a.add(b.negate());
const sum = arr => arr.reduce((a, b) => a.add(b), Z);

const ser = deck => deck.map(([a, b]) => [enc(a), enc(b)]);
const des = deck => deck.map(([a, b]) => [dec(a), dec(b)]);

/* deterministic stream from a seed: lets anyone replay a shuffle later */
class Stream {
  constructor(seed) { this.s = seed; this.c = 0; }
  block() { return sha(this.s + "|" + (this.c++)); }
  async scalar() {
    const a = await this.block(), b = await this.block();
    return big(new Uint8Array([...a, ...b])) % (N - 1n) + 1n;
  }
  async below(n) {
    const lim = Math.floor(2 ** 48 / n) * n;
    for (;;) {
      const b = await this.block();
      let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + b[i];
      if (v < lim) return v % n;
    }
  }
}

/** permute + re-randomize every card, fully determined by seed */
async function shuffleDeck(deck, seed, H) {
  const s = new Stream(seed), n = deck.length, idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = await s.below(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const out = [];
  for (const i of idx) {
    const r = await s.scalar(), [c1, c2] = deck[i];
    out.push([c1.add(mul(G, r)), c2.add(mul(H, r))]);
  }
  return out;
}

/* ---------- the table ---------- */
export class Table {
  /**
   * @param {object} o
   * @param {string}   o.id         unique game/room id (prevents replay across games)
   * @param {string[]} o.players    ids in seat order (same on every client)
   * @param {string}   o.me         my id (must be in players)
   * @param {function} o.send       (msg) => void, broadcast to everyone else
   * @param {number}   [o.deckSize=52]
   * @param {function} [o.onCheat]  (playerId, reason) => void
   */
  constructor({ id, players, me, send, deckSize = 52, onCheat, onOpen }) {
    if (!players.includes(me)) throw new Error("me not in players");
    Object.assign(this, { id: String(id), players, me, send, size: deckSize, onCheat, onOpen });
    this.n = players.length;
    this.pk = {};          // id -> Point
    this.stages = Array(this.n + 1); // stages[0] = initial deck, stages[k+1] = after seat k
    this.deck = null;      // final shuffled deck (ciphertexts)
    this.shares = {};      // idx -> {id: Point}
    this.sent = new Set(); // idx I already published a share for
    this.dealt = {};       // idx -> player id (local log, returned by audit)
    this.rc = {}; this.rr = {}; // random(): commits / reveals
    this.ends = {};
    this.failed = null;
    this._w = [];
    this.lookup = new Map();
    const init = [];
    for (let i = 0; i < deckSize; i++) {
      const M = mul(G, BigInt(i + 1));
      this.lookup.set(enc(M), i);
      init.push([Z, M]);
    }
    this.stages[0] = init;
  }

  /* ----- plumbing ----- */
  receive(from, msg) { if (from === this.me) return; return this._on(from, msg); }

  async _post(msg) {
    msg.g = this.id;
    this.send(msg);
    await this._on(this.me, msg);
  }

  _cheat(who, why) {
    this.failed = { who, why };
    try { this.onCheat && this.onCheat(who, why); } catch (e) {}
  }

  _wait(f) {
    return new Promise((res, rej) => {
      const chk = () => {
        if (this.failed) { rej(new Error(`cheat: ${this.failed.who}: ${this.failed.why}`)); return true; }
        let v; try { v = f(); } catch (e) { rej(e); return true; }
        if (v) { res(v); return true; }
        return false;
      };
      if (!chk()) this._w.push(chk);
    });
  }
  _tick() { this._w = this._w.filter(c => !c()); }

  async _on(from, msg) {
    try {
      if (!msg || msg.g !== this.id || !this.players.includes(from)) return;
      switch (msg.t) {
        case "key": {
          if (this.pk[from]) break;
          const pk = dec(msg.pk), A = dec(msg.A), s = big(msg.s);
          const e = await hs("key", this.id, from, msg.pk, msg.A);
          if (!mul(G, s).equals(A.add(mul(pk, e)))) return this._cheat(from, "bad key proof");
          if (!this.pk[from]) this.pk[from] = pk;
          break;
        }
        case "shuf": {
          if (from !== this.players[msg.seat]) return this._cheat(from, "wrong seat");
          if (this.stages[msg.seat + 1]) break;
          if (!Array.isArray(msg.deck) || msg.deck.length !== this.size) return this._cheat(from, "bad deck");
          this.stages[msg.seat + 1] = des(msg.deck);
          if (this.stages.filter(Boolean).length === this.n + 1) this.deck = this.stages[this.n];
          break;
        }
        case "shares": {
          await this._wait(() => this.deck);
          if (!Array.isArray(msg.list)) return this._cheat(from, "bad shares");
          for (const it of msg.list) { if (await this._verify(from, it)) return; }
          break;
        }
        case "commit": {
          const m = (this.rc[msg.l] ??= {});
          if (!m[from] && isHex(msg.c, 64)) m[from] = msg.c;
          break;
        }
        case "rev": {
          const m = (this.rr[msg.l] ??= {});
          if (!m[from] && isHex(msg.v, 64)) m[from] = msg.v;
          break;
        }
        case "end": {
          if (!this.ends[from] && isHex(msg.seed, 64) && isHex(msg.x, 64))
            this.ends[from] = { seed: msg.seed, x: big(msg.x) };
          break;
        }
      }
    } catch (e) {
      this._cheat(from, "malformed message: " + e.message);
    }
    this._tick();
  }

  /* ----- 1. setup: keys + shuffle. Resolves when the deck is ready ----- */
  async start() {
    this.x = scalar();
    const pk = mul(G, this.x), k = scalar(), A = mul(G, k);
    const e = await hs("key", this.id, this.me, enc(pk), enc(A));
    await this._post({ t: "key", pk: enc(pk), A: enc(A), s: sh((k + e * this.x) % N) });
    await this._wait(() => this.players.every(p => this.pk[p]));
    this.H = sum(this.players.map(p => this.pk[p]));

    const seat = this.players.indexOf(this.me);
    await this._wait(() => this.stages[seat]);       // wait for previous seat
    this.seed = b2h(rnd(32));
    const out = await shuffleDeck(this.stages[seat], this.seed, this.H);
    await this._post({ t: "shuf", seat, deck: ser(out) });
    await this._wait(() => this.deck);                // wait for last seat
    return this;
  }

  /* ----- 2. deal / reveal ----- */

  /**
   * Deal position(s) `idx` face-down to player `to`.
   * EVERY client must call this with the same arguments.
   * Resolves to the card number(s) (0..deckSize-1) for `to`, and null for everyone else.
   */
  async deal(idx, to) {
    if (Array.isArray(idx)) return Promise.all(idx.map(i => this.deal(i, to)));
    await this._wait(() => this.deck);
    this._chk(idx);
    if (this.dealt[idx] !== undefined && this.dealt[idx] !== to) throw new Error("already dealt to " + this.dealt[idx]);
    this.dealt[idx] = to;
    if (to !== this.me) { await this._share(idx); return null; }
    const others = this.players.filter(p => p !== this.me);
    await this._wait(() => others.every(p => this.shares[idx]?.[p]));
    return this._decode(idx);
  }

  /**
   * Turn position(s) `idx` face-up for everybody. Everyone calls it.
   * If a card was dealt to player X, only X's call actually "plays" it:
   * the others' shares are already public, X's share is what unlocks it.
   * Resolves to the card number(s).
   */
  async reveal(idx) {
    if (Array.isArray(idx)) return Promise.all(idx.map(i => this.reveal(i)));
    await this._wait(() => this.deck);
    this._chk(idx);
    await this._share(idx);
    await this._wait(() => this.players.every(p => this.shares[idx]?.[p]));
    return this._decode(idx);
  }

  _chk(i) { if (!Number.isInteger(i) || i < 0 || i >= this.size) throw new Error("bad position " + i); }

  /* verify one share; returns true on cheat. Fires onOpen(pos, card) when a card becomes public */
  async _verify(from, it) {
    const i = it.i;
    if (!Number.isInteger(i) || i < 0 || i >= this.size) return this._cheat(from, "bad index"), true;
    const m = (this.shares[i] ??= {});
    if (m[from]) return false;
    const c1 = this.deck[i][0], d = dec(it.d), pk = this.pk[from];
    const e = big(it.e), s = big(it.s);
    const A = sub(mul(G, s), mul(pk, e)), B = sub(mul(c1, s), mul(d, e));
    const e2 = await hs("dleq", this.id, enc(pk), enc(c1), enc(d), enc(A), enc(B));
    if (e2 !== e) return this._cheat(from, "bad decryption share"), true;
    if (!m[from]) m[from] = d;
    if (this.onOpen && this.players.every(p => m[p]) && !(this._op ??= new Set()).has(i)) {
      this._op.add(i);
      try { this.onOpen(i, this._decode(i)); } catch (err) { this._cheat(from, "invalid card"); return true; }
    }
    return false;
  }

  /* shares requested in the same tick are batched into ONE message */
  _share(i) {
    if (this.sent.has(i)) return this._fp || Promise.resolve();
    this.sent.add(i);
    (this._sq ??= []).push(i);
    return this._fp ??= new Promise(r => setTimeout(r, 0)).then(async () => {
      const q = this._sq; this._sq = []; this._fp = null;
      const list = [];
      for (const j of q) {
        const c1 = this.deck[j][0], d = mul(c1, this.x), k = scalar(), A = mul(G, k), B = mul(c1, k);
        const e = await hs("dleq", this.id, enc(this.pk[this.me]), enc(c1), enc(d), enc(A), enc(B));
        list.push({ i: j, d: enc(d), e: sh(e), s: sh((k + e * this.x) % N) });
      }
      await this._post({ t: "shares", list });
    });
  }

  _decode(i) {
    const [c1, c2] = this.deck[i];
    const ds = this.players.map(p => (p === this.me && !this.sent.has(i)) ? mul(c1, this.x) : this.shares[i][p]);
    const v = this.lookup.get(enc(sub(c2, sum(ds))));
    if (v === undefined) throw new Error("invalid card (someone cheated in the shuffle)");
    return v;
  }

  /* ----- 3. shared randomness (commit-reveal), e.g. coin flip / who starts ----- */
  /** Everyone calls with same label & max. Returns integer in [0,max). */
  async random(label, max) {
    const v = b2h(rnd(32));
    const c = b2h(await sha(`${this.id}|${label}|${this.me}|${v}`));
    await this._post({ t: "commit", l: label, c });
    await this._wait(() => this.players.every(p => this.rc[label]?.[p]));
    await this._post({ t: "rev", l: label, v });
    await this._wait(() => this.players.every(p => this.rr[label]?.[p]));
    let total = 0n;
    for (const p of this.players) {
      const rv = this.rr[label][p];
      if (b2h(await sha(`${this.id}|${label}|${p}|${rv}`)) !== this.rc[label][p]) {
        this._cheat(p, "random reveal mismatch"); this._tick();
        throw new Error("cheat: " + p);
      }
      total += big(rv);
    }
    return Number(total % BigInt(max));
  }

  /* ----- 4. end of game: prove nobody cheated ----- */
  /**
   * Reveals my seed + secret key and audits everyone's shuffle.
   * After this the table is burned (all hands become public) — make a new Table for the next game.
   * Returns { ok, cheaters[], deck[], dealt{} } where deck[pos] = card number at that position,
   * so your game can also check rule-breaking (e.g. not following suit) against dealt{}.
   */
  async end() {
    await this._post({ t: "end", seed: this.seed, x: sh(this.x) });
    await this._wait(() => this.players.every(p => this.ends[p]));
    const bad = new Set();
    for (let j = 0; j < this.n; j++) {
      const id = this.players[j], e = this.ends[id];
      if (!mul(G, e.x).equals(this.pk[id])) { bad.add(id); continue; }
      const out = await shuffleDeck(this.stages[j], e.seed, this.H);
      if (JSON.stringify(ser(out)) !== JSON.stringify(ser(this.stages[j + 1]))) bad.add(id);
    }
    const X = this.players.reduce((a, p) => (a + this.ends[p].x) % N, 0n);
    const deck = this.deck.map(([c1, c2]) => this.lookup.get(enc(sub(c2, mul(c1, X)))));
    return { ok: bad.size === 0 && deck.every(v => v !== undefined), cheaters: [...bad], deck, dealt: { ...this.dealt } };
  }
}
