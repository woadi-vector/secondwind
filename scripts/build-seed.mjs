// Builds data/tempo-seed.json: tempo measurements, made with the app's own code, for the top songs of
// artists that Qloo associates with a broad set of well-loved artists. Sessions that touch these songs
// skip measurement, which matters on small servers where measuring takes seconds per song.
//
// Run: node --env-file=.env scripts/build-seed.mjs
// Holds only our own measurements (track id -> tempo and swing score), never Qloo data.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { blendedArtists } from '../lib/qloo.js';
import { createDeezer } from '../lib/deezer.js';
import { tempoFromUrl } from '../lib/audio.js';

const SEEDS = [
  'The Temptations', 'Patsy Cline', 'Frank Sinatra', 'Elvis Presley', 'The Beatles', 'Johnny Cash',
  'Aretha Franklin', 'Ray Charles', 'Dolly Parton', 'The Beach Boys', 'Glenn Miller', 'Fleetwood Mac',
  'ABBA', 'Bee Gees', 'Willie Nelson', 'Neil Diamond', 'Tony Bennett', 'Louis Armstrong',
  'Earth, Wind & Fire', 'Simon & Garfunkel', 'Creedence Clearwater Revival', 'Selena', 'Marvin Gaye',
  'Hank Williams', 'Tina Turner',
];
const OUT = 'data/tempo-seed.json';
const TRACKS_PER_ARTIST = 8;

const table = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = () => { mkdirSync('data', { recursive: true }); writeFileSync(OUT, JSON.stringify(table)); };
const deezer = createDeezer();

const names = new Map();
for (const seed of SEEDS) {
  for (const age of ['55_and_older', '36_to_55']) {
    try {
      const { artists } = await blendedArtists([seed], { age, perSeed: 15 });
      artists.forEach(a => names.set(a.name.toLowerCase(), a.name));
    } catch (e) { console.log(`Qloo failed for ${seed}: ${e.message}`); }
  }
}
console.log(`${names.size} artists to cover; ${Object.keys(table).length} songs already in the table`);

let n = 0, measured = 0, failed = 0;
for (const name of names.values()) {
  n++;
  try {
    const { artist } = await deezer.findArtist(name);
    if (!artist) { console.log(`[${n}/${names.size}] ${name}: no confident match`); continue; }
    const tracks = await deezer.topTracks(artist.id, { limit: TRACKS_PER_ARTIST });
    for (const t of tracks) {
      if (table[t.id]) continue;
      try { const e = await tempoFromUrl(t.preview); table[t.id] = { bpm: e.bpm, tripletRatio: Math.round(e.tripletRatio * 1000) / 1000 }; measured++; }
      catch { failed++; }
    }
    console.log(`[${n}/${names.size}] ${name}: ${tracks.length} songs`);
  } catch (e) { console.log(`[${n}/${names.size}] ${name}: ${e.message}`); }
  if (n % 10 === 0) save();
}
save();
console.log(`Done: ${Object.keys(table).length} songs in the table (${measured} measured now, ${failed} failed)`);
