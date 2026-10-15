// The whole agent: listener's favorites in, a walkable playlist out, with every decision explained.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { blendedArtists } from './qloo.js';
import { createDeezer } from './deezer.js';
import { tempoFromUrl } from './audio.js';
import { buildPlaylist } from './select.js';

// Tempo measurements are cached by Deezer track id (preview links expire; ids do not).
// The cache lives on the server only and is git-ignored.
// A seed table of songs measured ahead of time ships with the app (data/tempo-seed.json), so
// sessions that touch well-known songs skip measurement. It holds only our own measurements.
let seedTable = null;
function loadSeed(seedPath) {
  if (seedTable) return seedTable;
  try { seedTable = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, 'utf8')) : {}; } catch { seedTable = {}; }
  return seedTable;
}

export function createTempoCache(path = 'cache/tempo.json', seedPath = 'data/tempo-seed.json') {
  let data = { ...loadSeed(seedPath) };
  try { if (existsSync(path)) Object.assign(data, JSON.parse(readFileSync(path, 'utf8'))); } catch { /* keep seed */ }
  return {
    get: id => data[id],
    set: (id, v) => { data[id] = v; },
    size: () => Object.keys(data).length,
    save: () => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); },
  };
}

// Run tasks with a small concurrency limit so Deezer is not hammered.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function buildSession({
  favorites, age, target, maxArtists = 14, tracksPerArtist = 6,
  deezer = createDeezer(), measure = tempoFromUrl, cache = createTempoCache(), log = () => {},
}) {
  const t0 = Date.now();
  log({ stage: 'taste', text: `Asking Qloo who else fans of ${favorites.join(' and ')} love` });
  const { artists } = await blendedArtists(favorites, { age, perSeed: 15 });
  const chosenArtists = artists.slice(0, maxArtists);
  log({ stage: 'taste', text: `Qloo found ${artists.length} artists`, artists: chosenArtists.map(a => ({ name: a.name, via: a.via, source: a.source })) });

  const artistIssues = [];
  const perArtist = await pool(chosenArtists, 4, async a => {
    try {
      const { artist, issue } = await deezer.findArtist(a.name);
      if (issue) artistIssues.push({ artist: a.name, issue });
      if (!artist) return [];
      const tracks = await deezer.topTracks(artist.id, { limit: tracksPerArtist });
      log({ stage: 'songs', text: `Pulled ${tracks.length} songs by ${a.name}`, artist: a.name });
      return tracks.map(t => ({ ...t, artist: a.name, via: a.via, source: a.source }));
    } catch (e) {
      artistIssues.push({ artist: a.name, issue: String(e.message || e) });
      return [];
    }
  });
  const tracks = perArtist.flat();
  log({ stage: 'tempo', text: `Measuring the beat of ${tracks.length} songs`, total: tracks.length });

  // A song whose catalog tempo is far from the walking pace (even halved or doubled) cannot make
  // the playlist, so measuring it would only cost time. Songs near the pace, or with no catalog
  // tempo, are always measured. The margin is wider than the playlist window on purpose.
  const couldFit = d => !(d > 0) || [d, d / 2, d * 2].some(b => b >= target * 0.9 && b <= target * 1.15);

  let measured = 0, cached = 0, failed = 0, skipped = 0, done = 0;
  await pool(tracks, 6, async t => {
    const hit = cache.get(t.id);
    if (hit) { t.est = hit; cached++; }
    else if (!couldFit(t.deezerBpm)) { t.est = null; skipped++; }
    else {
      try { t.est = await measure(t.preview); cache.set(t.id, t.est); measured++; }
      catch { t.est = null; failed++; }
    }
    done++;
    if (done % 10 === 0 || done === tracks.length) log({ stage: 'tempo', progress: done, total: tracks.length });
  });
  cache.save();
  log({ stage: 'tempo', text: `Beat checked on ${tracks.length - failed} songs`, measured, cached, skipped });

  const result = buildPlaylist(tracks, { target, favorites });
  return {
    ...result,
    artistIssues,
    stats: { artists: chosenArtists.length, tracks: tracks.length, measured, cached, skipped, failed, ms: Date.now() - t0 },
  };
}
