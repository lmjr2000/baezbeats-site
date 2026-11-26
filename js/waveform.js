// Canvas waveforms: the scrolling close-up view and the whole-track overview.
export const CUE_COLORS = ['#ff5a4f', '#ff9f1c', '#f4e04d', '#7bd389', '#3dd6d0', '#5b9cff', '#b388ff', '#ff7ac6'];
export const PX_PER_SEC = 120;
// Section colours: hooks in the deck's colour, everything else in greys.
const SECTION_TINT = { Intro: '#4a5060', Verse: '#6b7385', Break: '#3c4150', Outro: '#4a5060' };
export const sectionColor = (label, deckColor) => (label === 'Hook' ? deckColor : SECTION_TINT[label] || '#5b6377');

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr), hgt = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; return true; }
  return false;
}

function bandMax(peaks, i0, i1, out) {
  let l = 0, m = 0, hi = 0;
  const n = peaks.length / 3;
  if (i0 < 0) i0 = 0;
  if (i1 > n) i1 = n;
  for (let i = i0; i < i1; i++) {
    const k = i * 3;
    if (peaks[k] > l) l = peaks[k];
    if (peaks[k + 1] > m) m = peaks[k + 1];
    if (peaks[k + 2] > hi) hi = peaks[k + 2];
  }
  out[0] = l / 255; out[1] = m / 255; out[2] = hi / 255;
}

