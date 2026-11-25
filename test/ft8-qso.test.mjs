// Run with: node test/ft8-qso.test.mjs
//
// Tests src/client/ft8-qso.js directly in Node — parseFt8Message(),
// formatReport(), defaultCqMessage(), isRelatedToQso(), and the full
// Ft8QsoSequencer state machine (both roles: replying to someone else's
// CQ, and someone replying to our own CQ), end to end through the
// standard 4-message FT8 exchange. No DOM/canvas involved, so unlike
// scope-display.test.mjs's pure-function subset, this covers the whole
// module.
//
// src/client/ft8-qso.js is plain ESM (served to browsers as-is via
// <script type="module">), but this project's package.json sets "type":
// "commonjs" for the Node side, so a .js import here would be parsed as
// CommonJS. Sidestepped the same way scope-display.test.mjs does: copy to
// a temporary .mjs file, which Node always treats as ESM regardless of
// package.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, '..', 'src', 'client', 'ft8-qso.js');
const tmpPath = path.join(os.tmpdir(), `ft8-qso-test-${process.pid}.mjs`);
fs.copyFileSync(sourcePath, tmpPath);

let parseFt8Message;
let formatReport;
let defaultCqMessage;
let trimMessageGrid;
let isRelatedToQso;
let Ft8QsoSequencer;
try {
  ({ parseFt8Message, formatReport, defaultCqMessage, isRelatedToQso, Ft8QsoSequencer, trimMessageGrid } = await import(
    `file://${tmpPath}`
  ));
} finally {
  fs.rmSync(tmpPath, { force: true });
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// --- parseFt8Message() ---

{
  const p = parseFt8Message('CQ VK2IO QF56');
  check(p.isCq === true && p.cqCall === 'VK2IO' && p.cqGrid === 'QF56', `plain "CQ CALL GRID" parses correctly, got ${JSON.stringify(p)}`);
}

{
  const p = parseFt8Message('CQ DX VK2IO QF56');
  check(p.isCq === true && p.cqCall === 'VK2IO' && p.cqGrid === 'QF56', `"CQ <qualifier> CALL GRID" still extracts the right call/grid, got ${JSON.stringify(p)}`);
}

{
  const p = parseFt8Message('cq vk2io qf56');
  check(p.isCq === true && p.cqCall === 'VK2IO' && p.cqGrid === 'QF56', 'lowercase input is uppercased before parsing');
}

{
  const p = parseFt8Message('CQ VK2IO');
  check(p.isCq === true && p.cqCall === 'VK2IO' && p.cqGrid === null, 'a CQ with no grid still parses the callsign, with cqGrid null');
}

{
  const p = parseFt8Message('CQ');
  check(p.isCq === true && p.cqCall === null, 'a bare "CQ" with nothing else does not throw, and leaves cqCall null');
}

{
  const p = parseFt8Message('VK2IO VK3XU QF56');
  check(p.isCq === false && p.toCall === 'VK2IO' && p.fromCall === 'VK3XU' && p.grid === 'QF56', `a reply-to-CQ message parses its grid, got ${JSON.stringify(p)}`);
}

{
  const p = parseFt8Message('VK3XU VK2IO -15');
  check(p.report === '-15' && p.ackReport === undefined, `a bare signal report parses as "report", not "ackReport", got ${JSON.stringify(p)}`);
}

{
  const p = parseFt8Message('VK2IO VK3XU R-05');
  check(p.ackReport === '-05' && p.report === undefined, `an "R"-prefixed report parses as "ackReport" (R stripped), got ${JSON.stringify(p)}`);
}

{
  const p = parseFt8Message('VK3XU VK2IO RRR');
  check(p.isRRR === true && !p.isRR73 && !p.is73, 'RRR parses as isRRR only');
}

{
  const p = parseFt8Message('VK3XU VK2IO RR73');
  check(p.isRR73 === true && !p.isRRR, 'RR73 parses as isRR73 (and not also isRRR)');
}

{
  const p = parseFt8Message('VK2IO VK3XU 73');
  check(p.is73 === true, 'a final 73 parses as is73');
}

check(parseFt8Message('').tokens.length === 0, 'empty input parses without throwing, with no tokens');
check(parseFt8Message('   ').tokens.length === 0, 'whitespace-only input parses without throwing');

// --- formatReport() ---

check(formatReport(-15) === '-15', 'formatReport(-15) === "-15"');
check(formatReport(3) === '+03', 'formatReport(3) === "+03" (explicit sign, zero-padded)');
check(formatReport(0) === '+00', 'formatReport(0) === "+00" (zero is treated as non-negative)');
check(formatReport(-2.6) === '-03', 'formatReport rounds to the nearest integer before formatting, got ' + formatReport(-2.6));
check(formatReport(45) === '+30', 'formatReport clamps above the standard +30 ceiling, got ' + formatReport(45));
check(formatReport(-45) === '-30', 'formatReport clamps below the standard -30 floor, got ' + formatReport(-45));
check(formatReport(NaN) === '+00', 'formatReport(NaN) falls back to a sane default rather than "NaN" or throwing');

// --- defaultCqMessage() ---

check(defaultCqMessage('VK2IO', 'QF56') === 'CQ VK2IO QF56', 'defaultCqMessage builds "CQ CALLSIGN GRID"');
check(defaultCqMessage('vk2io', 'qf56') === 'CQ VK2IO QF56', 'defaultCqMessage uppercases both callsign and grid');
// The standard FT8 "CQ CALL GRID" message has bits for only a 4-character
// locator, so a configured 6-character grid is trimmed to its subsquare
// (as WSJT-X does). Feeding the full 6 chars to the encoder makes the
// packer drop the grid entirely and transmit a bare "CQ CALL".
check(defaultCqMessage('VK2IO', 'QF56MC') === 'CQ VK2IO QF56', 'defaultCqMessage trims a 6-character grid to 4 for the standard CQ message');
check(defaultCqMessage(null, 'QF56') === '', 'defaultCqMessage returns empty string when the callsign is missing');
check(defaultCqMessage('VK2IO', null) === '', 'defaultCqMessage returns empty string when the grid is missing');
check(defaultCqMessage(null, null) === '', 'defaultCqMessage returns empty string when neither is configured');

// --- trimMessageGrid() (composer free text at send time) ---
check(trimMessageGrid('CQ W4PFI EM95PC') === 'CQ W4PFI EM95', 'trims a typed 6-char grid in a CQ to its 4-char subsquare');
check(trimMessageGrid('VK3XU VK2IO QF56MC') === 'VK3XU VK2IO QF56', 'trims a typed 6-char grid in a reply to 4');
check(trimMessageGrid('CQ W4PFI EM95') === 'CQ W4PFI EM95', 'leaves a 4-char grid untouched');
check(trimMessageGrid('VK3XU VK2IO R-11') === 'VK3XU VK2IO R-11', 'leaves an acknowledged report untouched');
check(trimMessageGrid('VK3XU VK2IO 73') === 'VK3XU VK2IO 73', 'leaves 73 untouched');
check(trimMessageGrid('CQ W4PFI') === 'CQ W4PFI', 'leaves a grid-less CQ untouched');
check(trimMessageGrid('MY QTH EM95PC') === 'MY QTH EM95PC', 'leaves free text (non-callsign tokens) untouched — a 6-char grid is valid in free text');
check(trimMessageGrid('CQ DX VK2IO QF56MC') === 'CQ DX VK2IO QF56', 'trims a 6-char grid in a "CQ <qualifier> CALL GRID"');

// A 6-character configured grid is likewise trimmed in the caller-role
// Tx2 reply (us -> CQer, carrying our grid).
{
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56MC' });
  const step = seq.engage({ msg: 'CQ VK3XU QF33', freq: 1500, snr: -10 });
  check(step !== null && step.txText === 'VK3XU VK2IO QF56', `caller-role Tx2 trims our 6-char grid to 4, got ${JSON.stringify(step)}`);
}

// --- isRelatedToQso() ---

{
  const qso = { partnerCall: 'VK3XU' };
  check(isRelatedToQso({ msg: 'VK3XU VK2IO -15' }, qso), 'a message to the partner call is related');
  check(isRelatedToQso({ msg: 'VK2IO VK3XU R-05' }, qso), 'a message from the partner call is related');
  check(isRelatedToQso({ msg: 'CQ VK3XU QF56' }, qso), "the partner's own CQ is related");
  check(!isRelatedToQso({ msg: 'VK5ZZZ VK9YYY 73' }, qso), 'a message between two unrelated stations is not related');
  check(!isRelatedToQso({ msg: 'VK3XU VK2IO -15' }, null), 'nothing is related when there is no active QSO');
}

// --- Ft8QsoSequencer: not configured ---

{
  const seq = new Ft8QsoSequencer();
  check(seq.isConfigured === false, 'isConfigured is false with no station identity set');
  check(seq.engage({ msg: 'CQ VK3XU QF56', freq: 1500 }) === null, 'engage() is a no-op when not configured');
  check(seq.ingestDecodes([{ msg: 'CQ VK3XU QF56', freq: 1500 }]) === null, 'ingestDecodes() is a no-op when not configured');
}

// --- Ft8QsoSequencer: caller role (we click/engage someone else's CQ) ---

{
  const seq = new Ft8QsoSequencer({ myCall: 'vk2io', myGrid: 'qf56' });
  check(seq.isConfigured === true, 'isConfigured is true once both myCall and myGrid are set');

  // 1. Engage a heard CQ -> Tx2 (reply with our grid)
  const step1 = seq.engage({ msg: 'CQ VK3XU QF33', freq: 1500, snr: -10 });
  check(step1 !== null && step1.txText === 'VK3XU VK2IO QF56', `engaging a CQ suggests the Tx2 reply, got ${JSON.stringify(step1)}`);
  check(step1.freqHz === 1500, 'the suggestion carries the CQ\'s own decoded frequency, to reply on the same frequency they\'re listening on');
  check(seq.getQso().partnerCall === 'VK3XU' && seq.getQso().role === 'caller', 'the sequencer now tracks an in-progress QSO with the CQer, in the caller role');

  // 2. They send us a signal report (Tx3) -> Tx4 (R + our report of them)
  const step2 = seq.ingestDecodes([{ msg: 'VK2IO VK3XU -09', freq: 1503, snr: -6 }]);
  check(step2 !== null && step2.txText === 'VK3XU VK2IO R-06', `receiving their report suggests the Tx4 ack-with-our-own-report, got ${JSON.stringify(step2)}`);
  check(step2.freqHz === 1503, "the QSO's tracked frequency follows the partner's most recently decoded frequency (drift tracking)");

  // Unrelated traffic in the same slot must not disturb the QSO.
  const noise = seq.ingestDecodes([{ msg: 'CQ VK9ZZZ QF10', freq: 2000, snr: 5 }]);
  check(noise === null, 'unrelated decodes (a different station entirely) do not advance or disturb the active QSO');
  check(seq.getQso().partnerCall === 'VK3XU', 'the QSO partner is unchanged after unrelated traffic');

  // 3. They send RR73 (Tx5, combined) -> optional Tx6 73 suggested, QSO marked complete
  const step3 = seq.ingestDecodes([{ msg: 'VK2IO VK3XU RR73', freq: 1503, snr: -4 }]);
  check(step3 !== null && step3.txText === 'VK3XU VK2IO 73', `receiving RR73 suggests the (optional) final 73, got ${JSON.stringify(step3)}`);
  check(seq.getQso().step === 'complete', 'the QSO is marked complete after RR73');
}

{
  // Same caller-role flow, but the CQer sends bare RRR instead of RR73 —
  // still ends in the same suggested final 73, and completes.
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  seq.engage({ msg: 'CQ VK3XU QF33', freq: 1500 });
  seq.ingestDecodes([{ msg: 'VK2IO VK3XU -09', freq: 1500, snr: -6 }]);
  const step = seq.ingestDecodes([{ msg: 'VK2IO VK3XU RRR', freq: 1500, snr: -4 }]);
  check(step !== null && step.txText === 'VK3XU VK2IO 73', 'a bare RRR (not RR73) still suggests sending the final 73');
  check(seq.getQso().step === 'complete', 'the QSO completes after RRR + our 73 suggestion, same as after RR73');
}

// --- Ft8QsoSequencer: cqer role (we send our own CQ, someone answers) ---

{
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });

  // Before sending our own CQ, an incoming reply-shaped message should
  // not spontaneously start a QSO — only noteOwnCqSent() arms that.
  const premature = seq.ingestDecodes([{ msg: 'VK2IO VK3XU QF33', freq: 1200, snr: -8 }]);
  check(premature === null, 'a reply-shaped message is ignored until we actually send our own CQ (noteOwnCqSent())');

  seq.noteOwnCqSent();

  // 1. Someone answers our CQ (Tx2, with grid) -> Tx3 (our report of them)
  const step1 = seq.ingestDecodes([{ msg: 'VK2IO VK3XU QF33', freq: 1200, snr: -8 }]);
  check(step1 !== null && step1.txText === 'VK3XU VK2IO -08', `a reply to our CQ suggests the Tx3 report, got ${JSON.stringify(step1)}`);
  check(seq.getQso().role === 'cqer' && seq.getQso().partnerCall === 'VK3XU', 'the sequencer now tracks the QSO in the cqer role');

  // 2. They acknowledge with their own report (Tx4) -> Tx5 (RR73)
  const step2 = seq.ingestDecodes([{ msg: 'VK2IO VK3XU R-11', freq: 1200, snr: -7 }]);
  check(step2 !== null && step2.txText === 'VK3XU VK2IO RR73', `an acknowledged report suggests the final RR73, got ${JSON.stringify(step2)}`);
  check(seq.getQso().step === 'complete', 'the QSO completes once RR73 is suggested in the cqer role');
}

