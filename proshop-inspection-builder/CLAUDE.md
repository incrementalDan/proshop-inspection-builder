# ProShop Inspection Builder

## What This Is
A browser-based, local-first engineering tool that:
1. Imports inspection CSV data exported from Ground Control (AS9102C format)
2. Parses and structures dimension data (spec units, tolerances, notes)
3. Applies deterministic math (nominal centering, plating, unit conversion)
4. Allows controlled user overrides via sidebar
5. Exports ProShop-compatible CSV for direct import into ProShop ERP
6. Displays engineering drawing PDFs alongside inspection data (Phase 1 — view only)

## Architecture Rules (DO NOT VIOLATE)
- **Local-first**: NO backend, NO external API calls. Runs entirely from `index.html` in a browser.
- **No build step**: No bundlers, no npm, no frameworks. Vanilla JS, ES5-style (`var`, function declarations), `PSB` namespace on `window`. Exception: pdf.js is loaded as an ES module (`lib/pdf.min.mjs`) via a `<script type="module">` tag, then exposed as `window.pdfjsLib`.
- **Single source of truth**: Every row follows `{ raw, user, computed }` pattern.
  - `raw` = immutable parsed import data
  - `user` = user overrides and settings for this row
  - `computed` = derived output values (what the table/sidebar/export reads)
- **All UI, sidebar, and export read from `computed`** — never duplicate calculations.
- **OP2000 is sacred**: Only Type 1 (parsing) and Type 2 (manual overrides). No math, no unit conversion, no nominal centering. OP2000 values are the base from which other OP values are derived.

## File Structure & Module Responsibilities
```
index.html              — Entry point, loads all modules
css/styles.css          — All styling, dark/light themes, CSS variables
js/app.js               — App initialization, wires modules together, global state
js/dataModel.js         — Row creation, recompute pipeline, state management
js/parser.js            — CSV import, dimension text parsing, feature detection
js/mathEngine.js        — Nominal centering, plating, unit conversion, precision
js/ui.js                — Table rendering, sidebar, inline editing, theme toggle
js/exportEngine.js      — ProShop CSV export generation
js/storage.js           — Save/load full project state as JSON
js/history.js           — Undo/redo snapshot stack, audit log with coalescing
js/pdfViewer.js         — PDF viewer module (canvas-based via pdf.js, Phase 1 view-only)
lib/pdf.min.mjs         — pdf.js library (Mozilla, local copy, ~800KB)
lib/pdf.worker.min.mjs  — pdf.js web worker (local copy, ~800KB)
test/index.html         — Test runner page
test/testData.js        — Sample CSV data as JS constants for testing
test/parser.test.js     — Parser unit tests
test/mathEngine.test.js — Math engine unit tests
data/sample-input.csv   — Real Ground Control export (test fixture)
data/sample-output.csv  — Known-good ProShop import (validation target)
docs/spec.txt           — Full engineering spec
docs/proshop-field-mapping.png — ProShop UI field reference screenshot
js/cmmParser.js
```

## Module APIs (keep these stable)

### dataModel.js
- `createRow(rawData)` → returns `{ id, raw, user, computed }`
- `recompute(row, globals)` → recalculates `row.computed` from `raw` + `user` + `globals`
- `getExportData(row, opNumber, globals)` → returns flat object for CSV row

### parser.js
- `parseCSV(csvString)` → returns array of raw row objects
- `parseDimension(drawingSpec, toleranceText, nominalText)` → returns parsed fields
- `detectFeatureType(drawingSpec)` → returns 'dimension' | 'note' | 'gdt' | 'thread'
- `parseSpecUnits(text)` → returns `{ su1, su2, su3, cleaned }`
- `parseTolerance(text)` → returns `{ tolPlus, tolMinus, isSymmetric }`

### mathEngine.js
- `centerNominal(nominal, tolPlus, tolMinus)` → returns `{ nominal, tolSymmetric }`
- `applyPlating(nominal, platingThickness, mode)` → returns adjusted nominal
- `convertUnits(value, fromUnit, toUnit)` → returns converted value
- `formatPrecision(value, decimalPlaces)` → returns formatted string
- `computePinGage(nominal, tolerance)` → returns `{ go, noGo, formatted }`
- `computeGageBlock(nominal, tolPlus, tolMinus)` → returns `{ low, high, formatted }`
- `detectPrecision(str)` → returns decimal place count (number) or null if non-numeric

### exportEngine.js
- `generateCSV(rows, selectedOps, globals)` → returns CSV string
- `formatExportRow(row, opNumber, globals)` → returns single CSV line

### storage.js
- `saveProject(state)` → saves to localStorage + triggers JSON download
- `loadProject(jsonString)` → returns full app state
- `autoSave(state)` → saves to localStorage only
- `openProjectWithHandle()` → File System Access API picker, stores handle for silent re-saves
- `autoSaveToDisk(state)` → silently writes to stored file handle (no prompt)