// A section name tag at the top of the close-up view.
function sectionTag(g, x, label, color, dpr, H) {
  g.font = `700 ${11 * dpr}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
  const w = g.measureText(label).width + 10 * dpr, hgt = 15 * dpr;
  const left = Math.max(0, x);
  g.fillStyle = color;
  g.fillRect(left, H - hgt, w, hgt);
  g.fillStyle = label === 'Hook' ? '#15171d' : '#ece8df';
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(label, left + 5 * dpr, H - hgt / 2 + dpr * 0.5);
}

export class ZoomWave {
  constructor(canvas, deck, colors) {
    this.canvas = canvas; this.deck = deck; this.colors = colors;
    this.g = canvas.getContext('2d');
    this.bands = [0, 0, 0];
    let startX, startPos;
    canvas.addEventListener('pointerdown', (e) => {
      if (!deck.ready) return;
      canvas.setPointerCapture(e.pointerId);
      startX = e.clientX; startPos = deck.pos;
      deck.scrubStart();
      canvas.classList.add('grabbing');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!canvas.hasPointerCapture(e.pointerId)) return;
      deck.scrubTo(startPos - ((e.clientX - startX) / PX_PER_SEC) * deck.tempo);
    });
    const end = (e) => {
      if (!canvas.hasPointerCapture(e.pointerId)) return;
      canvas.releasePointerCapture(e.pointerId);
      deck.scrubEnd();
      canvas.classList.remove('grabbing');
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  draw() {
    fit(this.canvas);
    const { g, deck, canvas } = this;
    const W = canvas.width, H = canvas.height, mid = H / 2;
    const dpr = W / (canvas.clientWidth || 1);
    g.clearRect(0, 0, W, H);
    if (!deck.track) return;
    const pos = deck.pos;
    const secPerPx = deck.tempo / (PX_PER_SEC * dpr);   // source seconds per device pixel
    const cx = Math.round(W / 2);
    const t0 = pos - cx * secPerPx;
    const xOf = (t) => (t - t0) / secPerPx;

    // loop region
    if (deck.loop) {
      const a = Math.max(0, xOf(deck.loop.start)), b = Math.min(W, xOf(deck.loop.end));
      if (b > a) { g.fillStyle = this.colors.loop; g.fillRect(a, 0, b - a, H); }
    }

    // waveform: bass, mids and highs layered
    if (deck.peaks) {
      const step = Math.max(1, Math.round(dpr));
      const rate = deck.peaksRate;
      const low = new Path2D(), midP = new Path2D(), high = new Path2D();
      const b = this.bands;
      for (let x = 0; x < W; x += step) {
        const ta = t0 + x * secPerPx;
        if (ta < 0 || ta > deck.duration) continue;
        const i0 = Math.floor(ta * rate), i1 = Math.max(i0 + 1, Math.floor((ta + step * secPerPx) * rate));
        bandMax(deck.peaks, i0, i1, b);
        const hl = Math.min(1, b[0] * 1.5) * mid * 0.96, hm = Math.min(1, b[1] * 1.7) * mid * 0.8, hh = Math.min(1, b[2] * 1.6) * mid * 0.5;
        if (hl > 0.5) low.rect(x, mid - hl, step, hl * 2);
        if (hm > 0.5) midP.rect(x, mid - hm, step, hm * 2);
        if (hh > 0.5) high.rect(x, mid - hh, step, hh * 2);
      }
      g.fillStyle = this.colors.low; g.fill(low);
      g.fillStyle = this.colors.mid; g.fill(midP);
      g.fillStyle = this.colors.high; g.fill(high);
    } else {
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(Math.max(0, xOf(0)), mid - 1, Math.min(W, xOf(deck.duration)) - Math.max(0, xOf(0)), 2);
    }

    // beat grid (every fourth beat is stronger)
    if (deck.bpm) {
      const beat = deck.beatLen;
      let n = Math.ceil((t0 - deck.firstBeat) / beat);
      for (; ; n++) {
        const t = deck.firstBeat + n * beat;
        const x = Math.round(xOf(t));
        if (x > W) break;
        if (t < 0 || t > deck.duration) continue;
        // strong ticks mark the backbeat (snare) when one was found, else every fourth beat
        let bar = ((n % 4) + 4) % 4 === 0;
        if (deck.snarePeriod) {
          const k = (t - deck.snareFirst) / deck.snarePeriod;
          bar = Math.abs(k - Math.round(k)) < 0.05;
        }
        g.fillStyle = bar ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.32)';
        // ticks at the top and bottom edges, so the waveform stays readable
        const len = bar ? H * 0.2 : H * 0.1;
        g.fillRect(x, 0, Math.max(1, dpr), len); g.fillRect(x, H - len, Math.max(1, dpr), len);
      }
    }

    // phrase starts (every 8 bars) and section names
    const grid = deck.grid;
    if (grid) {
      const len = grid.bar * grid.phraseBars, first = grid.downbeat + grid.offset * grid.bar;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (let k = Math.ceil((t0 - first) / len); ; k++) {
        const t = first + k * len, x = Math.round(xOf(t));
        if (x > W) break;
        if (t < 0 || t > deck.duration) continue;
        g.fillRect(x, 0, Math.max(1, dpr * 1.5), H);
      }
    }
    for (const sec of deck.sections) {
      const x = Math.round(xOf(sec.start));
      if (x > W || xOf(sec.end) < 0) continue;
      sectionTag(g, x, sec.label, sectionColor(sec.label, this.colors.mid), dpr, H);
    }

    // track start / end
    g.fillStyle = 'rgba(255,255,255,0.5)';
    for (const t of [0, deck.duration]) { const x = xOf(t); if (x >= 0 && x <= W) g.fillRect(x - dpr, 0, 2 * dpr, H); }

    // cue point and hot cues
    const flag = (t, color, label) => {
      const x = Math.round(xOf(t));
      if (x < -20 || x > W + 20) return;
      g.fillStyle = color;
      g.fillRect(x, 0, Math.max(1, dpr * 1.5), H);
      if (label) {
        const s = 15 * dpr;
        g.fillRect(x, 0, s, s);
        g.fillStyle = '#14161b'; g.font = `700 ${11 * dpr}px "Avenir Next Condensed", "Arial Narrow", sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(label, x + s / 2, s / 2 + dpr);
      } else {
        g.beginPath(); g.moveTo(x - 6 * dpr, H); g.lineTo(x + 6 * dpr, H); g.lineTo(x, H - 9 * dpr); g.fill();
      }
    };
    flag(deck.cuePoint, '#ffffff');
    deck.hotcues.forEach((t, i) => { if (t != null) flag(t, CUE_COLORS[i], String(i + 1)); });

    // playhead
    g.fillStyle = '#fff';
    g.fillRect(cx - dpr, 0, 2 * dpr, H);
  }
}

