/**
 * parser.js — CSV Import & Dimension Parsing
 *
 * Responsibilities:
 * - Parse CSV string into array of raw row objects
 * - Parse dimension text into structured fields (spec units, nominal, tolerance)
 * - Detect feature types (dimension, note, GD&T, thread)
 * - Never corrupt data: if unsure, preserve original
 */

window.PSB = window.PSB || {};

// ── CSV Column Mapping ────────────────────────────────────
// ProShop CSV headers → internal field names
var COLUMN_MAP = {
  'Internal Part #': 'internalPartNum',
  'Op #': 'opNum',
  'Dim Tag #': 'dimTag',
  'Ref Loc': 'refLoc',
  'Char Dsg': 'charDsg',
  'Spec Unit 1': 'specUnit1',
  'Drawing Spec': 'drawingSpec',
  'Spec Unit 2': 'specUnit2',
  'Spec Unit 3': 'specUnit3',
  'Inspec Equip': 'inspectionEquipment',
  'Nom Dim': 'nominal',
  'Tol ±': 'tolerance',
  'IPC?': 'ipc',
  'Inspection Frequency': 'inspectionFrequency',
  'Show Dim When?': 'showDimWhen',
};

// ── GD&T and special symbols ──────────────────────────────
var GDT_SYMBOLS = [
  '⏤', '⏥', '○', '⌭', '⌒', '⌓', '⊚', '↗', '⌖',  // GD&T
  '⊕', '⊘', '◎',                                       // More GD&T
  'Ⓜ', 'Ⓕ', 'Ⓛ', 'Ⓟ', 'Ⓢ', 'Ⓣ', 'Ⓤ',             // Modifiers
];

// Thread patterns
var THREAD_PATTERNS = [
  /\d+[\-\/]\d+\s*UN[CEFJS]/i,   // 1/4-20 UNC, 1-8 UNF
  /M\d+(\.\d+)?\s*[xX×]\s*\d/i,  // M6x1.0, M10X1.5
  /\d+[\-]\d+\s*ACME/i,           // 1-5 ACME
  /NPT/i,                          // NPT threads
  /BSPP/i,                         // BSPP threads
];

// Note detection patterns
var NOTE_PATTERNS = [
  /BREAK\s+(AND\s+)?DEBURR/i,
  /BAG\s+AND\s+TAG/i,
  /MATERIAL/i,
  /FINISH/i,
  /SURFACE\s+TREATMENT/i,
  /PER\s+SPEC/i,
  /INVAR/i,
  /HEAT\s+TREAT/i,
  /ANODIZE/i,
  /PASSIVAT/i,
  /CERTIF/i,
  /STAMP/i,
  /MARK/i,
  /CLEAN/i,
  /INSPECT/i,
  /PACKAGE/i,
];

// Spec Unit 2 keywords
var SU2_KEYWORDS = [
  'THRU', 'DEEP', 'TYP', 'MIN', 'MAX',
  'Flatness', 'Perpendicular', 'Parallel',
  'Position', 'Position M', 'Concentricity', 'Concentricity M',
  'Surf Profile', 'Surf Profile M',
  'Angular', 'Total Runout', 'Runout',
  'Basic', 'Ref',
];

// Spec Unit 3 patterns (quantity)
var SU3_PATTERNS = [
  /(\d+)\s*[xX×]/,          // 2X, 4x, 2×
  /[xX×]\s*(\d+)/,          // X2, x4
  /(\d+)\s*PLACES?/i,       // 4 PLACES
  /(\d+)\s*HOLES?/i,        // 2 HOLES
];

/**
 * Parse a CSV string into array of raw row objects.
 *
 * @param {string} csvString — raw CSV text
 * @returns {Object[]} rows — array of { dimTag, refLoc, charDsg, specUnit1, drawingSpec, ... }
 */
