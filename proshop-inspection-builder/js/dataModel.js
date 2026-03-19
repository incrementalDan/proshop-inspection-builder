/**
 * dataModel.js — Single Source of Truth
 *
 * Every row: { id, raw, user, computed }
 * - raw: immutable parsed import data
 * - user: user overrides and settings
 * - computed: derived output (what UI/export reads)
 *
 * Rule: table, sidebar, and export ALL read from `computed`.
 * Call recompute() whenever raw, user, or globals change.
 */

import { parseDimension, detectFeatureType, parseSpecUnits, parseTolerance } from './parser.js';
import { centerNominal, applyPlating, convertUnits, formatPrecision, computePinGage, computeGageBlock } from './mathEngine.js';

// ── Row ID counter ────────────────────────────────────────
let _nextId = 1;

/**
 * Default global settings
 */
export function defaultGlobals() {
  return {
    importUnits: 'mm',        // 'mm' or 'inch'
    displayUnits: 'inch',     // 'mm', 'inch', or 'both'
    exportUnits: 'inch',
    platingThickness: 0,
    platingUnits: 'inch',
    inchPrecision: 4,
    mmPrecision: 3,
    ops: [],                  // e.g., [2000, 50, 60]
    opPrefixes: {},           // e.g., { 2000: '', 50: 'HREF-' }
    equipmentList: [
      'Calipers',
      'Micrometer',
      'Optical C.',
      'CMM',
      'Height Gage',
      'Gage Block',
      'GO / NO-GO',
      'PASS/FAIL',
      'Drop Indicator',
      'N/A',
    ],
  };
}

/**
 * Default user overrides for a single row
 */
export function defaultUserState() {
  return {
    includeOps: {},          // { [opNumber]: true/false }
    ipc: false,
    isNote: false,
    autoNominal: true,
    platingMode: 'none',     // 'none', '+1xI', '+2xI', '-1xE', '-2xE'
    inspectionFrequency: '',
    inspectionEquipment: '',
    pinGageEnabled: false,
    status: 'none',          // 'none', 'edited', 'complete'
    overrides: {
      outDrawingSpec: null,  // null = use computed, string = manual override
      outTolerance: null,
      pinGageValue: null,
    },
  };
}

/**
 * Create a new row from raw CSV data
 * @param {Object} rawData — parsed CSV fields
 * @returns {Object} row — { id, raw, user, computed }
 */
export function createRow(rawData) {
  const row = {
    id: _nextId++,
    raw: Object.freeze({ ...rawData }),
    user: defaultUserState(),
    computed: {},
  };

  // Auto-detect notes
  const featureType = detectFeatureType(rawData.drawingSpec || '');
  if (featureType === 'note' || featureType === 'gdt' || featureType === 'thread') {
    row.user.isNote = true;
  }

  return row;
}

/**
 * Recompute a row's `computed` object from raw + user + globals.
 * This is the ONLY place calculations happen.
 *
 * @param {Object} row — the row to recompute
 * @param {Object} globals — global settings
 * @returns {Object} row — same row, mutated with new computed values
 */
