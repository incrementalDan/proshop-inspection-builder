> **Historical build spec.** Written as instructions for building this feature.
> Parts may be out of date. For output/math rules, `RULES.md` wins.

## GD&T — Geometric Dimensioning and Tolerancing

This section documents GD&T awareness across the ballooning, OCR, and inspection features.
GD&T rows are a special case of balloon-created rows — same `{ raw, user, computed }` shape,
but with additional structured data in `user.gdt`.

-----

### GD&T Symbol Definitions

All GD&T symbols are stored and output as **Unicode text characters**.
ProShop DIM Spec field accepts plain text — no images, no special fonts needed.

**CRITICAL — Emoji rendering prevention:**
Several circled-letter Unicode characters render as colored emoji in browsers and some apps.
Always append the **text variation selector U+FE0E** (`︎`) to force text presentation.
Store the VS15 suffix in the constant definition — never add it inline at render time.

```javascript
// In js/gdtParser.js — module-level constants
var VS15 = '︎'; // Unicode text presentation selector — prevents emoji rendering

var GDT_SYMBOLS = {
  // Geometric characteristics
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

  // Modifiers — ALL get VS15 to prevent emoji rendering
  diameter:          'Ø',           // Ø  (no emoji risk but consistent)
  mmc:               'Ⓜ' + VS15,    // Ⓜ  (subway emoji without VS15 — always append)
  lmc:               'Ⓛ' + VS15,    // Ⓛ
  rfs:               'Ⓢ' + VS15,    // Ⓢ
  projectedZone:     'Ⓟ' + VS15,    // Ⓟ
  freeState:         'Ⓕ' + VS15,    // Ⓕ
  tangentPlane:      'Ⓣ' + VS15,    // Ⓣ
};
```

**CSS — force text rendering on all GD&T elements:**

```css
.gdt-symbol, .gdt-modifier, .gdt-frame {
  font-variant-emoji: text;
  font-family: 'Segoe UI Symbol', 'Apple Symbols', 'Symbola', sans-serif;
}
```

-----

### Feature Control Frame — ProShop Text Format

ProShop DIM Spec field receives a pipe-delimited string that visually approximates the
feature control frame box structure. This is display-only text — ProShop cannot parse it.

**Format:**

```
| <characteristic symbol> | <Ø if cylindrical><tolerance><modifier> | <datum A><modifier> | <datum B><modifier> | <datum C><modifier> |
```

**Examples:**

|Drawing shows                        |ProShop DIM Spec             |SU2                 |
|-------------------------------------|-----------------------------|--------------------|
|Position Ø.014 MMC, datums A B C     |`| ⊕ | Ø.014 Ⓜ | A | B | C |`|Position            |
|Flatness .003                        |`| ⏥ | .003 |`               |Flatness            |
|Perpendicularity Ø.005 MMC, datum A  |`| ⊥ | Ø.005 Ⓜ | A |`        |Perpendicularity    |
|Profile of a Surface .010, datums A B|`| ⌓ | .010 | A | B |`       |Profile of a Surface|
|Concentricity Ø.002, datum A         |`| ◎ | Ø.002 | A |`          |Concentricity       |

**Assembly function — `buildProShopGdtSpec(gdtData)`:**

```javascript
function buildProShopGdtSpec(gdtData) {
  // gdtData: { characteristic, hasDiameter, tolerance, materialCondition, datums[] }
  // datums: [{ letter, materialCondition }]

  var sym = GDT_SYMBOLS[gdtData.characteristic] || gdtData.characteristic;
  var tolPart = '';
  if (gdtData.hasDiameter) tolPart += GDT_SYMBOLS.diameter;
  tolPart += gdtData.tolerance;
  if (gdtData.materialCondition) tolPart += ' ' + GDT_SYMBOLS[gdtData.materialCondition];

  var parts = ['', sym, tolPart];

  for (var i = 0; i < gdtData.datums.length; i++) {
    var d = gdtData.datums[i];
    var datumStr = d.letter;
    if (d.materialCondition) datumStr += GDT_SYMBOLS[d.materialCondition];
    parts.push(datumStr);
  }

  parts.push(''); // trailing pipe
  return parts.join(' | ');
}
```

