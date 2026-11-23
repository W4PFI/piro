'use strict';

/**
 * Runs inside a Node worker_thread (spawned by ft8-bridge.js), never
 * required directly from the main thread. Exists because FT8 decoding is
 * genuinely CPU-heavy — measured at 1-3+ seconds for a moderately busy
 * band on fast hardware, plausibly longer on a Raspberry Pi under real
 * contest-weekend band conditions with dozens of simultaneous decodes —
 * and running that synchronously on the main thread would stall CI-V
 * serial communication, audio streaming, and the WebSocket connection
 * itself for that whole span, every 15 seconds. Node has no built-in way
 * to make a single synchronous library call yield partway through, so
 * the only real option is moving it off the main thread entirely; this
 * uses the standard library's own `worker_threads` rather than pulling
 * in a job-queue dependency, keeping the "no external dependencies"
 * goal intact for this part of the app (ft8ts itself is the one
 * accepted, deliberate exception — see README/LICENSE).
 *
 * FT8 decoding further runs on ft8ts's `FT8DecoderPool`, which splits the
 * band into one sub-band per thread and decodes them in parallel
 * worker_threads (nested under this one), meeting after each pass to
 * subtract each other's signals — the same scheme WSJT-X 3 uses. The pool
 * is created lazily and kept for the life of this worker; its threads start
 * on first use and sit idle between slots. FT4 has no pool in ft8ts (as in
 * WSJT-X), so it stays on the single-threaded decodeFT4. Thread count and
 * decode depth are set from the environment — see the constants below.
 *
 * Protocol (all messages are plain objects via postMessage):
 *   -> { type: 'decode', requestId, samples: ArrayBuffer (Float32),
 *        sampleRate, knownCallsigns: string[], protocol?: 'FT8'|'FT4' }
 *   <- { type: 'decoded', requestId, messages: DecodedMessage[],
 *        discoveredCallsigns: string[] }
 *   <- { type: 'decode-error', requestId, error: string }
 *
 * `protocol` selects which of ft8ts's decoders to run (defaults to 'FT8'
 * for backward compatibility with any caller that predates FT4 support —
 * see ft8-bridge.js#setVariant()). Both decoders take the same options
 * shape and return the same DecodedMessage shape, so nothing else here
 * needs to branch on it.
 *
 * `knownCallsigns`/`discoveredCallsigns` stand in for passing a real
 * ft8ts HashCallBook across the worker boundary, which isn't practical —
 * it's a class instance, not plain data, and worker_threads can only
 * structured-clone plain data. Each decode instead builds a *fresh*
 * HashCallBook seeded from whatever plain callsign strings the main
 * thread has accumulated across previous slots (see ft8-bridge.js), and
 * reports back any additional full (non-hashed) callsigns this decode
 * itself turned up, so the main thread's running set keeps growing.
 * Honest limitation: a hashed-callsign reference can only resolve
 * against a callsign already learned in an *earlier* slot (or earlier in
 * the same decode call's candidate order), same as it would take a
 * real operator a moment to build up context on who's on frequency —
 * this just doesn't carry a mid-decode hash table across the boundary.
 */

const { parentPort } = require('node:worker_threads');
const { decodeFT4, FT8DecoderPool, HashCallBook } = require('@e04/ft8ts');

// Decode tuning, from the environment (documented in the README). Defaults
// are chosen for a Raspberry Pi 4: 2 FT8 decode threads is the measured sweet
// spot — the pool splits the band across that many cores, and using more
// starves the main process (CI-V, audio, WebSocket) so decode actually gets
// slower; depth 1 is WSJT-X "fast" (band-pass only), raise to 2 (BP+OSD) or 3
// (deep) for more decodes of weak stations if the hardware has the headroom.
const DECODE_THREADS = Math.max(1, parseInt(process.env.FT8_DECODE_THREADS || '', 10) || 2);
const DECODE_DEPTH = Math.max(1, parseInt(process.env.FT8_DECODE_DEPTH || '', 10) || 1);
const MAX_CANDIDATES = Math.max(1, parseInt(process.env.FT8_MAX_CANDIDATES || '', 10) || 80);

// The FT8 decoder pool, created on first FT8 decode and reused thereafter.
// With DECODE_THREADS === 1 the pool decodes on this worker thread (still off
// the main thread), so there is no separate single-threaded FT8 path to keep.
let ft8Pool = null;
function getFt8Pool() {
  if (!ft8Pool) ft8Pool = new FT8DecoderPool({ threads: DECODE_THREADS });
  return ft8Pool;
}

// A generous, permissive shape check, not a strict callsign validator —
// HashCallBook.save() already tolerates and ignores blank/short/`<...>`
// input on its own (see its own doc comment), so erring toward saving a
// few non-callsign tokens is harmless; the real failure mode being
// guarded against is a real callsign getting *missed* because a
// regex here was too strict about slashes, digits, or portable/compound
// forms (e.g. "VK2IO/P", "PJ4/K1ABC").
const CALLSIGN_LIKE = /^[A-Z0-9]{1,3}\/?[A-Z0-9]{2,4}\/?[A-Z0-9]{0,4}$/;

function looksLikeCallsign(token) {
  return token.length >= 3 && token.length <= 12 && /\d/.test(token) && CALLSIGN_LIKE.test(token);
}

function extractCallsigns(messageText) {
  return messageText
    .split(/\s+/)
    .filter((tok) => tok && !tok.startsWith('<') && looksLikeCallsign(tok));
}

parentPort.on('message', async (msg) => {
  if (msg.type !== 'decode') return;
  const { requestId, samples, sampleRate, knownCallsigns, protocol } = msg;
  try {
    const floatSamples = new Float32Array(samples);
    const book = new HashCallBook();
    for (const call of knownCallsigns) book.save(call);
    const options = { sampleRate, depth: DECODE_DEPTH, maxCandidates: MAX_CANDIDATES, hashCallBook: book };
    // FT8 goes through the multi-threaded pool (await: it resolves once all
    // sub-band threads have met and finished); FT4 stays single-threaded.
    const messages = protocol === 'FT4'
      ? decodeFT4(floatSamples, options)
      : await getFt8Pool().decode(floatSamples, options);
    const discoveredCallsigns = [];
    for (const m of messages) {
      for (const call of extractCallsigns(m.msg)) discoveredCallsigns.push(call);
    }
    parentPort.postMessage({ type: 'decoded', requestId, messages, discoveredCallsigns });
  } catch (err) {
    parentPort.postMessage({ type: 'decode-error', requestId, error: err.message });
  }
});
