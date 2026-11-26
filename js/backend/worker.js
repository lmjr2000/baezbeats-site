// Background worker for the browser version: heavy number crunching off the page's thread.
//   'analyze'    two channels at 22.05 kHz -> tempo, key, waveform, loudness, structure
//   'interleave' two channels at 44.1 kHz  -> interleaved 16-bit PCM for a deck
import { analyze } from '../shared/analysis/analysis.js';

self.onmessage = (e) => {
  const { id, op, left, right } = e.data;
  try {
    if (op === 'analyze') {
      const n = left.length, mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = 0.5 * (left[i] + right[i]);
      const r = analyze(mono);
      self.postMessage({ id, ok: true, result: r, duration: n / 22050 }, [r.peaks.buffer]);
    } else if (op === 'interleave') {
      const n = left.length, out = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        const l = left[i], r = right[i];
        out[i * 2] = (l > 1 ? 1 : l < -1 ? -1 : l) * 32767;
        out[i * 2 + 1] = (r > 1 ? 1 : r < -1 ? -1 : r) * 32767;
      }
      self.postMessage({ id, ok: true, result: out.buffer }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