-----

### GD&T Data Model

GD&T rows are balloon-created rows with `raw._source = 'balloon'` and `user.isNote = true`
(so the math pipeline skips them). GD&T structured data lives in `user.gdt`.

```javascript
// user.gdt shape — null for non-GD&T rows
user.gdt = {
  characteristic: 'position',        // key into GDT_SYMBOLS
  characteristicName: 'Position',     // plain English first word — used in SU2
  category: 'Location',              // Form | Profile | Orientation | Runout | Location
  hasDiameter: true,                 // Ø prefix on tolerance zone
  tolerance: '0.014',                // numeric string, unrounded — goes into DIM Spec
  materialCondition: 'mmc',          // 'mmc' | 'lmc' | 'rfs' | null
  datums: [
    { letter: 'A', materialCondition: null },
    { letter: 'B', materialCondition: 'mmc' },
    { letter: 'C', materialCondition: null },
  ],
  isComposite: false,                // true if two stacked frames
  compositeUpper: null,
  compositeLower: null,
  // Pre-built field strings — generated by gdtParser, stored for export
  su1: '⊕ Ø',                        // buildSu1() result → raw.specUnit1
  su2: 'Position | A | B Ⓜ | C',    // buildSu2() result → raw.specUnit2
  nominalFrame: '| ⊕ | Ø.014 Ⓜ | A | B Ⓜ | C |', // buildNominalFrame() → raw.nominal
  rawOcrText: '...',                 // original Claude API response, for debug
  gdtbasicsUrl: 'https://www.gdandtbasics.com/true-position/',
};
```

**How GD&T maps to app fields and ProShop columns:**

|App field / ProShop column |Content                                                  |Example                      |
|---------------------------|---------------------------------------------------------|-----------------------------|
|**Spec Unit 1 (SU1)**      |Characteristic symbol + Ø if cylindrical                 |`⊕ Ø` or `⊥`                 |
|**Drawing Spec (DIM Spec)**|Tolerance value as a standalone number                   |`0.014`                      |
|**Spec Unit 2 (SU2)**      |Characteristic name + datums with pipes + datum modifiers|`Position | A | B Ⓜ | C`     |
|**Nominal**                |Full feature control frame string (informational)        |`| ⊕ | Ø.014 Ⓜ | A | B | C |`|
|**Tolerance**              |blank — ProShop math not used for GD&T rows              |—                            |

**Rationale:**

- ProShop only performs math on Dim Spec — for GD&T that field holds just the tolerance number
- Nominal is informational in ProShop — the full frame string goes here for traceability
- SU1 + SU2 together give the inspector the full context in the columns they already see
- This mirrors how a trained inspector reads a feature control frame: symbol → value → datums

**Field assembly functions — add to `gdtParser.js`:**

