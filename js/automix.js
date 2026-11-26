// "AI mix": one button that brings the selected song in for you, the way a DJ would.
//
// What it does, in order:
//  1. loads the song on the free deck and sets its level (auto gain)
//  2. matches tempo, then lines the two songs up snare-on-snare (the backbeat found by the
//     track analysis), and re-checks that alignment once both are playing
//  3. keeps the overlap short and uses the EQ so only one song is "up front" at a time:
//     the new song comes in without its bass, the basses swap on the bar, and the old
//     song is thinned out and filtered away
//  4. stops the old song and puts its channel back to normal
// Every move is timed on the songs' 8-bar phrases (see server/structure.js).
import { h, toast } from './controls.js';
import { mashupFit, blendable } from './setplan.js';
import { api } from './api.js';
import { ctx } from './engine.js';
import { fx, buildClubDrums, feelOf } from './clubfx.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const ramp = (p, a, b) => clamp((p - a) / (b - a));       // 0 before a, 1 after b

export const STYLES = [
  { id: 'freestyle', name: 'Freestyle', blurb: 'Surprise me. Picks a different move each time.' },
  { id: 'pop', name: 'Pop', blurb: 'Tight blend: new song slides in under the old one, basses swap on the bar.' },
  { id: 'hiphop', name: 'Hip-hop', blurb: 'Loop roll that tightens up, then drops the new song on the one.' },
  { id: 'house', name: 'House / EDM', blurb: 'Longer blend with a filter sweep on the way out.' },
  { id: 'rnb', name: 'R&B / slow jam', blurb: 'Echo the old song out, start the new one clean. Works at any tempo.' },
  { id: 'mashup', name: 'Mashup', blurb: "The new song's hook vocals over the old beat, then its beat drops in. Needs stems on the new song." },
  // club moves: quick and choppy, the new song comes in on its hook or drop
  { id: 'cut', group: 'club', name: 'Cut', blurb: 'Hard switch on the one, the old song leaves an echo.' },
  { id: 'spinback', group: 'club', name: 'Spinback', blurb: 'The old song spins backwards, the new one drops on the one.' },
  { id: 'brake', group: 'club', name: 'Brake', blurb: 'The old song slows to a stop like a turntable, the new one slams in.' },
  { id: 'chop', group: 'club', name: 'Chop', blurb: 'The last bar of the old song is chopped in rhythm, then a cut.' },
  { id: 'tease', group: 'club', name: 'Tease', blurb: 'Flicks to the new song for 2 bars, back, then in for good.' },
  { id: 'teasefire', group: 'club', name: 'Quick-fire', blurb: 'Flips between the two songs every bar, then lands on the new one.' },
  { id: 'quick2', group: 'club', name: 'Quick blend', blurb: 'A 2-bar beat-matched blend with a bass swap.' },
  { id: 'runback', group: 'club', name: 'Run it back', blurb: 'Spins the song that is playing back and restarts its hook. No new song needed.', noTrack: true },
];
export const CLUB_MOVES = ['cut', 'spinback', 'brake', 'chop', 'tease', 'teasefire'];
const MOVE_LABEL = { cut: 'Cut', spinback: 'Spinback', brake: 'Brake', chop: 'Chop', tease: 'Tease', teasefire: 'Quick-fire', quick2: 'Quick blend', quick4: 'Quick blend', mashup: 'Mashup', runback: 'Run it back' };

