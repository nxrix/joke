// Cards are identified by DECK POSITION (0..51); only the owner knows what a position holds.
// Card VALUE is 0..51: suit = floor(v/13), rank = v%13.

export const SUITS = ["♦", "♥", "♣", "♠"];
export const RANKS = ["2","3","4","5","6","7","8","9","=","J","Q","K","A"];   // "=" is the 10 in the cardr font
export const suitOf  = v => Math.floor(v / 13);
export const rankOf  = v => v % 13;
export const isRed   = v => suitOf(v) < 2;
export const cardText = v => RANKS[rankOf(v)] + SUITS[suitOf(v)];
export const cardSpan = v => `<span class="${isRed(v) ? "red" : "black"}">${cardText(v)}</span>`;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);

/* ---------- Hokm trick rules ---------- */
export function beats(a, b, lead, trump) {
  const sa = suitOf(a), sb = suitOf(b), sl = suitOf(lead);
  if (sa === trump && sb !== trump) return true;
  if (sb === trump && sa !== trump) return false;
  if (sa === sb) return rankOf(a) > rankOf(b);
  return sa === sl && sb !== sl;
}
export function trickWinner(trick, trump) {
  let best = trick[0];
  for (const play of trick.slice(1)) if (beats(play.card, best.card, trick[0].card, trump)) best = play;
  return best.seat;
}

/* ---------- the board ---------- */
// Views: 0 = me (bottom), 1 = left, 2 = across (top), 3 = right
export class Board {
  constructor(boardEl, players = 4) {
    this.boardEl = boardEl;
    this.players = players;
    this.cards = [];
    this.z = 0;
    for (let pos = 0; pos < 52; pos++) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `<div class="front"></div><div class="back"></div>`;
      boardEl.appendChild(el);
      this.cards.push(el);
      this.place(pos, { ry: 180, zi: pos / 2 });
    }
    this.tags = [0, 1, 2, 3].map(v => {
      const t = document.createElement("div");
      t.className = "nametag v" + v;
      t.style.display = "none";
      boardEl.appendChild(t);
      return t;
    });
  }

  place(pos, { x = 0, y = 0, rx = 0, ry = 0, rz = 0, s = 1, zi = 0 }) {
    const el = this.cards[pos];
    el.style.transform =
      `translateX(calc(var(--vmin)/100*${x})) translateY(calc(var(--vmin)/100*${y})) translateZ(0) ` +
      `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
    el.style.zIndex = zi;
  }

  reveal(pos, value) {
    const el = this.cards[pos];
    el.classList.toggle("red", isRed(value));
    const front = el.querySelector(".front");
    front.innerHTML = `${RANKS[rankOf(value)]}<br>${SUITS[suitOf(value)]}`;
    front.setAttribute("after-content", cardText(value));
  }

  // t2 = mine: corner index + outline. Only for cards actually in my hand.
  setMine(pos, yes) { this.cards[pos].classList.toggle("t2", !!yes); }
  setClickable(pos, fn) { this.cards[pos].onclick = fn ? () => fn(pos) : null; }
  _release(pos) { this.setMine(pos, false); this.setClickable(pos, null); }

  // hidden = a hand I am not allowed to see, drawn at the bottom (spectators watching seat 0's side)
  fan(view, positions, { onClick = null, raised = new Set(), hidden = false } = {}) {
    const m = positions.length, s = m / 2 - 0.5, k = 4;
    positions.forEach((pos, i) => {
      const b = s < 1 ? 0 : (1 - Math.sin(i * Math.PI / 2 / s)) * s / 4;
      const up = raised.has(pos) ? 4 : 0;
      const spot = [
        hidden ? { x: (i - s) * k * 1.4, y: 45 + b * 2 - up, ry: 180, rz: -(i - s) * 2, s: 1.625, zi: i + 13 }
               : { x: (i - s) * k * 1.4, y: 45 + b * 2 - up, rz: (i - s) * 2, s: 1.625, zi: i + 13 },
        { x: -45 - b * 2 + up, y: (i - s) * k, rx: 180, rz: 90 - (i - s) * 2, zi: i },
        { x: (i - s) * k, y: -45 - b * 2 + up, ry: 180, rz: 180 + (i - s) * 2, zi: m - i },
        { x: 45 + b * 2 - up, y: (i - s) * k, rx: 180, rz: 270 + (i - s) * 2, zi: m - i },
      ][view];
      this.place(pos, spot);
      this.setMine(pos, view === 0 && !hidden);
      this.setClickable(pos, view === 0 && !hidden ? onClick : null);
    });
  }

  drop(view, pos) {
    const nr = Math.random() * 10 - 5, nx = Math.random() * 5 - 2.5, ny = Math.random() * 5 - 2.5;
    const spot = [
      { x: nx, y: ny + 20, rz: nr }, { x: nx - 20, y: ny, rz: nr + 90 },
      { x: nx, y: ny - 20, rz: nr + 180 }, { x: nx + 20, y: ny, rz: nr + 270 },
    ][view];
    // Always under the hand (hand uses zi ~13+)
    this.place(pos, { ...spot, zi: 0 });
    this._release(pos);
  }

  // Won tricks pile up face-down.
  // 4p: one pile per team. 2p: one pile per player.
  pile(pos, mine, n) {
    let spot;
    if (this.players === 2) {
      spot = mine ? { x: -36 + (n % 2) * 2.5, y: 4 + n * 3, ry: 180, rz: 0, s: 0.5, zi: n }
                  : { x: 36 - (n % 2) * 2.5, y: -4 - n * 3, ry: 180, rz: 180, s: 0.5, zi: n };
    } else {
      spot = mine ? { x: -30 + n * 4, y: -30 + (n % 2) * 2.5, ry: 180, rz: 180, s: 0.5, zi: n - 5 }
                  : { x: -30 + (n % 2) * 2.5, y: 30 - n * 4, ry: 180, rz: 270, s: 0.5, zi: n - 5 };
    }
    this.place(pos, spot);
    this._release(pos);
  }

  // Discarded cards (2p), face-down.
  discard(view, pos, n) {
    this.place(pos, { x: view === 0 ? 38 : -38, y: view === 0 ? 8 : -8, ry: 180, rz: n * 7, s: 0.6, zi: n });
    this._release(pos);
  }

  showTrump(suit) {
    const box = document.getElementById("trump_board");
    if (suit === null) {
      box.classList.remove("show");
      box.style.display = "none";
    } else {
      box.style.display = "flex";
      box.classList.add("show");
      [...box.children].forEach((d, i) => d.style.display = i === suit ? "flex" : "none");
    }
  }
  askTrump() {
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
  setTag(view, text, active, mate = false) {
    const t = this.tags[view];
    t.style.display = text ? "flex" : "none";
    t.innerHTML = text || "";
    t.classList.toggle("active", !!active);
    t.classList.toggle("mate", !!mate);
  }

  async reset() {
    this.z = 0;
    this.showTrump(null);
    for (let pos = 0; pos < 52; pos++) {
      this._release(pos);
      this.place(pos, { ry: 180, zi: pos / 2 });
      await sleep(20);
    }
  }
}
