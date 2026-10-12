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
 * Keeps the leading zero ("0.390") — screen and export match (RULES.md §5).
 *
 * @param {number} value
 * @param {number} decimalPlaces
 * @returns {string}
 */
function formatPrecision(value, decimalPlaces) {
  if (typeof value !== 'number' || isNaN(value)) return '';
  return value.toFixed(decimalPlaces);
}

/**
 * Round angle text to at most maxDec decimals (RULES.md §5).
 * Only numbers with MORE decimals are touched — never pads:
 *   "12.0833333333333925" (3) → "12.083",  "41" → "41",  "±0.5" → "±0.5"
 */
function capAngleDecimals(str, maxDec) {
  if (str === null || str === undefined || maxDec === null || maxDec === undefined || isNaN(maxDec)) return str;
  return String(str).replace(/\d*\.\d+/g, function(num) {
    var dec = num.length - num.indexOf('.') - 1;
    if (dec <= maxDec) return num;
    var out = parseFloat(num).toFixed(maxDec);
    // Keep the print's bare-decimal style (".25" not "0.25")
    return num.charAt(0) === '.' ? out.replace(/^0\./, '.') : out;
  });
}

/**
 * Add a leading zero to bare decimals: ".390" → "0.390", "+.005 -.002" → "+0.005 -0.002".
 * Only the zero is added — decimals are untouched.
 */