function parseCSV(csvString) {
  // Normalize line endings and remove BOM
  var text = csvString.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var lines = text.split('\n').filter(function(line) { return line.trim() !== ''; });

  if (lines.length < 2) return [];

  // Parse header row
  var headers = parseCSVLine(lines[0]);
  var fieldMap = headers.map(function(h) { return COLUMN_MAP[h.trim()] || null; });

  // Parse data rows
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var values = parseCSVLine(lines[i]);
    var rowObj = {};

    for (var j = 0; j < fieldMap.length; j++) {
      if (fieldMap[j]) {
        rowObj[fieldMap[j]] = (values[j] || '').trim();
      }
    }

    // Skip completely empty rows
    var allEmpty = true;
    for (var key in rowObj) {
      if (rowObj[key] !== '') { allEmpty = false; break; }
    }
    if (allEmpty) continue;

    // Must have at least a dim tag or drawing spec
    if (!rowObj.dimTag && !rowObj.drawingSpec) continue;

    rows.push(rowObj);
  }

  return rows;
}

/**
 * Parse a single CSV line, respecting quoted fields.
 */
function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Detect the feature type from drawing spec text.
 *
 * @param {string} drawingSpec
 * @returns {'dimension'|'note'|'gdt'|'thread'}
 */
function detectFeatureType(drawingSpec) {
  if (!drawingSpec || drawingSpec.trim() === '') return 'dimension';

  var text = drawingSpec.trim();

  // Check for GD&T symbols
  for (var i = 0; i < GDT_SYMBOLS.length; i++) {
    if (text.includes(GDT_SYMBOLS[i])) return 'gdt';
  }

  // Check for thread patterns
  for (var i = 0; i < THREAD_PATTERNS.length; i++) {
    if (THREAD_PATTERNS[i].test(text)) return 'thread';
  }

  // Check for note patterns
  for (var i = 0; i < NOTE_PATTERNS.length; i++) {
    if (NOTE_PATTERNS[i].test(text)) return 'note';
  }

  // Long text strings that aren't numeric → likely notes
  if (text.length > 20 && isNaN(parseFloat(text))) return 'note';

  return 'dimension';
}

/**
 * Parse spec units from a text string.
 * Extracts SU1 (geometry), SU2 (modifiers), SU3 (quantity).
 * Returns cleaned text with extracted portions removed.
 *
 * @param {string} text
 * @returns {{ su1: string, su2: string, su3: string, cleaned: string }}
 */
function parseSpecUnits(text) {
  if (!text) return { su1: '', su2: '', su3: '', cleaned: '' };

  var remaining = text.trim();
  var su1 = '';
  var su2 = '';
  var su3 = '';

  // ── SU1: Diameter/Radius ────────────────────────────
  // Look for diameter symbol
  if (/[Ø⌀∅]/.test(remaining)) {
    su1 = 'Ø';
    remaining = remaining.replace(/[Ø⌀∅]\s*/g, '');
  }
  // Look for R (radius) — only if standalone at start
  else if (/^R\s/.test(remaining)) {
    su1 = 'R';
    remaining = remaining.replace(/^R\s*/, '');
  }

  // ── SU2: Modifiers ─────────────────────────────────
  for (var i = 0; i < SU2_KEYWORDS.length; i++) {
    var kw = SU2_KEYWORDS[i];
    var regex = new RegExp('\\b' + kw + '\\b', 'i');
    if (regex.test(remaining)) {
      su2 = kw;
      remaining = remaining.replace(regex, '').trim();
      break;
    }
  }

  // Degree symbol → SU2
  if (remaining.includes('°')) {
    su2 = su2 || '°';
    remaining = remaining.replace(/°/g, '');
  }

  // ── SU3: Quantity ──────────────────────────────────
  for (var i = 0; i < SU3_PATTERNS.length; i++) {
    var match = remaining.match(SU3_PATTERNS[i]);
    if (match) {
      su3 = match[1] + 'x';
      remaining = remaining.replace(SU3_PATTERNS[i], '').trim();
      break;
    }
  }

  return {
    su1: su1,
    su2: su2,
    su3: su3,
    cleaned: remaining.trim(),
  };
}

