// Where a song's sound really starts and ends, from its waveform data.
// Auto DJ uses this to skip silent intros and to get out before a song trails off.
export function energyProfile(peaks, rate) {
  const n = Math.floor(peaks.length / 3);
  const secs = Math.max(1, Math.ceil(n / rate));
  const sum = new Float32Array(secs), cnt = new Float32Array(secs);
  for (let i = 0; i < n; i++) {
    const s = Math.min(secs - 1, Math.floor(i / rate));
    sum[s] += Math.max(peaks[i * 3], peaks[i * 3 + 1]);
    cnt[s]++;
  }
  const level = Array.from(sum, (v, i) => (cnt[i] ? v / cnt[i] : 0));
  const sorted = level.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return { start: 0, end: secs, tailStart: secs };
  const ref = sorted[Math.floor(sorted.length * 0.7)];        // the song's normal "full" level
  let start = 0, end = secs, tail = secs;
  for (let s = 0; s < secs; s++) if (level[s] >= 0.15 * ref) { start = s; break; }
  for (let s = secs - 1; s >= 0; s--) if (level[s] >= 0.15 * ref) { end = s + 1; break; }
  // the last moment the song is still at full strength; after it comes the outro / fade
  for (let s = secs - 1; s >= 0; s--) if (level[s] >= 0.55 * ref) { tail = s + 1; break; }
  return { start, end, tailStart: Math.min(tail, end) };
}