function addLeadingZero(str) {
  if (!str) return str;
  return String(str).replace(/(^|[^0-9])\.(\d)/g, '$10.$2');
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

/**
 * Largest number of decimal places among the numbers in a string.
 * Unlike detectPrecision, works on tolerance text too.
 *
 *   "0.005"          → 3
 *   "+.005 -.0020"   → 4
 *   "90"             → 0
 *   "THRU"           → null
 *
 * @param {string|number} str
 * @returns {number|null}
 */
function countDecimals(str) {
  if (str === null || str === undefined) return null;
  var nums = String(str).match(/\d*\.?\d+/g);
  if (!nums) return null;
  var max = 0;
  for (var i = 0; i < nums.length; i++) {
    var dot = nums[i].indexOf('.');
    if (dot >= 0) max = Math.max(max, nums[i].length - dot - 1);
  }
  return max;
}

/**
 * Compute FAI pass/warn/fail status for a single measurement.
 *
 * @param {number} measured
 * @param {number} nominal
 * @param {number} plusTol   — upper limit = nominal + plusTol (may be negative)
 * @param {number} minusTol  — lower limit = nominal - minusTol (negative = lower limit above nominal)
 * @param {number} warnThreshold — fraction of tolerance band used before warn (default 0.8)
 * @returns {'pass'|'warn'|'fail'}
 */
function computeFaiStatus(measured, nominal, plusTol, minusTol, warnThreshold) {
  warnThreshold = warnThreshold || 0.8;
  var upperLimit = nominal + plusTol;
  var lowerLimit = nominal - minusTol;
  if (measured > upperLimit || measured < lowerLimit) return 'fail';

  // Avoid division by zero — zero tolerance means exact match only
  if (plusTol === 0 && minusTol === 0) {
    return measured === nominal ? 'pass' : 'fail';
  }

  var deviation = measured - nominal;
  var bandUsed;
  if (deviation >= 0) {
    bandUsed = plusTol > 0 ? deviation / plusTol : 1;
  } else {
    bandUsed = minusTol > 0 ? Math.abs(deviation) / minusTol : 1;
  }
  if (bandUsed >= warnThreshold) return 'warn';
  return 'pass';
}

/**
 * Compute aggregate FAI status across multiple measurements.
 * Priority: fail > warn > pass > null (no measurements).
 *
 * @param {Array} measurements — array of measurement objects with .status
 * @returns {'pass'|'warn'|'fail'|null}
 */
function computeAggregateStatus(measurements) {
  if (!measurements || measurements.length === 0) return null;
  var worst = 'pass';
  for (var i = 0; i < measurements.length; i++) {
    var s = measurements[i].status;
    if (s === 'fail') return 'fail';
    if (s === 'warn') worst = 'warn';
  }
  return worst;
}

/**
 * Pick the nominal + tolerance a CMM measurement is graded against.
 * Plan values win. If the plan has no tolerance (both 0 / missing) or no
 * numeric nominal, fall back to the CMM's own nominal + tolerance — otherwise
 * a tol-less dim (e.g. a countersink "⌄ .248") is graded as zero-tolerance
 * and every measurement FAILs.
 *
 * @param {Object} c — row.computed
 * @param {Object} m — measurement { nominal, plusTol, minusTol }
 * @param {string} compareMode — 'op2000' | 'compensated'
 * @returns {{ nominal: number, plusTol: number, minusTol: number, source: 'plan'|'cmm' }}
 */
function getFaiLimits(c, m, compareMode) {
  c = c || {};
  var op2kPlus  = Number(c.op2kTolPlus)  || 0;
  var op2kMinus = Number(c.op2kTolMinus) || 0;
  var out = c.output || {};
  var nominal, plus, minus;
  if (compareMode === 'compensated') {
    nominal = out.nominal != null ? out.nominal : c.op2000Nominal;
    plus    = out.tolPlus  != null ? Number(out.tolPlus)  : op2kPlus;
    minus   = out.tolMinus != null ? Number(out.tolMinus) : op2kMinus;
  } else {
    nominal = c.op2000Nominal;
    plus    = op2kPlus;
    minus   = op2kMinus;
  }
  nominal = parseFloat(nominal);
  var hasTol = (plus || 0) !== 0 || (minus || 0) !== 0;
  if (!hasTol || !isFinite(nominal)) {
    return { nominal: m.nominal, plusTol: m.plusTol, minusTol: m.minusTol, source: 'cmm' };
  }
  return { nominal: nominal, plusTol: plus || 0, minusTol: minus || 0, source: 'plan' };
}

/**
 * Grade one CMM measurement for a plan row (see getFaiLimits).
 */
function computeFaiMeasurementStatus(c, m, compareMode, warnThreshold) {
  var lim = getFaiLimits(c, m, compareMode);
  return computeFaiStatus(m.measured, lim.nominal, lim.plusTol, lim.minusTol, warnThreshold);
}

/**
 * Re-grade every measurement on a row (OP2000 compare) and its aggregate.
 * Call after import, re-tag, or delete so stored statuses match the table.
 */
function refreshFaiStatus(row, warnThreshold) {
  if (!row || !row.fai || !row.fai.measurements) return;
  var ms = row.fai.measurements;
  for (var i = 0; i < ms.length; i++) {
    ms[i].status = computeFaiMeasurementStatus(row.computed, ms[i], 'op2000', warnThreshold);
  }
  row.fai.aggregateStatus = computeAggregateStatus(ms);
}

/**
 * Keep a row's CMM measurements in print units.
 * Measurements are real sizes, not print text — when print units change they
 * must be converted (unlike print values, which are relabeled). Each
 * measurement remembers its units in m.units; old ones without it are
 * assumed to already be in print units. Angles are never converted.
 *
 * @returns {boolean} true if anything was converted
 */
function syncFaiUnits(row, printUnits) {
  if (!row || !row.fai || !row.fai.measurements) return false;
  var changed = false;
  var rowIsAngle = !!(row.computed && row.computed.isAngle);
  row.fai.measurements.forEach(function(m) {
    var from = m.units || printUnits;
    if (from !== printUnits && !rowIsAngle && !/angle|°/i.test(m.cmmName || '')) {
      ['measured', 'nominal', 'deviation', 'plusTol', 'minusTol'].forEach(function(k) {
        if (typeof m[k] === 'number') m[k] = convertUnits(m[k], from, printUnits);
      });
      changed = true;
    }
    m.units = printUnits;
  });
  return changed;
}

// ── Export to namespace ───────────────────────────────────
PSB.centerNominal = centerNominal;
PSB.applyPlating = applyPlating;
PSB.convertUnits = convertUnits;
PSB.formatPrecision = formatPrecision;
PSB.addLeadingZero = addLeadingZero;
PSB.computePinGage = computePinGage;
PSB.computeGageBlock = computeGageBlock;
PSB.detectPrecision = detectPrecision;
PSB.countDecimals = countDecimals;
PSB.capAngleDecimals = capAngleDecimals;
PSB.computeFaiStatus = computeFaiStatus;
PSB.computeAggregateStatus = computeAggregateStatus;
PSB.getFaiLimits = getFaiLimits;
PSB.computeFaiMeasurementStatus = computeFaiMeasurementStatus;
PSB.refreshFaiStatus = refreshFaiStatus;
PSB.syncFaiUnits = syncFaiUnits;
