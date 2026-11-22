'use strict';

// Emits a completed QSO as a WSJT-X "Logged ADIF" (message type 12) UDP
// datagram -- the de-facto standard that loggers (GridTracker, JTAlert,
// Log4OM, WaveLogGate, ...) consume for auto-logging. We send ONLY type 12
// (not the structured type-5 "QSO Logged"), which carries the whole QSO as
// one ADIF record and avoids the well-known double-logging some gateways do
// when they process both messages. See docs and src/client/ft8-qso.js for the
// guided-QSO state machine that produces the fields.

const dgram = require('dgram');

const WSJTX_MAGIC = 0xadbccbda;
const WSJTX_SCHEMA = 2;
const MSG_LOGGED_ADIF = 12;

// QDataStream (Qt, big-endian) QString: a quint32 byte length then UTF-8
// bytes; 0xffffffff is a null string.
function qString(str) {
  if (str == null) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(0xffffffff, 0);
    return b;
  }
  const bytes = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function buildLoggedAdif(id, adif) {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(WSJTX_MAGIC, 0);
  head.writeUInt32BE(WSJTX_SCHEMA, 4);
  head.writeUInt32BE(MSG_LOGGED_ADIF, 8);
  return Buffer.concat([head, qString(id), qString(adif)]);
}

function adif(name, value) {
  if (value == null || value === '') return '';
  const v = String(value);
  return `<${name}:${Buffer.byteLength(v, 'utf8')}>${v}`;
}

const BANDS = [
  [1.8, 2.0, '160M'], [3.5, 4.0, '80M'], [5.06, 5.45, '60M'], [7.0, 7.3, '40M'],
  [10.1, 10.15, '30M'], [14.0, 14.35, '20M'], [18.068, 18.168, '17M'],
  [21.0, 21.45, '15M'], [24.89, 24.99, '12M'], [28.0, 29.7, '10M'],
  [50.0, 54.0, '6M'], [144.0, 148.0, '2M'], [430.0, 450.0, '70CM'],
];
function bandForHz(hz) {
  const mhz = Number(hz) / 1e6;
  for (const [lo, hi, b] of BANDS) if (mhz >= lo && mhz <= hi) return b;
  return '';
}

function utcDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function utcTime(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

class WsjtxLogger {
  /**
   * @param {{host?:string, port:number, id?:string, myCall?:string,
   *   myGrid?:string, dedupMs?:number}} opts
   */
  constructor({ host = '127.0.0.1', port, id = 'PiRO', myCall, myGrid, dedupMs = 120000 } = {}) {
    this.host = host;
    this.port = Number(port) || 0;
    this.id = id;
    this.myCall = myCall ? String(myCall).toUpperCase() : '';
    this.myGrid = myGrid ? String(myGrid).toUpperCase() : '';
    this.dedupMs = dedupMs;
    this._recent = new Map(); // "CALL|BAND|MODE" -> ms, for dedup
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => console.error('[log] UDP socket error:', err.message));
  }

  /** Build the ADIF record (exported-ish for testing). qso fields below. */
  buildAdif(qso) {
    const freqHz = Number(qso.freqHz) || 0;
    const band = bandForHz(freqHz);
    const started = Number(qso.startedAt) || Date.now();
    const ended = Date.now();
    const record = [
      '<adif_ver:5>3.1.0',
      adif('programid', 'PiRO'),
      '<EOH>',
      adif('call', String(qso.call).toUpperCase()),
      adif('gridsquare', qso.grid ? String(qso.grid).toUpperCase() : ''),
      adif('mode', (qso.mode || 'FT8').toUpperCase()),
      adif('rst_sent', qso.rstSent),
      adif('rst_rcvd', qso.rstRcvd),
      adif('qso_date', utcDate(started)),
      adif('time_on', utcTime(started)),
      adif('qso_date_off', utcDate(ended)),
      adif('time_off', utcTime(ended)),
      adif('band', band),
      adif('freq', freqHz ? (freqHz / 1e6).toFixed(6) : ''),
      adif('station_callsign', this.myCall),
      adif('my_gridsquare', this.myGrid),
      adif('operator', this.myCall),
      '<EOR>',
    ].filter(Boolean).join(' ');
    return { record, band };
  }

  /**
   * Log one completed QSO. qso: {call, grid?, mode?, rstSent?, rstRcvd?,
   * freqHz?, startedAt?}. Deduplicated on call+band+mode within dedupMs.
   * Returns true if a datagram was sent.
   */
  log(qso) {
    if (!this.port || !qso || !qso.call) return false;
    const { record, band } = this.buildAdif(qso);
    const key = `${String(qso.call).toUpperCase()}|${band}|${(qso.mode || '').toUpperCase()}`;
    const now = Date.now();
    const prev = this._recent.get(key);
    if (prev && now - prev < this.dedupMs) {
      console.log(`[log] duplicate ${key} within ${Math.round(this.dedupMs / 1000)}s -- not re-logged`);
      return false;
    }
    this._recent.set(key, now);
    for (const [k, t] of this._recent) if (now - t > this.dedupMs) this._recent.delete(k);

    const msg = buildLoggedAdif(this.id, record);
    this.socket.send(msg, this.port, this.host, (err) => {
      if (err) console.error('[log] WSJT-X UDP send failed:', err.message);
    });
    console.log(`[log] QSO ${String(qso.call).toUpperCase()} ${band} ${(qso.mode || 'FT8').toUpperCase()} ` +
      `sent ${qso.rstSent || '-'} rcvd ${qso.rstRcvd || '-'} -> WSJT-X UDP ${this.host}:${this.port}`);
    return true;
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

module.exports = { WsjtxLogger, buildLoggedAdif, bandForHz };