### history.js
- `pushUndo(state, description)` → snapshot current state before mutation
- `undo(state, desc)` / `redo(state, desc)` → pop/push between stacks, return snapshot
- `canUndo()` / `canRedo()` → boolean checks
- `getUndoDescriptions()` / `getRedoDescriptions()` → arrays for dropdown menus
- `logChange(auditLog, entry)` → append to audit log with 750ms coalescing
- `getRowHistory(auditLog, rowId)` → entries for a specific row

### pdfViewer.js
- `initPdfViewer()` → bind toolbar, resizer, upload button, keyboard/mouse handlers
- `loadPdfFromFile(file)` → read File as ArrayBuffer, render via pdf.js
- `closePdf()` → clear all state, hide viewer, remove IDB handle
- `tryRestorePdf(expectedFileName)` → restore from IndexedDB handle (validates filename match)
- `restoreOrPromptPdf(fileName, promptIfMissing)` → try IDB, then file picker fallback
- `promptForPdf(suggestedName)` → open file picker (uses startIn for same-folder hint)
- `hasPdf()` / `getPdfFileName()` → state queries

## CSV Column Mapping (ProShop Import Format)
Both input and output use these exact headers:
```
Internal Part #, Op #, Dim Tag #, Ref Loc, Char Dsg, Spec Unit 1,
Drawing Spec, Spec Unit 2, Spec Unit 3, Inspec Equip, Nom Dim,
Tol ±, IPC?, Inspection Frequency, Show Dim When?
```

### Input (Ground Control) example:
```
,,7,S1,,Ø,3.5,,,,3.5,0.1,,,
```
- Dim Tag = 7, Ref Loc = S1, Spec Unit 1 = Ø, Drawing Spec = 3.5
- Nom Dim = 3.5, Tol = 0.1

### Output (ProShop) example:
```
,50,HREF-07,S1,,⌀,.1388,,,GO / NO-GO,.1388 (+2xI),.0039,TRUE,1 in 50,
```
- Op = 50, Dim Tag = HREF-07, Spec Unit 1 = ⌀, Drawing Spec = .1388
- Inspec Equip = GO / NO-GO, Nom Dim = .1388 (+2xI), Tol = .0039
- IPC = TRUE, Frequency = 1 in 50

Key differences in output:
- Op # is populated (user selects which ops)
- Dim Tag gets a prefix - formatted = frequency letter code+"REF-"+ Dim tag #(follow the = Inspection Frequency → Output Tag Naming Logic below)
- Nom Dim includes plating annotation like `(+2xI)` or `(-2xE)`
- Values may be unit-converted (mm→inch or vice versa)
- IPC, Frequency, Equipment are populated from user selections

## Key Business Rules

### Data Transformation Pipeline (Change Types)

There are 4 types of transformations applied from import data to export data. They execute in order, and each builds on the output of the previous.

**Type 1 — Parsing**
Cleans up messy Ground Control import data by placing values in the correct ProShop columns. Tolerance data sometimes ends up in Drawing Spec; spec unit identifiers sometimes appear in the wrong field. Parsing corrects column placement and formatting without altering the underlying data. Implemented by `parseSpecUnits()`, `parseTolerance()`, `detectFeatureType()`.

**Type 2 — Manual Overrides**
User corrections for data that was originally incorrect or misread by Ground Control. Stored in `row.user.overrides`.

Override architecture for Spec/Tol:
- `outDrawingSpec` / `outTolPlus` / `outTolMinus` — OP2000 base overrides. These feed into the NUMERIC pipeline (update nominal/tolerance values), so all downstream calculations (centering, plating, OUT values) derive from the corrected base. Editing OP2000 Spec/Tol in the table or sidebar sets these keys.
- `outputSpec` / `outputTolPlus` / `outputTolMinus` — Independent OUT overrides. These bypass the pipeline entirely and set OUT display values directly. When an OP2000 base override is edited, any existing independent OUT override is cleared (with a toast notification).
- Tolerances are stored as separate plus/minus values (not single strings). Double-clicking a tolerance cell shows dual +/- inputs. Asymmetric tolerances auto-switch Pin/Gage to Gage Block mode.
- Other editable fields: SU1, SU2, SU3, Output Nominal, Input Tolerance, Pin Gage.

**Type 3 — Modifiers**
Sidebar-driven transformations: plating adjustments, unit conversion, inspection frequency tagging, pin/gage computation. Applied after types 1, 2, and 4.

**Type 4 — Auto-Nominal Centering**
Converts asymmetric tolerances to symmetric by shifting the nominal value. Applied before type 3 modifiers so all subsequent math uses centered values.

#### Pipeline execution order

```
Raw CSV → Parse (Type 1) → Override (Type 2) → [OP2000 values]
                                                      ↓
                                          Auto-Nominal (Type 4)
                                                      ↓
                                          Modifiers (Type 3)
                                                      ↓
                                    [Other OP values (derived)]
                                                      ↓
                              Independent OUT override? → [use override]
                                         else          → [use derived]
```