```javascript
/**
 * Build SU1 — characteristic symbol, plus Ø if cylindrical tolerance zone.
 * Examples: "⊕ Ø"  "⊥"  "⏥"
 */
function buildSu1(gdtData) {
  var sym = GDT_SYMBOLS[gdtData.characteristic] || '';
  return gdtData.hasDiameter ? sym + ' ' + GDT_SYMBOLS.diameter : sym;
}

/**
 * Build SU2 — characteristic name + datums separated by pipes + datum modifiers.
 * Examples: "Position | A | B Ⓜ | C"   "Flatness"   "Perpendicularity | A"
 */
function buildSu2(gdtData) {
  var ref = GDT_REFERENCE[gdtData.characteristic];
  // Use first word of name only — e.g. "Position" not "Position (True Position)"
  var name = ref ? ref.name.split(' ')[0] : gdtData.characteristic;

  if (!gdtData.datums || gdtData.datums.length === 0) return name;

  var datumParts = gdtData.datums.map(function(d) {
    return d.materialCondition
      ? d.letter + ' ' + GDT_SYMBOLS[d.materialCondition]
      : d.letter;
  });

  return name + ' | ' + datumParts.join(' | ');
}

/**
 * Build Nominal — full feature control frame as a pipe-delimited string.
 * This is informational only — ProShop does not parse it mathematically.
 * Example: "| ⊕ | Ø.014 Ⓜ | A | B | C |"
 */
function buildNominalFrame(gdtData) {
  var sym = GDT_SYMBOLS[gdtData.characteristic] || '';
  var tolPart = '';
  if (gdtData.hasDiameter) tolPart += GDT_SYMBOLS.diameter;
  tolPart += gdtData.tolerance;
  if (gdtData.materialCondition) tolPart += ' ' + GDT_SYMBOLS[gdtData.materialCondition];

  var parts = ['', sym, tolPart];
  (gdtData.datums || []).forEach(function(d) {
    parts.push(d.materialCondition
      ? d.letter + ' ' + GDT_SYMBOLS[d.materialCondition]
      : d.letter);
  });
  parts.push('');
  return parts.join(' | ');
}

PSB.buildSu1 = buildSu1;
PSB.buildSu2 = buildSu2;
PSB.buildNominalFrame = buildNominalFrame;
```

-----

### GD&T OCR Pipeline

GD&T feature control frames are visually complex. Tesseract cannot reliably read them.
**Always use the Claude API for GD&T OCR — skip Steps 1 and 2 of the normal pipeline.**

**Detection — when to trigger GD&T mode:**

After the normal OCR pipeline runs (or in parallel for speed):

- PDF.js text layer returns `|` characters, or contains known GD&T Unicode chars → GD&T likely
- Crop image contains box/frame-like structure → GD&T likely
- OCR result has zero numeric content but contains letters A–Z that look like datum refs → GD&T likely

If GD&T is detected, route to `extractGdtFromCrop()` instead of the normal dimension parser.

**Claude API prompt for GD&T extraction:**

```javascript
var GDT_OCR_SYSTEM_PROMPT =
  'You are an engineering drawing OCR assistant specializing in GD&T (Geometric Dimensioning and Tolerancing). ' +
  'Extract the feature control frame from this image. ' +
  'Respond ONLY with a JSON object — no commentary, no markdown, no explanation. ' +
  'JSON shape: { ' +
  '"characteristic": string (one of: position, flatness, straightness, circularity, cylindricity, profileLine, profileSurface, angularity, perpendicularity, parallelism, concentricity, symmetry, circularRunout, totalRunout), ' +
  '"hasDiameter": boolean, ' +
  '"tolerance": string (numeric, unrounded, e.g. "0.014"), ' +
  '"materialCondition": string or null (one of: "mmc", "lmc", "rfs", or null), ' +
  '"datums": array of { "letter": string, "materialCondition": string or null }, ' +
  '"isComposite": boolean, ' +
  '"compositeUpper": same shape or null, ' +
  '"compositeLower": same shape or null ' +
  '}';
```

**`extractGdtFromCrop(base64ImagePng)`** in `ocrEngine.js`:

- Call Claude API with above system prompt
- Parse response as JSON (strip any accidental markdown fences)
- On parse failure: return null, show user the raw text for manual entry
- On success: pass to `PSB.parseGdtResponse(jsonData)` in `gdtParser.js`

-----

### GD&T Education System

Every GD&T row in the table and sidebar gets contextual learning aids.
This is a first-class feature — not an afterthought.

**GD&T characteristics reference data — `GDT_REFERENCE` in `gdtParser.js`:**