export function buildAutomix(decks, mixer, library) {
  let run = null; // { cancelled }

  const btn = h('button.btn.btn-ai', { type: 'button', text: 'AI mix', title: 'Mix the selected song in automatically', 'aria-haspopup': 'menu' });
  const item = (s) => h('button.ai-item', {
    type: 'button', role: 'menuitem',
    onclick: () => {
      menu.hidden = true;
      if (s.noTrack) return rewind();
      if (!library.selectedTrack()) return toast('Click a song in the list first, then pick a move.');
      start(s.id);
    },
  }, h('span.ai-name', { text: s.name }), h('span.ai-blurb', { text: s.blurb }));
  const usable = STYLES.filter((s) => s.id !== 'mashup' || api.capabilities.stems);
  const menu = h('.ai-menu', { role: 'menu', hidden: true },
    h('.ai-col', {}, h('.ai-menu-head', { text: 'Mix the selected song in' }), ...usable.filter((s) => !s.group).map(item)),
    h('.ai-col', {}, h('.ai-menu-head', { text: 'Club moves' }), ...usable.filter((s) => s.group === 'club').map(item)));
  const el = h('.ai-wrap', {}, btn, menu);

  btn.addEventListener('click', () => {
    if (run) { run.cancelled = true; return; }
    menu.hidden = !menu.hidden;
  });
  addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) menu.hidden = true; });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });

  const setBusy = (text) => {
    btn.textContent = text || 'AI mix';
    btn.classList.toggle('on', !!text);
    btn.title = text ? 'Click to stop the automatic mix' : 'Mix the selected song in automatically';
  };

  function waitFor(deck, test, timeout) {
    return new Promise((resolve) => {
      if (test()) return resolve(true);
      const events = ['ready', 'analysis', 'error', 'load'];
      const done = (ok) => { events.forEach((ev) => deck.removeEventListener(ev, check)); clearTimeout(timer); resolve(ok); };
      const check = () => { if (test()) done(true); };
      events.forEach((ev) => deck.addEventListener(ev, check));
      const timer = setTimeout(() => done(test()), timeout);
    });
  }

  // Resolves when the deck's playback reaches a position (seconds in the track).
  async function until(r, deck, pos) {
    while (!r.cancelled && deck.playing && deck.pos < pos) await sleep(4);
    return !r.cancelled && deck.playing;
  }

  // Calls fn(progress 0..1) over `seconds` of real time, starting at `origin` (performance.now ms).
  async function automate(r, origin, seconds, fn) {
    for (;;) {
      const p = (performance.now() - origin) / 1000 / seconds;
      fn(clamp(p));
      if (p >= 1 || r.cancelled) break;
      await sleep(25);
    }
  }

  // ----- timing on the phrase grid -----
  // A transition is planned around one moment S on the old song: a phrase start (bar 1 of
  // an 8-bar phrase). Blends begin at S; rolls and echo-outs end at S, and the new song
  // drops there. The new song starts at a downbeat I of its own, so bars line up 1 to 1.
  const bars = (deck, n) => n * (deck.grid ? deck.grid.bar : deck.beatLen * 4 || 2);
  // How long the parts of a move take, in seconds of the OLD song's own timeline.
  function shape(style, from) {
    const bar = bars(from, 1), phrase = from.phraseLen || bar * 8;
    if (style === 'house') return { before: 0, after: 2 * phrase };
    if (style === 'pop') return { before: 0, after: phrase };
    if (style === 'mashup') return { before: 0, after: (phrase / from.rate < 12 ? 2 : 1) * phrase + bar };
    if (style === 'hiphop') return { before: (bar / from.rate < 2.2 ? 2 : 1) * bar, after: 0 };   // 1-2 bars of roll
    const beat = bar / 4;
    if (style === 'quick2') return { before: 0, after: 2 * bar };
    if (style === 'quick4') return { before: 0, after: 4 * bar };
    if (style === 'cut') return { before: beat, after: 0 };     // echo goes on a beat early
    if (style === 'spinback') return { before: beat, after: 0 };
    if (style === 'brake') return { before: 2 * beat, after: 0 };
    if (style === 'chop') return { before: bar, after: 0 };
    if (style === 'tease') return { before: 0, after: 4 * bar };
    if (style === 'teasefire') return { before: 0, after: 4 * bar };
    return { before: bar, after: 0 };                         // echo out
  }
  // Roughly how many seconds (real time) a move out of `from` takes, start to finish.
  function estimate(style, from) {
    const sh = shape(style, from);
    return (sh.before + sh.after) / from.rate + 2;
  }
  // The next phrase start the move can still make: whole phrases if one is near, else half
  // phrases (4 bars), else the next bar, so pressing the button never means a long wait.
  function nextMoment(from, before) {
    const ready = from.pos + (before + 0.6 * from.rate);
    for (const step of [1, 0.5, 0.125]) {
      const S = from.nextPhrase(ready, step);
      if ((S - from.pos) / from.rate <= (step === 1 ? 14 : 8)) return S;
    }
    return from.nextPhrase(ready, 0.125);
  }
  // Where the new song should come in: its first phrase of music, or its hook.
  function entry(to, which) {
    if (which === 'hook' && to.hook != null) return to.hook;
    const st = to.structure;
    if (which === 'drop' && st?.drop != null) return st.drop;
    if (which === 'hot') {
      const spots = [to.hook, st?.drop, st?.hooks?.[1]].filter((x) => x != null && x < to.duration - 25);
      if (spots.length) return spots[Math.floor(Math.random() * spots.length)];
    }
    const m = to.musicStart;
    const p = to.phraseAtOrBefore(m + 0.05);
    return m - p <= bars(to, 3) ? p : m;
  }
  // Waits for the old song to reach S, showing a countdown on the button.
  async function waitUntil(r, from, S, label) {
    while (!r.cancelled && from.playing && from.pos < S) {
      const left = (S - from.pos) / from.rate;
      if (left > 1.2) setBusy(`${label} in ${Math.ceil(left)} s… (stop)`);
      await sleep(left > 0.2 ? 20 : 3);
    }
    return !r.cancelled && from.playing;
  }
  // Keeps the new song's bars locked to the old song's while both play (a DJ riding the pitch).
  function lock(r, from, to, S, I) {
    const trim = () => {
      if (r.cancelled || !to.playing || !from.playing) return;
      const want = I + (from.pos - S) * (to.rate / from.rate);
      const d = want - to.pos;
      if (Math.abs(d) > 0.003 && Math.abs(d) < to.beatLen / 4) to.nudgeBy(d);
    };
    [250, 1000, 2500, 6000].forEach((ms) => setTimeout(trim, ms));
  }

  // Mixes `track` (default: the song selected in the library) in. Resolves true when the
  // handover completed, false if it was stopped or failed.
  // opts.at: the old song's phrase start to mix on; opts.entry: 'start' or 'hook'.
  async function start(styleId, track = library.selectedTrack(), opts = {}) {
    if (!track || run) return false;
    const playing = decks.filter((d) => d.playing);
    if (playing.length === 2) { toast('Both decks are playing. Pause one, then press AI mix.', 'error'); return false; }
    clearInterval(glide);
    const r = run = { cancelled: false, done: false };
    try {
      await mix(r, track, styleId, playing[0], opts);
    } catch (e) {
      toast(`AI mix stopped: ${e.message}`, 'error');
    } finally {
      run = null; setBusy(null);
    }
    return r.done;
  }

  async function mix(r, track, styleId, from, opts) {
    // Nothing playing yet: just start the song.
    if (!from) {
      const deck = decks.find((d) => !d.track) || decks[0];
      setBusy('Loading…');
      await deck.load(track);
      if (!deck.ready || deck.track !== track) throw new Error('the song could not be loaded');
      await waitFor(deck, () => deck.profile || deck.bpm > 0, 8000);
      const at = entry(deck, opts.entry);
      if (at > deck.pos + 1) deck.seek(at);                    // skip a silent intro
      resetChannel(deck.index);
      mixer.setCrossfader(deck.index);
      deck.setTempo(1); deck.setSemis(0);
      deck.play();
      if (!r.quiet) toast(`Playing ${track.title}. Pick another song and press AI mix to bring it in.`);
      r.done = true;
      return;
    }

    const to = from.other;
    const side = to.index;                     // crossfader end for the incoming deck
    const xf = (p) => mixer.setCrossfader(side ? p : 1 - p);

    if (!(to.ready && to.track && to.track.id === track.id)) {
      setBusy('Loading…');
      await to.load(track);
      if (!to.ready || to.track !== track) throw new Error('the song could not be loaded');
    }
    setBusy('Listening…');
    await waitFor(to, () => to.bpm > 0 || to.peaks, 60000);     // tempo, structure, loudness
    if (r.cancelled) return;
    if (!from.playing) throw new Error(`deck ${from.name} stopped`);

    // Can the two songs be beat-matched without sounding sped up or slowed down?
    let ratio = from.bpm && to.bpm ? from.effectiveBpm / to.bpm : 0;
    while (ratio > 1.42) ratio /= 2;
    while (ratio && ratio < 0.71) ratio *= 2;
    const matchable = ratio > 0.9 && ratio < 1.1;

    let style = styleId, note = '';
    if (style === 'freestyle') {
      const pool = matchable ? ['pop', 'hiphop', 'house', 'rnb'] : ['hiphop', 'rnb'];
      if (to.track.stems === 1 && mashupFit({ bpm: from.effectiveBpm, camelot: from.keyCamelot }, to.track)) pool.push('mashup', 'mashup');
      style = pool[Math.floor(Math.random() * pool.length)];
      note = ` Freestyle picked: ${{ pop: 'bass-swap blend', hiphop: 'loop roll and drop', house: 'filter blend', rnb: 'echo out', mashup: 'mashup' }[style]}.`;
    }
    let fit = null;
    if (style === 'mashup') {
      fit = mashupFit({ bpm: from.effectiveBpm, camelot: from.keyCamelot }, { bpm: to.bpm, camelot: to.camelot });
      let why = '';
      if (to.track.stems !== 1) why = `${track.title} needs its stems prepared first`;
      else if (!fit) why = blendable(from.effectiveBpm, to.bpm, 0.06) ? 'their keys clash' : 'their tempos are too far apart';
      if (why) { style = matchable ? 'pop' : 'rnb'; note = ` A mashup is not possible here (${why}), so this is a ${matchable ? 'blend' : 'echo-out'}.`; }
    } else if (!matchable && (style === 'pop' || style === 'house')) {
      style = 'rnb';
      note = from.bpm && to.bpm
        ? ` These two are too far apart in tempo to blend (${from.effectiveBpm.toFixed(0)} and ${to.bpm.toFixed(0)} BPM), so this one echoes out instead.`
        : ' No steady tempo was found, so this one echoes out instead.';
    }
    if ((style === 'tease' || style === 'teasefire') && !blendable(from.effectiveBpm, to.bpm, 0.08)) {
      style = 'cut'; note = ' The tempos are too far apart to tease, so this one cuts in.';
    }
    if ((style === 'quick2' || style === 'quick4') && !matchable) { style = 'cut'; note = ' The tempos are too far apart to blend, so this one cuts in.'; }
    const blend = style === 'pop' || style === 'house' || style === 'mashup' || style === 'quick2' || style === 'quick4';
    const club = CLUB_MOVES.includes(style);
    const teaseLike = style === 'tease' || style === 'teasefire';
    if (style === 'mashup') {
      setBusy('Loading stems…');
      if (!to.stemsLoaded) to.loadStems();
      await waitForStems(to, 30000);
      if (!to.stemsLoaded) { style = 'pop'; note = ' The stems did not load in time, so this is a blend.'; }
    }

    // Prepare the incoming deck (its gain was already set from its measured loudness).
    mixer.setEq(side, 'low', 0); mixer.setEq(side, 'mid', 0); mixer.setEq(side, 'high', 0);
    mixer.setFilter(side, 0); mixer.setFader(side, 1);
    mixer.setFader(from.index, 1);
    xf(0);
    to.exitLoop();
    to.soloStem(null);
    const sync = blend || teaseLike;
    to.setTempo(sync ? ratio : 1);
    if (sync && Math.abs(ratio - 1) > to.tempoRange) to.setTempoRange(0.16);
    to.setSemis(style === 'mashup' ? fit.shift : 0);

    // When: the planned phrase start, or the next one that is close enough.
    const sh = shape(style, from);
    let S = opts.at;
    if (!(S > from.pos + sh.before + 0.4 * from.rate)) S = nextMoment(from, sh.before);
    if (sh.after && S + sh.after > from.duration - 1) S = Math.max(from.pos + 1, from.duration - 1 - sh.after);
    // Where: the new song's first phrase of music, or its hook (short sets and mashups).
    const I = entry(to, style === 'mashup' ? 'hook' : opts.entry ?? (club || style === 'quick2' ? 'hot' : undefined));
    to.seek(I);

    if (!opts.quiet) toast(`${MOVE_LABEL[style] ? `${MOVE_LABEL[style]}: ` : 'Mixing in '}${track.title}${style === 'mashup' && fit.shift ? ` (key shifted ${fit.shift > 0 ? '+' : ''}${fit.shift})` : ''}.${note}`);
    const label = MOVE_LABEL[style] || 'Mixing';

    if (club) {
      if (!await clubMove(r, style, from, to, S, I, sh, label, xf, opts)) return;
    } else if (blend) {
      if (!await waitUntil(r, from, S, label)) return;
      setBusy(`${label}… (stop)`);
      to.play();
      const origin = performance.now();
      lock(r, from, to, S, I);
      const phrase = sh.after / from.rate;                     // real seconds (blends)

      if (style === 'mashup') {
        // ----- mashup: the new song's hook vocals over the old beat, then its beat drops in -----
        const vocalsSrc = sh.after - bars(from, 1);              // one or two whole phrases
        to.soloStem('vocals');
        if (from.stemsLoaded) from.setStemMute('vocals', true);
        else mixer.setEq(from.index, 'mid', -0.45);             // make room for the new vocal
        await automate(r, origin, 0.6, (p) => xf(0.5 * p));     // vocals come straight in
        if (!await until(r, from, S + vocalsSrc)) return;      // the drop lands on a phrase start
        if (r.cancelled) return;
        to.soloStem(null);                                       // the drop: full new song
        mixer.setEq(from.index, 'low', -1);
        const dropAt = performance.now();
        await automate(r, dropAt, bars(from, 1) / from.rate, (p) => {
          xf(0.5 + 0.5 * p);
          mixer.setFilter(from.index, 0.6 * p);
        });
      } else {
        // ----- beat-matched blend over one phrase (two for house), bass swap halfway -----
        mixer.setEq(side, 'low', -1);
        mixer.setEq(side, 'mid', -0.3);
        if (to.stemsLoaded) to.setStemMute('vocals', true);    // no second vocal until the swap
        let swapped = false;
        await automate(r, origin, phrase, (p) => {
          xf(0.5 * ramp(p, 0, 0.22) + 0.5 * ramp(p, 0.55, 1));  // up to the middle, hold, then across
          if (p < 0.5) {
            mixer.setEq(from.index, 'mid', -0.35 * ramp(p, 0.25, 0.5));
          } else {
            if (!swapped) {
              swapped = true;                                    // the swap: one song's bass at a time
              mixer.setEq(side, 'low', 0); mixer.setEq(side, 'mid', 0);
              mixer.setEq(from.index, 'low', -1);
              if (to.stemsLoaded) to.setStemMute('vocals', false);
              if (from.stemsLoaded) from.setStemMute('vocals', true);
            }
            mixer.setEq(from.index, 'mid', -0.35 - 0.4 * ramp(p, 0.5, 0.8));
            mixer.setFilter(from.index, (style === 'house' ? 0.7 : 0.55) * ramp(p, 0.55, 1));
          }
        });
      }
    } else if (style === 'hiphop') {
      // ----- loop roll that ends on the phrase start, then the new song drops -----
      const len = sh.before, R0 = S - len;
      if (!await waitUntil(r, from, R0, label)) return;
      setBusy(`${label}… (stop)`);
      const origin = performance.now(), bar = bars(from, 1);
      let stage = -1;
      await automate(r, origin, len / from.rate, (p) => {
        const s = p < 0.5 ? 0 : p < 0.75 ? 1 : 2;               // half bar, then quarter, then eighth
        if (s !== stage) { stage = s; from.setLoop(R0, R0 + bar / [2, 4, 8][s], null); }
        mixer.setFilter(from.index, 0.5 * ramp(p, 0.5, 1));
      });
      if (!r.cancelled) { xf(1); to.play(); from.pause(); }
      from.exitLoop();
    } else {
      // ----- echo out over the last bar, the new song starts clean on the phrase -----
      const E0 = S - sh.before;
      if (!await waitUntil(r, from, E0, label)) return;
      setBusy(`${label}… (stop)`);
      const fx = { ...from.channel.state };
      from.channel.setFx({ fx: 'echo', on: true, amount: 0.8, beats: 0.75 }, from.effectiveBpm);
      from.dispatchEvent(new CustomEvent('tempo'));
      let origin = performance.now();
      await automate(r, origin, sh.before / from.rate, (p) => mixer.setFilter(from.index, 0.35 * p));
      if (!r.cancelled) {
        xf(0.5);
        to.play();
        from.pause();                                            // only the echo tail carries on
        origin = performance.now();
        await automate(r, origin, bars(to, 1) / to.rate, (p) => xf(0.5 + 0.5 * p));
      }
      from.channel.setFx({ fx: fx.fx, on: false, amount: fx.fxAmount, beats: fx.fxBeats }, from.effectiveBpm);
      from.dispatchEvent(new CustomEvent('tempo'));
    }

    if (r.cancelled) { toast('AI mix stopped. The mixer is left where it was.'); return; }

    // Hand over: the old deck stops and its channel goes back to normal.
    xf(1);
    if (from.playing) from.pause();
    from.exitLoop();
    await sleep(250);
    from.soloStem(null);
    from.setSemis(0);
    resetChannel(from.index);
    toast(`Now playing ${track.title}.`);
    r.done = true;
    easeToOwnTempo(to);
  }

  // ----- club moves -----
  // The drums and effects are optional (Auto DJ turns them on): opts.drums, opts.fx = 'club' | 'party'.
  let drums = null;
  function useDrums(sequencer) { drums = buildClubDrums(sequencer); }

  function dropFx(opts, t, beat) {
    if (opts.fx === 'party') { fx.impact(t); return; }
    if (opts.fx !== 'club' || Math.random() > 0.4) return;
    const pick = Math.random();
    if (pick < 0.45) fx.airHorn(t, beat);
    else if (pick < 0.8) fx.impact(t);
    else fx.siren(t, beat * 4);
  }

  async function clubMove(r, style, from, to, S, I, sh, label, xf, opts) {
    const bar = bars(from, 1), beat = bar / 4, rate = from.rate, b = beat / rate;
    const teaseLike = style === 'tease' || style === 'teasefire';
    const useDrums = opts.drums && drums;
    const ctxAt = (pos) => ctx.currentTime + (pos - from.pos) / rate;
    const final = teaseLike ? S + sh.after : S;               // where the new song takes over for good
    // lead-in: a snare roll and (party) a riser in the bar before the drop
    const lead = Math.max(sh.before, useDrums || opts.fx === 'party' ? bar : 0);
    if (!await waitUntil(r, from, (teaseLike ? S : final) - lead, label)) return false;
    setBusy(`${label}… (stop)`);
    if (!teaseLike) {
      if (useDrums) drums.fill(ctxAt(final - bar), b, 4);
      if (opts.fx === 'party') fx.riser(ctxAt(final - bar), bar / rate);
    }
    let ctxDrop = ctxAt(final);
    const land = () => {
      xf(1); to.play();
      if (from.playing) from.pause();
      if (useDrums) drums.punch(Math.max(ctx.currentTime, ctxDrop));
      dropFx(opts, Math.max(ctx.currentTime, ctxDrop), b);
    };

    if (style === 'cut') {
      if (!await until(r, from, S - beat)) return false;
      const was = { ...from.channel.state };
      from.channel.setFx({ fx: 'echo', on: true, amount: 0.7, beats: 0.5 }, from.effectiveBpm);
      ctxDrop = ctxAt(S);
      if (!await until(r, from, S)) return false;
      land();
      setTimeout(() => from.channel.setFx({ fx: was.fx, on: false, amount: was.fxAmount, beats: was.fxBeats }, from.effectiveBpm), (2 * bar / rate) * 1000);
    } else if (style === 'chop') {
      if (!await until(r, from, S - bar)) return false;
      // gate the last bar: 1/8 notes for two beats, then 1/16 notes, exactly on the old song's beats
      const t0 = ctxAt(S - bar), g = from.channel.gate.gain;
      g.cancelScheduledValues(ctx.currentTime);
      for (let k = 0; k < 4; k++) g.setTargetAtTime(k % 2 ? 0 : 1, t0 + (k * b) / 2, 0.002);
      for (let k = 0; k < 8; k++) g.setTargetAtTime(k % 2 ? 0 : 1, t0 + 2 * b + (k * b) / 4, 0.002);
      ctxDrop = ctxAt(S);
      g.setTargetAtTime(1, ctxDrop + 0.08, 0.002);            // open again once the old song is muted
      if (!await until(r, from, S)) return false;
      land();
    } else if (style === 'spinback') {
      if (!await until(r, from, S - beat)) return false;
      ctxDrop = ctx.currentTime + b;
      const p0 = from.pos, t0 = performance.now();
      from.scrubStart();
      await automate(r, t0, b, (p) => {
        from.scrubTo(p0 - 2 * beat * (1 - (1 - p) ** 2));     // fast backwards, slowing down
        mixer.setFilter(from.index, -0.65 * p);
      });
      if (r.cancelled) { from.scrubEnd(); return false; }
      from.pause(); from.scrubEnd();
      land();
    } else if (style === 'brake') {
      if (!await until(r, from, S - 2 * beat)) return false;
      ctxDrop = ctx.currentTime + 2 * b;
      const keylock = from.keylock;
      from.setKeylock(false);                                  // let the pitch fall, like vinyl
      if (useDrums) drums.bed(ctx.currentTime, b, 0.5, feelOf(from));
      await automate(r, performance.now(), 2 * b, (p) => from.setBend(-0.97 * p ** 0.8));
      from.pause(); from.setBend(0); from.setKeylock(keylock);
      if (r.cancelled) return false;
      land();
    } else {
      // tease / quick-fire: the new song runs hidden in sync; the crossfader flicks between them
      const flipBars = style === 'teasefire' ? 1 : 2, flips = style === 'teasefire' ? 4 : 2;
      if (!await until(r, from, S)) return false;            // the hidden song starts exactly on the phrase
      xf(0);
      to.play();
      lock(r, from, to, S, I);
      for (let k = 0; k < flips; k++) {
        if (!await until(r, from, S + k * flipBars * bar)) return false;
        xf(k % 2 === 0 ? 1 : 0);
        if (useDrums && k % 2 === 0) drums.punch(ctx.currentTime);
        if (k === flips - 1 && useDrums) drums.fill(ctxAt(final - bar), b, 4);
      }
      ctxDrop = ctxAt(final);
      if (!await until(r, from, final)) return false;
      xf(1); from.pause();
      if (useDrums) drums.punch(Math.max(ctx.currentTime, ctxDrop));
      dropFx(opts, Math.max(ctx.currentTime, ctxDrop), b);
    }
    return true;
  }

  // Run it back: spin the playing song backwards and restart it from its hook (or the start
  // of the phrase), on the beat. opts.at: where to rewind (source seconds); opts.to: where to restart.
  async function rewind(deck = decks.find((d) => d.playing), opts = {}) {
    if (!deck?.playing) { toast('Play a song first, then run it back.'); return false; }
    if (run) return false;
    const r = run = { cancelled: false, done: false };
    try {
      const bar = bars(deck, 1), beat = bar / 4, b = beat / deck.rate;
      const S = opts.at > deck.pos + 2 * beat ? opts.at : deck.nextPhrase(deck.pos + 2 * beat + 0.4 * deck.rate, 0.125);
      const to = opts.to ?? (deck.hook != null && deck.hook < S - bar ? deck.hook : deck.phraseAtOrBefore(S - bar));
      if (!await waitUntil(r, deck, S - 2 * beat, 'Run it back')) return false;
      setBusy('Run it back… (stop)');
      if (opts.fx === 'club' || opts.fx === 'party') fx.airHorn(ctx.currentTime, b);
      const p0 = deck.pos;
      deck.scrubStart();
      await automate(r, performance.now(), 2 * b, (p) => deck.scrubTo(p0 - 3 * beat * (1 - (1 - p) ** 2)));
      deck.scrubEnd();
      deck.seek(to);
      if (opts.drums && drums) drums.punch(ctx.currentTime + 0.005);
      r.done = true;
    } finally {
      run = null; setBusy(null);
    }
    return r.done;
  }

  function waitForStems(deck, timeout) {
    return new Promise((resolve) => {
      if (deck.stemsLoaded) return resolve(true);
      const check = () => { if (deck.stemsLoaded || !deck.stemsLoading) done(); };
      const done = () => { deck.removeEventListener('stems', check); clearTimeout(timer); resolve(deck.stemsLoaded); };
      deck.addEventListener('stems', check);
      const timer = setTimeout(done, timeout);
    });
  }

  // After a blend the new song is still running at the old song's tempo. Ease it back to
  // its own speed over a few seconds (key lock keeps the pitch), so a long set does not
  // end up playing every song at the first song's tempo.
  let glide = null;
  function easeToOwnTempo(deck) {
    clearInterval(glide);
    const from = deck.tempo;
    if (Math.abs(from - 1) < 0.002) return;
    const t0 = performance.now(), seconds = 10;
    let expect = from;
    glide = setInterval(() => {
      // stop if the DJ has touched the tempo fader, or the deck stopped
      if (!deck.playing || Math.abs(deck.tempo - expect) > 0.0006) { clearInterval(glide); return; }
      const p = clamp((performance.now() - t0) / 1000 / seconds);
      expect = from + (1 - from) * p;
      deck.setTempo(expect);
      if (p >= 1) clearInterval(glide);
    }, 100);
  }

  function resetChannel(i) {
    mixer.setEq(i, 'low', 0); mixer.setEq(i, 'mid', 0); mixer.setEq(i, 'high', 0);
    mixer.setFilter(i, 0);
    mixer.setFader(i, 1);
  }

  return { el, start, rewind, useDrums, estimate, shape, get running() { return !!run; }, cancel() { if (run) run.cancelled = true; } };
}
