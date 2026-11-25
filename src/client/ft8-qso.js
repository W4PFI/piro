'use strict';

// Guided FT8 QSO support: parses the standard FT8 message set (CQ, a
// reply-to-CQ carrying a grid, a signal report, an acknowledged report,
// RRR/RR73, and 73) and drives a small state machine that tracks one
// in-progress exchange at a time, suggesting (never sending) the next
// message to transmit as the exchange progresses.
//
// Deliberately guidance, not automation: every suggestion this module
// produces still has to be reviewed and sent by the operator, the same
// as any other FT8 composer text — see docs/ui-notes.md's "What's still
// Phase 3 (explicitly not built)" for why full auto-sequencing (deciding
// *and sending* without a human per transmission) is an explicit scope
// boundary in this app, not an oversight. This module only ever returns
// suggested text; src/client/app.js is what puts it in the composer, and
// the operator is what puts it on the air.
//
// Kept as plain, dependency-free functions/classes (no DOM) so the whole
// state machine is directly unit-testable — see test/ft8-qso.test.js —
// the same "pure logic, thin UI wiring in app.js" split already used for
// scope.js's tuningMarkerX()/frequencyAtFraction() and cw-decoder.js's
// DSP.

// Maidenhead grid locator: 2 letters + 2 digits, optionally + 2 more
// letters for the finer 6-character form (e.g. "QF56" or "QF56MC").
// Deliberately permissive about case here (parseFt8Message uppercases
// first) and about the finer subsquare being present, not a full
// validator of every real-world edge case.
export const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;

// A standard FT8 signal report: a sign, always present, and two digits
// (e.g. "-15", "+03"), optionally prefixed with "R" for an *acknowledged*
// report (the second station confirming receipt of the first station's
// report while sending back their own reading of it) — see
// parseFt8Message()'s doc comment for how the two are told apart.
export const REPORT_RE = /^R?[+-]\d{2}$/;

/**
 * Parses one FT8 message's text into its structured fields, covering the
 * standard message set this module's guided sequence needs to recognize:
 *
 *   CQ [<qualifier>] <CALL> [<GRID>]   e.g. "CQ VK2IO QF56", "CQ DX VK2IO QF56"
 *   <TOCALL> <FROMCALL> <GRID>          reply to a CQ (Tx2)
 *   <TOCALL> <FROMCALL> <REPORT>        signal report (Tx3), e.g. "-15"
 *   <TOCALL> <FROMCALL> R<REPORT>       acknowledged report (Tx4), e.g. "R-05"
 *   <TOCALL> <FROMCALL> RRR             roger report received (Tx5)
 *   <TOCALL> <FROMCALL> RR73            RRR + 73 combined (Tx5, the modern default)
 *   <TOCALL> <FROMCALL> 73              final (Tx6)
 *
 * Anything else (compound/hashed callsigns, non-standard free text, a
 * bare "CQ" with nothing following it) still parses without throwing —
 * the relevant fields are simply left unset, and the guided sequencer
 * treats that as "nothing recognized this slot" rather than a bug to
 * surface. Not a strict protocol validator; good enough to drive the
 * guided sequence, not to reject malformed input elsewhere.
 *
 * @returns {{
 *   raw: string, tokens: string[],
 *   isCq?: boolean, cqCall?: string|null, cqGrid?: string|null,
 *   toCall?: string, fromCall?: string, extra?: string|null,
 *   grid?: string, report?: string, ackReport?: string,
 *   isRRR?: boolean, isRR73?: boolean, is73?: boolean
 * }}
 */
