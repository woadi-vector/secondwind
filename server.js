// Web server: serves the page and streams each session's progress to the browser as it works.
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, normalize } from 'path';
import { buildSession } from './lib/pipeline.js';
import { buildPlaylist, buildDrill } from './lib/select.js';
import { claudeAvailable, planClass, briefWalk } from './lib/claude.js';
import * as claudeState from './lib/claude.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = join(process.cwd(), 'public');
const AGES = new Set(['35_and_younger', '36_to_55', '55_and_older']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let running = 0;
const MAX_RUNNING = Number(process.env.MAX_SESSIONS || 4);

function parseRequest(url) {
  const favorites = (url.searchParams.get('favorites') || '')
    .split('|').map(s => s.trim()).filter(Boolean).slice(0, 4);
  const target = Math.round(Number(url.searchParams.get('pace')));
  const age = url.searchParams.get('age') || '55_and_older';
  if (!favorites.length) return { error: 'Name at least one artist the listener loves.' };
  if (favorites.some(f => f.length > 60)) return { error: 'Artist names must be under 60 characters.' };
  if (!(target >= 60 && target <= 200)) return { error: 'Set a pace between 60 and 200 steps a minute.' };
  if (!AGES.has(age)) return { error: 'Choose an age range from the list.' };
  const mode = url.searchParams.get('mode') === 'drill' ? 'drill' : 'steady';
  return { favorites, target, age, mode };
}

// Development only: replay recorded tracks so the page can be built without network access.
async function fixtureSession({ favorites, target, mode }, log) {
  const tracks = JSON.parse(readFileSync(process.env.SECONDWIND_FIXTURE, 'utf8'));
  const artists = [...new Set(tracks.map(t => t.artist))];
  log({ stage: 'taste', text: `Asking Qloo who else fans of ${favorites.join(' and ')} love` });
  await new Promise(r => setTimeout(r, 600));
  log({ stage: 'taste', text: `Qloo found ${artists.length} artists`, artists: artists.map(name => ({ name })) });
  for (const a of artists) { await new Promise(r => setTimeout(r, 120)); log({ stage: 'songs', text: `Pulled songs by ${a}`, artist: a }); }
  log({ stage: 'tempo', text: `Measuring the beat of ${tracks.length} songs`, total: tracks.length });
  for (let i = 10; i <= tracks.length; i += 10) { await new Promise(r => setTimeout(r, 60)); log({ stage: 'tempo', progress: i, total: tracks.length }); }
  log({ stage: 'tempo', text: `Beat checked on ${tracks.length} songs` });
  const build = mode === 'drill' ? buildDrill : buildPlaylist;
  return { ...build(tracks, { target, favorites }), artistIssues: [], stats: { tracks: tracks.length, artists: artists.length } };
}

async function streamSession(req, res, url) {
  const parsed = parseRequest(url);
  if (parsed.error) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: parsed.error })); }
  if (running >= MAX_RUNNING) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Several playlists are being built right now. Try again in a minute.' })); }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  running++;
  try {
    const log = e => send('progress', e);
    const result = process.env.SECONDWIND_FIXTURE
      ? await fixtureSession(parsed, log)
      : await buildSession({ ...parsed, log });
    // Send only what the page needs; previews are short-lived signed links.
    const pick = t => ({ id: t.id, artist: t.artist, title: t.title, preview: t.preview, step: t.step, bpm: t.bpm,
      confidence: t.confidence, note: t.note, reason: t.reason, duration: t.duration,
      measured: t.est?.bpm || t.deezerBpm || null, blockPace: t.blockPace, block: t.block, cue: t.cue, volume: t.volume });
    send('result', {
      target: parsed.target, favorites: parsed.favorites, mode: result.mode, paces: result.paces,
      playlist: result.playlist.map(pick), held: result.held.map(pick),
      outOfRange: result.outOfRange.length, favoriteNotes: result.favoriteNotes, counts: result.counts,
      artistIssues: result.artistIssues, stats: result.stats, briefing: claudeAvailable(),
    });
    // The instructor's note comes after the songs, so a slow answer never holds up the playlist.
    if (claudeAvailable()) {
      try {
        const b = await briefWalk({ target: parsed.target, mode: parsed.mode, favorites: parsed.favorites, result });
        const a = b.adjustment;
        const adjustment = a && a.label ? {
          label: String(a.label).slice(0, 80),
          pace: Number.isInteger(a.pace) && a.pace >= 60 && a.pace <= 200 ? a.pace : null,
          mode: a.mode === 'drill' || a.mode === 'steady' ? a.mode : null,
          addArtist: typeof a.addArtist === 'string' && a.addArtist.trim() && a.addArtist.length <= 60 ? a.addArtist.trim() : null,
        } : null;
        send('brief', { brief: String(b.brief || '').slice(0, 800), adjustment: adjustment && (adjustment.pace || adjustment.mode || adjustment.addArtist) ? adjustment : null });
      } catch (e) { console.error('Brief failed:', e.message); send('brief', { brief: null }); }
    }
  } catch (e) {
    console.error(e);
    send('failure', { error: 'The playlist could not be built. The music services did not respond; try again in a moment.' });
  } finally {
    running--; clearInterval(keepAlive); res.end();
  }
}

// The instructor's description, read by Claude into session settings. Everything it returns is checked
// against the same limits as the form before it reaches the page.
async function planRequest(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!claudeAvailable()) return reply(503, { error: 'Describing the class is not switched on yet.' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 8000) return reply(413, { error: 'Keep the description under a page.' }); }
  let description = '';
  try { description = String(JSON.parse(raw).description || '').trim(); } catch { return reply(400, { error: 'Could not read the description.' }); }
  if (description.length < 10) return reply(400, { error: 'Tell a little more about the class: what music they love, and how you run it.' });
  try {
    const p = await planClass(description);
    const favorites = (Array.isArray(p.favorites) ? p.favorites : []).map(f => String(f).trim()).filter(f => f && f.length <= 60).slice(0, 4);
    if (!favorites.length) return reply(422, { error: 'No artists could be picked out of that. Name a few singers or bands the class likes.' });
    reply(200, {
      favorites,
      age: AGES.has(p.age) ? p.age : '55_and_older',
      mode: p.mode === 'drill' ? 'drill' : 'steady',
      pace: Number.isInteger(p.pace) && p.pace >= 60 && p.pace <= 200 ? p.pace : null,
      understood: String(p.understood || '').slice(0, 600),
      check: p.check ? String(p.check).slice(0, 300) : null,
    });
  } catch (e) { console.error('Plan failed:', e.message); reply(502, { error: 'Could not read the description just now. Fill in the form below instead.' }); }
}

function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

// Log anything that would otherwise crash the server silently, and keep serving.
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e));

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/session') return streamSession(req, res, url);
  if (url.pathname === '/api/plan' && req.method === 'POST') return planRequest(req, res);
  if (url.pathname === '/api/features') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ claude: claudeAvailable(), lastError: claudeState.lastClaudeError })); }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, uptimeSeconds: Math.round(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1e6),
      sessionsRunning: running, commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
    }));
  }
  return serveStatic(res, url.pathname);
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}${process.env.SECONDWIND_FIXTURE ? ' (fixture mode)' : ''}`));
