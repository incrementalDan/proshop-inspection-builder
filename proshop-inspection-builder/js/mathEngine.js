/**
 * mathEngine.js — Deterministic Math Engine
 *
 * Execution order:
 * 1. Parse → 2. Extract values → 3. Nominal centering
 * 4. Plating → 5. Unit conversion → 6. Precision formatting
 *
 * CRITICAL: OP2000 bypasses ALL math. That logic lives in dataModel.js.
 * This module only provides pure math functions.
 */

window.PSB = window.PSB || {};

// ── Conversion constants ──────────────────────────────────
const MM_PER_INCH = 25.4;

/**
 * Center a nominal value when tolerance is asymmetric.
 *
 * Symmetric: Ø0.100 ±0.005 → nominal stays 0.100, tol = 0.005
 * Asymmetric: Ø0.100 +0.010 -0.002 → nominal = 0.104, tol = ±0.006
 *
 * Formula:
 *   newNominal = nominal + (tolPlus - tolMinus) / 2
 *   newTol = (tolPlus + tolMinus) / 2
 *
 * @param {number} nominal — original nominal value
 * @param {number} tolPlus — positive tolerance (always positive number)
 * @param {number} tolMinus — negative tolerance (always positive number, represents magnitude)
 * @returns {{ nominal: number, tolSymmetric: number }}
 */
function centerNominal(nominal, tolPlus, tolMinus) {
  if (tolPlus === tolMinus) {
    // Already symmetric
    return { nominal, tolSymmetric: tolPlus };
  }

  const shift = (tolPlus - tolMinus) / 2;
  const newNominal = nominal + shift;
  const newTol = (tolPlus + tolMinus) / 2;

  return {
    nominal: newNominal,
    tolSymmetric: newTol,
  };
}

/**
 * Apply plating offset to nominal.
 *
 * The drawing spec is the FINAL (post-plating) dimension.
 * We compute the PRE-plating machining target.
 *
 * Internal modes (hole shrinks after plating → machine LARGER):
 *   +1xI: add 1× plating to nominal (1 side, e.g. depth)
 *   +2xI: add 2× plating to nominal (2 sides, e.g. diameter)
 *
 * External modes (part grows after plating → machine SMALLER):
 *   -1xE: subtract 1× plating from nominal (1 side)
 *   -2xE: subtract 2× plating from nominal (2 sides, e.g. OD)
 *
 * @param {number} nominal — current nominal value (drawing spec)
 * @param {number} platingThickness — plating thickness per side (positive number)
 * @param {string} mode — '+1xI', '+2xI', '-1xE', '-2xE'
 * @returns {number} adjusted nominal (pre-plating machining target)
 */
function applyPlating(nominal, platingThickness, mode) {
  switch (mode) {
    case '+1xI':
      return nominal + (1 * platingThickness);
    case '+2xI':
      return nominal + (2 * platingThickness);
    case '-1xE':
      return nominal - (1 * platingThickness);
    case '-2xE':
      return nominal - (2 * platingThickness);
    default:
      return nominal;
  }
}

/**
 * Convert a value between mm and inch.
 *
 * @param {number} value
 * @param {'mm'|'inch'} fromUnit
 * @param {'mm'|'inch'} toUnit
 * @returns {number}
 */
function convertUnits(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;

  if (fromUnit === 'mm' && toUnit === 'inch') {
    return value / MM_PER_INCH;
  }

  if (fromUnit === 'inch' && toUnit === 'mm') {
    return value * MM_PER_INCH;
  }

  // Unknown units — return unchanged
  return value;
}

/**
 * Format a number to a specific number of decimal places.
 * Removes leading zero for values between -1 and 1 (ProShop convention).
 *
 * @param {number} value
 * @param {number} decimalPlaces
 * @returns {string}
 */
function formatPrecision(value, decimalPlaces) {
  if (typeof value !== 'number' || isNaN(value)) return '';
  const str = value.toFixed(decimalPlaces);
  // Remove leading zero for values between -1 and 1 (ProShop convention)
  if (str.startsWith('0.')) return str.slice(1);
  if (str.startsWith('-0.')) return '-' + str.slice(2);
  return str;
}

/**
 * Compute pin gage GO/NO-GO values.
 *
 * GO = nominal - tolerance (minimum material condition for hole)
 * NO GO = nominal + tolerance (maximum material condition for hole)
 *
 * Format: P(Ø{GO}+ | Ø{NOGO}-)
 *
 * @param {number} nominal
 * @param {number} tolerance — symmetric tolerance value
 * @param {number} [precision=4] — decimal places
 * @returns {{ go: number, noGo: number, formatted: string }}
 */
function computePinGage(nominal, tolerance, precision) {
  if (precision === undefined) precision = 4;
  const go = nominal - tolerance;
  const noGo = nominal + tolerance;

  const goStr = formatPrecision(go, precision);
  const noGoStr = formatPrecision(noGo, precision);

  return {
    go,
    noGo,
    formatted: `P(Ø${goStr}+ | Ø${noGoStr}-)`,
  };
}

/**
 * Compute gage block values.
 *
 * Low = nominal - tolerance
 * High = nominal + tolerance
 *
 * Format: G({low} | {high})
 *
 * @param {number} nominal
 * @param {number} tolPlus
 * @param {number} tolMinus
 * @param {number} [precision=4]
 * @returns {{ low: number, high: number, formatted: string }}
 */
function computeGageBlock(nominal, tolPlus, tolMinus, precision) {
  if (precision === undefined) precision = 4;
  const low = nominal - tolMinus;
  const high = nominal + tolPlus;

  const lowStr = formatPrecision(low, precision);
  const highStr = formatPrecision(high, precision);

  return {
    low,
    high,
    formatted: `G(${lowStr} | ${highStr})`,
  };
}

/**
 * Detect the number of decimal places in a numeric string.
 * Preserves the original precision from engineering prints.
 *
 * Examples:
 *   ".2500" → 4
 *   "3.50"  → 2
 *   "0.1"   → 1
 *   "5"     → 0
 *   "+0.010 -0.002" → null (not a simple number)
 *   "THRU"  → null
 *
 * @param {string} str — the raw value string
 * @returns {number|null} — decimal places count, or null if non-numeric
 */
function detectPrecision(str) {
  if (typeof str !== 'string') return null;
  var trimmed = str.trim();
  if (trimmed === '') return null;

  // Must be a simple numeric value (optional leading sign, digits, optional decimal)
  if (!/^[+-]?\d*\.?\d+$/.test(trimmed)) return null;

  var dotIndex = trimmed.indexOf('.');
  if (dotIndex === -1) return 0;
  return trimmed.length - dotIndex - 1;
}

// ── Export to namespace ───────────────────────────────────
PSB.centerNominal = centerNominal;
PSB.applyPlating = applyPlating;
PSB.convertUnits = convertUnits;
PSB.formatPrecision = formatPrecision;
PSB.computePinGage = computePinGage;
PSB.computeGageBlock = computeGageBlock;
PSB.detectPrecision = detectPrecision;