export class Overview {
  constructor(canvas, deck, colors) {
    this.canvas = canvas; this.deck = deck; this.colors = colors;
    this.g = canvas.getContext('2d');
    this.cache = document.createElement('canvas');
    this.dirty = true;
    for (const ev of ['load', 'analysis', 'ready']) deck.addEventListener(ev, () => { this.dirty = true; });
    canvas.title = 'Click to jump. The strip along the bottom shows the song sections; hooks are in colour.';
    const seek = (e) => {
      const r = canvas.getBoundingClientRect();
      deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
    };
    canvas.addEventListener('pointerdown', (e) => { if (deck.ready) { canvas.setPointerCapture(e.pointerId); seek(e); } });
    canvas.addEventListener('pointermove', (e) => { if (canvas.hasPointerCapture(e.pointerId)) seek(e); });
  }

  render() {
    const { cache, canvas, deck } = this;
    cache.width = canvas.width; cache.height = canvas.height;
    const g = cache.getContext('2d');
    const W = cache.width, H = cache.height, mid = H / 2;
    if (!deck.peaks || !deck.duration) return;
    const n = deck.peaks.length / 3, b = [0, 0, 0];
    const total = deck.duration * deck.peaksRate;
    for (const [band, color, scale, gain] of [[0, this.colors.low, 0.98, 1.5], [1, this.colors.mid, 0.8, 1.7], [2, this.colors.high, 0.45, 1.6]]) {
      g.fillStyle = color;
      for (let x = 0; x < W; x++) {
        bandMax(deck.peaks, Math.floor((x / W) * total), Math.min(n, Math.max(Math.floor(((x + 1) / W) * total), Math.floor((x / W) * total) + 1)), b);
        const hgt = Math.min(1, b[band] * gain) * mid * scale;
        if (hgt > 0.5) g.fillRect(x, mid - hgt, 1, hgt * 2);
      }
    }
  }

  draw() {
    if (fit(this.canvas)) this.dirty = true;
    const { g, deck, canvas } = this;
    const W = canvas.width, H = canvas.height;
    if (this.dirty) { this.render(); this.dirty = false; }
    g.clearRect(0, 0, W, H);
    if (!deck.track || !deck.duration) return;
    const dpr = W / (canvas.clientWidth || 1);
    if (deck.peaks) g.drawImage(this.cache, 0, 0);
    const xOf = (t) => (t / deck.duration) * W;
    // played part dimmed
    g.fillStyle = 'rgba(23,26,33,0.62)';
    g.fillRect(0, 0, xOf(deck.pos), H);
    if (deck.loop) { g.fillStyle = this.colors.loop; g.fillRect(xOf(deck.loop.start), 0, Math.max(2, xOf(deck.loop.end) - xOf(deck.loop.start)), H); }
    g.fillStyle = '#fff';
    g.fillRect(xOf(deck.cuePoint) - dpr / 2, H - 5 * dpr, dpr, 5 * dpr);
    deck.hotcues.forEach((t, i) => {
      if (t == null) return;
      g.fillStyle = CUE_COLORS[i];
      g.fillRect(xOf(t) - dpr, 0, 2 * dpr, 6 * dpr);
    });
    // song sections along the bottom edge
    for (const sec of deck.sections) {
      g.fillStyle = sectionColor(sec.label, this.colors.mid);
      g.fillRect(xOf(sec.start), H - 4 * dpr, Math.max(1, xOf(sec.end) - xOf(sec.start) - dpr), 4 * dpr);
    }
    g.fillStyle = '#fff';
    g.fillRect(xOf(deck.pos) - dpr, 0, 2 * dpr, H);
  }
}
