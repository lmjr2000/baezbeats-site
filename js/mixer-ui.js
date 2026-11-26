// Centre mixer: channel strips, crossfader, master and headphone controls.
import { h, knob } from './controls.js';
import { engine } from './engine.js';

// dBFS (RMS of the loud half of a song) every deck is trimmed towards; leaves headroom for two songs at once.
const TARGET_LOUDNESS = -13;
const pct = (level) => Math.max(0, Math.min(1, (20 * Math.log10(level || 1e-6) + 48) / 48)) * 100;

export function buildMixer(decks) {
  const strips = decks.map((deck) => {
    const ch = deck.channel;
    const fader = h('input.ch-fader', { type: 'range', min: 0, max: 1, step: 0.005, value: 1, 'aria-label': `Deck ${deck.name} volume` });
    fader.addEventListener('input', () => ch.setFader(Number(fader.value)));
    const bar = h('i');
    const cue = h('button.btn.btn-small.btn-phones', {
      type: 'button', text: 'Phones', title: `Listen to deck ${deck.name} in the headphones`,
      onclick: () => { ch.setCue(!ch.state.cue); cue.classList.toggle('on', ch.state.cue); },
    });
    const knobs = {
      gain: knob({ label: 'Gain', onChange: (v) => ch.setTrim(v), size: 'small' }),
      high: knob({ label: 'High', onChange: (v) => ch.setHigh(v), size: 'small' }),
      mid: knob({ label: 'Mid', onChange: (v) => ch.setMid(v), size: 'small' }),
      low: knob({ label: 'Low', onChange: (v) => ch.setLow(v), size: 'small' }),
      filter: knob({ label: 'Filter', onChange: (v) => ch.setFilter(v), size: 'small', title: 'Filter: left cuts highs, right cuts lows, centre is off' }),
    };
    const el = h(`.strip.strip-ch.strip-${deck.name.toLowerCase()}`, {},
      h('.strip-knobs', {}, h('.strip-name', { text: `Deck ${deck.name}` }), ...Object.values(knobs)),
      h('.strip-fade', {}, h('.fader-wrap', {}, fader, h('.meter', {}, bar)), cue));
    // Auto gain: bring every song to a similar loudness as soon as its analysis arrives.
    const autoGain = () => {
      if (deck.loud == null) return;
      const v = Math.max(-1, Math.min(1, (TARGET_LOUDNESS - deck.loud) / 12));
      knobs.gain.set(v); ch.setTrim(v);
    };
    deck.addEventListener('analysis', autoGain);
    deck.addEventListener('ready', autoGain);
    return { el, bar, ch, knobs, fader };
  });

  const mL = h('i'), mR = h('i');
  const xf = h('input.crossfader', { type: 'range', min: 0, max: 1, step: 0.002, value: 0.5, 'aria-label': 'Crossfader', title: 'Crossfader. Double-click to centre.' });
  xf.addEventListener('input', () => engine.setCrossfader(Number(xf.value)));
  xf.addEventListener('dblclick', () => { xf.value = 0.5; engine.setCrossfader(0.5); });
  const curve = h('button.btn.btn-small', {
    type: 'button', text: 'Smooth blend', title: 'Crossfader curve: smooth blend for mixing, sharp cut for scratching',
    onclick: () => {
      engine.setCrossfader(engine.xfade, engine.xfCurve === 'smooth' ? 'sharp' : 'smooth');
      curve.textContent = engine.xfCurve === 'smooth' ? 'Smooth blend' : 'Sharp cut';
    },
  });

  engine.setMaster(0.8); engine.setCueVolume(0.7); engine.setCueMix(0);
  const centre = h('.strip.strip-master', {},
    h('.strip-name', { text: 'Master' }),
    knob({ label: 'Volume', min: 0, max: 1, value: 0.8, onChange: (v) => engine.setMaster(v) }),
    h('.meter-pair', {}, h('.meter', {}, mL), h('.meter', {}, mR)),
    h('.strip-name.phones', { text: 'Headphones' }),
    knob({ label: 'Volume', min: 0, max: 1, value: 0.7, size: 'small', onChange: (v) => engine.setCueVolume(v) }),
    knob({ label: 'Cue / mix', min: 0, max: 1, value: 0, size: 'small', onChange: (v) => engine.setCueMix(v), title: 'Headphone blend: left is the cued deck, right is the master mix' }));

  const el = h('section.mixer', { 'aria-label': 'Mixer' },
    h('.strips', {}, strips[0].el, centre, strips[1].el),
    h('.xf-row', {}, h('span.xf-end.a', { text: 'A' }), xf, h('span.xf-end.b', { text: 'B' })),
    h('.xf-curve', {}, curve));

  return {
    el,
    setCrossfader(v) { xf.value = v; engine.setCrossfader(v); },
    // Used by AI mix: move a control and its knob together.
    setEq(i, band, v) { const s = strips[i]; s.knobs[band].set(v); s.ch[{ low: 'setLow', mid: 'setMid', high: 'setHigh' }[band]](v); },
    setFilter(i, v) { strips[i].knobs.filter.set(v); strips[i].ch.setFilter(v); },
    setFader(i, v) { strips[i].fader.value = v; strips[i].ch.setFader(v); },
    tick() {
      for (const s of strips) {
        const p = pct(s.ch.level());
        s.bar.style.height = `${p}%`;
        s.bar.classList.toggle('hot', p > 96);
      }
      const [l, r] = engine.masterLevels.map((f) => pct(f()));
      mL.style.height = `${l}%`; mR.style.height = `${r}%`;
      mL.classList.toggle('hot', l > 97); mR.classList.toggle('hot', r > 97);
    },
  };
}
