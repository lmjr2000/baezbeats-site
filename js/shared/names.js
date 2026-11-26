// Title and artist from a file name, for songs without usable tags.
// Shared by the Mac server and the browser version, so plain string work only.

// "Artist - Title (Official Video).mp4" -> { artist, title }
export function parseFilename(file) {
  const name = String(file).split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  base = base.replace(/_/g, ' ')
    .replace(/[\[(](official|lyric|audio|video|hd|hq|4k|1080p|720p|music video|visualizer)[^\])]*[\])]/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].replace(/^\d+[\s.)-]+/, '').trim(), title: m[2].trim() };
  return { artist: '', title: base };
}

// File types BaezBeats can play.
export const MEDIA_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.m4a', '.mp3', '.wav', '.flac', '.aac', '.ogg', '.aiff', '.aif'];
export const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.webm'];
export const extOf = (name) => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; };
