// Runs decoding and tempo analysis off the main thread, so the web server keeps answering
// (progress updates, Render's health checks) while a song is being measured.
import { parentPort } from 'worker_threads';
import { tempoFromMp3Bytes } from './audio.js';

parentPort.on('message', async ({ id, bytes }) => {
  try { parentPort.postMessage({ id, result: await tempoFromMp3Bytes(bytes) }); }
  catch (e) { parentPort.postMessage({ id, error: String(e.message || e) }); }
});
