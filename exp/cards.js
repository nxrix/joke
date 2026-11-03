// Cards are identified by DECK POSITION (0..51), because only the owner knows what a position holds.
// A card VALUE is a number 0..51:  suit = floor(v/13), rank = v%13.

export const SUITS = ["♦", "♥", "♣", "♠"];
export const RANKS = ["2","3","4","5","6","7","8","9","=","J","Q","K","A"];   // "=" is the 10 in the cardr font
export const suitOf  = v => Math.floor(v / 13);
export const rankOf  = v => v % 13;
export const isRed   = v => suitOf(v) < 2;
export const cardText = v => RANKS[rankOf(v)] + SUITS[suitOf(v)];
export const cardSpan = v => `<span class="${isRed(v) ? "red" : "black"}">${cardText(v)}</span>`;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);

/* ---------- Hokm trick rules (same as joke) ---------- */
// Does card a beat card b? `lead` is the first card of the trick.
export function beats(a, b, lead, trump) {
  const sa = suitOf(a), sb = suitOf(b), sl = suitOf(lead);
  if (sa === trump && sb !== trump) return true;
  if (sb === trump && sa !== trump) return false;
  if (sa === sb) return rankOf(a) > rankOf(b);
  return sa === sl && sb !== sl;
}
// trick = [{seat, card}, ...] in play order -> winning seat
export function trickWinner(trick, trump) {
  let best = trick[0];
  for (const play of trick.slice(1)) if (beats(play.card, best.card, trick[0].card, trump)) best = play;
  return best.seat;
}

/* ---------- make the vmin-based sizing work (from joke) ---------- */
export function initViewport() {
  const root = document.documentElement;
  const resize = () => {
    const w = innerWidth, h = innerHeight;
    root.style.setProperty("--vw", w + "px");
    root.style.setProperty("--vh", h + "px");
    root.style.setProperty("--vmin", Math.min(w, h) + "px");
    root.style.setProperty("--vmax", Math.max(w, h) + "px");
  };
  resize();
  addEventListener("resize", resize);
}

/* ---------- the board ---------- */
// Views: 0 = me (bottom), 1 = left, 2 = across (top), 3 = right
export class Board {
  constructor(boardEl) {
    this.boardEl = boardEl;
    this.cards = [];
    this.z = 60;                         // z-index counter for cards dropped on the table
    for (let pos = 0; pos < 52; pos++) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `<div class="front"></div><div class="back"></div>`;
      boardEl.appendChild(el);
      this.cards.push(el);
      this.place(pos, { ry: 180, zi: pos / 2 });      // everything starts as a face-down stack
    }
    this.tags = [0, 1, 2, 3].map(v => {
      const t = document.createElement("div");
      t.className = "nametag v" + v;
      t.style.display = "none";
      boardEl.appendChild(t);
      return t;
    });
  }

  // Low-level: move a card. x/y are in vmin/100 units, angles in degrees.
  place(pos, { x = 0, y = 0, rx = 0, ry = 0, rz = 0, s = 1, zi = 0 }) {
    const el = this.cards[pos];
    el.style.transform =
      `translateX(calc(var(--vmin)/100*${x})) translateY(calc(var(--vmin)/100*${y})) translateZ(0) ` +
      `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
    el.style.zIndex = zi;
  }

  // Write a card value on the front of a position (do this when the value becomes known to me).
  reveal(pos, value) {
    const el = this.cards[pos];
    el.classList.toggle("red", isRed(value));
    const front = el.querySelector(".front");
    front.innerHTML = `${RANKS[rankOf(value)]}<br>${SUITS[suitOf(value)]}`;
    front.setAttribute("after-content", cardText(value));
  }

  setClickable(pos, fn) {
    const el = this.cards[pos];
    el.classList.toggle("t2", !!fn);
    el.onclick = fn ? () => fn(pos) : null;
  }

  // Lay out one player's hand as a fan. My own hand is face-up and clickable; others are face-down.
  fan(view, positions, { onClick = null, raised = new Set() } = {}) {
    const m = positions.length, s = m / 2 - 0.5, k = 4;
    positions.forEach((pos, i) => {
      const b = s < 1 ? 0 : (1 - Math.sin(i * Math.PI / 2 / s)) * s / 4;
      const up = raised.has(pos) ? 4 : 0;
      const spot = [
        { x: (i - s) * k * 1.4, y: 45 + b * 2 - up, rz: (i - s) * 2, s: 1.625, zi: i + 13 },
        { x: -45 - b * 2 + up, y: (i - s) * k, rx: 180, rz: 90 - (i - s) * 2, zi: i },
        { x: (i - s) * k, y: -45 - b * 2 + up, ry: 180, rz: 180 + (i - s) * 2, zi: m - i },
        { x: 45 + b * 2 - up, y: (i - s) * k, rx: 180, rz: 270 + (i - s) * 2, zi: m - i },
      ][view];
      this.place(pos, spot);
      this.setClickable(pos, view === 0 ? onClick : null);
    });
  }

  // Put a played card in front of its player.
  drop(view, pos) {
    const nr = Math.random() * 10 - 5, nx = Math.random() * 5 - 2.5, ny = Math.random() * 5 - 2.5;
    const spot = [
      { x: nx, y: ny + 20, rz: nr }, { x: nx - 20, y: ny, rz: nr + 90 },
      { x: nx, y: ny - 20, rz: nr + 180 }, { x: nx + 20, y: ny, rz: nr + 270 },
    ][view];
    this.place(pos, { ...spot, zi: this.z++ });
    this.setClickable(pos, null);
  }

  // Won tricks pile up face-down: mine = my team's pile, otherwise the other team's. n = tricks already in it.
  pile(pos, mine, n) {
    this.place(pos, mine
      ? { x: -30 + n * 4, y: -30 + (n % 2) * 2.5, ry: 180, rz: 180, s: 0.5, zi: n - 5 }
      : { x: -30 + (n % 2) * 2.5, y: 30 - n * 4, ry: 180, rz: 270, s: 0.5, zi: n - 5 });
    this.setClickable(pos, null);
  }

  // Discarded cards (2-player game), face-down.
  discard(view, pos, n) {
    this.place(pos, { x: view === 0 ? 36 : -36, y: view === 0 ? 32 : -32, ry: 180, rz: n * 7, s: 0.6, zi: n });
    this.setClickable(pos, null);
  }

  showTrump(suit) {   // suit = 0..3, or null to hide
    const box = document.getElementById("trump_board");
    box.style.display = suit === null ? "none" : "flex";
    [...box.children].forEach((d, i) => d.style.display = i === suit ? "flex" : "none");
  }
  askTrump() {        // shows the 4 big suit buttons, resolves to 0..3
    return new Promise(resolve => {
      const b = document.getElementById("select_trump_board");
      b.classList.add("active");
      [...b.children].forEach((d, i) => d.onclick = () => { b.classList.remove("active"); resolve(i); });
    });
  }
  setScore(mine, theirs) {
    for (const [id, v] of [["counter_t1", mine], ["counter_t2", theirs]]) {
      const el = document.getElementById(id); el.style.opacity = 1; el.textContent = v;
    }
  }
  setTag(view, text, active) {
    const t = this.tags[view];
    t.style.display = text ? "block" : "none";
    t.innerHTML = text || "";
    t.classList.toggle("active", !!active);
  }

  async reset() {     // everything back to the stack
    this.z = 60;
    this.showTrump(null);
    for (let pos = 0; pos < 52; pos++) {
      this.setClickable(pos, null);
      this.place(pos, { ry: 180, zi: pos / 2 });
      await sleep(20);
    }
  }
}
