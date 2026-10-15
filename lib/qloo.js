// Qloo stage: turn a listener's seed artists into a blended list of artists they are likely to love.
// Each seed is queried on its own so one genre cannot drown out another, then results are interleaved.

const BASE = process.env.QLOO_BASE_URL || 'https://hackathon.api.qloo.com';

// Answers are remembered for a day: the same favorites give the same neighbors, and it spares
// both waiting time and the hackathon key's rate limit. Kept in server memory only, never committed.
const MEMO_MS = 24 * 60 * 60 * 1000;
const memo = new Map();

async function qloo(path, params, attempt = 0) {
  const key = process.env.QLOO_API_KEY;
  if (!key) throw new Error('QLOO_API_KEY is not set');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const hit = memo.get(url.href);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.body;
  const res = await fetch(url, { headers: { 'X-Api-Key': key } });
  if (res.status === 429 && attempt < 3) {
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    return qloo(path, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Qloo ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (memo.size > 2000) memo.clear();
  memo.set(url.href, { at: Date.now(), body });
  return body;
}

// Normalized keys used to merge "Smokey Robinson" with "Smokey Robinson and The Miracles",
// and "The Supremes" with "Diana Ross and the Supremes". A joint name yields a key for each half.
const norm = s => s.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
export function artistKeys(name) {
  const parts = name.toLowerCase().split(/\s+(?:and|&|with)\s+/);
  return [...new Set([norm(name), ...parts.map(norm)])].filter(Boolean);
}
export const artistKey = name => artistKeys(name)[0];

export async function resolveArtist(name) {
  const d = await qloo('/search', { query: name, types: 'urn:entity:artist' });
  const results = d.results || [];
  const target = name.trim().toLowerCase();
  // Prefer an exact name match; fall back to the most popular result.
  const exact = results.find(r => r.name.trim().toLowerCase() === target);
  const pick = exact || results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  if (!pick) throw new Error(`No Qloo artist found for "${name}"`);
  return { id: pick.entity_id, name: pick.name };
}

export async function artistsForSeed(seedId, { age, take = 20 } = {}) {
  const d = await qloo('/v2/insights', {
    'filter.type': 'urn:entity:artist',
    'signal.interests.entities': seedId,
    'signal.demographics.age': age,
    take,
  });
  return (d.results?.entities || []).map(e => ({
    id: e.entity_id,
    name: e.name,
    affinity: e.query?.affinity ?? null,
  }));
}

// Interleave per-seed lists (round robin) and drop duplicates and the seeds themselves.
export async function blendedArtists(seedNames, { age, perSeed = 20 } = {}) {
  const seeds = await Promise.all(seedNames.map(resolveArtist));
  const lists = await Promise.all(seeds.map(s => artistsForSeed(s.id, { age, take: perSeed })));
  const seen = new Set(seeds.flatMap(s => artistKeys(s.name)));
  const out = [];
  // Seeds themselves belong in the playlist: the listener named them.
  for (const s of seeds) out.push({ ...s, source: 'seed', via: s.name });
  const max = Math.max(...lists.map(l => l.length));
  for (let i = 0; i < max; i++) {
    lists.forEach((list, j) => {
      const a = list[i];
      if (!a) return;
      const keys = artistKeys(a.name);
      if (keys.some(k => seen.has(k))) return;
      keys.forEach(k => seen.add(k));
      out.push({ ...a, source: 'qloo', via: seeds[j].name });
    });
  }
  return { seeds, artists: out };
}
