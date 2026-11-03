// hokm.js — Hokm rules and game flow for 2 or 4 players.
// Layers: room.js (nostr + lobby + chat) → deck.js (shuffled deck) → this file (rules) → cards.js (visuals)
//
// Deck positions 0..51 are the identity of a card. Only the owner knows what a position holds.
// H.cards[seat] = positions in that seat's hand; H.known[tableId][pos] = card values I may see.
import { Room } from "./room.js?v=10";
import { Board, SUITS, suitOf, rankOf, cardSpan, beats, trickWinner, sleep, range, initViewport } from "./cards.js?v=10";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => "&#" + c.charCodeAt() + ";");
const suitSpan = s => `<span class="${s < 2 ? "red" : "black"}">${SUITS[s]}</span>`;
const TRICKS_TO_WIN = 7;
const POINTS_TO_WIN = 7;

export function runHokm(startN) {
  initViewport();
  let N = startN;
  const board = new Board($("board"), N);
  const bar = $("bar");
  const room = new Room({
    seatCount: N, lobbyEl: $("lobby"), logEl: $("log"), chatInput: $("chat"),
    onStart, onLobby, onModeChange(n) { N = n; board.players = n; },
  });

  let G = null;        // game across hands: { n, score:[t0,t1], king, gen }
  let H = null;        // current hand
  let tables = {};
  let mySeat = 0;

  // 4p: teams {0,2} and {1,3}. 2p: each seat is its own team.
  const teamOf = s => (N === 4 ? s % 2 : s);
  const myTeam = () => teamOf(mySeat);
  // Views: 0 = me (bottom), 1 = left, 2 = across, 3 = right.
  const viewOf = s => (N === 2 ? (s === mySeat ? 0 : 2) : (s - mySeat + 4) % 4);
  const nameOfSeat = s => room.nameOf(H.seats[s]);
  const setBar = html => { bar.style.display = html ? "flex" : "none"; bar.innerHTML = html || ""; bar.onclick = null; };

  /* =====================================================================
     GAME START / END
     ===================================================================== */
  function onStart() {
    mySeat = room.seats.indexOf(room.me);
    G = { n: 0, score: [0, 0], king: null, gen: room.gameId };
    board.setScore(0, 0);
    room.log(`Game started - first to ${POINTS_TO_WIN} points.`);
    runHands(G);
  }

  function onLobby() {
    G = null; H = null; tables = {};
    setBar("");
    for (let v = 0; v < 4; v++) board.setTag(v, "", false);
    for (const id of ["counter_t1", "counter_t2"]) $(id).style.opacity = 0;
    board.reset();
  }

  async function runHands(g) {
    try {
      while (G === g) if (await playHand(g)) break;
    } catch (e) {
      room.log("⚠ " + esc(e.message));
      console.error(e);
    }
  }

  /* =====================================================================
     ONE HAND
     ===================================================================== */
  async function playHand(g) {
    const id = g.gen + "." + g.n++;
    const seats = room.seats.slice();
    if (g.n > 1) { setBar(""); await board.reset(); }

    H = {
      id, seats, king: g.king, trump: null,
      cards: seats.map(() => []),
      owner: {},
      known: {},
      disc: seats.map(() => 0),
      won: [0, 0],
      trick: [], plays: [], pending: [],
      turn: null, playing: false, hold: false, sent: false, step: 0, botStep: -1, finish: null,
    };

    tables = room.createTables(id, {
      onOpen: (pos, card) => onOpen(id, pos, card),
      onCheat: (who, why) => room.log(`⚠ ${room.nameOf(who)}: ${esc(why)}`),
    });
    for (const pid of Object.keys(tables)) H.known[pid] = {};
    const all = Object.values(tables);

    room.log("Shuffling…");
    await Promise.all(all.map(t => t.start()));

    if (H.king === null) {
      const picks = await Promise.all(all.map(t => t.random("king", N)));
      H.king = g.king = picks[0];
    }
    room.log(`<b>${nameOfSeat(H.king)}</b> is the King 👑`);
    updateTags();

    if (N === 4) await dealFour(H.king); else await dealTwo(H.king);

    H.playing = true;
    H.turn = H.king;
    return new Promise(resolve => { H.finish = resolve; refresh(); drain(); });
  }

  /* ---------- dealing ---------- */

  async function dealTo(seat, ps) {
    ps.forEach(p => (H.owner[p] = seat));
    const to = H.seats[seat];
    await Promise.all(Object.entries(tables).map(async ([pid, t]) => {
      const cards = await t.deal(ps, to);
      if (pid !== to) return;
      ps.forEach((p, i) => {
        H.known[pid][p] = cards[i];
        if (pid === room.me) board.reveal(p, cards[i]);
      });
    }));
  }
  const addHand = (seat, ps) => H.cards[seat].push(...ps);

  // 4p: 5 each → trump → 8 more each.
  async function dealFour(hk) {
    const batch = (from, size) => Promise.all(range(0, 4).map(async i => {
      const s = (hk + i) % 4, ps = range(from + size * i, size);
      await dealTo(s, ps); addHand(s, ps);
    }));
    await batch(0, 5); layout();
    await chooseTrump(hk);
    await batch(20, 8); layout();
  }

  // 2p: King gets 5, names trump, discards 3. Other gets 5, discards 2.
  // Then alternate drawing from stock: look at top card privately;
  // keep it → also look at the next card and discard that face-down;
  // or skip it → discard it and must take the next card.
  async function dealTwo(hk) {
    const ot = 1 - hk;
    await dealTo(hk, range(0, 5)); addHand(hk, range(0, 5)); layout();
    await chooseTrump(hk);
    await discardPhase(hk, 3);
    await dealTo(ot, range(5, 5)); addHand(ot, range(5, 5)); layout();
    await discardPhase(ot, 2);

    const draws = 21;
    const drawer = d => (d % 2 ? ot : hk);
    let next = dealTo(drawer(0), [10]);
    for (let d = 0; d < draws; d++) {
      const s = drawer(d), pid = H.seats[s], p = 10 + 2 * d;
      await next;
      next = d + 1 < draws ? dealTo(drawer(d + 1), [p + 2]) : null;

      // Show the offered card face-up in the middle. No "mine" outline until it is kept.
      board.place(p, { x: 14, y: 0, ry: pid === room.me ? 0 : 180, s: 1.1, zi: 90 });
      board.setMine(p, false);
      if (pid === room.me) room.send({ k: "draw", g: H.id, d, keep: await askKeep() });
      else if (room.isHost && room.isBot(pid)) { await sleep(700); room.send({ k: "draw", g: H.id, d, keep: botKeep(pid, p) }, pid); }
      const keep = !!(await room.waitFor((from, m) => m.k === "draw" && m.g === H.id && m.d === d && from === pid)).p.keep;

      if (keep) {
        // Rules: keep first → it joins the hand, then look at the next card and discard it face-down.
        addHand(s, [p]);
        layout();
        await sleep(pid === room.me ? 350 : 150);
        await dealTo(s, [p + 1]);
        board.place(p + 1, { x: 14, y: 0, ry: pid === room.me ? 0 : 180, s: 1.1, zi: 90 });
        board.setMine(p + 1, false);
        await sleep(pid === room.me ? 900 : 400);
        throwAway(s, p + 1);
      } else {
        throwAway(s, p);
        await dealTo(s, [p + 1]);
        addHand(s, [p + 1]);
      }
      layout();
    }
  }
  const throwAway = (seat, p) => board.discard(viewOf(seat), p, H.disc[seat]++);

  async function chooseTrump(hk) {
    const pid = H.seats[hk];
    if (pid === room.me) {
      setBar("<span>Choose trump</span>");
      const s = await board.askTrump();
      setBar("");
      room.send({ k: "trump", g: H.id, s });
    } else if (room.isHost && room.isBot(pid)) {
      await sleep(900);
      room.send({ k: "trump", g: H.id, s: botTrump(hk) }, pid);
    }
    const s = (await room.waitFor((from, m) => m.k === "trump" && m.g === H.id && from === pid)).p.s;
    if (!Number.isInteger(s) || s < 0 || s > 3) throw new Error("bad trump");
    H.trump = s;
    board.showTrump(s);
    room.log(`Trump: ${suitSpan(s)}`);
  }

  async function discardPhase(seat, count) {
    const pid = H.seats[seat];
    if (pid === room.me) room.send({ k: "disc", g: H.id, p: await pickCards(count, `Discard ${count} card${count > 1 ? "s" : ""}`) });
    else if (room.isHost && room.isBot(pid)) { await sleep(800); room.send({ k: "disc", g: H.id, p: botDiscard(seat, count) }, pid); }
    const ps = (await room.waitFor((from, m) => m.k === "disc" && m.g === H.id && from === pid)).p.p;
    if (!Array.isArray(ps) || ps.length !== count || new Set(ps).size !== count || !ps.every(p => H.cards[seat].includes(p)))
      throw new Error(`illegal discard by ${pid.slice(0, 6)}`);
    H.cards[seat] = H.cards[seat].filter(p => !ps.includes(p));
    ps.forEach(p => throwAway(seat, p));
    layout();
  }

  /* ---------- small UIs ---------- */
  function pickCards(count, title) {
    return new Promise(resolve => {
      const chosen = new Set();
      const draw = () => {
        layout({ pick, raised: chosen });
        setBar(`<span>${title}</span><button data-b="ok" ${chosen.size === count ? "" : "disabled"}>OK</button>`);
        bar.onclick = e => {
          if (e.target.dataset.b !== "ok" || chosen.size !== count) return;
          setBar(""); layout(); resolve([...chosen]);
        };
      };
      const pick = pos => { if (chosen.has(pos)) chosen.delete(pos); else if (chosen.size < count) chosen.add(pos); draw(); };
      draw();
    });
  }
  function askKeep() {
    return new Promise(resolve => {
      setBar(`<span>Keep this card? (skip = take the next one instead)</span><button data-b="1">Keep</button><button data-b="0">Skip</button>`);
      bar.onclick = e => { const b = e.target.dataset.b; if (b === undefined) return; setBar(""); resolve(b === "1"); };
    });
  }

  /* =====================================================================
     PLAYING
     ===================================================================== */
  const canPlayNow = () => H.playing && H.turn === mySeat && !H.hold && !H.sent;

  function legalPositions(seat, valueOf) {
    const ps = H.cards[seat];
    if (!H.trick.length) return ps;
    const led = suitOf(H.trick[0].card);
    const follow = ps.filter(p => suitOf(valueOf(p)) === led);
    return follow.length ? follow : ps;
  }

  function playMine(pos) {
    if (!canPlayNow() || !legalPositions(mySeat, p => H.known[room.me][p]).includes(pos)) return;
    H.sent = true;
    layout();
    tables[room.me].reveal(pos).catch(e => room.log("⚠ " + esc(e.message)));
  }

  function onOpen(id, pos, card) {
    if (!H || H.id !== id) return;
    H.pending.push([pos, card]);
    if (H.playing) drain();
  }
  function drain() {
    for (;;) {
      const i = H.pending.findIndex(([p]) => H.turn !== null && H.owner[p] === H.turn && H.cards[H.turn].includes(p));
      if (i < 0) return;
      const [[pos, card]] = H.pending.splice(i, 1);
      onPlay(pos, card);
      if (!H.playing) return;
    }
  }

  function onPlay(pos, card) {
    const seat = H.turn;
    H.plays.push({ seat, pos, led: H.trick.length ? suitOf(H.trick[0].card) : null, hand: H.cards[seat].slice() });
    H.known[room.me][pos] = card;
    board.reveal(pos, card);
    H.cards[seat] = H.cards[seat].filter(p => p !== pos);
    board.drop(viewOf(seat), pos);
    H.trick.push({ seat, card, pos });
    H.sent = false; H.step++;
    room.log(`${nameOfSeat(seat)}: ${cardSpan(card)}`);

    if (H.trick.length < N) { H.turn = (seat + 1) % N; return refresh(); }

    const winner = trickWinner(H.trick, H.trump), team = teamOf(winner), n = H.won[team]++;
    const trick = H.trick, last = H.won[team] >= TRICKS_TO_WIN, id = H.id;
    H.trick = []; H.turn = winner; H.hold = true;
    if (last) H.playing = false;
    room.log(`<b>${nameOfSeat(winner)}</b> wins the trick`);
    refresh();
    setTimeout(() => {
      if (!H || H.id !== id) return;
      trick.forEach(pl => board.pile(pl.pos, team === myTeam(), n));
      H.hold = false;
      if (last) finishHand(); else refresh();
    }, 1100);
  }

  /* ---------- bots ---------- */
  const weight = v => rankOf(v) + (suitOf(v) === H.trump ? 20 : 0);

  function botPlay(seat) {
    const K = H.known[H.seats[seat]], val = p => K[p];
    const lowest = list => list.reduce((m, p) => (weight(val(p)) < weight(val(m)) ? p : m));
    const highest = list => list.reduce((m, p) => (weight(val(p)) > weight(val(m)) ? p : m));
    const legal = legalPositions(seat, val);
    if (!H.trick.length) {
      const plain = legal.filter(p => suitOf(val(p)) !== H.trump);
      return plain.length ? highest(plain) : lowest(legal);
    }
    const winSeat = trickWinner(H.trick, H.trump);
    if (N === 4 && winSeat === (seat + 2) % 4) return lowest(legal);
    const winCard = H.trick.find(t => t.seat === winSeat).card, lead = H.trick[0].card;
    const winners = legal.filter(p => beats(val(p), winCard, lead, H.trump));
    return winners.length ? lowest(winners) : lowest(legal);
  }
  function botTrump(seat) {
    const K = H.known[H.seats[seat]], count = [0, 0, 0, 0];
    H.cards[seat].forEach(p => (count[suitOf(K[p])] += 1 + rankOf(K[p]) / 100));
    return count.indexOf(Math.max(...count));
  }
  function botDiscard(seat, count) {
    const K = H.known[H.seats[seat]];
    return H.cards[seat].slice().sort((a, b) => weight(K[a]) - weight(K[b])).slice(0, count);
  }
  const botKeep = (pid, p) => { const v = H.known[pid][p]; return suitOf(v) === H.trump || rankOf(v) >= 9; };

  function scheduleBot() {
    if (!room.isHost || !H.playing || H.hold) return;
    const seat = H.turn, pid = H.seats[seat];
    if (!room.isBot(pid) || H.botStep === H.step) return;
    H.botStep = H.step;
    const id = H.id, step = H.step;
    setTimeout(() => {
      if (H && H.id === id && H.step === step && H.playing)
        tables[pid].reveal(botPlay(seat)).catch(e => room.log("⚠ " + esc(e.message)));
    }, 900);
  }

  /* =====================================================================
     END OF HAND
     ===================================================================== */
  async function finishHand() {
    const h = H, g = G, my = myTeam();
    const win = h.won[0] > h.won[1] ? 0 : 1, loserTricks = h.won[1 - win], kingTeam = teamOf(h.king);
    // 1 point for a win, 2 for a kot (7-0), 3 for a king kot (King's side gets 7-0'd)
    const pts = loserTricks > 0 ? 1 : win === kingTeam ? 2 : 3;
    g.score[win] += pts;
    board.setScore(g.score[my], g.score[1 - my]);
    const who = N === 4 ? (win === my ? "Your team" : "The other team") : (win === mySeat ? "You" : room.nameOf(h.seats[win]));
    room.log(`Hand over ${h.won[my]}-${h.won[1 - my]}. <b>${who}</b> +${pts}` + (pts === 2 ? " (kot!)" : pts === 3 ? " (king kot!!)" : "") +
      ` - score ${g.score[my]}-${g.score[1 - my]}`);

    if (win !== kingTeam) g.king = N === 4 ? (h.king + 1) % 4 : 1 - h.king;

    const audits = Object.values(tables).map(t => t.end().then(r => ({ t, r }), err => ({ t, err })));
    const done = await Promise.race([Promise.all(audits), sleep(10000).then(() => null)]);
    if (!done) room.log("Audit timed out (somebody left?)");
    else for (const { t, r, err } of done) if (t.me === room.me) room.log(auditText(h, r, err));

    if (g.score[win] >= POINTS_TO_WIN) {
      const text = N === 4 ? (win === my ? "Your team wins!" : "The other team wins!") : (win === mySeat ? "You win!" : `${room.nameOf(h.seats[win])} wins!`);
      room.gameOver(`${text} ${g.score[my]}-${g.score[1 - my]}`);
      return h.finish(true);
    }
    await sleep(2000);
    h.finish(false);
  }

  function auditText(h, r, err) {
    if (err) return "⚠ " + esc(err.message);
    if (!r.ok) return "⚠ Audit failed: " + r.cheaters.map(room.nameOf.bind(room)).join(", ");
    const bad = new Set();
    for (const pl of h.plays) {
      if (pl.led !== null && suitOf(r.deck[pl.pos]) !== pl.led && pl.hand.some(p => suitOf(r.deck[p]) === pl.led)) bad.add(pl.seat);
    }
    return bad.size ? "⚠ Didn't follow suit: " + [...bad].map(s => room.nameOf(h.seats[s])).join(", ") : "Shuffle audit ✓";
  }

  /* =====================================================================
     RENDERING
     ===================================================================== */
  function layout(opts = {}) {
    if (!H) return;
    for (let s = 0; s < N; s++) {
      const mine = s === mySeat, K = H.known[room.me];
      const ps = H.cards[s].slice();
      if (mine) ps.sort((a, b) => K[a] - K[b]);
      board.fan(viewOf(s), ps, { raised: mine ? opts.raised : undefined });
    }
    if (opts.pick) H.cards[mySeat].forEach(p => board.setClickable(p, opts.pick));
    else if (canPlayNow()) legalPositions(mySeat, p => H.known[room.me][p]).forEach(p => board.setClickable(p, playMine));
  }

  function updateTags() {
    for (let v = 0; v < 4; v++) board.setTag(v, "", false);
    const showTricks = H.playing || H.won[0] + H.won[1] > 0;
    H.seats.forEach((pid, s) => {
      const mate = N === 4 && teamOf(s) === myTeam();
      const text = `<span>${room.nameOf(pid)}${H.king === s ? " 👑" : ""}</span>` + (showTricks ? `<span class="tk">${H.won[teamOf(s)]}</span>` : "");
      board.setTag(viewOf(s), text, H.playing && H.turn === s, mate);
    });
  }

  function refresh() {
    layout();
    updateTags();
    scheduleBot();
  }
}
