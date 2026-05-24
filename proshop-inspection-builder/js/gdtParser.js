/**
 * gdtParser.js — GD&T (Geometric Dimensioning & Tolerancing) constants + helpers.
 *
 * Pure data + pure functions. No DOM, no fetch, no app state. The OCR engine
 * (ocrEngine.js) and the popover/Datum-Mode UI (balloonManager.js + ui.js)
 * consume the exports.
 *
 * GD&T rows are balloon-created rows with raw._source='balloon' and
 * user.isNote=true (so recompute() skips them). Structured GD&T data lives
 * on row.user.gdt.
 */

window.PSB = window.PSB || {};

// ── Unicode safety ───────────────────────────────────────
// Several circled-letter Unicode chars (Ⓜ Ⓛ Ⓢ Ⓟ Ⓕ Ⓣ) render as colored
// emoji in modern browsers. VS15 (U+FE0E) forces text presentation.
// Always store the suffix on the constant so callers can't forget it.
var VS15 = '︎';

var GDT_SYMBOLS = {
  // Geometric characteristics (no emoji risk, but kept here for symmetry).
  position:          '⊕',           // ⊕
  flatness:          '⏥',           // ⏥
  straightness:      '⏤',           // ⏤
  circularity:       '○',           // ○
  cylindricity:      '⌭',           // ⌭
  profileLine:       '⌒',           // ⌒
  profileSurface:    '⌓',           // ⌓
  angularity:        '∠',           // ∠
  perpendicularity:  '⊥',           // ⊥
  parallelism:       '∥',           // ∥
  concentricity:     '◎',           // ◎
  symmetry:          '≡',           // ≡
  circularRunout:    '↗',           // ↗
  totalRunout:       '↗↗',     // ↗↗

  // Modifiers — circled letters MUST carry VS15 to suppress emoji rendering.
  diameter:          'Ø',           // Ø  (no emoji variant but kept consistent)
  mmc:               'Ⓜ' + VS15,    // Ⓜ
  lmc:               'Ⓛ' + VS15,    // Ⓛ
  rfs:               'Ⓢ' + VS15,    // Ⓢ
  projectedZone:     'Ⓟ' + VS15,    // Ⓟ
  freeState:         'Ⓕ' + VS15,    // Ⓕ
  tangentPlane:      'Ⓣ' + VS15,    // Ⓣ
};

// Reverse lookup: symbol char → characteristic key. Used by internal callers
// that need to map any symbol back to its key (not the detection heuristic).
var SYMBOL_TO_KEY = (function() {
  var m = {};
  Object.keys(GDT_SYMBOLS).forEach(function(k) { m[GDT_SYMBOLS[k]] = k; });
  return m;
})();

// Detection-only set: the 14 geometric characteristics. These are
// unambiguously GD&T — they never appear on plain dimensions. The diameter
// modifier (Ø) and the material-condition modifiers (Ⓜ Ⓛ Ⓢ Ⓟ Ⓕ Ⓣ) are
// EXCLUDED — Ø is everywhere on machined-part drawings, and the circled
// letters are too rare standalone to justify the false-positive risk. The
// pipe-character branch in isGdtLikely catches frames that contain only
// modifiers + a value.
var GDT_CHARACTERISTIC_KEYS = [
  'position','flatness','straightness','circularity','cylindricity',
  'profileLine','profileSurface','angularity','perpendicularity',
  'parallelism','concentricity','symmetry','circularRunout','totalRunout',
];
var DETECTION_SYMBOLS = (function() {
  var s = {};
  GDT_CHARACTERISTIC_KEYS.forEach(function(k) { s[GDT_SYMBOLS[k]] = true; });
  return s;
})();