export function recompute(row, globals) {
  const { raw, user } = row;

  // ── Step 0: If note, skip all math ─────────────────────
  if (user.isNote) {
    row.computed = {
      isNote: true,
      dimTag: raw.dimTag || '',
      drawingSpec: raw.drawingSpec || '',
      outDrawingSpec: raw.drawingSpec || '',
      inputSpec: raw.drawingSpec || '',
      specUnit1: raw.specUnit1 || '',
      specUnit2: raw.specUnit2 || '',
      specUnit3: raw.specUnit3 || '',
      outNominal: '',
      outTolerance: '',
      inputTolerance: raw.tolerance || '',
      pinGage: '',
      platingAnnotation: '',
      platingMode: 'none',
      status: user.status,
      ipc: user.ipc,
      inspectionEquipment: user.inspectionEquipment,
      inspectionFrequency: user.inspectionFrequency,
      includeOps: { ...user.includeOps },
      original: { nominal: 0, tolPlus: 0, tolMinus: 0 },
      output: { nominal: 0, tolPlus: 0, tolMinus: 0 },
    };
    return row;
  }

  // ── Step 1: Parse spec units from drawing spec text ────
  const specUnits = parseSpecUnits(raw.drawingSpec || '');
  const tolParsed = parseTolerance(raw.toleranceText || raw.tolerance || '');

  // ── Step 2: Extract numeric values ─────────────────────
  let nominal = parseFloat(raw.nominalText || raw.nominal || raw.drawingSpec) || 0;
  let tolPlus = tolParsed.tolPlus;
  let tolMinus = tolParsed.tolMinus;

  // If tolerance was a single ± value from CSV
  if (tolPlus === 0 && tolMinus === 0 && raw.tolerance) {
    const t = parseFloat(raw.tolerance);
    if (!isNaN(t)) {
      tolPlus = t;
      tolMinus = t;
    }
  }

  // Store originals before math
  const originalNominal = nominal;
  const originalTolPlus = tolPlus;
  const originalTolMinus = tolMinus;

  // ── Step 3: Nominal centering (skip for OP2000) ────────
  if (user.autoNominal && !tolParsed.isSymmetric && (tolPlus !== tolMinus)) {
    const centered = centerNominal(nominal, tolPlus, tolMinus);
    nominal = centered.nominal;
    tolPlus = centered.tolSymmetric;
    tolMinus = centered.tolSymmetric;
  }

  // ── Step 4: Plating (skip for OP2000) ──────────────────
  let platingAnnotation = '';
  if (user.platingMode !== 'none' && globals.platingThickness > 0) {
    let platingValue = globals.platingThickness;

    // Convert plating to same units as import if needed
    if (globals.platingUnits !== globals.importUnits) {
      platingValue = convertUnits(platingValue, globals.platingUnits, globals.importUnits);
    }

    nominal = applyPlating(nominal, platingValue, user.platingMode);

    // Build annotation string, e.g., "(+2xI)" or "(-1xE)"
    const modeMap = {
      '+1xI': '(+1xI)',
      '+2xI': '(+2xI)',
      '-1xE': '(-1xE)',
      '-2xE': '(-2xE)',
    };
    platingAnnotation = modeMap[user.platingMode] || '';
  }

  // ── Step 5: Unit conversion ────────────────────────────
  if (globals.exportUnits && globals.exportUnits !== globals.importUnits) {
    nominal = convertUnits(nominal, globals.importUnits, globals.exportUnits);
    tolPlus = convertUnits(tolPlus, globals.importUnits, globals.exportUnits);
    tolMinus = convertUnits(tolMinus, globals.importUnits, globals.exportUnits);
  }

  // ── Step 6: Precision formatting ───────────────────────
  const outputUnits = globals.exportUnits || globals.importUnits;
  const precision = outputUnits === 'inch' ? globals.inchPrecision : globals.mmPrecision;
  const nominalStr = formatPrecision(nominal, precision);
  const tolStr = formatPrecision(tolPlus, precision);

  // ── Step 7: Pin/Gage computation ───────────────────────
  let pinGageStr = '';
  if (user.pinGageEnabled && user.overrides.pinGageValue !== null) {
    pinGageStr = user.overrides.pinGageValue;
  } else if (user.pinGageEnabled) {
    const pg = computePinGage(nominal, tolPlus);
    pinGageStr = pg.formatted;
  }

  // ── Step 8: Build output drawing spec ──────────────────
  let outDrawingSpec = user.overrides.outDrawingSpec !== null
    ? user.overrides.outDrawingSpec
    : nominalStr;

  let outTolerance = user.overrides.outTolerance !== null
    ? user.overrides.outTolerance
    : tolStr;

  // ── Step 9: Build nominal display with plating annotation
  let outNominal = nominalStr;
  if (platingAnnotation) {
    outNominal = `${nominalStr} ${platingAnnotation}`;
  }

  // ── Assemble computed object ───────────────────────────
  row.computed = {
    isNote: false,
    dimTag: raw.dimTag || '',
    specUnit1: raw.specUnit1 || specUnits.su1 || '',
    specUnit2: raw.specUnit2 || specUnits.su2 || '',
    specUnit3: raw.specUnit3 || specUnits.su3 || '',
    inputSpec: raw.drawingSpec || '',
    inputTolerance: raw.tolerance || '',

    outDrawingSpec,
    outNominal,
    outTolerance,
    pinGage: pinGageStr,
    platingAnnotation,
    platingMode: user.platingMode,

    original: {
      nominal: originalNominal,
      tolPlus: originalTolPlus,
      tolMinus: originalTolMinus,
    },
    output: {
      nominal,
      tolPlus,
      tolMinus,
    },

    status: user.status,
    ipc: user.ipc,
    inspectionEquipment: user.inspectionEquipment,
    inspectionFrequency: user.inspectionFrequency,
    includeOps: { ...user.includeOps },
  };

  return row;
}