```javascript
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
    name: 'Flatness',
    category: 'Form',
    symbol: GDT_SYMBOLS.flatness,
    controls: 'How flat a surface is — the surface must lie between two parallel planes separated by the tolerance value.',
    requires: 'No datum references allowed. Applied to individual surfaces only.',
    common: 'Used on mating surfaces, sealing faces, and any surface requiring controlled flatness.',
    url: 'https://www.gdandtbasics.com/flatness/',
  },
  straightness: {
    name: 'Straightness',
    category: 'Form',
    symbol: GDT_SYMBOLS.straightness,
    controls: 'How straight a line or axis is. Can apply to a surface line element or to a feature axis.',
    requires: 'No datum references. Can use diameter symbol if applied to an axis.',
    common: 'Used on shafts, pins, and cylindrical features where bowing or curvature must be controlled.',
    url: 'https://www.gdandtbasics.com/straightness/',
  },
  circularity: {
    name: 'Circularity (Roundness)',
    category: 'Form',
    symbol: GDT_SYMBOLS.circularity,
    controls: 'How circular a cross-section is at any given point along the feature.',
    requires: 'No datum references. Applied per cross-section, not the full length of a feature.',
    common: 'Used on turned parts, O-ring grooves, bearing bores.',
    url: 'https://www.gdandtbasics.com/circularity/',
  },
  cylindricity: {
    name: 'Cylindricity',
    category: 'Form',
    symbol: GDT_SYMBOLS.cylindricity,
    controls: 'The overall form of a cylinder — combines circularity, straightness, and taper into one control.',
    requires: 'No datum references. Tightest form control for cylindrical features.',
    common: 'Used on precision bores and shafts where the full cylindrical form must be controlled.',
    url: 'https://www.gdandtbasics.com/cylindricity/',
  },
  profileLine: {
    name: 'Profile of a Line',
    category: 'Profile',
    symbol: GDT_SYMBOLS.profileLine,
    controls: 'The shape of a cross-sectional line element of any surface — controls size and form together.',
    requires: 'Datum references optional. Controls a 2D profile at a specific cross-section.',
    common: 'Used on complex contoured surfaces, airfoils, cam profiles.',
    url: 'https://www.gdandtbasics.com/profile-of-a-line/',
  },
  profileSurface: {
    name: 'Profile of a Surface',
    category: 'Profile',
    symbol: GDT_SYMBOLS.profileSurface,
    controls: 'The 3D shape of an entire surface — controls size, form, orientation, and location in one call-out.',
    requires: 'Datum references usually required for location control.',
    common: 'One of the most versatile GD&T controls. Common on complex machined surfaces, castings, and injection molded parts.',
    url: 'https://www.gdandtbasics.com/profile-of-a-surface/',
  },
  angularity: {
    name: 'Angularity',
    category: 'Orientation',
    symbol: GDT_SYMBOLS.angularity,
    controls: 'The orientation of a surface or axis at a specified angle relative to a datum.',
    requires: 'Datum reference required. Does not control the angle value itself — that is on the drawing. Controls how close to that angle the feature must be.',
    common: 'Used on angled surfaces, chamfers, and features at non-90° angles to datums.',
    url: 'https://www.gdandtbasics.com/angularity/',
  },
  perpendicularity: {
    name: 'Perpendicularity',
    category: 'Orientation',
    symbol: GDT_SYMBOLS.perpendicularity,
    controls: 'How close to exactly 90° a surface or axis is relative to a datum.',
    requires: 'Datum reference required.',
    common: 'Very common on holes, slots, and mating faces. Diameter symbol used when controlling an axis.',
    url: 'https://www.gdandtbasics.com/perpendicularity/',
  },
  parallelism: {
    name: 'Parallelism',
    category: 'Orientation',
    symbol: GDT_SYMBOLS.parallelism,
    controls: 'How parallel a surface or axis is to a datum — the feature must lie within two planes parallel to the datum.',
    requires: 'Datum reference required.',
    common: 'Used on parallel mating surfaces, slots, and features that must be parallel to a datum face.',
    url: 'https://www.gdandtbasics.com/parallelism/',
  },
  concentricity: {
    name: 'Concentricity',
    category: 'Location',
    symbol: GDT_SYMBOLS.concentricity,
    controls: 'The location of a feature\'s median points relative to a datum axis. All median points must fall within the cylindrical tolerance zone.',
    requires: 'Datum reference required. Very difficult and expensive to measure — coaxiality or runout are often preferred.',
    common: 'Less common in modern drawings. Often replaced by circular runout or true position.',
    url: 'https://www.gdandtbasics.com/concentricity/',
  },
  symmetry: {
    name: 'Symmetry',
    category: 'Location',
    symbol: GDT_SYMBOLS.symmetry,
    controls: 'The location of median points of a non-cylindrical feature relative to a datum plane.',
    requires: 'Datum reference required. Rarely used — position is usually preferred.',
    common: 'Uncommon. Typically seen on symmetric slots or features where the midplane must be controlled.',
    url: 'https://www.gdandtbasics.com/symmetry/',
  },
  circularRunout: {
    name: 'Circular Runout',
    category: 'Runout',
    symbol: GDT_SYMBOLS.circularRunout,
    controls: 'The variation of a surface at any cross-section when rotated 360° around a datum axis. Measured at individual cross-sections.',
    requires: 'Datum axis required (usually a shaft centerline).',
    common: 'Used on rotating parts — shafts, bearing journals, OD of turned features.',
    url: 'https://www.gdandtbasics.com/circular-runout/',
  },
  totalRunout: {
    name: 'Total Runout',
    category: 'Runout',
    symbol: GDT_SYMBOLS.totalRunout,
    controls: 'The variation of an entire surface simultaneously when rotated 360° around a datum axis. Stricter than circular runout.',
    requires: 'Datum axis required.',
    common: 'Used where the full surface must be controlled, not just individual cross-sections.',
    url: 'https://www.gdandtbasics.com/total-runout/',
  },
};
```

