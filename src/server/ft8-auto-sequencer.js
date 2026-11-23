'use strict';

/**
 * Server-side FT8/FT4 auto-sequencer. Given a slot's decoded messages, and an
 * armed guided QSO, it returns the next standard reply (R-report / RR73 / 73)
 * the instant the slot decodes -- so with Auto armed the reply is generated and
 * queued ON THE SERVER, with no decode -> browser -> server round-trip. That
 * round-trip (seconds over a remote/Tailscale link) is what made auto replies
 * miss their slot and QSOs stall at the report stage.
 *
 * This is a faithful subset of the client sequencer (src/client/ft8-qso.js):
 * the same message parser and the same "caller"/"cqer" advance rules, limited
 * to the automatic replies. The client still runs its own sequencer for the
 * on-screen status and for the FIRST transmission (answering a CQ / our CQ);
 * the server takes over the decode-triggered replies once armed.
 */

const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;
const REPORT_RE = /^R?[+-]\d{2}$/;

// Verbatim port of src/client/ft8-qso.js#parseFt8Message (kept in sync).
function parseFt8Message(text) {
  const raw = (text || '').trim().toUpperCase();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { raw, tokens };
  if (tokens[0] === 'CQ') {
    let cqCall = null;
    let cqGrid = null;
    if (tokens.length === 2) {
      cqCall = tokens[1];
    } else if (tokens.length >= 3) {
      const last = tokens[tokens.length - 1];
      const hasGrid = GRID_RE.test(last);
      cqCall = hasGrid ? tokens[tokens.length - 2] : tokens[tokens.length - 1];
      cqGrid = hasGrid ? last : null;
    }
    return { raw, tokens, isCq: true, cqCall, cqGrid };
  }
  if (tokens.length < 2) return { raw, tokens, isCq: false };
  const [toCall, fromCall, ...rest] = tokens;
  const extra = rest.length > 0 ? rest.join(' ') : null;
  const parsed = { raw, tokens, isCq: false, toCall, fromCall, extra };
  if (extra === 'RR73') parsed.isRR73 = true;
  else if (extra === 'RRR') parsed.isRRR = true;
  else if (extra === '73') parsed.is73 = true;
  else if (extra && GRID_RE.test(extra)) parsed.grid = extra;
  else if (extra && REPORT_RE.test(extra)) {
    if (extra.startsWith('R')) parsed.ackReport = extra.slice(1);
    else parsed.report = extra;
  }
  return parsed;
}

// Verbatim port of src/client/ft8-qso.js#formatReport.
function formatReport(snr) {
  const n = Number.isFinite(snr) ? Math.round(snr) : 0;
  const clamped = Math.max(-30, Math.min(30, n));
  const sign = clamped >= 0 ? '+' : '-';
  const digits = String(Math.abs(clamped)).padStart(2, '0');
  return `${sign}${digits}`;
}

class Ft8AutoSequencer {
  /** @param {{myCall?: string}} opts */
  constructor({ myCall } = {}) {
    this.myCall = (myCall || '').toUpperCase();
    this.qso = null; // null = disarmed
  }

  /**
   * Arm. Three ways:
   *  - { cqWatch: true, freqHz? } -> we just sent a CQ; watch for anyone
   *    answering it ("MYCALL THEIRCALL GRID") and start the QSO by replying
   *    with our report of them.
   *  - { partnerCall, role: 'caller', ... } -> we answered their CQ; send the
   *    R-report then 73.
   *  - { partnerCall, role: 'cqer', ... } -> mid-QSO after they answered our CQ.
   */
  arm({ partnerCall, role, step, freqHz, cqWatch } = {}) {
    if (!this.myCall) return false;
    const fallbackFreq = Number.isFinite(freqHz) ? freqHz : null;
    if (cqWatch) {
      this.qso = { mode: 'cq-watch', freqHz: fallbackFreq };
      return true;
    }
    const call = (partnerCall || '').toUpperCase();
    if (!call) return false;
    const r = role === 'cqer' ? 'cqer' : 'caller';
    this.qso = {
      mode: 'qso',
      partnerCall: call,
      role: r,
      step: step || (r === 'cqer' ? 'awaiting-ack' : 'awaiting-report'),
      freqHz: fallbackFreq,
    };
    return true;
  }

  disarm() {
    this.qso = null;
  }

  get active() {
    return this.qso != null;
  }

  getQso() {
    return this.qso ? { ...this.qso } : null;
  }

  /**
   * Advance on a decoded slot. `messages` is EVENT.FT8_DECODES' array of
   * { msg, snr, freq }. Returns { message, freqHz, step } to transmit, or null.
   * Mutates state; clears itself once the QSO completes (after 73 / RR73).
   */
  advance(messages) {
    if (!this.qso || !Array.isArray(messages) || messages.length === 0) return null;
    // Strongest first -- the clearest copy wins, matching the client, which
    // sorts decodes by SNR descending before ingesting them.
    const sorted = [...messages].sort((a, b) => (b.snr ?? -999) - (a.snr ?? -999));

    // CQ-watch: we just CQ'd; the first station to answer us with a grid
    // ("MYCALL THEIRCALL GRID") becomes the QSO, and we reply with our report
    // of them. (A pileup -> the strongest answer, like WSJT-X.)
    if (this.qso.mode === 'cq-watch') {
      for (const m of sorted) {
        if (!m || typeof m.msg !== 'string') continue;
        const parsed = parseFt8Message(m.msg);
        if (parsed.isCq) continue;
        if (parsed.toCall !== this.myCall || !parsed.fromCall || parsed.fromCall === this.myCall || !parsed.grid) continue;
        const partnerCall = parsed.fromCall;
        const freqHz = Number.isFinite(m.freq) ? m.freq : this.qso.freqHz;
        this.qso = { mode: 'qso', partnerCall, role: 'cqer', step: 'awaiting-ack', freqHz };
        return { message: `${partnerCall} ${this.myCall} ${formatReport(m.snr)}`, freqHz, step: 'awaiting-ack' };
      }
      return null;
    }

    const { role, step, partnerCall } = this.qso;
    for (const m of sorted) {
      if (!m || typeof m.msg !== 'string') continue;
      const parsed = parseFt8Message(m.msg);
      if (parsed.isCq) continue;
      if (parsed.fromCall !== partnerCall || parsed.toCall !== this.myCall) continue;

      if (role === 'caller' && step === 'awaiting-report' && parsed.report) {
        this.qso.step = 'awaiting-final';
        this.qso.freqHz = Number.isFinite(m.freq) ? m.freq : this.qso.freqHz;
        return { message: `${partnerCall} ${this.myCall} R${formatReport(m.snr)}`, freqHz: this.qso.freqHz, step: 'awaiting-final' };
      }
      if (role === 'caller' && step === 'awaiting-final' && (parsed.isRRR || parsed.isRR73)) {
        const freqHz = Number.isFinite(m.freq) ? m.freq : this.qso.freqHz;
        this.qso = null; // QSO complete
        return { message: `${partnerCall} ${this.myCall} 73`, freqHz, step: 'complete' };
      }
      if (role === 'cqer' && step === 'awaiting-ack' && parsed.ackReport) {
        const freqHz = Number.isFinite(m.freq) ? m.freq : this.qso.freqHz;
        this.qso = null; // complete after RR73
        return { message: `${partnerCall} ${this.myCall} RR73`, freqHz, step: 'complete' };
      }
    }
    return null;
  }
}

module.exports = { Ft8AutoSequencer, parseFt8Message, formatReport };
