'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ft8AutoSequencer, parseFt8Message, formatReport } = require('../src/server/ft8-auto-sequencer');

test('formatReport renders a signed two-digit report, clamped to ±30', () => {
  assert.equal(formatReport(5), '+05');
  assert.equal(formatReport(-7), '-07');
  assert.equal(formatReport(0), '+00');
  assert.equal(formatReport(99), '+30');
  assert.equal(formatReport(-99), '-30');
});

test('parseFt8Message classifies CQ / reply / report / ack / RR73 / 73', () => {
  assert.deepEqual(
    { isCq: parseFt8Message('CQ W4PFI EM95').isCq, cqCall: parseFt8Message('CQ W4PFI EM95').cqCall },
    { isCq: true, cqCall: 'W4PFI' }
  );
  assert.equal(parseFt8Message('CQ DX W4PFI EM95').cqCall, 'W4PFI');
  assert.equal(parseFt8Message('W4PFI K1ABC FN42').grid, 'FN42');
  assert.equal(parseFt8Message('W4PFI K1ABC -03').report, '-03');
  assert.equal(parseFt8Message('W4PFI K1ABC R-03').ackReport, '-03');
  assert.equal(parseFt8Message('W4PFI K1ABC RR73').isRR73, true);
  assert.equal(parseFt8Message('W4PFI K1ABC 73').is73, true);
});

test('caller: their report -> our R-report -> their RR73 -> our 73, then disarms', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ partnerCall: 'W2CG', role: 'caller', step: 'awaiting-report', freqHz: 2029 });
  // report of us from the partner -> we reply R<our report of them>, ignoring a CQ
  let r = s.advance([{ msg: 'CQ K1ABC FN42', snr: 10, freq: 500 }, { msg: 'W4PFI W2CG -03', snr: 5, freq: 2029 }]);
  assert.equal(r.message, 'W2CG W4PFI R+05');
  assert.equal(s.getQso().step, 'awaiting-final');
  // their RR73 -> our 73 (drift-tracking their frequency), then disarmed
  r = s.advance([{ msg: 'W4PFI W2CG RR73', snr: 3, freq: 2030 }]);
  assert.equal(r.message, 'W2CG W4PFI 73');
  assert.equal(r.freqHz, 2030);
  assert.equal(s.active, false);
});

test('caller awaiting-final ignores a repeated report (only RRR/RR73 advances)', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ partnerCall: 'W2CG', role: 'caller', step: 'awaiting-final', freqHz: 2029 });
  assert.equal(s.advance([{ msg: 'W4PFI W2CG -03', snr: 5, freq: 2029 }]), null);
});

test('cqer: their R-report -> our RR73, then disarms', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ partnerCall: 'K1ABC', role: 'cqer', step: 'awaiting-ack', freqHz: 1000 });
  const r = s.advance([{ msg: 'W4PFI K1ABC R-10', snr: 2, freq: 1000 }]);
  assert.equal(r.message, 'K1ABC W4PFI RR73');
  assert.equal(s.active, false);
});

test('a QSO ignores messages not from the partner or not addressed to us', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ partnerCall: 'W2CG', role: 'caller', step: 'awaiting-report', freqHz: 2029 });
  assert.equal(s.advance([{ msg: 'W2CG W4PFI -03', snr: 5, freq: 2029 }]), null); // from us direction
  assert.equal(s.advance([{ msg: 'W4PFI N0XYZ -03', snr: 5, freq: 2029 }]), null); // other station
  assert.equal(s.active, true);
});

test('cq-watch: the strongest answer starts a QSO (our report), then RR73', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ cqWatch: true, freqHz: 1500 });
  let r = s.advance([{ msg: 'CQ N0XYZ EM10', snr: 20, freq: 400 }, { msg: 'W4PFI K1ABC FN42', snr: 8, freq: 800 }]);
  assert.equal(r.message, 'K1ABC W4PFI +08');
  assert.equal(r.freqHz, 800); // reply on the answerer's frequency
  assert.equal(s.getQso().role, 'cqer');
  r = s.advance([{ msg: 'W4PFI K1ABC R-05', snr: 3, freq: 800 }]);
  assert.equal(r.message, 'K1ABC W4PFI RR73');
  assert.equal(s.active, false);
});

test('cq-watch ignores a CQ, an answer to someone else, and a call it cannot sequence', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ cqWatch: true, freqHz: 1500 });
  assert.equal(s.advance([{ msg: 'CQ K1ABC FN42', snr: 9, freq: 700 }]), null);
  assert.equal(s.advance([{ msg: 'N0XYZ K1ABC FN42', snr: 9, freq: 700 }]), null);
  // Addressed to us but neither grid nor report (bare call): held, not acted on.
  assert.equal(s.advance([{ msg: 'W4PFI K1ABC', snr: 9, freq: 700 }]), null);
  assert.equal(s.active, true);
});

