// 16-step drum sequencer that locks to a deck's beat. The kit is synthesised here, so there
// are no sample files to license; drop your own sounds onto a row to replace one.
import { h, knob, toast } from './controls.js';
import { ctx, engine } from './engine.js';

const SR = 44100;
const STEPS = 16;

// ---------- drum synthesis ----------
function render(seconds, fn) {
  const n = Math.floor(SR * seconds);
  const buf = ctx.createBuffer(1, n, SR);
  const d = buf.getChannelData(0);
  fn(d, n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < n; i++) d[i] *= 0.9 / peak;
  return buf;
}
const noise = () => Math.random() * 2 - 1;
function highpass(d, hz) {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  let lp = 0;
  for (let i = 0; i < d.length; i++) { lp = a * lp + (1 - a) * d[i]; d[i] -= lp; }
}
function sweep(d, n, f0, f1, tFreq, tAmp) {
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / tFreq))) / SR;
    d[i] += Math.sin(ph) * Math.exp(-t / tAmp);
  }
}

const KIT = [
  ['Kick', () => render(0.5, (d, n) => { sweep(d, n, 160, 46, 0.03, 0.16); for (let i = 0; i < 80; i++) d[i] += noise() * 0.3 * (1 - i / 80); })],
  ['Snare', () => render(0.3, (d, n) => {
    for (let i = 0; i < n; i++) d[i] = noise() * Math.exp(-i / SR / 0.07);
    highpass(d, 1200); sweep(d, n, 240, 170, 0.02, 0.06);
  })],
  ['Clap', () => render(0.35, (d, n) => {
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const burst = t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : Math.exp(-(t - 0.03) / 0.07);
      d[i] = noise() * burst;
    }
    highpass(d, 900);
  })],
  ['Closed hat', () => render(0.08, (d, n) => { for (let i = 0; i < n; i++) d[i] = noise() * Math.exp(-i / SR / 0.015); highpass(d, 7000); })],
  ['Open hat', () => render(0.4, (d, n) => { for (let i = 0; i < n; i++) d[i] = noise() * Math.exp(-i / SR / 0.11); highpass(d, 6000); })],
  ['Tom', () => render(0.4, (d, n) => sweep(d, n, 230, 110, 0.06, 0.14))],
  ['Rim', () => render(0.08, (d, n) => {
    for (let i = 0; i < n; i++) { const t = i / SR; d[i] = (Math.sin(2 * Math.PI * 820 * t) + 0.6 * Math.sin(2 * Math.PI * 1730 * t)) * Math.exp(-t / 0.012); }
  })],
  ['Cowbell', () => render(0.3, (d, n) => {
    for (let i = 0; i < n; i++) { const t = i / SR; d[i] = (Math.sign(Math.sin(2 * Math.PI * 562 * t)) + Math.sign(Math.sin(2 * Math.PI * 845 * t))) * Math.exp(-t / 0.08); }
    highpass(d, 500);
  })],
];

const STARTER = {
  0: [0, 4, 8, 12], 1: [4, 12], 3: [0, 2, 4, 6, 8, 10, 12, 14], 4: [14],
};

