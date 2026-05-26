/**
 * ocrEngine.test.js — OCR text-parsing unit tests
 *
 * Covers the parseOcrText pipeline that turns a raw OCR/text-layer string into
 * structured dimension fields. These guard the classification rules that have
 * regressed before: threads/notes must NOT be decomposed into fake dimensions,
 * and tolerance/diameter strings must parse into the right fields.
 */

window.TEST = window.TEST || {};

TEST.runOcrTests = function(log) {
  var passed = 0;
  var failed = 0;

  function assert(desc, condition) {
    if (condition) {
      log('<div class="test pass">✓ ' + desc + '</div>');
      passed++;
    } else {
      log('<div class="test fail">✗ ' + desc + '</div>');
      failed++;
    }
  }

  var parseOcrText = PSB.ocrEngine.parseOcrText;

  // ── Threads & notes are notes, not dimensions (bug #4) ───
  log('<h3>Thread / Note classification</h3>');

  var thread = parseOcrText('M4X0.7 - 6H THRU');
  assert('Metric thread → detectFeatureType "thread"',
    PSB.detectFeatureType('M4X0.7 - 6H THRU') === 'thread');
  assert('Metric thread → isNote = true', thread.isNote === true);
  assert('Metric thread → full text preserved in drawingSpec',
    thread.drawingSpec === 'M4X0.7 - 6H THRU');
  assert('Metric thread → NOT decomposed into a numeric nominal',
    thread.nominal === '' || thread.nominal === 'M4X0.7 - 6H THRU');

  var unc = parseOcrText('1/4-20 UNC-2B THRU');
  assert('UNC thread → isNote = true', unc.isNote === true);
  assert('UNC thread → full text preserved', unc.drawingSpec === '1/4-20 UNC-2B THRU');

  var note = parseOcrText('BREAK ALL SHARP EDGES');
  assert('General note → isNote = true', note.isNote === true);
  assert('General note → text preserved', note.drawingSpec === 'BREAK ALL SHARP EDGES');

  // ── Tolerance + diameter parsing (bugs #5 / #8) ──────────
  log('<h3>Tolerance &amp; diameter parsing</h3>');

  var symDim = parseOcrText('.630±.003');
  assert('".630±.003" → drawingSpec ".630"', symDim.drawingSpec === '.630');
  assert('".630±.003" → tolerance "0.003"', symDim.tolerance === '0.003');
  assert('".630±.003" → tolMode "sym"', symDim.tolMode === 'sym');
  assert('".630±.003" → not a note', symDim.isNote === false);

  var asymDia = parseOcrText('Ø.690 +.001/-.000');
  assert('"Ø.690 +.001/-.000" → specUnit1 "Ø"', asymDia.specUnit1 === 'Ø');
  assert('"Ø.690 +.001/-.000" → drawingSpec ".690"', asymDia.drawingSpec === '.690');
  assert('"Ø.690 +.001/-.000" → tolerance "+0.001-0"', asymDia.tolerance === '+0.001-0');
  assert('"Ø.690 +.001/-.000" → tolMode "asym"', asymDia.tolMode === 'asym');

  // ── Sanity: a plain dimension stays a dimension ──────────
  log('<h3>Plain dimension sanity</h3>');

  var plain = parseOcrText('1.250 ±.005');
  assert('"1.250 ±.005" → not a note', plain.isNote === false);
  assert('"1.250 ±.005" → drawingSpec "1.250"', plain.drawingSpec === '1.250');
  assert('"1.250 ±.005" → tolerance "0.005"', plain.tolerance === '0.005');

  return { passed: passed, failed: failed };
};