The OP2000 computed values are the **base** from which all other OP values are derived. Types 3 and 4 build on top of the OP2000 values — they are not independent calculations from raw data. This ensures overrides always propagate correctly to every OP.

#### Applicability by OP type

| Change Type | OP2000 | Other OPs |
|---|---|---|
| 1 — Parsing | ✓ | ✓ |
| 2 — Manual Overrides | ✓ | ✓ |
| 3 — Modifiers | ✗ | ✓ |
| 4 — Auto-Nominal | ✗ | ✓ |

#### Implementation in `recompute()`
The pipeline stores intermediate OP2000 values in `computed` (e.g., `computed.op2000Nominal`, `computed.op2000Tolerance`, `computed.op2000DrawingSpec`). These hold type 1+2 results only. The other OP output fields (`outNominal`, `outTolerance`, `outDrawingSpec`) are derived FROM the OP2000 values after applying types 3 and 4. The `getExportData()` function reads OP2000 fields for OP2000 export and the full-pipeline fields for other OPs.

### Parsing Rules
- **Notes**: Rows with GD&T symbols, thread specs, or long text → `isNote = true`, skip all math
- **Diameter**: Normalize `⌀` to `Ø` internally. Always place in Spec Unit 1. Strip from other fields.
- **Spec Unit 1**: Ø, R (radius), base geometry identifiers
- **Spec Unit 2**: THRU, DEEP, TYP, MIN, MAX, Flatness, Position, Perpendicular, Parallel, Basic, etc.
- **Spec Unit 3**: Quantity notation → normalize to `Nx` format (e.g., "2 HOLES" → "2x", "4 PLACES" → "4x")
- **Tolerance**: Support `±0.005`, `+0.005 -0.002`, `+.005-.002` formats
- **Deduplication**: A value should only appear in ONE spec unit field, never repeated across fields

### OP2000 (CRITICAL)
- Receives **only** Type 1 (parsing) and Type 2 (manual overrides)
- NO Type 3 modifiers (no plating, no unit conversion)
- NO Type 4 auto-nominal centering
- Output reflects the corrected print values — parsing fixes column placement, overrides fix misreads
- OP2000 computed values serve as the base for all other OP calculations

### Nominal Centering
- Symmetric: `Ø0.100 ±0.005` → nominal stays 0.100
- Asymmetric: `Ø0.100 +0.010 -0.002` → nominal = 0.100 + (0.010 - 0.002)/2 = 0.104, tol = ±0.006

### Plating (4 modes)
Drawing spec = final post-plating dimension. We compute the pre-plating machining target.
- `+1x Internal`: ADD 1× plating to nominal (1 side — hole shrinks after plating, so machine larger)
- `+2x Internal`: ADD 2× plating to nominal (2 sides, e.g. diameter — hole shrinks, machine larger)
- `-1x External`: SUBTRACT 1× plating from nominal (1 side — part grows after plating, so machine smaller)
- `-2x External`: SUBTRACT 2× plating from nominal (2 sides, e.g. OD — part grows, machine smaller)
- **NEVER apply plating to tolerance — only to nominal**

### Pin / Gage (equipment-dependent)
The Pin/Gage column format depends on the selected Inspection Equipment:
- **GO / NO-GO** → Pin format: `P(Ø{GO}+ | Ø{NOGO}-)` where GO = nominal - tolerance, NO GO = nominal + tolerance
- **Gage Block** → Gage format: `G({low} | {high})` where low = nominal - tolMinus, high = nominal + tolPlus
- When pin/gage is enabled with no equipment selected, auto-set equipment to "GO / NO-GO" (user can override to "Gage Block")

## Global Settings (stored in app state, shown in header bar)
- Import Units: mm or inch
- Display Units: mm, inch, or both
- Plating Thickness: numeric value
- Plating Units: mm or inch
- Custom OP list: array of op numbers (e.g., [2000, 50, 60])
- Inch Precision: number of decimal places (default 4)
- MM Precision: number of decimal places (default 3)
- Equipment List: `["Calipers","Micrometer","Optical C.","CMM","Height Gage","Gage Block","GO / NO-GO","PASS/FAIL","Drop Indicator","N/A"]`
- PDF Filename: stored as `pdfFileName` in globals (just the name, e.g. `"drawing.pdf"`, not a path)

## UI Layout
- **Header bar**: Global settings (always visible), includes PDF upload button
- **Main area**: `#left-panel` (vertical flex) + `#sidebar-resizer` + `#sidebar`
  - **Without PDF**: `#left-panel` contains only `#table-container` (full height)
  - **With PDF loaded**: `#left-panel` splits vertically — `#pdf-viewer` (flex:2, ~2/3) + `#pdf-resizer` (draggable) + `#table-container` (flex:1, ~1/3)
