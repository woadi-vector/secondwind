// Server-side audio: decode a 30-second mp3 preview to mono PCM and measure its tempo.
import { MPEGDecoder } from 'mpg123-decoder';
import { estimateTempo } from './tempo.js';

const TARGET_RATE = 11025;
let decoderPromise = null;

async function getDecoder() {
  if (!decoderPromise) decoderPromise = (async () => { const d = new MPEGDecoder(); await d.ready; return d; })();
  return decoderPromise;
}

// Average the channels and downsample by block averaging. Tempo lives below a few kHz,
// so this is plenty and keeps analysis fast.
function toMonoLowRate(channelData, sampleRate) {
  const n = channelData[0].length;
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const out = new Float32Array(Math.floor(n / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) for (const ch of channelData) s += ch[i * factor + k];
    out[i] = s / (factor * channelData.length);
  }
  return { samples: out, rate: sampleRate / factor };
}

export async function tempoFromMp3Bytes(bytes) {
  const decoder = await getDecoder();
  await decoder.reset();
  const { channelData, sampleRate, errors } = decoder.decode(new Uint8Array(bytes));
  if (!channelData?.length || !channelData[0].length) throw new Error(`Could not decode audio${errors?.length ? `: ${errors[0].message}` : ''}`);
  const { samples, rate } = toMonoLowRate(channelData, sampleRate);
  return estimateTempo(samples, rate);
}

export async function tempoFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Preview fetch ${res.status}`);
  return tempoFromMp3Bytes(await res.arrayBuffer());
}
