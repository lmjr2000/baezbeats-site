// Music-video playback. Videos are silent and follow each deck's audio clock; the output
// window (for a projector or second screen) crossfades the two decks with the mixer.
import { api } from './api.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function buildVideo(decks, previews) {
  let win = null;
  const sets = decks.map((deck, i) => ({ deck, els: [previews[i]], src: '' }));

  // Each deck's video link comes from the backend: a server address in the Mac app, a
  // temporary link to the file on disk in the browser version (released on change).
  function sources() {
    for (const s of sets) {
      const t = s.deck.track;
      const want = t && t.has_video ? t.id : null;
      if (s.trackId === want && !s.dirty) continue;
      s.trackId = want; s.dirty = false;
      const old = s.src;
      const apply = (src) => {
        s.src = src;
        for (const v of s.els) {
          if (!v || v.dataset.src === src) continue;
          v.dataset.src = src;
          v.classList.remove('broken');
          if (src) { v.src = src; v.load(); } else { v.removeAttribute('src'); v.load(); }
        }
        if (old && old !== src) api.releaseVideoUrl(old);
      };
      if (!want) { apply(''); continue; }
      api.videoUrl(t).then((src) => { if (s.trackId === want) apply(src); else api.releaseVideoUrl(src); })
        .catch(() => { if (s.trackId === want) apply(''); });
    }
  }

  // Keep one <video> locked to the deck position.
  function follow(v, deck) {
    if (!v.dataset.src || v.readyState < 1 || v.classList.contains('broken')) return;
    const target = clamp(deck.pos, 0, Math.max(0, (v.duration || deck.duration) - 0.05));
    const drift = v.currentTime - target;
    const moving = deck.playing && !deck.scrubbing;
    if (moving) {
      if (Math.abs(drift) > 0.2) v.currentTime = target + 0.03;
      v.playbackRate = clamp(deck.rate * (1 - clamp(drift * 0.6, -0.12, 0.12)), 0.1, 4);
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(drift) > 0.04 && !v.seeking) v.currentTime = target;
    }
  }

  function tick() {
    if (win && win.closed) closeOutput();
    sources();
    for (const s of sets) for (const v of s.els) follow(v, s.deck);
    for (const s of sets) s.els[0].classList.toggle('has-video', !!s.src);
    if (win) {
      // Crossfade: deck B's picture sits on top of deck A's.
      const a = sets[0].src ? decks[0].channel.outLevel : 0;
      const b = sets[1].src ? decks[1].channel.outLevel : 0;
      const [va, vb] = [sets[0].els[1], sets[1].els[1]];
      if (va && vb) {
        va.style.opacity = a > 0.001 ? 1 : 0;
        vb.style.opacity = a + b > 0.001 ? b / (a + b) : 0;
        win.document.body.style.setProperty('--level', clamp(Math.max(a, b) * 1.4, 0, 1));
        win.document.body.classList.toggle('idle', !sets[0].src && !sets[1].src);
      }
    }
  }
  setInterval(tick, 80);

  function closeOutput() {
    for (const s of sets) s.els.length = 1;
    win = null;
    onChange?.(false);
  }

  let onChange = null;
  return {
    onChange(fn) { onChange = fn; },
    get open() { return !!win; },
    toggleOutput() {
      if (win && !win.closed) { win.close(); closeOutput(); return; }
      win = window.open('output.html', 'baezbeats-output', 'popup,width=960,height=540');
      if (!win) return false;
      win.addEventListener('load', () => {
        const vids = win.document.querySelectorAll('video');
        sets.forEach((s, i) => {
          const v = vids[i];
          v.addEventListener('error', () => v.classList.add('broken'));
          s.els[1] = v;
          if (s.src) { v.dataset.src = s.src; v.src = s.src; v.load(); }
        });
        onChange?.(true);
      });
      return true;
    },
  };
}