{
  // When multiple stations reply to our CQ in the same slot (a pileup),
  // the strongest (highest SNR) one is picked deterministically.
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  seq.noteOwnCqSent();
  const step = seq.ingestDecodes([
    { msg: 'VK2IO VK5WEAK QF10', freq: 900, snr: -20 },
    { msg: 'VK2IO VK9STRONG QF20', freq: 1800, snr: -2 },
  ]);
  check(step !== null && step.txText === 'VK9STRONG VK2IO -02', `the strongest (highest-SNR) reply is engaged first out of a pileup, got ${JSON.stringify(step)}`);
}

{
  // engage() also supports manually picking a specific reply out of a
  // pileup (clicking a row) rather than waiting for the auto-picked one.
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  seq.noteOwnCqSent();
  const step = seq.engage({ msg: 'VK2IO VK5WEAK QF10', freq: 900, snr: -20 });
  check(step !== null && step.txText === 'VK5WEAK VK2IO -20', 'engage() lets the operator manually pick a specific caller to work, overriding auto-selection');
  check(seq.getQso().partnerCall === 'VK5WEAK', 'the manually-engaged caller becomes the tracked QSO partner');
}

// --- Ft8QsoSequencer: engage() returns null for rows it can't guide ---

{
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  check(seq.engage({ msg: 'VK9ZZZ VK8YYY -05', freq: 1000 }) === null, 'engage() on a message not addressed to us and not a CQ returns null (falls back to plain copy in app.js)');
  check(seq.engage({ msg: 'VK2IO VK3XU R-05', freq: 1000 }) === null, "engage() on an ack-report addressed to us (not a fresh CQ reply) returns null — that's ingestDecodes()'s job mid-QSO, not a fresh engagement");
}

