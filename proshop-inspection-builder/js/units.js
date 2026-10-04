/**
 * units.js — Print units: detection, title-block tolerance, unit changes
 *
 * Model (RULES.md §10): every value stays in the units it was written in.
 * `globals.importUnits` is the print's unit label. Changing it RELABELS —
 * nothing is converted unless the user asks to convert values they typed.
 *
 * Pure functions only — no DOM. UI lives in app.js.
 */

window.PSB = window.PSB || {};

/** The print's units. One fallback for the whole app. */
function getPrintUnits(globals) {
  return (globals && globals.importUnits) || 'mm';
}

// ── Detection ─────────────────────────────────────────────

var TITLE_INCH_RE = /(DIMENSIONS?|DIMS?)\s+(ARE\s+)?(IN|SHOWN\s+IN)\s+INCH(ES)?/i;
var TITLE_MM_RE = /(DIMENSIONS?|DIMS?)\s+(ARE\s+)?(IN|SHOWN\s+IN)\s+(MM|MILLIMET(ER|RE)S?)/i;

/**
 * Guess the print's units from its values (and title block text if we have it).
 *
 * Clues (points):
 *   Title block "DIMENSIONS ARE IN INCHES / MM"  → +20 (decisive)
 *   Leading dot ".390"                            → inch +2
 *   3–4 decimals                                  → inch +1
 *   1–2 decimals                                  → mm +1
 *   Value > 50                                    → mm +1
 *   Tolerance < .02                               → inch +1
 *   Tolerance ≥ .05                               → mm +1
 * Metric thread callouts are ignored — inch prints use them too.
 *
 * @param {Array<{spec:string, tol:string}>} values — non-note rows
 * @param {string} [titleText] — PDF text (optional)
 * @returns {{ units: 'inch'|'mm'|null, confidence: 'high'|'low'|'none',
 *             inch: number, mm: number, reasons: string[] }}
 */
function detectPrintUnits(values, titleText) {
  var inch = 0, mm = 0;
  var reasons = [];
  var counts = { dot: 0, dec34: 0, dec12: 0, big: 0, tolSmall: 0, tolBig: 0 };

  if (titleText) {
    if (TITLE_INCH_RE.test(titleText)) { inch += 20; reasons.push('Title block says inches'); }
    if (TITLE_MM_RE.test(titleText)) { mm += 20; reasons.push('Title block says millimeters'); }
  }

  (values || []).forEach(function(v) {
    var spec = String(v.spec || '').trim();
    if (/^\.\d/.test(spec)) { inch += 2; counts.dot++; }
    if (/^\d*\.?\d+$/.test(spec)) {
      var dec = PSB.countDecimals(spec);
      if (dec >= 3 && dec <= 4) { inch += 1; counts.dec34++; }
      else if (dec >= 1 && dec <= 2) { mm += 1; counts.dec12++; }
      if (parseFloat(spec) > 50) { mm += 1; counts.big++; }
    }
    var tol = PSB.parseTolerance(String(v.tol || ''));
    var t = Math.max(tol.tolPlus, tol.tolMinus);
    if (t > 0 && t < 0.02) { inch += 1; counts.tolSmall++; }
    else if (t >= 0.05) { mm += 1; counts.tolBig++; }
  });

  function n(count, one, many) { return count + ' ' + (count === 1 ? one : many); }
  if (counts.dot) reasons.push(n(counts.dot, 'value', 'values') + ' with a leading dot (.390)');
  if (counts.dec34) reasons.push(n(counts.dec34, 'value', 'values') + ' with 3–4 decimals');
  if (counts.dec12) reasons.push(n(counts.dec12, 'value', 'values') + ' with 1–2 decimals');
  if (counts.big) reasons.push(n(counts.big, 'value', 'values') + ' over 50');
  if (counts.tolSmall) reasons.push(n(counts.tolSmall, 'tolerance', 'tolerances') + ' under .02');
  if (counts.tolBig) reasons.push(n(counts.tolBig, 'tolerance', 'tolerances') + ' .05 or more');

  var total = inch + mm;
  if (total === 0 || inch === mm) {
    return { units: null, confidence: 'none', inch: inch, mm: mm, reasons: reasons };
  }
  var units = inch > mm ? 'inch' : 'mm';
  var share = Math.max(inch, mm) / total;
  var confidence = (total >= 5 && share >= 0.8) ? 'high' : 'low';
  return { units: units, confidence: confidence, inch: inch, mm: mm, reasons: reasons };
}

/** Collect detector input from rows (notes skipped). */
function unitSamplesFromRows(rows) {
  var out = [];
  (rows || []).forEach(function(r) {
    if (r.user && r.user.isNote) return;
    // Angles carry no unit clue (90° is not "over 50 mm")
    var su = [r.raw.specUnit1, r.raw.specUnit2, r.raw.specUnit3, r.raw.drawingSpec].join(' ');
    if (/°|angle/i.test(su)) return;
    out.push({ spec: r.raw.drawingSpec || '', tol: r.raw.toleranceText || r.raw.tolerance || '' });
  });
  return out;
}

// ── Title-block default tolerance ─────────────────────────