/**
 * Get flat export data for a row + specific op.
 * OP2000 returns raw values only.
 *
 * @param {Object} row
 * @param {number} opNumber
 * @param {Object} globals
 * @returns {Object} flat object matching CSV columns
 */
export function getExportData(row, opNumber, globals) {
  const { raw, user, computed } = row;
  const isOp2000 = opNumber === 2000;
  const prefix = globals.opPrefixes[opNumber] || '';

  // Zero-pad dim tag to 2 digits if numeric
  const dimTagStr = /^\d+$/.test(computed.dimTag)
    ? computed.dimTag.padStart(2, '0')
    : computed.dimTag;

  if (computed.isNote) {
    // Notes export with drawing spec text only
    return {
      'Internal Part #': '',
      'Op #': opNumber,
      'Dim Tag #': `${prefix}${dimTagStr}`,
      'Ref Loc': raw.refLoc || '',
      'Char Dsg': '',
      'Spec Unit 1': '',
      'Drawing Spec': computed.drawingSpec,
      'Spec Unit 2': '',
      'Spec Unit 3': '',
      'Inspec Equip': '',
      'Nom Dim': '',
      'Tol ±': '',
      'IPC?': '',
      'Inspection Frequency': '',
      'Show Dim When?': '',
    };
  }

  if (isOp2000) {
    // OP2000: raw values only, no math applied
    return {
      'Internal Part #': '',
      'Op #': 2000,
      'Dim Tag #': `${prefix}${dimTagStr}`,
      'Ref Loc': raw.refLoc || '',
      'Char Dsg': raw.charDsg || '',
      'Spec Unit 1': raw.specUnit1 || '',
      'Drawing Spec': raw.drawingSpec || '',
      'Spec Unit 2': raw.specUnit2 || '',
      'Spec Unit 3': raw.specUnit3 || '',
      'Inspec Equip': computed.inspectionEquipment || '',
      'Nom Dim': raw.nominal || raw.drawingSpec || '',
      'Tol ±': raw.tolerance || '',
      'IPC?': computed.ipc ? 'TRUE' : '',
      'Inspection Frequency': computed.inspectionFrequency || '',
      'Show Dim When?': '',
    };
  }

  // Non-OP2000: computed values
  return {
    'Internal Part #': '',
    'Op #': opNumber,
    'Dim Tag #': `${prefix}${dimTagStr}`,
    'Ref Loc': raw.refLoc || '',
    'Char Dsg': '',
    'Spec Unit 1': computed.specUnit1,
    'Drawing Spec': computed.outDrawingSpec,
    'Spec Unit 2': computed.specUnit2,
    'Spec Unit 3': computed.specUnit3,
    'Inspec Equip': computed.inspectionEquipment || '',
    'Nom Dim': computed.outNominal,
    'Tol ±': computed.outTolerance,
    'IPC?': computed.ipc ? 'TRUE' : '',
    'Inspection Frequency': computed.inspectionFrequency || '',
    'Show Dim When?': '',
  };
}

/**
 * Reset row ID counter (useful for testing)
 */
export function resetIdCounter() {
  _nextId = 1;
}