export function parseFt8Message(text) {
  const raw = (text || '').trim().toUpperCase();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { raw, tokens };

  if (tokens[0] === 'CQ') {
    let cqCall = null;
    let cqGrid = null;
    if (tokens.length === 2) {
      cqCall = tokens[1];
    } else if (tokens.length >= 3) {
      // Handles both "CQ CALL GRID" and "CQ <qualifier> CALL GRID" (e.g.
      // "CQ DX", "CQ POTA", "CQ VK") without needing to know the set of
      // possible qualifiers: whichever token is last determines whether
      // a grid was sent at all, and the call is always immediately
      // before it.
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

/**
 * Formats a numeric SNR (as decoded — see EVENT.FT8_DECODES' `snr` field)
 * as a standard FT8 signal report: an explicit sign and exactly two
 * digits (e.g. "-05", "+13"), matching how WSJT-X and this protocol's own
 * message set always render one. Real FT8 reports are clamped to a
 * -30..+30 range (values outside it are rare in practice but not
 * impossible to decode as a raw SNR number); clamped here the same way
 * rather than emitting a report shape no other software would ever send.
 */
export function formatReport(snr) {
  const n = Number.isFinite(snr) ? Math.round(snr) : 0;
  const clamped = Math.max(-30, Math.min(30, n));
  const sign = clamped >= 0 ? '+' : '-';
  const digits = String(Math.abs(clamped)).padStart(2, '0');
  return `${sign}${digits}`;
}

/**
 * The default message this app's FT8 composer starts with (see
 * enterFt8Mode() in app.js) — "CQ {CALLSIGN} {MAIDENHEAD}", built from
 * the operator's own configured station identity (STATION_CALLSIGN/
 * STATION_GRID — see src/server/index.js and docs/ui-notes.md). Returns
 * an empty string if either isn't configured, rather than a
 * half-built/misleading message like "CQ null QF56" or "CQ VK2IO null".
 */
// The standard FT8 "CQ <call> <grid>" and "<call> <call> <grid>"
// message types carry only a 4-character Maidenhead locator. A 6-char
// grid (e.g. "EM95PC") has no bits in those messages, so the packer
// silently drops the grid and the message goes on air as a bare
// "CQ W4PFI" (verified by an encode->decode round-trip). Send the 4-char
// subsquare, which is exactly what WSJT-X transmits for these.
export function gridField(grid) {
  return grid ? String(grid).toUpperCase().slice(0, 4) : '';
}

// A standard FT8 callsign — enough to tell a real "CQ CALL GRID" / reply
// from free text like "MY QTH EM95PC": a 1-2 char prefix, a digit, then
// 1-3 letters. Compound/portable calls aren't standard (they're hashed),
// and wouldn't carry a plain grid field anyway.
const CALLSIGN_RE = /^[A-Z0-9]{1,2}[0-9][A-Z]{1,3}$/;
// The 6-character (subsquare) grid form specifically.
const GRID6_RE = /^[A-R]{2}[0-9]{2}[A-X]{2}$/;

// Trim a 6-character grid down to its 4-character subsquare, but ONLY in a
// recognized standard message where the grid sits in the structured grid
// field: a "CQ [qual] CALL GRID" with a real callsign, or a
// "TOCALL FROMCALL GRID" reply between two real callsigns. Those 77-bit
// messages carry only 4 grid chars there, so a 6-char token makes the
// encoder drop the grid entirely (see gridField()). Free text can hold any
// 13 characters, grid-like or not (e.g. "MY QTH EM95PC"), so it's left
// untouched. Input is trimmed/uppercased by parseFt8Message().
export function trimMessageGrid(text) {
  const parsed = parseFt8Message(text);
  const trimLast = () => {
    const t = parsed.tokens.slice();
    t[t.length - 1] = t[t.length - 1].slice(0, 4);
    return t.join(' ');
  };
  if (parsed.isCq) {
    return parsed.cqGrid && GRID6_RE.test(parsed.cqGrid) && CALLSIGN_RE.test(parsed.cqCall || '')
      ? trimLast()
      : parsed.raw;
  }
  return parsed.grid && GRID6_RE.test(parsed.grid)
    && CALLSIGN_RE.test(parsed.toCall || '') && CALLSIGN_RE.test(parsed.fromCall || '')
    ? trimLast()
    : parsed.raw;
}

export function defaultCqMessage(callsign, grid) {
  if (!callsign || !grid) return '';
  return `CQ ${callsign.toUpperCase()} ${gridField(grid)}`;
}

/**
 * Does this decoded message belong to the given in-progress QSO? Used to
 * highlight the relevant rows in the FT8 band-activity table (see
 * app.js) — any message to/from the QSO's partner callsign, including
 * their original CQ.
 * @param {{msg: string}} decoded - one decoded message, as broadcast in EVENT.FT8_DECODES
 * @param {{partnerCall: string}|null} qso
 */
export function isRelatedToQso(decoded, qso) {
  if (!qso || !decoded || typeof decoded.msg !== 'string') return false;
  const parsed = parseFt8Message(decoded.msg);
  const partner = qso.partnerCall;
  return parsed.fromCall === partner || parsed.toCall === partner || (parsed.isCq && parsed.cqCall === partner);
}

/**
 * Drives one guided FT8 QSO at a time, following the standard 4-message
 * exchange (see docs/ui-notes.md for the full sequence diagram this
 * mirrors):
 *
 *   Caller role (engage a CQ heard from someone else):
 *     Tx2 (us->them, grid) -> Tx3 (them->us, report) ->
 *     Tx4 (us->them, R+report) -> Tx5 (them->us, RRR/RR73) -> [Tx6 73]
 *
 *   CQer role (we called CQ, someone answered):
 *     Tx1 (us->all, CQ) -> Tx2 (them->us, grid) ->
 *     Tx3 (us->them, report) -> Tx4 (them->us, R+report) -> Tx5 (us->them, RR73)
 *
 * Every transition only ever *suggests* the next transmission (see the
 * module doc comment) — it never sends anything itself, and tracking only
 * ever advances in response to something actually decoded (an inbound
 * message genuinely arriving), never merely because a suggested reply sat
 * in the composer. That keeps the state machine's notion of "what are we
 * waiting for next" always grounded in what was actually heard, not in
 * whether the operator happened to press Send.
 */
export class Ft8QsoSequencer {
  /** @param {{myCall?: string, myGrid?: string}} [opts] */
  constructor({ myCall, myGrid } = {}) {
    this.configure({ myCall, myGrid });
    this.qso = null; // {partnerCall, role: 'caller'|'cqer', step, freqHz}
    this._seeking = false; // we've sent our own CQ and are watching for a reply
  }

  /** (Re)sets the operator's own station identity — see docs/ui-notes.md. */
  configure({ myCall, myGrid }) {
    this.myCall = myCall ? String(myCall).toUpperCase() : null;
    this.myGrid = myGrid ? String(myGrid).toUpperCase() : null;
  }

  /** True once both myCall and myGrid are known — the guided sequence stays fully inactive without them. */
  get isConfigured() {
    return Boolean(this.myCall && this.myGrid);
  }

  /** The in-progress QSO, or null — used to decide which decoded rows to highlight (see isRelatedToQso()). */
  getQso() {
    return this.qso;
  }

  /** Clears any in-progress QSO/seeking state — call on leaving FT8 mode, or an explicit "start over". */
  reset() {
    this.qso = null;
    this._seeking = false;
  }

  /**
   * Call right after the operator actually sends a message that matches
   * this app's own default CQ template (see defaultCqMessage() and
   * app.js's sendFt8Message()) — arms "seeking" mode, watching subsequent
   * decodes for a reply addressed to us. Deliberately *not* inferred from
   * every send() — a manual/free-typed transmission shouldn't silently
   * arm a guided sequence the operator never asked for.
   */
  noteOwnCqSent() {
    this.qso = null;
    this._seeking = this.isConfigured;
  }

  /**
   * Call when the operator clicks a decoded row to engage with it
   * directly — a CQ from another station, or (to pick a specific caller
   * out of a pileup rather than waiting for ingestDecodes() to
   * auto-select one) a reply to our own CQ. Returns a suggestion
   * ({txText, freqHz, statusText, partnerCall}), or null if this
   * particular row isn't something the guided sequence knows how to
   * engage with — app.js falls back to its existing plain
   * copy-into-composer behavior in that case.
   * @param {{msg: string, freq?: number, snr?: number}} decoded
   */
  engage(decoded) {
    if (!this.isConfigured || !decoded || typeof decoded.msg !== 'string') return null;
    const parsed = parseFt8Message(decoded.msg);
    if (parsed.isCq && parsed.cqCall) return this._startFromCq(parsed, decoded);
    if (parsed.toCall === this.myCall && parsed.fromCall && parsed.grid) return this._startFromReply(parsed, decoded);
    if (parsed.toCall === this.myCall && parsed.report != null && parsed.fromCall && parsed.fromCall !== this.myCall && CALLSIGN_RE.test(parsed.fromCall)) return this._startFromReport(parsed, decoded);
    return null;
  }

  /**
   * Call once per completed FT8 slot with that slot's decoded messages
   * (the same array broadcast as EVENT.FT8_DECODES' `messages`). Scans
   * for whatever would advance the current QSO (or, while seeking,
   * whatever would start a new one from a reply to our CQ), strongest
   * SNR first so the clearest candidate wins when more than one message
   * could apply — e.g. several stations replying to our CQ in the same
   * slot. Returns a suggestion (same shape as engage()'s) if something
   * advanced, or null if nothing relevant decoded this slot.
   * @param {Array<{msg: string, freq?: number, snr?: number}>} messages
   */
  ingestDecodes(messages) {
    if (!this.isConfigured || !Array.isArray(messages) || messages.length === 0) return null;
    const sorted = [...messages].sort((a, b) => (b.snr ?? -Infinity) - (a.snr ?? -Infinity));

    if (this.qso) {
      for (const decoded of sorted) {
        if (typeof decoded.msg !== 'string') continue;
        const parsed = parseFt8Message(decoded.msg);
        if (parsed.fromCall !== this.qso.partnerCall || parsed.toCall !== this.myCall) continue;
        const result = this._advance(parsed, decoded);
        if (result) return result;
      }
      return null;
    }

    if (this._seeking) {
      // Pick the strongest answer to our CQ, grid-form OR report-form (grid/TX1
      // off), so the browser selects the SAME station the server's cq-watch
      // does (sorted is SNR-descending). Otherwise the two sequencers can track
      // different QSOs when both forms answer in one slot.
      for (const decoded of sorted) {
        if (typeof decoded.msg !== 'string') continue;
        const parsed = parseFt8Message(decoded.msg);
        if (parsed.toCall !== this.myCall || !parsed.fromCall || parsed.fromCall === this.myCall) continue;
        if (parsed.grid) return this._startFromReply(parsed, decoded);
        if (parsed.report != null && CALLSIGN_RE.test(parsed.fromCall)) return this._startFromReport(parsed, decoded);
      }
    }
    return null;
  }

  _startFromCq(parsed, decoded) {
    return this._startCalling(parsed.cqCall, decoded);
  }

  // Starts a QSO by calling `call` — the station whose CQ we answered, or any
  // station we heard and chose to work (see startCalling) — with our standard
  // first transmission, "THEIRCALL MYCALL MYGRID".
  _startCalling(call, decoded) {
    this.qso = { partnerCall: call, role: 'caller', step: 'awaiting-report', freqHz: decoded.freq };
    this._seeking = false;
    return this._suggestion(
      `${call} ${this.myCall} ${gridField(this.myGrid)}`,
      decoded.freq,
      `Calling ${call} — send this reply, then watch for their signal report.`
    );
  }

  /**
   * Stages a call to a station we heard that is NOT calling CQ and is NOT
   * answering us — e.g. one station working another. Clicking such a row
   * means "I want to work this station": compose our first call to its
   * sender so the operator can wait for them to finish, then send. Returns a
   * suggestion, or null if the row isn't a standard message from another
   * station.
   */
  startCalling(decoded) {
    if (!this.isConfigured || !decoded || typeof decoded.msg !== 'string') return null;
    const parsed = parseFt8Message(decoded.msg);
    if (parsed.isCq) return null;
    if (parsed.toCall === this.myCall) return null;
    // parseFt8Message sets fromCall to the second token even for free text
    // (e.g. "TNX FER QSO" -> "FER"); only start a call if it's actually a
    // callsign, else leave it to the non-auto-send copy-into-composer path.
    if (!parsed.fromCall || parsed.fromCall === this.myCall || !CALLSIGN_RE.test(parsed.fromCall)) return null;
    return this._startCalling(parsed.fromCall, decoded);
  }

  _startFromReply(parsed, decoded) {
    this.qso = { partnerCall: parsed.fromCall, role: 'cqer', step: 'awaiting-ack', freqHz: decoded.freq };
    this._seeking = false;
    return this._suggestion(
      `${parsed.fromCall} ${this.myCall} ${formatReport(decoded.snr)}`,
      decoded.freq,
      `${parsed.fromCall} answered your CQ — send their signal report, then watch for their acknowledgement.`
    );
  }
  _startFromReport(parsed, decoded) {
    // They answered/called us with a signal report instead of a grid (grid or
    // TX1 disabled), e.g. "US THEM -02": reply with our R-report and await
    // their RR73 -- i.e. the caller role at awaiting-final.
    this.qso = { partnerCall: parsed.fromCall, role: 'caller', step: 'awaiting-final', freqHz: decoded.freq,
      grid: null, reportSent: formatReport(decoded.snr), reportRcvd: parsed.report, startedAt: Date.now() };
    this._seeking = false;
    return this._suggestion(
      `${parsed.fromCall} ${this.myCall} R${formatReport(decoded.snr)}`,
      decoded.freq,
      `${parsed.fromCall} answered with a signal report — send your R-report, then watch for their RR73.`
    );
  }

  _advance(parsed, decoded) {
    const { role, step, partnerCall } = this.qso;

    if (role === 'caller' && step === 'awaiting-report' && parsed.report) {
      this.qso.step = 'awaiting-final';
      this.qso.freqHz = decoded.freq;
      return this._suggestion(
        `${partnerCall} ${this.myCall} R${formatReport(decoded.snr)}`,
        decoded.freq,
        `${partnerCall} sent a signal report — send yours back, then watch for RRR/RR73.`
      );
    }

    if (role === 'caller' && step === 'awaiting-final' && (parsed.isRRR || parsed.isRR73)) {
      this.qso.step = 'complete';
      this.qso.freqHz = decoded.freq;
      return this._suggestion(
        `${partnerCall} ${this.myCall} 73`,
        decoded.freq,
        parsed.isRR73
          ? `${partnerCall} confirmed — QSO complete. Sending 73 is optional but common courtesy.`
          : `${partnerCall} confirmed — send 73 to complete the QSO.`
      );
    }

    if (role === 'cqer' && step === 'awaiting-ack' && parsed.ackReport) {
      this.qso.step = 'complete';
      this.qso.freqHz = decoded.freq;
      return this._suggestion(
        `${partnerCall} ${this.myCall} RR73`,
        decoded.freq,
        `${partnerCall} acknowledged your report — send RR73 to complete the QSO.`
      );
    }

    return null;
  }

  _suggestion(txText, freqHz, statusText) {
    return { txText, freqHz, statusText, partnerCall: this.qso.partnerCall, step: this.qso.step };
  }
}
