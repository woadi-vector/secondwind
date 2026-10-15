// Deezer stage: real artist match, top tracks, catalog tempo and 30-second preview for each.
// No API key needed. All calls run on the server because Deezer blocks browser calls from other sites.

const API = 'https://api.deezer.com';
const MIN_FANS = 5000; // tribute acts and re-uploads usually have a few dozen fans at most

const norm = s => s.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const keys = n => [...new Set([norm(n), ...n.toLowerCase().split(/\s+(?:and|&|with)\s+/).map(norm)])];

// Strip edition labels so "Crazy (Single Version)" and "Crazy" are recognized as one song.
// If stripping would leave nothing, keep the original title.
export function cleanTitle(t) {
  const c = t
    .replace(/\s*[\(\[][^\)\]]*(remaster|single version|mono|stereo|version|edit|live|mix|rerecord)[^\)\]]*[\)\]]/ig, '')
    .replace(/\s+-\s+.*(remaster|version|mix).*$/i, '')
    .trim();
  return c || t.trim();
}

export function createDeezer({ fetchImpl = fetch } = {}) {
  async function get(path) {
    const res = await fetchImpl(API + path);
    if (!res.ok) throw new Error(`Deezer ${path} ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`Deezer ${path}: ${body.error.message || body.error.type}`);
    return body;
  }

  // Find the real artist: names must match, and the most-followed match wins.
  // Reports when it skipped the first search result, which is how impostors are caught.
  async function findArtist(name) {
    const s = await get(`/search/artist?q=${encodeURIComponent(name)}&limit=10`);
    const want = keys(name);
    const results = s.data || [];
    const matches = results
      .filter(a => keys(a.name).some(k => want.includes(k)) && a.nb_fan >= MIN_FANS)
      .sort((a, b) => b.nb_fan - a.nb_fan);
    if (!matches.length) return { artist: null, issue: `No confident match for ${name}` };
    const artist = matches[0];
    const first = results[0];
    const issue = first && first.id !== artist.id
      ? `Skipped "${first.name}" (${first.nb_fan} fans) for "${artist.name}" (${artist.nb_fan} fans)`
      : null;
    return { artist, issue };
  }

  // Top tracks with a preview, one per song, with the catalog tempo attached.
  async function topTracks(artistId, { limit = 8 } = {}) {
    const top = await get(`/artist/${artistId}/top?limit=${limit + 6}`);
    const seen = new Set();
    const out = [];
    for (const t of top.data || []) {
      if (!t.preview) continue;
      const title = cleanTitle(t.title);
      const k = norm(title);
      if (seen.has(k)) continue;
      seen.add(k);
      const detail = await get(`/track/${t.id}`);
      out.push({ id: t.id, title, deezerBpm: detail.bpm || 0, preview: t.preview, duration: t.duration });
      if (out.length >= limit) break;
    }
    return out;
  }

  return { findArtist, topTracks };
}