export function buildSequencer(decks) {
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(engine.masterIn);

  const rows = KIT.map(([name, make]) => ({ name, buffer: make(), muted: false }));
  const saved = JSON.parse(localStorage.getItem('baezbeats.patterns') || 'null');
  const patterns = saved || [0, 1, 2, 3].map((p) => rows.map((_, r) => {
    const steps = new Array(STEPS).fill(false);
    if (p === 0) (STARTER[r] || []).forEach((s) => { steps[s] = true; });
    return steps;
  }));
  let slot = 0, running = false, follow = 'a', manualBpm = 120;
  let step = 0, nextTime = 0, lastK = null, timer = null, shown = -1;
  const save = () => localStorage.setItem('baezbeats.patterns', JSON.stringify(patterns));

  function hit(r, when = 0) {
    const src = ctx.createBufferSource();
    src.buffer = rows[r].buffer;
    src.connect(out);
    src.start(when);
  }

  // For Auto DJ: one drum sound at an exact time (AudioContext seconds) and level, played
  // through the club bus so it does not depend on the sequencer's own volume or pattern.
  const KIT_INDEX = Object.fromEntries(KIT.map(([name], i) => [name, i]));
  function hitAt(name, when, gain = 1) {
    const r = KIT_INDEX[name];
    if (r == null || when < ctx.currentTime - 0.01) return;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = rows[r].buffer;
    g.gain.value = gain;
    src.connect(g).connect(engine.clubBus);
    src.start(Math.max(ctx.currentTime, when));
  }

  function fireStep(s, when) {
    rows.forEach((row, r) => { if (!row.muted && patterns[slot][r][s]) hit(r, when); });
    setTimeout(() => { shown = s; paintPlayhead(); }, Math.max(0, (when - ctx.currentTime) * 1000));
  }

  const followed = () => (follow === 'a' ? decks[0] : follow === 'b' ? decks[1] : null);

  // Look a little ahead and schedule the steps that fall in that window.
  function schedule() {
    const now = ctx.currentTime, ahead = 0.12;
    const d = followed();
    if (d && d.playing && d.bpm && !d.scrubbing) {
      // Locked to the deck: steps land on the deck's sixteenth notes.
      const sixteenth = d.beatLen / 4;
      const at = (d.pos - d.firstBeat) / sixteenth;
      let k = Math.ceil(at - 1e-6);
      if (lastK != null && k <= lastK && lastK - k < 3) k = lastK + 1;
      for (; ; k++) {
        const when = now + ((k - at) * sixteenth) / d.rate;
        if (when > now + ahead) break;
        fireStep(((k % STEPS) + STEPS) % STEPS, Math.max(now, when));
        lastK = k;
      }
      step = (((lastK ?? 0) + 1) % STEPS + STEPS) % STEPS;
      nextTime = now + (sixteenth / d.rate);
    } else {
      // Free-running at the last known tempo.
      lastK = null;
      const bpm = d?.bpm ? d.effectiveBpm : manualBpm;
      const sixteenth = 60 / (bpm || 120) / 4;
      if (nextTime < now) nextTime = now + 0.02;
      while (nextTime < now + ahead) {
        fireStep(step, nextTime);
        step = (step + 1) % STEPS;
        nextTime += sixteenth;
      }
    }
  }

  function start() {
    if (running) return;
    running = true; step = 0; nextTime = 0; lastK = null;
    if (ctx.state !== 'running') ctx.resume();
    timer = setInterval(schedule, 25);
    schedule(); paint();
  }
  function stop() {
    running = false; clearInterval(timer); shown = -1; paint(); paintPlayhead();
  }

  // ---------- UI ----------
  const cells = rows.map(() => []);
  const grid = h('.seq-grid', { role: 'grid' });
  rows.forEach((row, r) => {
    const label = h('button.seq-name', { type: 'button', text: row.name, title: `Play ${row.name}. Drop an audio file here to replace it.`, onclick: () => hit(r) });
    label.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); label.classList.add('drop'); } });
    label.addEventListener('dragleave', () => label.classList.remove('drop'));
    label.addEventListener('drop', async (e) => {
      e.preventDefault(); label.classList.remove('drop');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      try {
        row.buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        row.name = file.name.replace(/\.[^.]+$/, '').slice(0, 14);
        label.textContent = row.name;
        hit(r);
      } catch { toast(`${file.name} is not an audio file this browser can read.`, 'error'); }
    });
    const mute = h('button.seq-mute', { type: 'button', text: 'M', title: `Mute ${row.name}`, onclick: () => { row.muted = !row.muted; mute.classList.toggle('on', row.muted); } });
    const line = h('.seq-row', { role: 'row' }, label, mute);
    for (let s = 0; s < STEPS; s++) {
      const cell = h('button.seq-cell', {
        type: 'button', 'aria-label': `${row.name} step ${s + 1}`, 'aria-pressed': 'false',
        class: s % 4 === 0 ? 'beat' : '',
        onclick: () => { patterns[slot][r][s] = !patterns[slot][r][s]; save(); paint(); if (patterns[slot][r][s] && !running) hit(r); },
      });
      cells[r].push(cell);
      line.append(cell);
    }
    grid.append(line);
  });

  const playBtn = h('button.btn.btn-play', { type: 'button', text: 'Start drums', onclick: () => (running ? stop() : start()) });
  const followSel = h('select.select', { 'aria-label': 'Tempo source', onchange: () => { follow = followSel.value; bpmInput.hidden = follow !== 'manual'; lastK = null; } },
    h('option', { value: 'a', text: 'Follow deck A' }), h('option', { value: 'b', text: 'Follow deck B' }), h('option', { value: 'manual', text: 'Own tempo' }));
  const bpmInput = h('input.select.bpm-input', { type: 'number', min: 60, max: 200, value: 120, hidden: true, 'aria-label': 'Sequencer BPM', onchange: () => { manualBpm = Math.max(60, Math.min(200, Number(bpmInput.value) || 120)); } });
  const slotBtns = [0, 1, 2, 3].map((i) => h('button.btn.btn-small', { type: 'button', text: `Pattern ${i + 1}`, onclick: () => { slot = i; paint(); } }));
  const clear = h('button.btn.btn-small', { type: 'button', text: 'Clear pattern', onclick: () => { patterns[slot].forEach((r) => r.fill(false)); save(); paint(); } });
  const vol = knob({ label: 'Drums', min: 0, max: 1, value: 0.8, size: 'small', onChange: (v) => out.gain.setTargetAtTime(v * v * 1.25, ctx.currentTime, 0.02) });

  function paint() {
    playBtn.textContent = running ? 'Stop drums' : 'Start drums';
    playBtn.classList.toggle('on', running);
    slotBtns.forEach((b, i) => b.classList.toggle('on', i === slot));
    rows.forEach((_, r) => cells[r].forEach((c, s) => {
      const on = patterns[slot][r][s];
      c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on));
    }));
  }
  function paintPlayhead() {
    rows.forEach((_, r) => cells[r].forEach((c, s) => c.classList.toggle('now', running && s === shown)));
  }
  paint();

  const el = h('.sequencer', {},
    h('.seq-bar', {}, playBtn, followSel, bpmInput, h('.spacer'), ...slotBtns, clear, vol),
    grid);
  return { el, start, stop, hit, hitAt, get running() { return running; } };
}
