'use strict';

// Run with: node --test test/digital-tx-gain.test.js
// TX Adjust: AudioBridge scales server-generated digital TX audio in one
// chokepoint (writeGenerated), attenuation-only. See audio-bridge.js
// setGeneratedTxGainDb / writeGenerated and docs/ui-notes.md "TX Adjust".

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { AudioBridge } = require('../src/server/audio-bridge');

// Minimal injected I/O: capture is just an event source here, playback
// records every buffer written to it. Nothing is started, so no real audio
// device is touched.
function makeBridge() {
  const written = [];
  const playback = Object.assign(new EventEmitter(), {
    write: (buf) => written.push(Buffer.from(buf)),
  });
  const bridge = new AudioBridge({
    controlServer: Object.assign(new EventEmitter(), { state: {} }),
    capture: new EventEmitter(),
    playback,
    sampleRate: 48000,
  });
  return { bridge, written };
}

function pcm(...samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

test('0 dB is unity passthrough (same bytes, no copy-math)', () => {
  const { bridge, written } = makeBridge();
  bridge.setGeneratedTxGainDb(0);
  const input = pcm(10000, -10000, 32767, -32768);
  bridge.writeGenerated(input);
  assert.deepStrictEqual(written[0], input);
});

test('attenuation scales every sample by the linear gain', () => {
  const { bridge, written } = makeBridge();
  bridge.setGeneratedTxGainDb(-6); // ~0.5012x
  const g = Math.pow(10, -6 / 20);
  bridge.writeGenerated(pcm(10000, -8000, 0));
  const out = written[0];
  assert.strictEqual(out.readInt16LE(0), Math.round(10000 * g));
  assert.strictEqual(out.readInt16LE(2), Math.round(-8000 * g));
  assert.strictEqual(out.readInt16LE(4), 0);
});

test('a deep cut strongly attenuates (−40 dB ~= 0.01x)', () => {
  const { bridge, written } = makeBridge();
  bridge.setGeneratedTxGainDb(-40);
  bridge.writeGenerated(pcm(10000));
  assert.strictEqual(written[0].readInt16LE(0), Math.round(10000 * Math.pow(10, -40 / 20)));
});

test('positive gain is clamped to unity — generated audio is never boosted/clipped', () => {
  const { bridge, written } = makeBridge();
  bridge.setGeneratedTxGainDb(20); // clamped to 0 dB
  bridge.writeGenerated(pcm(10000, -10000));
  assert.strictEqual(written[0].readInt16LE(0), 10000);
  assert.strictEqual(written[0].readInt16LE(2), -10000);
});

test('output clamps at the 16-bit rails (no wrap)', () => {
  const { bridge, written } = makeBridge();
  bridge.setGeneratedTxGainDb(0); // unity path already exact; verify the math path too
  // Force the math path with a tiny attenuation that rounds the rail back to itself.
  bridge.setGeneratedTxGainDb(-0.0001);
  bridge.writeGenerated(pcm(32767, -32768));
  const out = written[0];
  assert.ok(out.readInt16LE(0) <= 32767 && out.readInt16LE(0) >= 32000);
  assert.ok(out.readInt16LE(2) >= -32768 && out.readInt16LE(2) <= -32000);
});