var GDT_REFERENCE = {
  position: {
    name: 'Position (True Position)',
    category: 'Location',
    symbol: GDT_SYMBOLS.position,
    controls: 'The location of a feature relative to its true theoretical position. Defines how far the feature center may deviate from the nominal location.',
    requires: 'Almost always requires datum references. Diameter symbol (Ø) used when the tolerance zone is cylindrical (holes, pins).',
    common: 'Most commonly used GD&T call-out. Used for holes, slots, and any feature with a specific location requirement.',
    url: 'https://www.gdandtbasics.com/true-position/',
  },
  flatness: {
    name: 'Flatness', category: 'Form', symbol: GDT_SYMBOLS.flatness,
    controls: 'How flat a surface is — the surface must lie between two parallel planes separated by the tolerance value.',
    requires: 'No datum references allowed. Applied to individual surfaces only.',
    common: 'Used on mating surfaces, sealing faces, and any surface requiring controlled flatness.',
    url: 'https://www.gdandtbasics.com/flatness/',
  },
  straightness: {
    name: 'Straightness', category: 'Form', symbol: GDT_SYMBOLS.straightness,
    controls: 'How straight a line or axis is. Can apply to a surface line element or to a feature axis.',
    requires: 'No datum references. Can use diameter symbol if applied to an axis.',
    common: 'Used on shafts, pins, and cylindrical features where bowing or curvature must be controlled.',
    url: 'https://www.gdandtbasics.com/straightness/',
  },
  circularity: {
    name: 'Circularity (Roundness)', category: 'Form', symbol: GDT_SYMBOLS.circularity,
    controls: 'How circular a cross-section is at any given point along the feature.',
    requires: 'No datum references. Applied per cross-section, not the full length of a feature.',
    common: 'Used on turned parts, O-ring grooves, bearing bores.',
    url: 'https://www.gdandtbasics.com/circularity/',
  },
  cylindricity: {
    name: 'Cylindricity', category: 'Form', symbol: GDT_SYMBOLS.cylindricity,
    controls: 'The overall form of a cylinder — combines circularity, straightness, and taper into one control.',
    requires: 'No datum references. Tightest form control for cylindrical features.',
    common: 'Used on precision bores and shafts where the full cylindrical form must be controlled.',
    url: 'https://www.gdandtbasics.com/cylindricity/',
  },
  profileLine: {
    name: 'Profile of a Line', category: 'Profile', symbol: GDT_SYMBOLS.profileLine,
    controls: 'The shape of a cross-sectional line element of any surface — controls size and form together.',
    requires: 'Datum references optional. Controls a 2D profile at a specific cross-section.',
    common: 'Used on complex contoured surfaces, airfoils, cam profiles.',
    url: 'https://www.gdandtbasics.com/profile-of-a-line/',
  },
  profileSurface: {
    name: 'Profile of a Surface', category: 'Profile', symbol: GDT_SYMBOLS.profileSurface,
    controls: 'The 3D shape of an entire surface — controls size, form, orientation, and location in one call-out.',
    requires: 'Datum references usually required for location control.',
    common: 'One of the most versatile GD&T controls. Common on complex machined surfaces, castings, and injection molded parts.',
    url: 'https://www.gdandtbasics.com/profile-of-a-surface/',
  },
  angularity: {
    name: 'Angularity', category: 'Orientation', symbol: GDT_SYMBOLS.angularity,
    controls: 'The orientation of a surface or axis at a specified angle relative to a datum.',
    requires: 'Datum reference required. Does not control the angle value itself — that is on the drawing. Controls how close to that angle the feature must be.',
    common: 'Used on angled surfaces, chamfers, and features at non-90° angles to datums.',
    url: 'https://www.gdandtbasics.com/angularity/',
  },
  perpendicularity: {
    name: 'Perpendicularity', category: 'Orientation', symbol: GDT_SYMBOLS.perpendicularity,
    controls: 'How close to exactly 90° a surface or axis is relative to a datum.',
    requires: 'Datum reference required.',
    common: 'Very common on holes, slots, and mating faces. Diameter symbol used when controlling an axis.',
    url: 'https://www.gdandtbasics.com/perpendicularity/',
  },
  parallelism: {
    name: 'Parallelism', category: 'Orientation', symbol: GDT_SYMBOLS.parallelism,
    controls: 'How parallel a surface or axis is to a datum — the feature must lie within two planes parallel to the datum.',
    requires: 'Datum reference required.',
    common: 'Used on parallel mating surfaces, slots, and features that must be parallel to a datum face.',
    url: 'https://www.gdandtbasics.com/parallelism/',
  },
  concentricity: {
    name: 'Concentricity', category: 'Location', symbol: GDT_SYMBOLS.concentricity,
    controls: 'The location of a feature\'s median points relative to a datum axis. All median points must fall within the cylindrical tolerance zone.',
    requires: 'Datum reference required. Very difficult and expensive to measure — coaxiality or runout are often preferred.',
    common: 'Less common in modern drawings. Often replaced by circular runout or true position.',
    url: 'https://www.gdandtbasics.com/concentricity/',
  },
  symmetry: {
    name: 'Symmetry', category: 'Location', symbol: GDT_SYMBOLS.symmetry,
    controls: 'The location of median points of a non-cylindrical feature relative to a datum plane.',
    requires: 'Datum reference required. Rarely used — position is usually preferred.',
    common: 'Uncommon. Typically seen on symmetric slots or features where the midplane must be controlled.',
    url: 'https://www.gdandtbasics.com/symmetry/',
  },
  circularRunout: {
    name: 'Circular Runout', category: 'Runout', symbol: GDT_SYMBOLS.circularRunout,
    controls: 'The variation of a surface at any cross-section when rotated 360° around a datum axis. Measured at individual cross-sections.',
    requires: 'Datum axis required (usually a shaft centerline).',
    common: 'Used on rotating parts — shafts, bearing journals, OD of turned features.',
    url: 'https://www.gdandtbasics.com/circular-runout/',
  },
  totalRunout: {
    name: 'Total Runout', category: 'Runout', symbol: GDT_SYMBOLS.totalRunout,
    controls: 'The variation of an entire surface simultaneously when rotated 360° around a datum axis. Stricter than circular runout.',
    requires: 'Datum axis required.',
    common: 'Used where the full surface must be controlled, not just individual cross-sections.',
    url: 'https://www.gdandtbasics.com/total-runout/',
  },
};

