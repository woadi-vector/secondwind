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
  // 70s rock, added after the Parkinson's class said their music runs from the 50s into 70s rock.
  'Eagles', 'Queen', 'Elton John', 'Boston', 'Journey', 'Foreigner', 'Heart', 'Steely Dan',
  'Tom Petty and the Heartbreakers', 'Lynyrd Skynyrd',
];
const OUT = 'data/tempo-seed.json';
const TRACKS_PER_ARTIST = 8;

const table = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = () => { mkdirSync('data', { recursive: true }); writeFileSync(OUT, JSON.stringify(table)); };
const deezer = createDeezer();

// The artist list is saved locally so a restarted run skips straight to measuring.
const NAMES_FILE = 'cache/seed-artists.json';
const BUDGET_MS = Number(process.env.BUDGET_MINUTES || 0) * 60000; // stop cleanly after this long (0 = no limit)
const started = Date.now();
const names = new Map(existsSync(NAMES_FILE) ? JSON.parse(readFileSync(NAMES_FILE, 'utf8')) : []);
// Seeds already expanded through Qloo are remembered, so adding a seed later expands only the new one.
const EXPANDED_FILE = 'cache/seed-expanded.json';
const expanded = new Set(existsSync(EXPANDED_FILE) ? JSON.parse(readFileSync(EXPANDED_FILE, 'utf8')) : (names.size ? SEEDS.slice(0, 25) : []));
for (const seed of SEEDS) {
  if (expanded.has(seed)) continue;
  names.set(seed.toLowerCase(), seed);
  expanded.add(seed);
  for (const age of ['55_and_older', '36_to_55']) {
    try {
      const { artists } = await blendedArtists([seed], { age, perSeed: 15 });
      artists.forEach(a => names.set(a.name.toLowerCase(), a.name));
    } catch (e) { console.log(`Qloo failed for ${seed}: ${e.message}`); }
  }
}
mkdirSync('cache', { recursive: true }); writeFileSync(NAMES_FILE, JSON.stringify([...names]));
writeFileSync(EXPANDED_FILE, JSON.stringify([...expanded]));
console.log(`${names.size} artists to cover; ${Object.keys(table).length} songs already in the table`);

const DONE_FILE = 'cache/seed-done.json';
const done = new Set(existsSync(DONE_FILE) ? JSON.parse(readFileSync(DONE_FILE, 'utf8')) : []);
const saveDone = () => writeFileSync(DONE_FILE, JSON.stringify([...done]));
let n = 0, measured = 0, failed = 0, stoppedEarly = false;
for (const name of names.values()) {
  n++;
  if (done.has(name)) continue;
  if (BUDGET_MS && Date.now() - started > BUDGET_MS) { stoppedEarly = true; break; }
  try {
    const { artist } = await deezer.findArtist(name);
    if (!artist) { console.log(`[${n}/${names.size}] ${name}: no confident match`); done.add(name); continue; }
    const tracks = await deezer.topTracks(artist.id, { limit: TRACKS_PER_ARTIST });
    for (const t of tracks) {
      if (table[t.id]) continue;
      try { const e = await tempoFromUrl(t.preview); table[t.id] = { bpm: e.bpm, tripletRatio: Math.round(e.tripletRatio * 1000) / 1000 }; measured++; }
      catch { failed++; }
    }
    console.log(`[${n}/${names.size}] ${name}: ${tracks.length} songs`);
    done.add(name);
  } catch (e) { console.log(`[${n}/${names.size}] ${name}: ${e.message}`); }
  if (n % 10 === 0) { save(); saveDone(); }
}
save(); saveDone();
console.log(`${stoppedEarly ? 'Paused (time budget)' : 'Done'}: ${Object.keys(table).length} songs in the table (${measured} measured now, ${failed} failed)`);
