'use strict';

const { EVENT, BINARY_TYPE } = require('./protocol');
const { SCOPE_MODE } = require('../civ/commands');

// Must match the SCOPE_MODE values in src/civ/commands.js.
const CENTER_LIKE_MODES = new Set([0x00, 0x02]); // Center, Scroll-C

// Watchdog defaults. The radio streams many waveform lines per second
// whenever scope output is on, so a multi-second gap means the output has
// stopped (see _watchTick). Re-enabling costs two small CI-V writes.
const DEFAULT_STALE_MS = 5000; // no line for this long (while RX) => output has died
const DEFAULT_CHECK_MS = 2000; // how often the watchdog looks

/**
 * Listens for 'scope-line' events from a CivDriver and broadcasts each
 * one to every connected WebSocket client as a tagged binary frame (see
 * BINARY_TYPE.SCOPE_LINE in protocol.js). Server->client only — clients
 * never send scope data upstream.
 *
 * Wire format (all multi-byte fields little-endian):
 *   byte[0]     BINARY_TYPE.SCOPE_LINE
 *   byte[1]     mode (see src/civ/commands.js SCOPE_MODE)
 *   byte[2]     mainSub (0=main, 1=sub)
 *   byte[3:7]   freqA as UInt32LE — centerFreq (center/scroll-c modes) or
 *               startFreq (fixed/scroll-f modes)
 *   byte[7:11]  freqB as UInt32LE — span (center/scroll-c) or endFreq (fixed/scroll-f)
 *   byte[11]    extra — inRange (0/1) for fixed/scroll-f modes, 0xFF (n/a) otherwise
 *   byte[12:]   points — raw amplitude sample bytes, one per pixel
 *
 * A fixed 12-byte header (rather than a variable-length one) keeps
 * client-side parsing simple — no conditional offset math needed. The
 * client-side decoder mirrors this exactly in src/client/rpc.js; keep
 * both in sync if this format changes.
 *
 * Watchdog: the IC-7300 clears its "scope waveform data output" setting
 * when it power-cycles. Because its USB serial often re-enumerates under
 * the same /dev name, the serial port doesn't always emit 'close', so the
 * process keeps running with a live CI-V link but a dead scope and nothing
 * ever re-sends enableScopeOutput() (that otherwise happens only at
 * startup). The watchdog notices the waveform has gone silent and
 * re-enables output — see _watchTick().
 */
class ScopeBridge {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {number} [opts.staleMs] - re-enable output if no line arrives for this long while not transmitting
   * @param {number} [opts.checkMs] - watchdog poll interval
   */
  constructor({ civ, controlServer, staleMs = DEFAULT_STALE_MS, checkMs = DEFAULT_CHECK_MS }) {
    if (!civ) throw new Error('ScopeBridge requires opts.civ');
    if (!controlServer) throw new Error('ScopeBridge requires opts.controlServer');
    this.civ = civ;
    this.controlServer = controlServer;
    this.staleMs = staleMs;
    this.checkMs = checkMs;

    this._lastLineAt = 0; // epoch ms of the last scope-line (0 until start())
    this._watchTimer = null;
    this._reEnabling = false; // an enableScopeOutput() from the watchdog is in flight

    this._onLine = (line) => this._broadcastLine(line);
    this.civ.on('scope-line', this._onLine);
  }

  _broadcastLine(line) {
    this._lastLineAt = Date.now();
    try {
      this.controlServer.broadcastBinary(encodeScopeLine(line));
    } catch (err) {
      console.error('[scope]', err.message);
      this.controlServer.broadcastJsonEvent(EVENT.SCOPE_ERROR, { message: err.message });
    }
  }