var MODIFIER_TOOLTIPS = {
  mmc: 'Maximum Material Condition (Ⓜ' + VS15 + '): The tolerance applies when the feature contains the most material — largest shaft, smallest hole. Bonus tolerance is available as the feature departs from MMC.',
  lmc: 'Least Material Condition (Ⓛ' + VS15 + '): The tolerance applies when the feature contains the least material — smallest shaft, largest hole.',
  rfs: 'Regardless of Feature Size (Ⓢ' + VS15 + '): The tolerance applies at any feature size. No bonus tolerance. Default condition when no modifier is shown (ASME Y14.5-2009+).',
  projectedZone: 'Projected Tolerance Zone (Ⓟ' + VS15 + '): Tolerance zone is projected above the surface — used for threaded holes that mate with studs.',
  freeState: 'Free State (Ⓕ' + VS15 + '): Tolerance applies when the part is free of any restraining forces.',
  tangentPlane: 'Tangent Plane (Ⓣ' + VS15 + '): The tolerance applies to a plane tangent to the high points of the feature, not the feature itself.',
};

// ── Field assembly ───────────────────────────────────────

/**
 * SU1 — characteristic symbol, plus Ø if the tolerance zone is cylindrical.
 * Examples: "⊕ Ø"  "⊥"  "⏥"
 */
function buildSu1(gdtData) {
  var sym = GDT_SYMBOLS[gdtData.characteristic] || '';
  return gdtData.hasDiameter ? (sym + ' ' + GDT_SYMBOLS.diameter) : sym;
}

