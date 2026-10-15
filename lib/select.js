// Selection stage: decide which tracks are safe to walk to at a target cadence, and say why
// the others were held out. Every rejection carries a plain-language reason for the listener.

const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;
// Calibrated on 232 real tracks: every verified 12/8 or swung ballad scored 1.03 or higher
// ("Crazy" 1.33, "These Arms of Mine" 1.03); the most swing-like straight songs scored up to 0.97
// ("I Wish" 0.97, "Superstition" 0.94). Between the two, a song needs independent confirmation.
export const TRIPLET_CUTOFF = 1.0;
export const TRIPLET_BORDERLINE = 0.95;
const SWAY = 'Swing or waltz feel: the beat can be counted two ways, so steps would be uneven';

// Resolve a track's beat into one trusted tempo, or a reason it cannot be trusted.
export function judgeTempo({ deezerBpm, est }) {
  const e = est?.bpm || 0;
  const d = deezerBpm > 0 ? deezerBpm : 0;
  if (!e && !d) return { ok: false, reason: 'No tempo could be measured' };
  if (est && est.tripletRatio > TRIPLET_CUTOFF) return { ok: false, reason: SWAY };
  // The catalog confirms the beat if it matches the measurement directly or at double or half.
  const confirmed = d && e && (near(e, d, 0.04) || near(e, d * 2, 0.05) || near(e, d / 2, 0.05));
  if (est && est.tripletRatio > TRIPLET_BORDERLINE && !confirmed) {
    return { ok: false, reason: 'Beat feel uncertain: it may sway, and the catalog cannot confirm it' };
  }
  if (d && e) {
    if (near(e, d, 0.04)) return { ok: true, bpm: e, confidence: 'high', note: 'Measured tempo agrees with catalog' };
    if (near(e, d * 2, 0.05) || near(e, d / 2, 0.05)) {
      return { ok: true, bpm: e, confidence: 'high', note: 'Catalog tempo was doubled or halved; measured beat used' };
    }
    if (near(e, d * 1.5, 0.05) || near(e, d / 1.5, 0.05)) {
      return { ok: false, reason: SWAY };
    }
    return { ok: false, reason: `Tempo unclear: measured ${e} BPM, catalog says ${Math.round(d)}` };
  }
  if (d && !e) return { ok: true, bpm: d, confidence: 'medium', note: 'Catalog tempo only' };
  return { ok: true, bpm: e, confidence: 'medium', note: 'Measured from the song; no catalog tempo' };
}

// Pick the felt beat (as is, halved or doubled) closest to the walking target.
export function stepTempo(bpm, target) {
  return [bpm, bpm / 2, bpm * 2].reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

// Build a playlist. Cueing sits at or a little above the walker's cadence to draw the stride forward.
export function buildPlaylist(tracks, { target, lower = 0.95, upper = 1.08, perArtist = 2, length = 20, favorites = [] }) {
  const held = [], outOfRange = [], eligible = [];
  const seenIds = new Set();
  for (const t of tracks) {
    // The same recording often appears under two artists (duets, features); keep it once.
    // Remixes and rerecordings of the same song count once too.
    const songKey = t.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
    if (!t.title || seenIds.has(t.id) || seenIds.has(songKey)) continue;
    seenIds.add(t.id); seenIds.add(songKey);
    const j = judgeTempo(t);
    if (!j.ok) { held.push({ ...t, reason: j.reason }); continue; }
    const step = Math.round(stepTempo(j.bpm, target) * 10) / 10;
    const ratio = step / target;
    if (ratio < lower || ratio > upper) { outOfRange.push({ ...t, step, bpm: j.bpm }); continue; }
    eligible.push({ ...t, step, confidence: j.confidence, note: j.note });
  }
  // The artists the listener named come first, then high confidence, then closeness to target.
  // Each artist is capped for variety.
  const fav = t => (favorites.includes(t.artist) ? 0 : 1);
  eligible.sort((a, b) => fav(a) - fav(b)
    || (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1)
    || Math.abs(a.step - target) - Math.abs(b.step - target));
  const count = {}, chosen = [];
  for (const t of eligible) {
    if ((count[t.artist] || 0) >= perArtist) continue;
    count[t.artist] = (count[t.artist] || 0) + 1;
    chosen.push(t);
    if (chosen.length >= length) break;
  }
  // Order as a session: start slightly under the target, settle onto it, finish just above.
  chosen.sort((a, b) => a.step - b.step);

  // When a favorite cannot be walked to, say why instead of dropping them silently.
  const favoriteNotes = favorites
    .filter(f => !chosen.some(t => t.artist === f))
    .map(f => {
      const swayed = held.filter(t => t.artist === f && /Swing or waltz/.test(t.reason)).length;
      // Judge by the song's own tempo, which is what a listener hears as slow or fast.
      const slow = outOfRange.filter(t => t.artist === f && t.bpm < target).length;
      const fast = outOfRange.filter(t => t.artist === f && t.bpm >= target).length;
      const parts = [];
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      if (swayed) parts.push(`${n(swayed, 'has', 'have')} a swaying triple feel that makes steps uneven`);
      if (slow) parts.push(`${n(slow, 'is', 'are')} slower than a ${target}-step walk`);
      if (fast) parts.push(`${n(fast, 'is', 'are')} faster`);
      return { artist: f, note: `None of ${f}'s top songs fit this walk: ${parts.join('; ') || 'no usable tempo'}.` };
    });
  return { playlist: chosen, held, outOfRange, favoriteNotes };
}
