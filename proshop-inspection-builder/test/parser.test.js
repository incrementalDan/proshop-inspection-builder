/**
 * parser.test.js — Parser Unit Tests
 */

window.TEST = window.TEST || {};

TEST.runParserTests = function(log) {
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

  function assertClose(desc, actual, expected, epsilon) {
    if (epsilon === undefined) epsilon = 0.0001;
    var ok = Math.abs(actual - expected) < epsilon;
    if (ok) {
      log('<div class="test pass">✓ ' + desc + '</div>');
      passed++;
    } else {
      log('<div class="test fail">✗ ' + desc + ' — got ' + actual + ', expected ' + expected + '</div>');
      failed++;
    }
  }

  // ── CSV Parsing ──────────────────────────────────────────

  log('<h3>CSV Parsing</h3>');

  var rows = PSB.parseCSV(TEST.SAMPLE_INPUT_CSV);
  assert('Parses correct number of rows (16)', rows.length === 16);

  assert('Row 1: dimTag = "1"', rows[0].dimTag === '1');
  assert('Row 1: refLoc = "S1"', rows[0].refLoc === 'S1');
  assert('Row 1: drawingSpec = "33.0"', rows[0].drawingSpec === '33.0');
  assert('Row 1: nominal = "33.0"', rows[0].nominal === '33.0');
  assert('Row 1: tolerance = "0.5"', rows[0].tolerance === '0.5');

  assert('Row 4: drawingSpec = "8.00"', rows[3].drawingSpec === '8.00');
  assert('Row 4: tolerance = "0.05"', rows[3].tolerance === '0.05');

  assert('Row 7: specUnit1 = "Ø"', rows[6].specUnit1 === 'Ø');
  assert('Row 7: drawingSpec = "3.5"', rows[6].drawingSpec === '3.5');

  assert('Row 9: specUnit3 = "2x"', rows[8].specUnit3 === '2x');

  assert('Row 11: specUnit3 = "4x"', rows[10].specUnit3 === '4x');

  assert('Row 14: drawingSpec is note text', rows[13].drawingSpec === 'BREAK AND DEBURR ALL SHARP EDGES.');
  assert('Row 15: drawingSpec is note text', rows[14].drawingSpec === 'BAG AND TAG PART WITH PART NO. AND REV LABELLED.');
  assert('Row 16: drawingSpec = "INVAR 36"', rows[15].drawingSpec === 'INVAR 36');

  // ── Feature Detection ────────────────────────────────────

  log('<h3>Feature Detection</h3>');

  var featureTests = TEST.PARSER_TEST_CASES.featureDetection;
  for (var i = 0; i < featureTests.length; i++) {
    var tc = featureTests[i];
    var result = PSB.detectFeatureType(tc.input);
    assert(
      'detectFeatureType("' + tc.input.substring(0, 40) + '") = "' + tc.expected + '"',
      result === tc.expected
    );
  }

  assert('Empty string → "dimension"', PSB.detectFeatureType('') === 'dimension');
  assert('Simple number → "dimension"', PSB.detectFeatureType('3.5') === 'dimension');
  assert('Long text without keywords → "note"', PSB.detectFeatureType('THIS IS A VERY LONG STRING THAT IS NOT A NUMBER AT ALL') === 'note');

  // ── Tolerance Parsing ────────────────────────────────────

  log('<h3>Tolerance Parsing</h3>');

  var tolTests = TEST.PARSER_TEST_CASES.toleranceParsing;
  for (var i = 0; i < tolTests.length; i++) {
    var tc = tolTests[i];
    var result = PSB.parseTolerance(tc.input);
    assert(
      'parseTolerance("' + tc.input + '") → tolPlus=' + tc.expected.tolPlus,
      Math.abs(result.tolPlus - tc.expected.tolPlus) < 0.0001
    );
    assert(
      'parseTolerance("' + tc.input + '") → tolMinus=' + tc.expected.tolMinus,
      Math.abs(result.tolMinus - tc.expected.tolMinus) < 0.0001
    );
    assert(
      'parseTolerance("' + tc.input + '") → isSymmetric=' + tc.expected.isSymmetric,
      result.isSymmetric === tc.expected.isSymmetric
    );
  }

  // ── Spec Unit Parsing ────────────────────────────────────

  log('<h3>Spec Unit Parsing</h3>');

  var suTests = TEST.PARSER_TEST_CASES.specUnits;
  for (var i = 0; i < suTests.length; i++) {
    var tc = suTests[i];
    var result = PSB.parseSpecUnits(tc.input);
    assert(
      'parseSpecUnits("' + tc.input + '") → su1="' + tc.expected.su1 + '"',
      result.su1 === tc.expected.su1
    );
    assert(
      'parseSpecUnits("' + tc.input + '") → su2="' + tc.expected.su2 + '"',
      result.su2 === tc.expected.su2
    );
    assert(
      'parseSpecUnits("' + tc.input + '") → su3="' + tc.expected.su3 + '"',
      result.su3 === tc.expected.su3
    );
  }

  // ── Full Dimension Parsing ───────────────────────────────

  log('<h3>Full Dimension Parsing</h3>');

  var dim1 = PSB.parseDimension('33.0', '0.5', '33.0');
  assert('Dim 1: featureType = "dimension"', dim1.featureType === 'dimension');
  assertClose('Dim 1: nominal = 33.0', dim1.nominal, 33.0);
  assertClose('Dim 1: tolPlus = 0.5', dim1.tolerance.tolPlus, 0.5);

  var dim7 = PSB.parseDimension('3.5', '0.1', '3.5');
  assert('Dim 7: featureType = "dimension"', dim7.featureType === 'dimension');
  assertClose('Dim 7: nominal = 3.5', dim7.nominal, 3.5);

  var note14 = PSB.parseDimension('BREAK AND DEBURR ALL SHARP EDGES.', '', '');
  assert('Dim 14: featureType = "note"', note14.featureType === 'note');
  assert('Dim 14: isNote = true', note14.isNote === true);

  return { passed: passed, failed: failed };
};