/**
 * SU2 — first-word characteristic name + datums (with modifiers) joined by " | ".
 * Examples: "Position | A | B Ⓜ | C"   "Flatness"   "Perpendicularity | A"
 */
function buildSu2(gdtData) {
  var ref = GDT_REFERENCE[gdtData.characteristic];
  var name = ref ? ref.name.split(' ')[0] : (gdtData.characteristic || '');
  var datums = gdtData.datums || [];
  if (!datums.length) return name;
  var parts = datums.map(function(d) {
    var mc = d.materialCondition && GDT_SYMBOLS[d.materialCondition];
    return mc ? (d.letter + ' ' + mc) : d.letter;
  });
  return name + ' | ' + parts.join(' | ');
}

/**
 * Nominal frame — full feature control frame as a pipe-delimited string.
 * Informational only; ProShop does not parse it.
 * Example: "| ⊕ | Ø0.014 Ⓜ | A | B Ⓜ | C |"
 *
 * Format: leading pipe, single-space padding, segments separated by ' | ',
 * trailing pipe. Matches the visual "boxed" feature-control-frame layout.
 */
function buildNominalFrame(gdtData) {
  var sym = GDT_SYMBOLS[gdtData.characteristic] || '';
  var tolPart = '';
  if (gdtData.hasDiameter) tolPart += GDT_SYMBOLS.diameter;
  tolPart += (gdtData.tolerance == null ? '' : gdtData.tolerance);
  if (gdtData.materialCondition && GDT_SYMBOLS[gdtData.materialCondition]) {
    tolPart += ' ' + GDT_SYMBOLS[gdtData.materialCondition];
  }
  var segments = [sym, tolPart];
  (gdtData.datums || []).forEach(function(d) {
    var mc = d.materialCondition && GDT_SYMBOLS[d.materialCondition];
    segments.push(mc ? (d.letter + ' ' + mc) : d.letter);
  });
  return '| ' + segments.join(' | ') + ' |';
}

/**
 * ProShop DIM Spec string — same shape as buildNominalFrame for now. Kept as a
 * separate exported function in case the two formats diverge later (e.g. if
 * ProShop requires a different separator or omits trailing pipe).
 */
function buildProShopGdtSpec(gdtData) {
  return buildNominalFrame(gdtData);
}

// ── OCR response parsing ─────────────────────────────────

var VALID_CHARS = Object.keys(GDT_REFERENCE);
var VALID_MCS = ['mmc', 'lmc', 'rfs'];

/**
 * Validate and normalize the JSON object returned by Claude vision.
 * Returns a fully-populated user.gdt object, or { _error: 'reason' } on failure.
 */
function parseGdtResponse(jsonData) {
  if (!jsonData || typeof jsonData !== 'object') {
    return { _error: 'not_object' };
  }
  var char = String(jsonData.characteristic || '').trim();
  if (VALID_CHARS.indexOf(char) === -1) {
    return { _error: 'unknown_characteristic', _value: char };
  }
  var ref = GDT_REFERENCE[char];

  var tolerance = String(jsonData.tolerance == null ? '' : jsonData.tolerance).trim();
  var hasDiameter = !!jsonData.hasDiameter;
  var mc = jsonData.materialCondition;
  if (mc != null) mc = String(mc).toLowerCase();
  if (VALID_MCS.indexOf(mc) === -1) mc = null;

  var datums = [];
  (jsonData.datums || []).forEach(function(d) {
    if (!d || !d.letter) return;
    var letter = String(d.letter).toUpperCase().charAt(0);
    if (!/^[A-Z]$/.test(letter)) return;
    var dmc = d.materialCondition;
    if (dmc != null) dmc = String(dmc).toLowerCase();
    if (VALID_MCS.indexOf(dmc) === -1) dmc = null;
    datums.push({ letter: letter, materialCondition: dmc });
  });

  var gdt = {
    characteristic: char,
    characteristicName: ref.name,
    category: ref.category,
    hasDiameter: hasDiameter,
    tolerance: tolerance,
    materialCondition: mc,
    datums: datums,
    isComposite: !!jsonData.isComposite,
    compositeUpper: null,
    compositeLower: null,
    su1: '',
    su2: '',
    nominalFrame: '',
    rawOcrText: jsonData._raw || null,
    gdtbasicsUrl: ref.url,
  };
  gdt.su1 = buildSu1(gdt);
  gdt.su2 = buildSu2(gdt);
  gdt.nominalFrame = buildNominalFrame(gdt);
  return gdt;
}

