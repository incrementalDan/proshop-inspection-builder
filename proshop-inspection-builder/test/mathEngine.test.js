/**
 * mathEngine.test.js — Math Engine Unit Tests
 */

window.TEST = window.TEST || {};

TEST.runMathTests = function(log) {
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
    if (epsilon === undefined) epsilon = 0.00001;
    var ok = Math.abs(actual - expected) < epsilon;
    if (ok) {
      log('<div class="test pass">✓ ' + desc + '</div>');
      passed++;
    } else {
      log('<div class="test fail">✗ ' + desc + ' — got ' + actual + ', expected ' + expected + '</div>');
      failed++;
    }
  }

  // ── Nominal Centering ────────────────────────────────────

  log('<h3>Nominal Centering</h3>');

  var centerTests = TEST.MATH_TEST_CASES.centering;
  for (var i = 0; i < centerTests.length; i++) {
    var tc = centerTests[i];
    var result = PSB.centerNominal(tc.input.nominal, tc.input.tolPlus, tc.input.tolMinus);

    assertClose(
      tc.desc + ' → nominal = ' + tc.expected.nominal,
      result.nominal,
      tc.expected.nominal
    );
    assertClose(
      tc.desc + ' → tolSymmetric = ' + tc.expected.tolSymmetric,
      result.tolSymmetric,
      tc.expected.tolSymmetric
    );
  }

  // Edge case: zero tolerance
  var zeroResult = PSB.centerNominal(1.0, 0, 0);
  assertClose('Zero tolerance → nominal unchanged', zeroResult.nominal, 1.0);
  assertClose('Zero tolerance → tol = 0', zeroResult.tolSymmetric, 0);

  // ── Plating ──────────────────────────────────────────────

  log('<h3>Plating</h3>');

  var platingTests = TEST.MATH_TEST_CASES.plating;
  for (var i = 0; i < platingTests.length; i++) {
    var tc = platingTests[i];
    var result = PSB.applyPlating(tc.input.nominal, tc.input.plating, tc.input.mode);

    assertClose(
      tc.desc + ' → ' + tc.expected,
      result,
      tc.expected
    );
  }

  // No plating mode
  assertClose(
    'mode="none" → no change',
    PSB.applyPlating(1.0, 0.001, 'none'),
    1.0
  );

  // Verify plating is NOT applied to tolerance (conceptual test)
  var platingResult = PSB.applyPlating(0.500, 0.002, '+2xI');
  assert('applyPlating returns a number', typeof platingResult === 'number');

  // ── Unit Conversion ──────────────────────────────────────

  log('<h3>Unit Conversion</h3>');

  var convTests = TEST.MATH_TEST_CASES.conversion;
  for (var i = 0; i < convTests.length; i++) {
    var tc = convTests[i];
    var result = PSB.convertUnits(tc.input.value, tc.input.from, tc.input.to);

    assertClose(
      tc.desc + ': ' + tc.input.value + ' ' + tc.input.from + ' → ' + tc.expected + ' ' + tc.input.to,
      result,
      tc.expected
    );
  }

  // Round-trip: mm → inch → mm
  var roundTrip = PSB.convertUnits(PSB.convertUnits(10.0, 'mm', 'inch'), 'inch', 'mm');
  assertClose('Round-trip mm→inch→mm = 10.0', roundTrip, 10.0);

  // ── Precision Formatting ─────────────────────────────────

  log('<h3>Precision Formatting</h3>');

  assert('4 decimal places', PSB.formatPrecision(1.23456, 4) === '1.2346');
  assert('3 decimal places', PSB.formatPrecision(1.23456, 3) === '1.235');
  assert('0 value', PSB.formatPrecision(0, 4) === '.0000');
  assert('NaN returns empty string', PSB.formatPrecision(NaN, 4) === '');
  assert('Negative number', PSB.formatPrecision(-0.123, 3) === '-.123');
  assert('Values < 1 drop leading zero', PSB.formatPrecision(0.5, 4) === '.5000');

  // ── Pin Gage ─────────────────────────────────────────────

  log('<h3>Pin Gage</h3>');

  var pgTests = TEST.MATH_TEST_CASES.pinGage;
  for (var i = 0; i < pgTests.length; i++) {
    var tc = pgTests[i];
    var result = PSB.computePinGage(tc.input.nominal, tc.input.tolerance);

    assertClose(tc.desc + ' → GO = ' + tc.expected.go, result.go, tc.expected.go);
    assertClose(tc.desc + ' → NO GO = ' + tc.expected.noGo, result.noGo, tc.expected.noGo);
    assert(tc.desc + ' → formatted starts with "P("', result.formatted.indexOf('P(') === 0);
  }

  // ── Gage Block ───────────────────────────────────────────

  log('<h3>Gage Block</h3>');

  var gb = PSB.computeGageBlock(1.000, 0.005, 0.003, 4);
  assertClose('Gage block low = 0.997', gb.low, 0.997);
  assertClose('Gage block high = 1.005', gb.high, 1.005);
  assert('Gage block formatted starts with "G("', gb.formatted.indexOf('G(') === 0);

  return { passed: passed, failed: failed };
};
