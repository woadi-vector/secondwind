// The whole agent: listener's favorites in, a walkable playlist out, with every decision explained.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { blendedArtists } from './qloo.js';
import { createDeezer } from './deezer.js';
import { tempoFromUrl } from './audio.js';
import { buildPlaylist } from './select.js';

// Tempo measurements are cached by Deezer track id (preview links expire; ids do not).
// The cache lives on the server only and is git-ignored.
export function createTempoCache(path = 'cache/tempo.json') {
  let data = {};
  try { if (existsSync(path)) data = JSON.parse(readFileSync(path, 'utf8')); } catch { data = {}; }
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
  favorites, age, target, maxArtists = 20, tracksPerArtist = 8,
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

  let measured = 0, cached = 0, failed = 0, done = 0;
  await pool(tracks, 6, async t => {
    const hit = cache.get(t.id);
    if (hit) { t.est = hit; cached++; }
    else {
      try { t.est = await measure(t.preview); cache.set(t.id, t.est); measured++; }
      catch { t.est = null; failed++; }
    }
    done++;
    if (done % 10 === 0 || done === tracks.length) log({ stage: 'tempo', progress: done, total: tracks.length });
  });
  cache.save();
  log({ stage: 'tempo', text: `Beat checked on ${tracks.length - failed} songs` });

  const result = buildPlaylist(tracks, { target, favorites });
  return {
    ...result,
    artistIssues,
    stats: { artists: chosenArtists.length, tracks: tracks.length, measured, cached, failed, ms: Date.now() - t0 },
  };
}
