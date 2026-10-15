// Tempo estimation from mono PCM samples (Float32Array). Pure JS, no dependencies, so the
// same code runs on the server (after mp3 decoding) and in a browser (after Web Audio decoding).
//
// Returns the best tempo plus how strongly the competing "three-against-two" reading scores,
// which is how swing, shuffle and waltz feels show up. Those feels are unsafe for gait cueing.

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Spectral flux onset envelope.
function onsetEnvelope(x, N = 1024, hop = 128) {
  const frames = Math.floor((x.length - N) / hop);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const re = new Float32Array(N), im = new Float32Array(N);
  const env = new Float32Array(Math.max(frames, 0));
  let prev = null;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.log(1 + 100 * Math.hypot(re[k], im[k]));
    let s = 0;
    if (prev) for (let k = 1; k < N / 2; k++) { const d = mag[k] - prev[k]; if (d > 0) s += d; }
    env[f] = s; prev = mag;
  }
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  for (let i = 0; i < env.length; i++) env[i] = Math.max(0, env[i] - mean);
  return env;
}

// Periodicity score for a tempo, summing the beat lag and its multiples.
function periodicity(env, fps, bpm) {
  const lag = fps * 60 / bpm;
  let acc = 0;
  for (const m of [1, 2, 3, 4]) {
    const L = lag * m, li = Math.floor(L), fr = L - li;
    let s = 0;
    for (let i = 0; i + li + 1 < env.length; i++) s += env[i] * (env[i + li] * (1 - fr) + env[i + li + 1] * fr);
    acc += s / m;
  }
  return acc;
}

export function estimateTempo(samples, sampleRate) {
  const hop = 128;
  const env = onsetEnvelope(samples, 1024, hop);
  const fps = sampleRate / hop;
  let best = 0, bpm = 0;
  for (let b = 55; b <= 210; b += 0.5) {
    // Mild prior toward walking tempos so the detector prefers the felt beat over subdivisions.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(b / 115) / 0.9, 2));
    const s = periodicity(env, fps, b) * prior;
    if (s > best) { best = s; bpm = b; }
  }
  // How strongly does a 3:2 reading compete? High values mean a triple or swung feel.
  const raw = periodicity(env, fps, bpm);
  const tripletRivals = [bpm * 2 / 3, bpm * 3 / 2].filter(b => b >= 45 && b <= 240);
  const tripletRatio = Math.max(0, ...tripletRivals.map(b => periodicity(env, fps, b) / raw));
  return { bpm, tripletRatio };
}