**Tooltip component behavior:**

- Every GD&T row in the table shows a small `ℹ` badge after the DIM Spec cell
- Hovering the badge shows a tooltip panel containing:
  - Symbol (large, CSS text rendering)
  - Category badge (color-coded: Form=blue, Profile=green, Orientation=orange, Runout=purple, Location=red)
  - `controls` text — what this characteristic actually controls
  - `requires` text — datum requirements and modifier notes
  - `common` text — when you'd see this in the shop
  - **"Learn more →"** link to `gdtbasicsUrl` (opens in new tab)
- Tooltip also appears in the sidebar when a GD&T row is selected
- Datum modifier badges (Ⓜ Ⓛ Ⓢ) on hover show: "MMC — Maximum Material Condition: tolerance applies when feature is at its largest material condition. Bonus tolerance available."

**Material condition modifier tooltips:**

```javascript
var MODIFIER_TOOLTIPS = {
  mmc: 'Maximum Material Condition (Ⓜ): The tolerance applies when the feature contains the most material — largest shaft, smallest hole. Bonus tolerance is available as the feature departs from MMC.',
  lmc: 'Least Material Condition (Ⓛ): The tolerance applies when the feature contains the least material — smallest shaft, largest hole.',
  rfs: 'Regardless of Feature Size (Ⓢ): The tolerance applies at any feature size. No bonus tolerance. Default condition when no modifier is shown (ASME Y14.5-2009+).',
};
```

-----

### Datum Reference Tool

A separate tool for highlighting datum symbols on the PDF.
This is a **visual aid only** — nothing exports, nothing goes to ProShop.

**Purpose:**
When a GD&T balloon references datum A, the user can visually locate datum A on the print
by hovering or clicking. The datum circle pulses to draw attention to it.

**Activation:**

- "Datum Mode" toggle button in PDF toolbar (distinct from Balloon Mode)
- While active: cursor changes to a crosshair circle
- User clicks and drags to draw a circle/ellipse around the datum symbol on the print
- A letter picker appears: A | B | C | D | E | … (A–Z)
- User selects the letter — circle is placed and saved

