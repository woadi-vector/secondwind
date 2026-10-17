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

  const favoriteNotes = notesForFavorites(favorites, chosen, held, outOfRange, target);
  // Counts for the visible funnel: songs checked, outside the pace, held out, fit the pace.
  const counts = { checked: held.length + outOfRange.length + eligible.length, outOfRange: outOfRange.length, held: held.length, fit: eligible.length, kept: chosen.length };
  return { mode: 'steady', playlist: chosen, held, outOfRange, favoriteNotes, counts };
}

// When a favorite cannot be walked to, say why instead of dropping them silently.
function notesForFavorites(favorites, chosen, held, outOfRange, target) {
  return favorites
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
}

// Drill: the instructor's version of the walk. Instead of one steady pace, the class works through
// planned changes they must adapt to: the pace moves every two songs (target, faster, target, slower),
// the style flips between favorites inside each pair, and the volume drops partway through some songs.
// Each pace window is tight (4 percent) so the changes are distinct, and the windows never overlap.
// Songs that sway are held out exactly as in a steady walk: a drill tests adapting, never balance.
// The gentle setting halves the pace changes (5 percent) and tightens each window to match, for
// classes with canes, walkers or balance concerns. It is a placeholder until a physical therapist sets it.
export const DRILL_SHIFT = 0.1;
export const GENTLE_SHIFT = 0.05;
export function drillPaces(target, gentle = false) {
  const shift = gentle ? GENTLE_SHIFT : DRILL_SHIFT;
  return [target, Math.round(target * (1 + shift)), target, Math.round(target * (1 - shift))];
}

export function buildDrill(tracks, { target, favorites = [], gentle = false, perArtist = 2, length = 16, blockLen = 2, window = gentle ? 0.025 : 0.04 }) {
  const cycle = drillPaces(target, gentle);
  const paces = [...new Set(cycle)];
  const held = [], outOfRange = [], eligible = [];
  const seenIds = new Set();
  for (const t of tracks) {
    const songKey = t.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
    if (!t.title || seenIds.has(t.id) || seenIds.has(songKey)) continue;
    seenIds.add(t.id); seenIds.add(songKey);
    const j = judgeTempo(t);
    if (!j.ok) { held.push({ ...t, reason: j.reason }); continue; }
    const fits = {};
    for (const p of paces) {
      const step = Math.round(stepTempo(j.bpm, p) * 10) / 10;
      if (Math.abs(step / p - 1) <= window) fits[p] = step;
    }
    if (!Object.keys(fits).length) { outOfRange.push({ ...t, step: Math.round(stepTempo(j.bpm, target) * 10) / 10, bpm: j.bpm }); continue; }
    eligible.push({ ...t, fits, confidence: j.confidence, note: j.note });
  }

  const fav = t => (favorites.includes(t.artist) ? 0 : 1);
  const used = new Set(), count = {}, chosen = [];
  let misses = 0;
  for (let b = 0; chosen.length < length && misses < cycle.length; b++) {
    const pace = cycle[b % cycle.length];
    const pool = eligible
      .filter(t => t.fits[pace] && !used.has(t.id) && (count[t.artist] || 0) < perArtist)
      .sort((x, y) => fav(x) - fav(y)
        || (x.confidence === y.confidence ? 0 : x.confidence === 'high' ? -1 : 1)
        || Math.abs(x.fits[pace] - pace) - Math.abs(y.fits[pace] - pace));
    // Every change goes through the home pace, so a class never jumps from slow straight to fast.
    // If the home pace has run out of songs, the drill ends there.
    if (!pool.length && pace === target) break;
    if (!pool.length) { misses++; continue; } // no songs at this off pace: skip that change
    misses = 0;
    for (let k = 0; k < blockLen && chosen.length < length; k++) {
      const prev = chosen[chosen.length - 1];
      // Inside a pair, flip to music from a different favorite's circle so the style changes too.
      const open = pool.filter(t => !used.has(t.id) && (count[t.artist] || 0) < perArtist);
      const pick = open.find(t => !prev || (t.via !== prev.via && t.artist !== prev.artist))
        || open.find(t => !prev || t.artist !== prev.artist) || open[0];
      if (!pick) break;
      used.add(pick.id); count[pick.artist] = (count[pick.artist] || 0) + 1;
      chosen.push({ ...pick, step: pick.fits[pace], blockPace: pace, block: b });
    }
  }

  // Write the cue the instructor calls at the start of each song, and plan the volume drops.
  chosen.forEach((t, i) => {
    const prev = chosen[i - 1];
    if (!prev) t.cue = { kind: 'start', text: `Start at ${t.blockPace} steps a minute` };
    else if (t.blockPace !== prev.blockPace) t.cue = { kind: 'pace', text: t.blockPace === target ? `Back to ${t.blockPace} steps a minute`
      : t.blockPace > prev.blockPace ? `Pick it up: ${t.blockPace} steps a minute` : `Slow down: ${t.blockPace} steps a minute` };
    else if (t.via && prev.via && t.via !== prev.via) t.cue = { kind: 'style', text: `Style change, same pace` };
    else t.cue = { kind: 'hold', text: `Same pace` };
    // A volume drop halfway through the second song of every other pair: one new change at a time.
    t.volume = (t.block % 2 === 1 && prev && prev.block === t.block) ? 'drop' : null;
  });

  const favoriteNotes = notesForFavorites(favorites, chosen, held, outOfRange, target);
  const counts = { checked: held.length + outOfRange.length + eligible.length, outOfRange: outOfRange.length, held: held.length, fit: eligible.length, kept: chosen.length };
  return { mode: 'drill', gentle, paces, playlist: chosen, held, outOfRange, favoriteNotes, counts };
}