/**
 * Title-block default tolerance for a drawing spec, in PRINT units.
 * Looked up live (never stored), so changing print units or the title
 * block later never leaves a stale value behind.
 *
 * Bucket by spec decimals (.X / .XX / .XXX / .XXXX). A GD&T profile
 * tolerance, if set, overrides the buckets.
 *
 * @returns {{ tol: string, source: true|'gdt-profile' } | null}
 */
function lookupTitleBlockTol(spec, globals) {
  if (!globals) return null;
  spec = String(spec || '').trim();
  if (!spec || !/\d/.test(spec)) return null;

  var defaultTol = '';
  var source = false;

  if (globals.titleBlockTolGdt) {
    defaultTol = globals.titleBlockTolGdt;
    source = 'gdt-profile';
  } else {
    var decimals = PSB.detectPrecision(spec);
    if (decimals === null || decimals === 0) return null;
    if      (decimals === 1 && globals.titleBlockTol1d) { defaultTol = globals.titleBlockTol1d; source = true; }
    else if (decimals === 2 && globals.titleBlockTol2d) { defaultTol = globals.titleBlockTol2d; source = true; }
    else if (decimals === 3 && globals.titleBlockTol3d) { defaultTol = globals.titleBlockTol3d; source = true; }
    else if (decimals >= 4 && globals.titleBlockTol4d)  { defaultTol = globals.titleBlockTol4d; source = true; }
  }

  if (!defaultTol || !source) return null;
  var tolStr = titleBlockToPrintUnits(defaultTol, globals);
  return tolStr === null ? null : { tol: tolStr, source: source };
}

/** Convert a title-block value from its own units into print units. */
function titleBlockToPrintUnits(value, globals) {
  var tolUnits = globals.titleBlockTolUnits || 'inch';
  var printUnits = getPrintUnits(globals);
  // Same units — use the entered string exactly (no float noise)
  if (tolUnits === printUnits) return String(value);
  var n = parseFloat(value);
  if (isNaN(n)) return null;
  n = PSB.convertUnits(n, tolUnits, printUnits);
  var prec = printUnits === 'mm' ? 3 : 4;
  return n.toFixed(prec).replace(/0+$/, '').replace(/\.$/, '') || String(n);
}

/**
 * Tolerance text for a row as the math should see it.
 * Balloon rows set to "Default" / "Profile" follow the title block live;
 * everything else uses the stored tolerance.
 */
function effectiveRawTolerance(row, globals) {
  var raw = row.raw;
  var tolType = row.user && row.user.balloon && row.user.balloon.tolType;
  if (tolType === 'default') {
    var hit = lookupTitleBlockTol(raw.drawingSpec, globals);
    return hit ? hit.tol : '';
  }
  if (tolType === 'profile') {
    return globals.titleBlockTolGdt ? (titleBlockToPrintUnits(globals.titleBlockTolGdt, globals) || '') : '';
  }
  return raw.toleranceText || raw.tolerance || '';
}

// ── Changing print units ──────────────────────────────────

// Override keys that hold numbers the user typed in print units.
var TYPED_NUMERIC_KEYS = ['outDrawingSpec', 'outTolPlus', 'outTolMinus', 'outputSpec', 'outputTolPlus', 'outputTolMinus'];

/**
 * Values the user typed (numeric overrides) — shown for review when
 * print units change. Notes and angle rows are skipped (never converted).
 *
 * @returns {Array<{ rowId, dimTag, key, value }>}
 */
function listTypedValues(rows) {
  var out = [];
  (rows || []).forEach(function(r) {
    if (r.user.isNote || (r.computed && r.computed.isAngle)) return;
    var ov = r.user.overrides || {};
    TYPED_NUMERIC_KEYS.forEach(function(k) {
      if (ov[k] !== null && ov[k] !== undefined && ov[k] !== '' && !isNaN(parseFloat(ov[k]))) {
        out.push({ rowId: r.id, dimTag: PSB.effectiveDimTag(r), key: k, value: String(ov[k]) });
      }
    });
  });
  return out;
}

/**
 * Convert every typed numeric value from one unit to the other.
 * Mutates rows. Uses the target unit's default decimals.
 * @returns {number} how many values changed
 */
function convertTypedValues(rows, fromUnits, toUnits, globals) {
  if (fromUnits === toUnits) return 0;
  var prec = toUnits === 'inch' ? globals.inchPrecision : globals.mmPrecision;
  var n = 0;
  listTypedValues(rows).forEach(function(t) {
    var row = rows.find(function(r) { return r.id === t.rowId; });
    var v = PSB.convertUnits(parseFloat(t.value), fromUnits, toUnits);
    row.user.overrides[t.key] = PSB.formatPrecision(v, prec);
    n++;
  });
  return n;
}

// ── Export to namespace ───────────────────────────────────
PSB.getPrintUnits = getPrintUnits;
PSB.detectPrintUnits = detectPrintUnits;
PSB.unitSamplesFromRows = unitSamplesFromRows;
PSB.lookupTitleBlockTol = lookupTitleBlockTol;
PSB.effectiveRawTolerance = effectiveRawTolerance;
PSB.listTypedValues = listTypedValues;
PSB.convertTypedValues = convertTypedValues;
