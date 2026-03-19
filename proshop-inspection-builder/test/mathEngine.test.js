/**
 * mathEngine.test.js — Math Engine Unit Tests
 */

import { centerNominal, applyPlating, convertUnits, formatPrecision, computePinGage, computeGageBlock } from '../js/mathEngine.js';
import { MATH_TEST_CASES } from './testData.js';

export function runMathTests(log) {
  let passed = 0;
  let failed = 0;

  function assert(desc, condition) {
    if (condition) {
      log(`<div class="test pass">✓ ${desc}</div>`);
      passed++;
    } else {
      log(`<div class="test fail">✗ ${desc}</div>`);
      failed++;
    }
  }

  function assertClose(desc, actual, expected, epsilon = 0.00001) {
    const ok = Math.abs(actual - expected) < epsilon;
    if (ok) {
      log(`<div class="test pass">✓ ${desc}</div>`);
      passed++;
    } else {
      log(`<div class="test fail">✗ ${desc} — got ${actual}, expected ${expected}</div>`);
      failed++;
    }
  }

  // ── Nominal Centering ────────────────────────────────────

  log('<h3>Nominal Centering</h3>');

  for (const tc of MATH_TEST_CASES.centering) {
    const { nominal, tolPlus, tolMinus } = tc.input;
    const result = centerNominal(nominal, tolPlus, tolMinus);

    assertClose(
      `${tc.desc} → nominal = ${tc.expected.nominal}`,
      result.nominal,
      tc.expected.nominal
    );
    assertClose(
      `${tc.desc} → tolSymmetric = ${tc.expected.tolSymmetric}`,
      result.tolSymmetric,
      tc.expected.tolSymmetric
    );
  }

  // Edge case: zero tolerance
  const zeroResult = centerNominal(1.0, 0, 0);
  assertClose('Zero tolerance → nominal unchanged', zeroResult.nominal, 1.0);
  assertClose('Zero tolerance → tol = 0', zeroResult.tolSymmetric, 0);

  // ── Plating ──────────────────────────────────────────────

  log('<h3>Plating</h3>');

  for (const tc of MATH_TEST_CASES.plating) {
    const { nominal, plating, mode } = tc.input;
    const result = applyPlating(nominal, plating, mode);

    assertClose(
      `${tc.desc} → ${tc.expected}`,
      result,
      tc.expected
    );
  }

  // No plating mode
  assertClose(
    'mode="none" → no change',
    applyPlating(1.0, 0.001, 'none'),
    1.0
  );

  // Verify plating is NOT applied to tolerance (conceptual test)
  // The dataModel enforces this, but we verify the function only returns a single number
  const platingResult = applyPlating(0.500, 0.002, '+2xI');
  assert('applyPlating returns a number', typeof platingResult === 'number');

  // ── Unit Conversion ──────────────────────────────────────

  log('<h3>Unit Conversion</h3>');

  for (const tc of MATH_TEST_CASES.conversion) {
    const { value, from, to } = tc.input;
    const result = convertUnits(value, from, to);

    assertClose(
      `${tc.desc}: ${value} ${from} → ${tc.expected} ${to}`,
      result,
      tc.expected
    );
  }

  // Round-trip: mm → inch → mm
  const roundTrip = convertUnits(convertUnits(10.0, 'mm', 'inch'), 'inch', 'mm');
  assertClose('Round-trip mm→inch→mm = 10.0', roundTrip, 10.0);

  // ── Precision Formatting ─────────────────────────────────

  log('<h3>Precision Formatting</h3>');

  assert('4 decimal places', formatPrecision(1.23456, 4) === '1.2346');
  assert('3 decimal places', formatPrecision(1.23456, 3) === '1.235');
  assert('0 value', formatPrecision(0, 4) === '0.0000');
  assert('NaN returns empty string', formatPrecision(NaN, 4) === '');
  assert('Negative number', formatPrecision(-0.123, 3) === '-0.123');

  // ── Pin Gage ─────────────────────────────────────────────

  log('<h3>Pin Gage</h3>');

  for (const tc of MATH_TEST_CASES.pinGage) {
    const { nominal, tolerance } = tc.input;
    const result = computePinGage(nominal, tolerance);

    assertClose(`${tc.desc} → GO = ${tc.expected.go}`, result.go, tc.expected.go);
    assertClose(`${tc.desc} → NO GO = ${tc.expected.noGo}`, result.noGo, tc.expected.noGo);
    assert(`${tc.desc} → formatted starts with "P("`, result.formatted.startsWith('P('));
  }

  // ── Gage Block ───────────────────────────────────────────

  log('<h3>Gage Block</h3>');

  const gb = computeGageBlock(1.000, 0.005, 0.003, 4);
  assertClose('Gage block low = 0.997', gb.low, 0.997);
  assertClose('Gage block high = 1.005', gb.high, 1.005);
  assert('Gage block formatted starts with "G("', gb.formatted.startsWith('G('));

  return { passed, failed };
}