// --- Ft8QsoSequencer: ingestDecodes() while seeking picks report OR grid ---

{
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  seq.noteOwnCqSent();
  // stronger report-form answer + weaker grid-form answer in the same slot:
  // pick the stronger (report-form), matching the server's cq-watch selection.
  const step = seq.ingestDecodes([
    { msg: 'VK2IO K1ABC -02', freq: 900, snr: 10 },
    { msg: 'VK2IO K2XYZ QF10', freq: 1500, snr: 3 },
  ]);
  check(step !== null && step.txText === 'K1ABC VK2IO R+10' && seq.getQso().partnerCall === 'K1ABC',
    `seeking picks the strongest answer (report-form here) like the server, got ${JSON.stringify(step)}`);
}

// --- Ft8QsoSequencer: engage() a report-form reply to us (grid/TX1 skipped) ---

{
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  const step = seq.engage({ msg: 'VK2IO KA0BOJ +02', freq: 900, snr: 5 });
  check(step !== null && step.txText === 'KA0BOJ VK2IO R+05', `engage() on a plain-report reply to us stages our R-report (not the raw text), got ${JSON.stringify(step)}`);
  check(seq.getQso() && seq.getQso().partnerCall === 'KA0BOJ' && seq.getQso().role === 'caller' && seq.getQso().step === 'awaiting-final', 'a report-form reply starts a caller-role QSO at awaiting-final (awaiting their RR73)');
}

// --- reset() ---

{
  const seq = new Ft8QsoSequencer({ myCall: 'VK2IO', myGrid: 'QF56' });
  seq.engage({ msg: 'CQ VK3XU QF33', freq: 1500 });
  check(seq.getQso() !== null, 'sanity: a QSO is active before reset()');
  seq.reset();
  check(seq.getQso() === null, 'reset() clears the active QSO');
  check(seq.ingestDecodes([{ msg: 'VK2IO VK9NEW QF44', freq: 1600, snr: -5 }]) === null, 'reset() also clears "seeking" state, so a stray reply-shaped message is ignored until noteOwnCqSent() is called again');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