// ── Detection heuristic ──────────────────────────────────

var DATUM_LETTER_RE = /(^|[^A-Za-z])([A-Z])(?=[^A-Za-z]|$)/;
var DIGIT_RE = /\d/;

/**
 * Return true if the OCR text looks like a GD&T feature control frame rather
 * than a plain dimension. Cheap signals only; the Claude call is expensive so
 * we want false positives more than false negatives.
 *
 *   - pipe characters
 *   - any known GD&T symbol char in the text
 *   - text with no digits but a lone uppercase datum-letter pattern
 */
function isGdtLikely(ocrText) {
  var s = String(ocrText || '');
  if (!s.trim()) return false;
  if (s.indexOf('|') !== -1) return true;
  for (var i = 0; i < s.length; i++) {
    if (DETECTION_SYMBOLS[s.charAt(i)]) return true;
  }
  // Two-char totalRunout
  if (s.indexOf(GDT_SYMBOLS.totalRunout) !== -1) return true;
  if (!DIGIT_RE.test(s) && DATUM_LETTER_RE.test(s)) return true;
  return false;
}

// ── Tooltip HTML (safe — no user data) ───────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the GD&T tooltip panel HTML for a given characteristic key.
 * Returns '' for unknown keys (caller should not render the badge in that case).
 */
function getGdtTooltipHtml(characteristic) {
  var ref = GDT_REFERENCE[characteristic];
  if (!ref) return '';
  var catSlug = ref.category.toLowerCase();
  return '<div class="gdt-tooltip">' +
    '<div class="gdt-tooltip-header">' +
      '<span class="gdt-symbol">' + escHtml(ref.symbol) + '</span>' +
      '<span class="gdt-name">' + escHtml(ref.name) + '</span>' +
      '<span class="gdt-category gdt-cat-' + escHtml(catSlug) + '">' + escHtml(ref.category) + '</span>' +
    '</div>' +
    '<div class="gdt-tooltip-controls"><strong>Controls:</strong> ' + escHtml(ref.controls) + '</div>' +
    '<div class="gdt-tooltip-requires"><strong>Requirements:</strong> ' + escHtml(ref.requires) + '</div>' +
    '<div class="gdt-tooltip-common"><strong>Common use:</strong> ' + escHtml(ref.common) + '</div>' +
    '<a class="gdt-tooltip-link" href="' + escHtml(ref.url) + '" target="_blank" rel="noopener">Learn more →</a>' +
    '</div>';
}

// ── Public namespace ─────────────────────────────────────
PSB.VS15 = VS15;
PSB.GDT_SYMBOLS = GDT_SYMBOLS;
PSB.GDT_REFERENCE = GDT_REFERENCE;
PSB.MODIFIER_TOOLTIPS = MODIFIER_TOOLTIPS;
PSB.buildSu1 = buildSu1;
PSB.buildSu2 = buildSu2;
PSB.buildNominalFrame = buildNominalFrame;
PSB.buildProShopGdtSpec = buildProShopGdtSpec;
PSB.parseGdtResponse = parseGdtResponse;
PSB.isGdtLikely = isGdtLikely;
PSB.getGdtTooltipHtml = getGdtTooltipHtml;
