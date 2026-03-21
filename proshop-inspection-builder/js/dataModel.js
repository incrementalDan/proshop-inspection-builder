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

// ── Frequency → Letter mapping (fixed, never dynamic) ────
var FREQ_LETTER_MAP = {
  '1 in 1': 'A',
  '1 in 2': 'B',
  '1 in 3': 'C',
  '1 in 4': 'D',
  '1 in 5': 'E',
  '1 in 10': 'F',
  '1 in 20': 'G',
  '1 in 50': 'H',
  'First and Last': 'I',
};

/**
 * Generate the Output Tag for a dim tag + frequency.
 *
 * Non-OP2000: <LetterPrefix>REF-<zero-padded dim tag>
 * OP2000: raw dim tag only (no REF-, no letter)
 *
 * @param {string} dimTag — raw dim tag value
 * @param {string} frequency — inspection frequency string
 * @param {boolean} isOp2000
 * @returns {string}
 */
function generateOutputTag(dimTag, frequency, isOp2000) {
  // Zero-pad to 2 digits if numeric
  var padded = /^\d+$/.test(dimTag) ? dimTag.padStart(2, '0') : dimTag;

  if (isOp2000) {
    return padded;
  }

  var letter = FREQ_LETTER_MAP[frequency] || '';
  return letter + 'REF-' + padded;
}

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
      specUnit1: null,
      specUnit2: null,
      specUnit3: null,
      outNominal: null,
      inputTolerance: null,
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
    var ov = user.overrides || {};
    row.computed = {
      isNote: true,
      dimTag: raw.dimTag || '',
      outputTag: generateOutputTag(raw.dimTag || '', user.inspectionFrequency || '', false),
      drawingSpec: raw.drawingSpec || '',
      outDrawingSpec: ov.outDrawingSpec !== null ? ov.outDrawingSpec : (raw.drawingSpec || ''),
      inputSpec: raw.drawingSpec || '',
      specUnit1: ov.specUnit1 !== null ? ov.specUnit1 : (raw.specUnit1 || ''),
      specUnit2: ov.specUnit2 !== null ? ov.specUnit2 : (raw.specUnit2 || ''),
      specUnit3: ov.specUnit3 !== null ? ov.specUnit3 : (raw.specUnit3 || ''),
      outNominal: ov.outNominal !== null ? ov.outNominal : '',
      outTolerance: ov.outTolerance !== null ? ov.outTolerance : '',
      inputTolerance: ov.inputTolerance !== null ? ov.inputTolerance : (raw.tolerance || ''),
      pinGage: ov.pinGageValue !== null ? ov.pinGageValue : '',
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

  // ══════════════════════════════════════════════════════════
  // Type 1 — Parsing: clean up raw data into correct columns
  // ══════════════════════════════════════════════════════════
  var specUnits = PSB.parseSpecUnits(raw.drawingSpec || '');
  var tolParsed = PSB.parseTolerance(raw.toleranceText || raw.tolerance || '');

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

  // ══════════════════════════════════════════════════════════
  // Type 2 — Manual Overrides: apply user corrections
  // After this point we have the OP2000 base values.
  // ══════════════════════════════════════════════════════════
  var op2000SpecUnit1 = user.overrides.specUnit1 !== null ? user.overrides.specUnit1 : (raw.specUnit1 || specUnits.su1 || '');
  var op2000SpecUnit2 = user.overrides.specUnit2 !== null ? user.overrides.specUnit2 : (raw.specUnit2 || specUnits.su2 || '');
  var op2000SpecUnit3 = user.overrides.specUnit3 !== null ? user.overrides.specUnit3 : (raw.specUnit3 || specUnits.su3 || '');
  var op2000DrawingSpec = user.overrides.outDrawingSpec !== null ? user.overrides.outDrawingSpec : (raw.drawingSpec || '');
  var op2000Nominal = nominal;  // numeric, from parsed raw
  var op2000Tolerance = user.overrides.outTolerance !== null ? user.overrides.outTolerance : (raw.tolerance || '');
  var op2000InputTolerance = user.overrides.inputTolerance !== null ? user.overrides.inputTolerance : (raw.tolerance || '');

  // Store originals (pre-math) for reference
  var originalNominal = nominal;
  var originalTolPlus = tolPlus;
  var originalTolMinus = tolMinus;

  // ══════════════════════════════════════════════════════════
  // Type 4 — Auto-Nominal Centering (derives from OP2000 base)
  // ══════════════════════════════════════════════════════════
  if (user.autoNominal && !tolParsed.isSymmetric && (tolPlus !== tolMinus)) {
    var centered = PSB.centerNominal(nominal, tolPlus, tolMinus);
    nominal = centered.nominal;
    tolPlus = centered.tolSymmetric;
    tolMinus = centered.tolSymmetric;
  }

  // ══════════════════════════════════════════════════════════
  // Type 3 — Modifiers (derives from centered values)
  // ══════════════════════════════════════════════════════════

  // ── Plating ──────────────────────────────────────────────
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

  // ── Dual-unit formatting ─────────────────────────────────
  var importUnits = globals.importUnits || 'mm';
  var secondaryUnits = importUnits === 'mm' ? 'inch' : 'mm';
  var primaryPrec = importUnits === 'inch' ? globals.inchPrecision : globals.mmPrecision;
  var secondaryPrec = secondaryUnits === 'inch' ? globals.inchPrecision : globals.mmPrecision;

  var primaryNom = nominal;
  var primaryTolPlus = tolPlus;
  var primaryTolMinus = tolMinus;

  var secondaryNom = PSB.convertUnits(nominal, importUnits, secondaryUnits);
  var secondaryTolPlus = PSB.convertUnits(tolPlus, importUnits, secondaryUnits);
  var secondaryTolMinus = PSB.convertUnits(tolMinus, importUnits, secondaryUnits);

  // ── Precision formatting ─────────────────────────────────
  var nominalStr = PSB.formatPrecision(primaryNom, primaryPrec);
  var tolStr = PSB.formatPrecision(primaryTolPlus, primaryPrec);
  var secNomStr = PSB.formatPrecision(secondaryNom, secondaryPrec);
  var secTolStr = PSB.formatPrecision(secondaryTolPlus, secondaryPrec);

  var dualNomStr = nominalStr + ' [' + secNomStr + ']';
  var dualTolStr = tolStr + ' [' + secTolStr + ']';

  // ── Pin/Gage computation ─────────────────────────────────
  var pinGageStr = '';
  if (user.pinGageEnabled && user.overrides.pinGageValue !== null) {
    pinGageStr = user.overrides.pinGageValue;
  } else if (user.pinGageEnabled) {
    var pg = PSB.computePinGage(secondaryNom, secondaryTolPlus, secondaryPrec);
    pinGageStr = pg.formatted;
  }

  // ── Build output display values (other OPs) ──────────────
  var outDrawingSpec = user.overrides.outDrawingSpec !== null
    ? user.overrides.outDrawingSpec
    : dualNomStr;

  var outTolerance = user.overrides.outTolerance !== null
    ? user.overrides.outTolerance
    : dualTolStr;

  var outNominal = dualNomStr;
  if (platingAnnotation) {
    outNominal = dualNomStr + ' ' + platingAnnotation;
  }

  // ── Output Tag ───────────────────────────────────────────
  var outputTag = generateOutputTag(
    raw.dimTag || '',
    user.inspectionFrequency || '',
    false  // non-OP2000 for display
  );

  // ── Assemble computed object ─────────────────────────────
  row.computed = {
    isNote: false,
    dimTag: raw.dimTag || '',
    outputTag: outputTag,
    specUnit1: op2000SpecUnit1,
    specUnit2: op2000SpecUnit2,
    specUnit3: op2000SpecUnit3,
    inputSpec: raw.drawingSpec || '',
    inputTolerance: op2000InputTolerance,

    // OP2000 base values (Type 1 + Type 2 only)
    op2000DrawingSpec: op2000DrawingSpec,
    op2000Nominal: op2000Nominal,
    op2000Tolerance: op2000Tolerance,

    // Other OP values (derived from OP2000 base + Types 3 & 4)
    outDrawingSpec: outDrawingSpec,
    outNominal: user.overrides.outNominal !== null ? user.overrides.outNominal : outNominal,
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
      nominal: primaryNom,
      tolPlus: primaryTolPlus,
      tolMinus: primaryTolMinus,
    },
    secondary: {
      nominal: secondaryNom,
      tolPlus: secondaryTolPlus,
      tolMinus: secondaryTolMinus,
    },
    // Export-ready values (secondary/converted units, no brackets)
    exportNominal: PSB.formatPrecision(secondaryNom, secondaryPrec),
    exportTolerance: PSB.formatPrecision(secondaryTolPlus, secondaryPrec),

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
 * OP2000 returns Type 1+2 values (parsed + overridden).
 * Other OPs return full pipeline values (Types 1-4).
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

  // Auto-generate Output Tag from frequency + dim tag
  var outputTag = generateOutputTag(
    computed.dimTag || '',
    computed.inspectionFrequency || '',
    isOp2000
  );

  if (computed.isNote) {
    // Notes export with drawing spec text and any user overrides
    return {
      'Internal Part #': '',
      'Op #': opNumber,
      'Dim Tag #': outputTag,
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

  if (isOp2000) {
    // OP2000: Type 1 (parsing) + Type 2 (overrides) only. No math, no unit conversion.
    return {
      'Internal Part #': '',
      'Op #': 2000,
      'Dim Tag #': outputTag,
      'Ref Loc': raw.refLoc || '',
      'Char Dsg': raw.charDsg || '',
      'Spec Unit 1': computed.specUnit1,
      'Drawing Spec': computed.op2000DrawingSpec,
      'Spec Unit 2': computed.specUnit2,
      'Spec Unit 3': computed.specUnit3,
      'Inspec Equip': computed.inspectionEquipment || '',
      'Nom Dim': computed.op2000DrawingSpec,
      'Tol ±': computed.op2000Tolerance,
      'IPC?': computed.ipc ? 'TRUE' : '',
      'Inspection Frequency': computed.inspectionFrequency || '',
      'Show Dim When?': '',
    };
  }

  // Non-OP2000: export uses secondary (converted) unit values, no brackets
  var exportNom = computed.exportNominal || '';
  if (computed.platingAnnotation) {
    exportNom = exportNom + ' ' + computed.platingAnnotation;
  }
  return {
    'Internal Part #': '',
    'Op #': opNumber,
    'Dim Tag #': outputTag,
    'Ref Loc': raw.refLoc || '',
    'Char Dsg': '',
    'Spec Unit 1': computed.specUnit1,
    'Drawing Spec': computed.exportNominal || '',
    'Spec Unit 2': computed.specUnit2,
    'Spec Unit 3': computed.specUnit3,
    'Inspec Equip': computed.inspectionEquipment || '',
    'Nom Dim': exportNom,
    'Tol ±': computed.exportTolerance || '',
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
PSB.generateOutputTag = generateOutputTag;