**Data model — `state.datumRefs` (top-level on state, not on rows):**

```javascript
state.datumRefs = [
  {
    id: 'datum_A',
    letter: 'A',
    page: 1,
    // Stored as a bounding circle in PDF coords:
    center: { x: 145.2, y: 302.8 },
    radius: 12.0,
    label: 'A',           // displayed in the circle
    notes: '',            // optional user note
  }
];
```

**Serialization:**
`state.datumRefs` is saved and loaded in `serializeState()` / `deserializeState()` alongside
`auditLog` and `faiRuns`. Add these fields now if not present.

**Rendering:**

- Yellow filled circle, black letter text centered
- Distinct from red balloon circles
- Always rendered on the SVG overlay on the correct page
- Non-interactive when not in Datum Mode (click-through)

**Hover interaction — GD&T ↔ Datum linking:**
When user hovers a GD&T balloon (or its table row):

1. Read `user.gdt.datums[]` for that row — e.g. `[{ letter: 'A' }, { letter: 'B' }]`
1. Find matching entries in `state.datumRefs` where `letter` matches
1. Pulse/highlight those datum circles on the PDF overlay (CSS animation, 2s)
1. This is one-way — hovering a datum circle does NOT highlight GD&T rows
   (too many GD&T rows might reference the same datum)

**Datum edit/delete:**

- Right-click datum circle → context menu: Edit label | Delete
- Deleting a datum ref does not affect any GD&T rows

-----

### File Responsibilities — New and Modified

|File                  |Changes                                                                                                                       |
|----------------------|------------------------------------------------------------------------------------------------------------------------------|
|`js/gdtParser.js`     |New. GDT_SYMBOLS, GDT_REFERENCE, buildProShopGdtSpec(), parseGdtResponse(), getGdtTooltipHtml()                               |
|`js/ocrEngine.js`     |Add extractGdtFromCrop(). Add GD&T detection heuristic. Always use Claude API for GD&T.                                       |
|`js/balloonManager.js`|Add datum reference tool (Datum Mode toggle, circle draw, datum rendering). Add GD&T ↔ datum hover linking.                   |
|`js/ui.js`            |Add ℹ badge on GD&T table rows. Add tooltip component. Add category color badges.                                             |
|`js/dataModel.js`     |Add `state.datumRefs = []` to default state.                                                                                  |
|`js/storage.js`       |Serialize/deserialize `state.datumRefs`.                                                                                      |
|`css/styles.css`      |Add .gdt-symbol, .gdt-modifier, .gdt-frame with font-variant-emoji: text. Add category color classes. Add datum circle styles.|

-----

### GD&T — Pitfalls (Do Not Repeat)

- **NEVER use Tesseract for GD&T** — always Claude API. GD&T symbols are not in Tesseract's character set.
- **ALWAYS append VS15 (`︎`) to Ⓜ, Ⓛ, Ⓢ, Ⓟ, Ⓕ, Ⓣ** — without it, browsers may render them as colored emoji
- **CSS `font-variant-emoji: text`** must be on any element that displays these characters
- Do NOT apply math pipeline (centering, plating, unit conversion) to GD&T rows — `user.isNote = true` bypasses all of this
- GD&T tolerance value is stored as-is from the drawing — do NOT interpret it as a bilateral tolerance
- Datum letters in `user.gdt.datums` are case-sensitive — always uppercase A–Z
- `state.datumRefs` is independent of `state.rows` — do not couple them
- The datum reference tool is a visual helper — **nothing from datum refs ever exports**
- Composite tolerances (two stacked frames) are flagged with `isComposite: true` — placeholder for now, do not try to fully parse them yet
- Do NOT confuse the Ø diameter modifier symbol with the Ø spec unit 1 — they are the same Unicode char but different semantic meaning depending on context