  /**
   * Enables scope output on the radio, switches it to Center mode, and
   * starts broadcasting lines. Deliberately does NOT set a span here.
   *
   * This has now failed at startup twice, for two different reasons: an
   * earlier wrong wire format made span-setting slow/unreliable enough to
   * delay everything after it (audio included), and even after the wire
   * format was corrected and verified against a real worked example, the
   * radio still rejected (NG) a span-set attempted immediately after
   * enabling scope output — root cause unconfirmed (could be a genuine
   * settling-time requirement in the radio's scope subsystem, could be
   * something else). Rather than keep guessing at server-startup
   * sequencing on hardware this project has no direct access to, span is
   * simply not set here at all anymore. The client requests a default
   * span itself once it's already connected (see app.js) — happening
   * naturally later, well after enable, with the WS round-trip and page
   * load already providing whatever settling time might be needed — and
   * any failure there only affects that one request (surfaced as an
   * error toast), never server health or anything else. Setting mode
   * alone is simple, low-risk, and was never implicated in the failures
   * above — kept here since Center mode's displayed center then
   * automatically tracks the VFO with no further commands needed.
   */
  async start() {
    await this.civ.enableScopeOutput();
    await this.civ.setScopeMode(SCOPE_MODE.CENTER);
    this._lastLineAt = Date.now();
    this._startWatchdog();
  }

  /** Disables scope output on the radio and stops listening for lines. */
  async stop() {
    this._stopWatchdog();
    this.civ.off('scope-line', this._onLine);
    try {
      await this.civ.disableScopeOutput();
    } catch {
      // best-effort on shutdown
    }
  }

  _startWatchdog() {
    if (this._watchTimer || !(this.checkMs > 0)) return;
    this._watchTimer = setInterval(() => {
      this._watchTick().catch((err) => console.error('[scope] watchdog:', err.message));
    }, this.checkMs);
    this._watchTimer.unref?.();
  }

  _stopWatchdog() {
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  /**
   * One watchdog poll. Re-enables scope output when the waveform has gone
   * silent for `staleMs` — the IC-7300 drops the output setting on a
   * power-cycle, and the serial port doesn't always close, so nothing else
   * recovers it. Transmitting is NOT a stall: the radio legitimately stops
   * the scope while keyed, so the clock is kept fresh during TX (and for
   * `staleMs` after it) so a long transmission never triggers a re-enable.
   */
  async _watchTick() {
    if (this._reEnabling) return;
    // Legitimately quiet while transmitting: keep the clock fresh so TX
    // (and the settle just after it) is never mistaken for a dead output.
    // Uses the aggregate `transmitting` guard, not state.ptt alone, so the
    // CW keyer and paddle (which key the radio without PTT) also count.
    if (this.controlServer.transmitting) {
      this._lastLineAt = Date.now();
      return;
    }
    if (Date.now() - this._lastLineAt < this.staleMs) return;

    this._reEnabling = true;
    console.warn(
      `[scope] no waveform for ${Math.round((Date.now() - this._lastLineAt) / 1000)}s; ` +
        're-enabling scope output (radio power-cycled?).'
    );
    try {
      await this.civ.enableScopeOutput();
    } catch (err) {
      console.error('[scope] re-enable failed:', err.message);
    } finally {
      // Give the radio a fresh window to resume before trying again,
      // whether or not the re-enable threw.
      this._lastLineAt = Date.now();
      this._reEnabling = false;
    }
  }
}

function encodeScopeLine(line) {
  const header = Buffer.alloc(12);
  header[0] = BINARY_TYPE.SCOPE_LINE;
  header[1] = line.mode;
  header[2] = line.mainSub;

  if (CENTER_LIKE_MODES.has(line.mode)) {
    header.writeUInt32LE(line.centerFreq >>> 0, 3);
    header.writeUInt32LE(line.span >>> 0, 7);
    header[11] = 0xff;
  } else {
    header.writeUInt32LE(line.startFreq >>> 0, 3);
    header.writeUInt32LE(line.endFreq >>> 0, 7);
    header[11] = line.inRange ? 0x01 : 0x00;
  }

  return Buffer.concat([header, line.points]);
}

module.exports = { ScopeBridge, encodeScopeLine };
