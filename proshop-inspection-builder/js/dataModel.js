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

window.PSB = window.PSB || {};

// ── Row ID counter ────────────────────────────────────────
var _nextId = 1;

/**
 * Default global settings
 */
function defaultGlobals() {
  return {
    importUnits: 'mm',        // 'mm' or 'inch'
    displayUnits: 'inch',     // 'mm', 'inch', or 'both'
    exportUnits: 'inch',
    platingThickness: 0,
    platingUnits: 'inch',
    inchPrecision: 4,
    mmPrecision: 3,
    ops: [50, 60],            // default OPs
    opPrefixes: { 50: '', 60: '' },
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
function defaultUserState() {
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
function createRow(rawData) {
  var row = {
    id: _nextId++,
    raw: Object.freeze(Object.assign({}, rawData)),
    user: defaultUserState(),
    computed: {},
  };

  // Auto-detect notes
  var featureType = PSB.detectFeatureType(rawData.drawingSpec || '');
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
function recompute(row, globals) {
  var raw = row.raw;
  var user = row.user;

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
      includeOps: Object.assign({}, user.includeOps),
      original: { nominal: 0, tolPlus: 0, tolMinus: 0 },
      output: { nominal: 0, tolPlus: 0, tolMinus: 0 },
    };
    return row;
  }

  // ── Step 1: Parse spec units from drawing spec text ────
  var specUnits = PSB.parseSpecUnits(raw.drawingSpec || '');
  var tolParsed = PSB.parseTolerance(raw.toleranceText || raw.tolerance || '');

  // ── Step 2: Extract numeric values ─────────────────────
  var nominal = parseFloat(raw.nominalText || raw.nominal || raw.drawingSpec) || 0;
  var tolPlus = tolParsed.tolPlus;
  var tolMinus = tolParsed.tolMinus;

  // If tolerance was a single ± value from CSV
  if (tolPlus === 0 && tolMinus === 0 && raw.tolerance) {
    var t = parseFloat(raw.tolerance);
    if (!isNaN(t)) {
      tolPlus = t;
      tolMinus = t;
    }
  }

  // Store originals before math
  var originalNominal = nominal;
  var originalTolPlus = tolPlus;
  var originalTolMinus = tolMinus;

  // ── Step 3: Nominal centering (skip for OP2000) ────────
  if (user.autoNominal && !tolParsed.isSymmetric && (tolPlus !== tolMinus)) {
    var centered = PSB.centerNominal(nominal, tolPlus, tolMinus);
    nominal = centered.nominal;
    tolPlus = centered.tolSymmetric;
    tolMinus = centered.tolSymmetric;
  }

  // ── Step 4: Plating (skip for OP2000) ──────────────────
  var platingAnnotation = '';
  if (user.platingMode !== 'none' && globals.platingThickness > 0) {
    var platingValue = globals.platingThickness;

    // Convert plating to same units as import if needed
    if (globals.platingUnits !== globals.importUnits) {
      platingValue = PSB.convertUnits(platingValue, globals.platingUnits, globals.importUnits);
    }

    nominal = PSB.applyPlating(nominal, platingValue, user.platingMode);

    // Build annotation string, e.g., "(+2xI)" or "(-1xE)"
    var modeMap = {
      '+1xI': '(+1xI)',
      '+2xI': '(+2xI)',
      '-1xE': '(-1xE)',
      '-2xE': '(-2xE)',
    };
    platingAnnotation = modeMap[user.platingMode] || '';
  }

  // ── Step 5: Unit conversion ────────────────────────────
  if (globals.exportUnits && globals.exportUnits !== globals.importUnits) {
    nominal = PSB.convertUnits(nominal, globals.importUnits, globals.exportUnits);
    tolPlus = PSB.convertUnits(tolPlus, globals.importUnits, globals.exportUnits);
    tolMinus = PSB.convertUnits(tolMinus, globals.importUnits, globals.exportUnits);
  }

  // ── Step 6: Precision formatting ───────────────────────
  var outputUnits = globals.exportUnits || globals.importUnits;
  var precision = outputUnits === 'inch' ? globals.inchPrecision : globals.mmPrecision;
  var nominalStr = PSB.formatPrecision(nominal, precision);
  var tolStr = PSB.formatPrecision(tolPlus, precision);

  // ── Step 7: Pin/Gage computation ───────────────────────
  var pinGageStr = '';
  if (user.pinGageEnabled && user.overrides.pinGageValue !== null) {
    pinGageStr = user.overrides.pinGageValue;
  } else if (user.pinGageEnabled) {
    var pg = PSB.computePinGage(nominal, tolPlus);
    pinGageStr = pg.formatted;
  }

  // ── Step 8: Build output drawing spec ──────────────────
  var outDrawingSpec = user.overrides.outDrawingSpec !== null
    ? user.overrides.outDrawingSpec
    : nominalStr;

  var outTolerance = user.overrides.outTolerance !== null
    ? user.overrides.outTolerance
    : tolStr;

  // ── Step 9: Build nominal display with plating annotation
  var outNominal = nominalStr;
  if (platingAnnotation) {
    outNominal = nominalStr + ' ' + platingAnnotation;
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

    outDrawingSpec: outDrawingSpec,
    outNominal: outNominal,
    outTolerance: outTolerance,
    pinGage: pinGageStr,
    platingAnnotation: platingAnnotation,
    platingMode: user.platingMode,

    original: {
      nominal: originalNominal,
      tolPlus: originalTolPlus,
      tolMinus: originalTolMinus,
    },
    output: {
      nominal: nominal,
      tolPlus: tolPlus,
      tolMinus: tolMinus,
    },

    status: user.status,
    ipc: user.ipc,
    inspectionEquipment: user.inspectionEquipment,
    inspectionFrequency: user.inspectionFrequency,
    includeOps: Object.assign({}, user.includeOps),
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
function getExportData(row, opNumber, globals) {
  var raw = row.raw;
  var user = row.user;
  var computed = row.computed;
  var isOp2000 = opNumber === 2000;
  var prefix = globals.opPrefixes[opNumber] || '';

  // Zero-pad dim tag to 2 digits if numeric
  var dimTagStr = /^\d+$/.test(computed.dimTag)
    ? computed.dimTag.padStart(2, '0')
    : computed.dimTag;

  if (computed.isNote) {
    // Notes export with drawing spec text only
    return {
      'Internal Part #': '',
      'Op #': opNumber,
      'Dim Tag #': prefix + dimTagStr,
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
      'Dim Tag #': prefix + dimTagStr,
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
    'Dim Tag #': prefix + dimTagStr,
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
function resetIdCounter() {
  _nextId = 1;
}

// ── Export to namespace ───────────────────────────────────
PSB.defaultGlobals = defaultGlobals;
PSB.defaultUserState = defaultUserState;
PSB.createRow = createRow;
PSB.recompute = recompute;
PSB.getExportData = getExportData;
PSB.resetIdCounter = resetIdCounter;
