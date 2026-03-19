/**
 * parser.js — CSV Import & Dimension Parsing
 *
 * Responsibilities:
 * - Parse CSV string into array of raw row objects
 * - Parse dimension text into structured fields (spec units, nominal, tolerance)
 * - Detect feature types (dimension, note, GD&T, thread)
 * - Never corrupt data: if unsure, preserve original
 */

// ── CSV Column Mapping ────────────────────────────────────
// ProShop CSV headers → internal field names
const COLUMN_MAP = {
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
const GDT_SYMBOLS = [
  '⏤', '⏥', '○', '⌭', '⌒', '⌓', '⊚', '↗', '⌖',  // GD&T
  '⊕', '⊘', '◎',                                       // More GD&T
  'Ⓜ', 'Ⓕ', 'Ⓛ', 'Ⓟ', 'Ⓢ', 'Ⓣ', 'Ⓤ',             // Modifiers
];

// Thread patterns
const THREAD_PATTERNS = [
  /\d+[\-\/]\d+\s*UN[CEFJS]/i,   // 1/4-20 UNC, 1-8 UNF
  /M\d+(\.\d+)?\s*[xX×]\s*\d/i,  // M6x1.0, M10X1.5
  /\d+[\-]\d+\s*ACME/i,           // 1-5 ACME
  /NPT/i,                          // NPT threads
  /BSPP/i,                         // BSPP threads
];

// Note detection patterns
const NOTE_PATTERNS = [
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
const SU2_KEYWORDS = [
  'THRU', 'DEEP', 'TYP', 'MIN', 'MAX',
  'Flatness', 'Perpendicular', 'Parallel',
  'Position', 'Position M', 'Concentricity', 'Concentricity M',
  'Surf Profile', 'Surf Profile M',
  'Angular', 'Total Runout', 'Runout',
  'Basic', 'Ref',
];

// Spec Unit 3 patterns (quantity)
const SU3_PATTERNS = [
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
export function parseCSV(csvString) {
  // Normalize line endings and remove BOM
  const text = csvString.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').filter(line => line.trim() !== '');

  if (lines.length < 2) return [];

  // Parse header row
  const headers = parseCSVLine(lines[0]);
  const fieldMap = headers.map(h => COLUMN_MAP[h.trim()] || null);

  // Parse data rows
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const rowObj = {};

    for (let j = 0; j < fieldMap.length; j++) {
      if (fieldMap[j]) {
        rowObj[fieldMap[j]] = (values[j] || '').trim();
      }
    }

    // Skip completely empty rows
    if (Object.values(rowObj).every(v => v === '')) continue;

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
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
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
export function detectFeatureType(drawingSpec) {
  if (!drawingSpec || drawingSpec.trim() === '') return 'dimension';

  const text = drawingSpec.trim();

  // Check for GD&T symbols
  for (const sym of GDT_SYMBOLS) {
    if (text.includes(sym)) return 'gdt';
  }

  // Check for thread patterns
  for (const pattern of THREAD_PATTERNS) {
    if (pattern.test(text)) return 'thread';
  }

  // Check for note patterns
  for (const pattern of NOTE_PATTERNS) {
    if (pattern.test(text)) return 'note';
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
export function parseSpecUnits(text) {
  if (!text) return { su1: '', su2: '', su3: '', cleaned: '' };

  let remaining = text.trim();
  let su1 = '';
  let su2 = '';
  let su3 = '';

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
  for (const kw of SU2_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
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
  for (const pattern of SU3_PATTERNS) {
    const match = remaining.match(pattern);
    if (match) {
      su3 = `${match[1]}x`;
      remaining = remaining.replace(pattern, '').trim();
      break;
    }
  }

  return {
    su1,
    su2,
    su3,
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
export function parseTolerance(text) {
  if (!text || text.trim() === '') {
    return { tolPlus: 0, tolMinus: 0, isSymmetric: true };
  }

  const t = text.trim();

  // ± format: ±0.005 or +/-0.005
  const symMatch = t.match(/[±]\s*([0-9]*\.?[0-9]+)/);
  if (symMatch) {
    const val = parseFloat(symMatch[1]);
    return { tolPlus: val, tolMinus: val, isSymmetric: true };
  }

  const pmMatch = t.match(/\+\s*\/\s*-\s*([0-9]*\.?[0-9]+)/);
  if (pmMatch) {
    const val = parseFloat(pmMatch[1]);
    return { tolPlus: val, tolMinus: val, isSymmetric: true };
  }

  // Asymmetric: +0.005 -0.002 or +.005-.002
  const asymMatch = t.match(/\+\s*([0-9]*\.?[0-9]+)\s*[-–]\s*([0-9]*\.?[0-9]+)/);
  if (asymMatch) {
    return {
      tolPlus: parseFloat(asymMatch[1]),
      tolMinus: parseFloat(asymMatch[2]),
      isSymmetric: false,
    };
  }

  // Separate +/- on same field
  const plusMatch = t.match(/\+\s*([0-9]*\.?[0-9]+)/);
  const minusMatch = t.match(/-\s*([0-9]*\.?[0-9]+)/);
  if (plusMatch && minusMatch) {
    return {
      tolPlus: parseFloat(plusMatch[1]),
      tolMinus: parseFloat(minusMatch[1]),
      isSymmetric: false,
    };
  }

  // Plain number → symmetric tolerance
  const numMatch = t.match(/^([0-9]*\.?[0-9]+)$/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
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
export function parseDimension(drawingSpec, toleranceText, nominalText) {
  const featureType = detectFeatureType(drawingSpec);

  if (featureType !== 'dimension') {
    return {
      featureType,
      isNote: true,
      specUnits: { su1: '', su2: '', su3: '', cleaned: drawingSpec },
      tolerance: { tolPlus: 0, tolMinus: 0, isSymmetric: true },
      nominal: 0,
    };
  }

  const specUnits = parseSpecUnits(drawingSpec);
  const tolerance = parseTolerance(toleranceText);

  // Nominal: prefer explicit nominal field, fall back to cleaned drawing spec
  let nominal = parseFloat(nominalText);
  if (isNaN(nominal)) {
    nominal = parseFloat(specUnits.cleaned);
  }
  if (isNaN(nominal)) {
    nominal = 0;
  }

  return {
    featureType,
    isNote: false,
    specUnits,
    tolerance,
    nominal,
  };
}