/**
 * Parse tolerance text into plus/minus values.
 *
 * Supported formats:
 * - ±0.005 or +/-0.005
 * - +0.005 -0.002
 * - +.005-.002
 * - 0.005 (plain number → symmetric)
 *
 * @param {string} text
 * @returns {{ tolPlus: number, tolMinus: number, isSymmetric: boolean }}
 */
function parseTolerance(text) {
  if (!text || text.trim() === '') {
    return { tolPlus: 0, tolMinus: 0, isSymmetric: true };
  }

  var t = text.trim();

  // ± format: ±0.005 or +/-0.005
  var symMatch = t.match(/[±]\s*([0-9]*\.?[0-9]+)/);
  if (symMatch) {
    var val = parseFloat(symMatch[1]);
    return { tolPlus: val, tolMinus: val, isSymmetric: true };
  }

  var pmMatch = t.match(/\+\s*\/\s*-\s*([0-9]*\.?[0-9]+)/);
  if (pmMatch) {
    var val = parseFloat(pmMatch[1]);
    return { tolPlus: val, tolMinus: val, isSymmetric: true };
  }

  // Asymmetric: +0.005 -0.002 or +.005-.002
  var asymMatch = t.match(/\+\s*([0-9]*\.?[0-9]+)\s*[-–]\s*([0-9]*\.?[0-9]+)/);
  if (asymMatch) {
    return {
      tolPlus: parseFloat(asymMatch[1]),
      tolMinus: parseFloat(asymMatch[2]),
      isSymmetric: false,
    };
  }

  // Separate +/- on same field
  var plusMatch = t.match(/\+\s*([0-9]*\.?[0-9]+)/);
  var minusMatch = t.match(/-\s*([0-9]*\.?[0-9]+)/);
  if (plusMatch && minusMatch) {
    return {
      tolPlus: parseFloat(plusMatch[1]),
      tolMinus: parseFloat(minusMatch[1]),
      isSymmetric: false,
    };
  }

  // Plain number → symmetric tolerance
  var numMatch = t.match(/^([0-9]*\.?[0-9]+)$/);
  if (numMatch) {
    var val = parseFloat(numMatch[1]);
    return { tolPlus: val, tolMinus: val, isSymmetric: true };
  }

  // Can't parse → preserve and return zero
  return { tolPlus: 0, tolMinus: 0, isSymmetric: true };
}

/**
 * Full dimension parsing pipeline.
 *
 * @param {string} drawingSpec — the drawing spec text
 * @param {string} toleranceText — the tolerance field text
 * @param {string} nominalText — the nominal field text
 * @returns {Object} parsed dimension data
 */
function parseDimension(drawingSpec, toleranceText, nominalText) {
  var featureType = detectFeatureType(drawingSpec);

  if (featureType !== 'dimension') {
    return {
      featureType: featureType,
      isNote: true,
      specUnits: { su1: '', su2: '', su3: '', cleaned: drawingSpec },
      tolerance: { tolPlus: 0, tolMinus: 0, isSymmetric: true },
      nominal: 0,
    };
  }

  var specUnits = parseSpecUnits(drawingSpec);
  var tolerance = parseTolerance(toleranceText);

  // Nominal: prefer explicit nominal field, fall back to cleaned drawing spec
  var nominal = parseFloat(nominalText);
  if (isNaN(nominal)) {
    nominal = parseFloat(specUnits.cleaned);
  }
  if (isNaN(nominal)) {
    nominal = 0;
  }

  return {
    featureType: featureType,
    isNote: false,
    specUnits: specUnits,
    tolerance: tolerance,
    nominal: nominal,
  };
}

// ── Export to namespace ───────────────────────────────────
PSB.parseCSV = parseCSV;
PSB.detectFeatureType = detectFeatureType;
PSB.parseSpecUnits = parseSpecUnits;
PSB.parseTolerance = parseTolerance;
PSB.parseDimension = parseDimension;