test('cq-watch re-sends the CQ up to cqRepeats times when unanswered, then gives up', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 2 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  const noAnswer = [{ msg: 'CQ N0XYZ EM10', snr: 5, freq: 400 }];
  let r = s.advance(noAnswer);
  assert.equal(r.message, 'CQ W4PFI EM95'); // 1st auto re-CQ
  assert.equal(r.freqHz, 1500);
  assert.equal(r.step, 'cq-watch');
  assert.equal(s.active, true);
  r = s.advance(noAnswer);
  assert.equal(r.message, 'CQ W4PFI EM95'); // 2nd auto re-CQ
  assert.equal(s.active, true);
  r = s.advance(noAnswer);
  assert.equal(r, null); // repeats exhausted -> give up
  assert.equal(s.active, false); // disarmed
});

test('cq-watch without cqText only watches (no auto-repeat), as before', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 3 });
  s.arm({ cqWatch: true, freqHz: 1500 }); // no cqText
  assert.equal(s.advance([{ msg: 'CQ N0XYZ EM10', snr: 5, freq: 400 }]), null);
  assert.equal(s.active, true);
});

test('cq-watch: an answer starts the QSO even with auto-CQ repeats configured', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 5 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  const r = s.advance([{ msg: 'W4PFI K1ABC FN42', snr: 8, freq: 800 }]);
  assert.equal(r.message, 'K1ABC W4PFI +08'); // answered, not a re-CQ
  assert.equal(s.getQso().role, 'cqer');
});

test('cqRepeats defaults to 5 and clamps a bad value', () => {
  assert.equal(new Ft8AutoSequencer({ myCall: 'W4PFI' }).cqRepeats, 5);
  assert.equal(new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: -1 }).cqRepeats, 5);
  assert.equal(new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 0 }).cqRepeats, 0);
});

test('cq-watch: a report-form answer (no grid) -> our R-report, then 73 on RR73', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 5 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  let r = s.advance([{ msg: 'W4PFI K1ABC -12', snr: 7, freq: 900 }]);
  assert.equal(r.message, 'K1ABC W4PFI R+07');
  assert.equal(r.step, 'awaiting-final');
  assert.equal(s.getQso().role, 'caller');
  r = s.advance([{ msg: 'W4PFI K1ABC RR73', snr: 7, freq: 900 }]);
  assert.equal(r.message, 'K1ABC W4PFI 73');
  assert.equal(s.active, false);
});

test('cq-watch: never auto-CQs over a station addressed to us it cannot sequence', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 5 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  // A bare "US THEM" with no grid/report: held, not CQ'd over, stays armed.
  assert.equal(s.advance([{ msg: 'W4PFI K1ABC', snr: 4, freq: 700 }]), null);
  assert.equal(s.active, true);
  // Only a truly empty slot triggers the re-CQ.
  assert.equal(s.advance([{ msg: 'CQ N0XYZ EM10', snr: 4, freq: 700 }]).message, 'CQ W4PFI EM95');
});

test('cq-watch: each auto-CQ carries its attempt number and total', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 3 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  const no = [{ msg: 'CQ N0XYZ EM10', snr: 4, freq: 700 }];
  assert.deepEqual([s.advance(no).cqAttempt, s.advance(no).cqAttempt, s.advance(no).cqAttempt], [1, 2, 3]);
  assert.equal(new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 3 }).cqRepeats, 3);
});

test('cq-watch: a quiet (empty) slot still triggers a CQ repeat (#3)', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 2 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  assert.equal(s.advance([]).message, 'CQ W4PFI EM95'); // no decodes -> still re-CQ
  assert.equal(s.advance([]).message, 'CQ W4PFI EM95');
  assert.equal(s.advance([]), null); assert.equal(s.active, false);
});

test('cq-watch: cqRepeats=0 is watch-only -- never disarms on no-answer (#4)', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 0 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  for (let i = 0; i < 5; i++) assert.equal(s.advance([]), null);
  assert.equal(s.active, true); // still watching
  // and it still answers a caller
  assert.equal(s.advance([{ msg: 'W4PFI K1ABC FN42', snr: 8, freq: 800 }]).message, 'K1ABC W4PFI +08');
});

test('cq-watch: a re-CQ is suppressed (no budget spend) while one is queued (#6)', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI', cqRepeats: 2 });
  s.arm({ cqWatch: true, freqHz: 1500, cqText: 'CQ W4PFI EM95' });
  assert.equal(s.advance([]).message, 'CQ W4PFI EM95');       // attempt 1 queued (budget 2->1)
  assert.equal(s.advance([], { cqSuppressed: true }), null);  // queued -> no re-CQ, no spend
  assert.equal(s.advance([], { cqSuppressed: true }), null);
  assert.equal(s.advance([]).message, 'CQ W4PFI EM95');       // aired -> attempt 2 (budget 1->0)
  assert.equal(s.advance([]), null); assert.equal(s.active, false);
});

test('disarm() stops it; advancing while disarmed returns null', () => {
  const s = new Ft8AutoSequencer({ myCall: 'W4PFI' });
  s.arm({ partnerCall: 'W2CG', role: 'caller', step: 'awaiting-report', freqHz: 2029 });
  s.disarm();
  assert.equal(s.active, false);
  assert.equal(s.advance([{ msg: 'W4PFI W2CG -03', snr: 5, freq: 2029 }]), null);
});