- **PDF viewer**: Canvas-based rendering, toolbar with page nav / zoom / fit / close. Pan via click-drag, Ctrl+wheel zoom, arrow keys for pages.
- **Table**: Sortable/filterable columns, alternating row colors, click to select
- **Sidebar**: Opens on row click. Dim Tag big at top. Output drawing spec + tolerance prominent. All controls below.
- **Row status**: none (untouched) → yellow (edited) → green (user marked complete)
- **Theme**: Dark default, blue (#4a9eff) / orange (#ff8c42) accents

## Testing Strategy
- Parser tests: verify each row of sample-input.csv parses correctly
- Math tests: known input/output pairs for centering, plating, unit conversion
- Integration test: import sample-input.csv → configure → export → compare against sample-output.csv
- Run tests by opening `test/index.html` in browser

## PDF Viewer (Phase 1 — View Only)

### Architecture
- **Completely independent** of CSV/table/export logic. If no PDF is loaded, the app is identical to before.
- Rendered via **pdf.js** (Mozilla's PDF engine, loaded locally from `lib/`). Canvas-based rendering — chosen for Phase 2 ballooning compatibility (annotations will overlay the canvas).
- All PDF data stays in the browser. No uploads, no cloud, no network calls. pdf.js runs entirely client-side.

### PDF File Persistence
The PDF file itself is **never re-saved or copied**. It stays on disk where the user put it. The project JSON stores only the filename string.

Persistence across sessions uses the **File System Access API** (Chromium):
- When the user opens a PDF via the upload button, `showOpenFilePicker` returns a `FileSystemFileHandle`
- That handle is stored in **IndexedDB** (`psb_pdf_store` database, `handles` store, key `currentPdfHandle`)
- On next app load or project load, `tryRestorePdf()` retrieves the handle from IDB, checks permission, reads the file, and renders — no user interaction needed
- If the IDB handle is missing or stale (wrong filename), `promptForPdf()` opens a file picker with `startIn` set to the project file's location so the PDF is right there
- First time per project = user picks the PDF once. Every subsequent load = auto-restores from IDB.

### Security Rules (DO NOT VIOLATE)
- **PDF data NEVER leaves the browser**. No network requests, no cloud uploads, no external services.
- PDF is rendered to `<canvas>` (rasterized pixels). No PDF content is ever inserted as HTML/DOM.
- IndexedDB is origin-scoped. File handles are structured-cloned (not JSON-serializable, can't be exfiltrated).
- No `postMessage`, `BroadcastChannel`, `SharedWorker`, or `ServiceWorker` — each tab is isolated.
- `pdfArrayBuffer` (raw bytes, 1-20MB) lives only in JS heap. Released on close/new load.

### Phase 2+ (Future)
- Phase 2: Manual ballooning annotations (canvas overlay)
- Phase 3: Auto-detection of dimension callouts
- Current implementation is designed to support these — canvas rendering, not `<iframe>`.

### Robustness Patterns
- **Generation counter** (`loadGeneration`): prevents stale FileReader callbacks from clobbering state when user rapidly loads multiple PDFs
- **Render task cancellation**: `closePdf()` and `loadPdfFromArrayBuffer()` cancel in-flight render tasks and call `pdfDoc.destroy()` to release pdf.js worker resources
- **Filename validation**: `tryRestorePdf(expectedFileName)` checks that the IDB handle points to the correct file — prevents wrong PDF from loading after project switch

## Git Workflow
- Commit after each working feature
- Use descriptive commit messages: `feat: add tolerance parsing`, `fix: OP2000 bypass`
- Tag milestones: `v0.1-import`, `v0.2-parsing`, `v0.3-math`, `v0.4-ui`, `v0.5-export`

## Inspection Frequency → Output Tag Naming Logic

### Purpose
This logic controls the prefix letter used in the generated Output Tag for non-OP2000 operations, so ProShop lists characteristics in the intended order based on inspection priority/frequency.
Formatting = frequency letter code+"REF-"+ Dim tag . So for Dim Tag #7 and frequency of 1 in 50 output = HREF-07 . another example Dim Tag #23 and frequency of 1 in 2 output = BREF-23 
OP2000 does not use this naming logic.

### Rule 1: Frequency dropdown values
Supported values:
- blank
- 1 in 1
- 1 in 2
- 1 in 3
- 1 in 4
- 1 in 5
- 1 in 10
- 1 in 20
- 1 in 50
- First and Last

Default should be blank.

### Rule 2: Frequency → Letter mapping
Use this mapping exactly:

| Inspection Frequency | Letter Prefix |
|----------------------|---------------|
| 1 in 1               | A             |
| 1 in 2               | B             |
| 1 in 3               | C             |
| 1 in 4               | D             |
| 1 in 5               | E             |
| 1 in 10              | F             |
| 1 in 20              | G             |
| 1 in 50              | H             |
| First and Last       | I             |
| blank                | no letter     |

This is a fixed one-to-one mapping.
Do not dynamically rank or sort frequencies unless Inspection Frequeny is updated.
Do not infer letters based on which frequencies exist in the current file.

### Rule 3: Output Tag format for non-OP2000 ops
For non-OP2000 operations, generate:
```
<LetterPrefix>REF-<two-digit Dim Tag #>
```

Examples:
- Dim Tag 2, Frequency 1 in 1 → `AREF-02`
- Dim Tag 7, Frequency 1 in 20 → `GREF-07`
- Dim Tag 13, Frequency 1 in 5 → `EREF-13`

If frequency is blank:
- no letter prefix
- format becomes: `REF-<two-digit Dim Tag #>`
- Example: Dim Tag 4, blank frequency → `REF-04`

### Rule 4: Dim Tag formatting
The numeric Dim Tag portion must:
- use the imported Dim Tag number
- be zero-padded to two digits for single-digit numbers

Examples:
- 1 → 01
- 7 → 07
- 12 → 12

If the Dim Tag is non-numeric or unusual, preserve it as-is after `REF-`.

### Rule 5: OP2000 exception
For OP2000 only:
- do not use frequency letters
- do not use `REF-`
- output the raw imported Dim Tag # only

Example: Dim Tag 13 → `13`

This applies only to OP2000 export. The internal row may still store an Output Tag for the production ops.

### Rule 6: Output Tag should auto-generate, but remain overrideable
The app should auto-generate Output Tag from:
- Dim Tag #
- Inspection Frequency

However, if the user manually edits the Output Tag, that manual value should be preserved unless the user explicitly resets/rebuilds it.

If the app detects the tag is still in an auto-generated form, it may safely update it when frequency changes.

Auto-generated patterns include:
- `REF-02`
- `AREF-02`
- `BREF-02`
- … through `IREF-02`

### Rule 7: Purpose of this logic
This naming convention is used so that in ProShop:
- more frequently inspected characteristics sort toward the top
- dimensional groups appear in a predictable order
- the user can visually infer inspection priority from the tag prefix

This is an ordering / readability tool, not a math function.

## Common Pitfalls (from previous attempts)
- Do NOT duplicate calculation logic between UI and export — both read `computed`
- Do NOT apply Type 3 or Type 4 changes to OP2000 — only Type 1 (parsing) and Type 2 (overrides)
- OP2000 computed values are the BASE for other OPs — do not calculate other OP values independently from raw data
- Do NOT lose the original raw data when user edits — raw is immutable
- Do NOT use frameworks or build tools — this must open from index.html directly
- Do NOT put plating adjustment on tolerance — only on nominal
- OP2000 overrides (`outDrawingSpec`/`outTolPlus`/`outTolMinus`) MUST feed into the numeric pipeline — they update the nominal/tolerance values used for centering, plating, and OUT derivation
- OUT overrides (`outputSpec`/`outputTolPlus`/`outputTolMinus`) are INDEPENDENT — they bypass the pipeline. Editing OP2000 clears them.
- Data flow is ONE-WAY: OP2000 → OUT. Editing OUT spec/tol NEVER changes OP2000 values.
- Tolerances are split plus/minus — never store as a single string. The deprecated `outTolerance`/`outputTolerance` keys exist only for v1→v2 migration in `storage.js`.
- The PDF viewer is **completely independent** of CSV/table logic. Do not couple them. If no PDF is loaded, no PDF code runs.
- NEVER re-save or copy the PDF file. It lives on disk; we just hold a read handle.
- NEVER send PDF data over the network or to any external service.
- `.hidden { display: none !important }` blocks CSS transitions — sidebar uses `sidebar-closed` class instead. PDF viewer uses `.hidden` class since it doesn't need transitions.
- `showDirectoryPicker` is confusing UX (files appear grayed out) — use `showOpenFilePicker` for file selection.
- All modules export to `window.PSB` namespace. ES5-style code (var, function declarations, no import/export, no build step).



-----

## FAI View — First Article Inspection

This section documents the First Article Inspection (FAI) feature.
FAI is a **separate view** of the same inspection plan, not a separate app.
The engineer view builds the plan. The FAI view imports CMM measurements and
shows pass/fail status against those specs.

### What FAI Is

- Engineer creates inspection plan (existing app — “Setup View”)
- Quality/engineer imports one or more Zeiss CALYPSO CMM PDF reports
- Measured values are matched to dim tags by the `#N` convention in CMM names
- Each dimension shows: Nominal | Tolerance | Measured | Deviation | Status
- Status is Green / Yellow / Red per measurement
- Multiple CMM runs can be imported — overlapping dims are preserved, not overwritten
- Results are saved into the project file alongside the inspection plan
- Export to ProShop FAI format (placeholder — spec TBD)

### Views

The app has two switchable top-level views. A toggle button switches between them.

|View   |Name in UI|Purpose                                      |
|-------|----------|---------------------------------------------|
|`setup`|Setup View|Engineer builds inspection plan (current app)|
|`fai`  |FAI View  |Import CMM data, review pass/fail, export    |

**Rules:**

- Both views share the same `state.rows` and `state.globals`
- Switching views does NOT reload data — it only changes which columns render and which controls are visible
- View state is NOT saved to project file — always opens in Setup View
- All existing Setup View logic (undo/redo, sidebar, export) is hidden in FAI View but NOT destroyed

-----

### FAI Data Model

FAI data attaches to the existing row and state structure.
Do NOT create a parallel row array. Do NOT modify `raw` or `user.overrides`.

#### Per-row: `row.fai`

Add `fai` as a top-level sibling of `raw`, `user`, `computed` on each row.
Default value: `null` (no measurements yet).

```javascript
row.fai = {
  measurements: [
    {
      runId: 'run_001',           // references state.faiRuns[].id
      cmmName: '#5 HOLE FRONT LEFT',  // original Name field from CMM report
      measured: 0.1878,
      nominal: 0.187,             // from CMM report (cross-check only)
      deviation: 0.0008,
      plusTol: 0.001,
      minusTol: 0.001,
      status: 'warn',             // 'pass' | 'warn' | 'fail'
      isChild: false,             // true if this is a sub-measurement (e.g. 4x holes)
      childIndex: null,           // 0-based index if isChild = true
      equipment: '',              // user can override per measurement
      notes: '',
      attachments: [],            // placeholder — [{type, name, data}] for later
      timestamp: '2026-05-20T14:32:00Z',
    }
  ],
  aggregateStatus: 'warn',        // worst status across all measurements for this row
  isExpanded: false,              // UI state — show/hide child measurements in table
};
```

**Multiple measurements per dim tag:**
When the CMM reports multiple rows with the same DimTag (e.g., `#5 HOLE 1`, `#5 HOLE 2`, `#5 HOLE 3`):

- All become entries in `row.fai.measurements`
- `isChild: true` for all but the first, or for all if they are clearly sub-features
- `childIndex: 0, 1, 2...`
- Parent row in table shows aggregate status
- User can expand the row to see all child measurements
- Placeholder: exact child display and output format TBD — leave `isChild` and `childIndex` in the model now

**Multiple runs, same dim:**
When a second CMM run contains the same DimTag:

- Append to `row.fai.measurements` — do NOT overwrite
- Each measurement retains its `runId` so the user knows which run it came from
- Aggregate status recalculates across all measurements

#### Global: `state.faiRuns`

Add `faiRuns` as a top-level key on `state` alongside `rows`, `globals`, `auditLog`.

```javascript
state.faiRuns = [
  {
    id: 'run_001',                // uuid or timestamp-based unique string
    label: 'OP50 CMM Run',        // user-editable display name, defaults to filename
    fileName: 'FAI_1500AS252_OP50.pdf',
    importedAt: '2026-05-20T14:30:00Z',
    rowCount: 45,                 // total CMM rows parsed
    matchedCount: 38,             // rows that matched a dim tag in the plan
    unmatchedRows: [              // CMM rows that had no dim tag match
      { cmmName: 'REFX Value_.25-28 TOP THREAD', measured: 0.25, ... }
    ],
  }
];
```

**On project save/load:**
`state.faiRuns` is serialized in `serializeState()` alongside `auditLog`.
`row.fai` is serialized in each row’s entry (like `row.user`).
Add to `serializeState()` and `deserializeState()` — do not change other serialization logic.

-----

### Pass / Fail Logic

Implemented in a new function in `mathEngine.js`: `computeFaiStatus(measured, nominal, plusTol, minusTol, warnThreshold)`

```javascript
/**
 * Compute FAI pass/warn/fail status for a single measurement.
 *
 * @param {number} measured
 * @param {number} nominal
 * @param {number} plusTol   — positive number, upper limit
 * @param {number} minusTol  — positive number, lower limit magnitude
 * @param {number} warnThreshold — fraction of tolerance band used before warn (default 0.8)
 * @returns {'pass'|'warn'|'fail'}
 */
function computeFaiStatus(measured, nominal, plusTol, minusTol, warnThreshold) {
  warnThreshold = warnThreshold || 0.8;
  var upperLimit = nominal + plusTol;
  var lowerLimit = nominal - minusTol;

  // Out of tolerance = fail
  if (measured > upperLimit || measured < lowerLimit) return 'fail';

  // Check how much of the tolerance band is consumed
  var deviation = measured - nominal;
  var bandUsed;
  if (deviation >= 0) {
    bandUsed = deviation / plusTol;
  } else {
    bandUsed = Math.abs(deviation) / minusTol;
  }

  if (bandUsed >= warnThreshold) return 'warn';
  return 'pass';
}
```

**Warn threshold:**

- Default: `0.80` (80% of tolerance band consumed = yellow)
- Stored in `state.globals.faiWarnThreshold`
- User-configurable in a FAI settings panel (future — add the field now, build the UI later)
- Add to `defaultGlobals()`: `faiWarnThreshold: 0.80`

**Aggregate status rule:**
`aggregateStatus` = worst status across all measurements for that row.
Priority: `fail` > `warn` > `pass` > `null` (no measurements yet).

**Status colors (CSS classes — add to styles.css):**

- `.fai-pass` — green
- `.fai-warn` — yellow/amber
- `.fai-fail` — red
- `.fai-none` — neutral/gray (no measurement yet)

-----

### CMM Parser — `js/cmmParser.js` (new file)

Port of the proven Google Sheets parser. Same logic, same rules.

**Do NOT use the Google Sheets version directly. Port it to vanilla JS in `cmmParser.js`.**

```javascript
window.PSB = window.PSB || {};

var CMM_SKIP_PATTERNS = [
  /^Name\s+Nominal\s+value\s+Measured\s+value\s+\+Tol\s+-Tol/i,
  /^\+\/-\s*Deviation/i,
  /^ZEISS\s+CALYPSO/i,
  /^\d+(\.\d+)?$/,           // version numbers like "6.8"
  /^Part\s+name/i,
  /^Order\s+number/i,
  /^Part\s+ident/i,
  /^Operator/i,
  /^Time\/Date/i,
  /^Page\s+\d+\s+of\s+\d+/i,
  /^OP\d+\s+Dims/i,
];

// Matches: <Name text> <5 numbers at end of line>
// Numbers can be negative or decimal.
var CMM_ROW_REGEX = /^(.*?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Parse pasted or extracted Zeiss CALYPSO text into structured rows.
 *
 * Column order in pasted text (IMPORTANT — do not swap):
 *   Name | MeasuredValue | NominalValue | +Tol | -Tol | Deviation
 *
 * @param {string} rawText — full pasted CMM report text
 * @returns {Array<Object>} — array of parsed measurement objects
 */
function parseCmmText(rawText) {
  var lines = rawText.split(/\r?\n/).map(function(s) { return (s || '').trim(); }).filter(Boolean);
  var rows = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (shouldSkipCmmLine(line)) continue;

    var m = line.match(CMM_ROW_REGEX);
    if (!m) continue;

    var name = (m[1] || '').trim();

    // DimTag: first digits after first # in name
    var dimMatch = name.match(/#\s*(\d{1,3})/);
    var dimTag = dimMatch ? parseInt(dimMatch[1], 10) : null;

    // Column order: measured is first number, nominal is second
    var measured  = parseFloat(m[2]);
    var nominal   = parseFloat(m[3]);
    var plusTol   = parseFloat(m[4]);
    var minusTol  = Math.abs(parseFloat(m[5])); // stored as positive magnitude
    var deviation = parseFloat(m[6]);

    rows.push({
      dimTag:    dimTag,      // null if no # found
      cmmName:   name,
      measured:  measured,
      nominal:   nominal,
      plusTol:   plusTol,
      minusTol:  minusTol,
      deviation: deviation,
    });
  }

  return rows;
}

function shouldSkipCmmLine(line) {
  for (var i = 0; i < CMM_SKIP_PATTERNS.length; i++) {
    if (CMM_SKIP_PATTERNS[i].test(line)) return true;
  }
  return false;
}

PSB.parseCmmText = parseCmmText;
```

-----

### CMM Import Flow

**Entry point:** “Import CMM Data” button — visible only in FAI View.

Accepts: paste into a textarea OR file picker for a `.txt` or `.pdf` text extraction.
(PDF text extraction: use the same PDF.js text layer approach as the balloon OCR pipeline.)

**Step 1 — Parse:**
Run `PSB.parseCmmText(rawText)` → array of parsed rows.

**Step 2 — Match to plan:**
For each parsed row:

- If `dimTag` is not null: find `state.rows` where `effectiveDimTag(row) === dimTag`
- If match found: this is a **matched row**
- If multiple CMM rows share the same dimTag: all are matched to the same plan row (child measurements)
- If no match: this is an **unmatched row** — still saved to `faiRun.unmatchedRows`

**Step 3 — Detect children:**
Group parsed rows by dimTag. If a dimTag has more than one parsed row:

- First row: `isChild: false`
- Subsequent rows: `isChild: true`, `childIndex: 1, 2, 3...`
- Placeholder: exact grouping heuristic (same name prefix vs. same dimTag) — TBD when real CMM output is provided

**Step 4 — Status computation:**
For each matched measurement, call `PSB.computeFaiStatus()` using:

- `measured` from CMM
- `plusTol` / `minusTol` from the CMM report (NOT from the plan — cross-check only)
- Note: if CMM tol differs significantly from plan tol, flag visually (orange border on the cell)

**Step 5 — Commit:**

- `PSB.pushUndo(state, 'Import CMM run: ' + fileName)`
- Generate `runId` (e.g., `'run_' + Date.now()`)
- Append measurements to `row.fai.measurements` (do NOT clear existing measurements)
- Recalculate `row.fai.aggregateStatus` for all affected rows
- Append new entry to `state.faiRuns`
- `PSB.logChange(auditLog, { type: 'import', rowId: null, description: 'CMM import: ' + fileName })`
- Trigger FAI view re-render

**Step 6 — Import summary modal:**
Show after import:

- Total rows parsed
- Matched: N  |  Unmatched: N
- List of unmatched rows (cmmName + measured value) so user can manually assign if needed
- “Done” closes the modal

-----

### FAI View — Column Configuration

The FAI view renders the same table but with a different column set.
Column visibility is controlled by the active view — NOT by CSS hide/show on individual cells.
The table renderer reads a **view config object** to know which columns to render.

**Setup View columns (existing — do not change):**
Status, DimTag, OutDrawingSpec, OP2000Spec, SU2, SU3, PinGage, OP2000Tol, OutTol, Plating, Ops

**FAI View columns:**
Status (aggregate FAI status badge), DimTag, DrawingSpec, SU1, SU2, Nominal, Tolerance, Measured, Deviation, FAIStatus, Notes, Run

- **Status badge** in FAI view shows `fai.aggregateStatus` (green/yellow/red dot), not the existing `user.status`
- **Measured** — the measured value from CMM (most recent run if multiple, expandable to see all)
- **Deviation** — from CMM report
- **FAIStatus** — colored badge: PASS / WARN / FAIL
- **Notes** — per-measurement notes field, inline editable
- **Run** — which CMM run this measurement came from (label, not runId)

**View config pattern — add to `app.js`:**

```javascript
var VIEW_CONFIGS = {
  setup: {
    id: 'setup',
    label: 'Setup View',
    columns: ['status','dimTag','outDrawingSpec','op2000Spec',
              'su2','su3','pinGage','op2000Tol','outTol','plating','ops'],
    sidebarEnabled: true,
    faiControlsVisible: false,
    setupControlsVisible: true,
  },
  fai: {
    id: 'fai',
    label: 'FAI View',
    columns: ['faiStatus','dimTag','drawingSpec','su1','su2',
              'nominal','tolerance','measured','deviation','notes','run'],
    sidebarEnabled: false,   // sidebar hidden in FAI view
    faiControlsVisible: true,
    setupControlsVisible: false,
  },
};

var currentView = 'setup'; // never persisted
```

**View switch function (in `app.js`):**

```javascript
function switchView(viewId) {
  currentView = viewId;
  PSB.renderTable(state, VIEW_CONFIGS[viewId]);
  PSB.updateToolbarForView(viewId);
  // sidebar: hide if fai, restore if setup
}
```

-----

### FAI View — Table Behavior

**Rows with no measurements:**

- Show dim tag and spec normally
- Status column shows gray dot (no data)
- Measured / Deviation / FAIStatus cells show `—`

**Rows with measurements:**

- Show the most recent measurement by default
- If multiple runs or children exist: show expand arrow on the left of the row
- Clicking expand shows child rows inline (indented, lighter background)

**Child rows:**

- Indented under parent
- Show: cmmName | measured | deviation | status
- Inherit plan columns (nominal, tolerance) from parent
- Each child has its own notes field

**Inline editing in FAI view:**

- Only `notes` and `equipment` fields are editable
- All spec/tolerance fields are read-only in FAI view
- Clicking a read-only cell shows a tooltip: “Edit specs in Setup View”

-----

### FAI Export — ProShop Format

**PLACEHOLDER — spec TBD.**

Add an “Export FAI” button to FAI view toolbar.
When clicked: show a modal with message “FAI export format not yet defined — coming soon.”
Wire up the button and modal now. Implement the actual export when the ProShop FAI format is confirmed.

Reserve these export considerations for when the spec is known:

- Which columns ProShop expects for measured values
- How sub-measurements (children) are represented in the output
- Whether pass/fail status exports as a column or affects row formatting
- Whether unmatched CMM rows are included or excluded

-----

### FAI — Module Responsibilities

|File              |New responsibilities                                                     |
|------------------|-------------------------------------------------------------------------|
|`js/cmmParser.js` |Parse Zeiss CALYPSO text → structured rows. New file.                    |
|`js/mathEngine.js`|Add `computeFaiStatus()` and `computeAggregateStatus()`                  |
|`js/dataModel.js` |Add `defaultFaiState()` returning null. Add `faiRuns` to state shape.    |
|`js/storage.js`   |Serialize/deserialize `row.fai` and `state.faiRuns`                      |
|`js/ui.js`        |Add `renderTable(state, viewConfig)` parameter. Add FAI column renderers.|
|`js/app.js`       |Add `VIEW_CONFIGS`, `currentView`, `switchView()`. Add FAI import flow.  |
|`js/history.js`   |No changes — FAI mutations use existing `pushUndo` / `logChange`         |

-----

### FAI — Pitfalls (Do Not Repeat)

- Do NOT overwrite existing measurements when importing a second CMM run — append only
- Do NOT use CMM nominal/tolerance values to override plan specs — they are for cross-check display only
- Do NOT render FAI columns in Setup View — use the view config, not CSS hide
- Do NOT modify `row.raw` or `row.user.overrides` from FAI import
- Do NOT skip unmatched CMM rows — save them to `faiRun.unmatchedRows` for user review
- `minusTol` from CMM is stored as a **positive magnitude** — the CMM may report it as negative
- Child measurement detection is a placeholder — do not hardcode grouping logic yet, wait for real CMM examples
- FAI view sidebar is hidden, not destroyed — Setup View sidebar state must survive a round-trip through FAI view and back
