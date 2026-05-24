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
- **Local-first**: NO backend. Runs entirely from `index.html` in a browser. The **single permitted** outbound network call is the Claude OCR fallback in `js/ocrEngine.js`, which sends only a small cropped image — never the PDF, filename, part number, or any project data. See the Ballooning Feature section for the boundary.
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

-----

# Ballooning Feature

## Claude Code Implementation Prompt — v2

-----

## CRITICAL RULES — READ FIRST

- **Do NOT touch** CSV import logic, existing table rendering, sidebar editor, ProShop export, or math engine
- **Do NOT touch** `history.js`, `dataModel.js`, `exportEngine.js`, `parser.js`, or `mathEngine.js` — EXCEPT for the specific, named additions described below
- **Additive only** — if no PDF is loaded and ballooning is never used, the app behaves identically to today
- **Security** — only a small cropped canvas region may be sent to an external API. The full PDF, its path, and its filename must never leave the browser
- **Pin all CDN versions explicitly** — never use `@latest`
- When in doubt, ask. Do not guess at existing behavior.

-----

## EXISTING ARCHITECTURE — What you're building on

### File structure (existing)

```
js/
  app.js          — main orchestrator
  dataModel.js    — single source of truth, row schema, recompute()
  exportEngine.js — CSV/ProShop export
  history.js      — undo/redo stack + audit log
  mathEngine.js   — unit conversion, plating, tolerance math
  parser.js       — CSV and dimension text parsing
  pdfViewer.js    — PDF.js wrapper (Phase 1 complete)
  storage.js      — autosave + project file load/save
  ui.js           — table, sidebar, toolbar rendering
```

### New files to create (do not scatter logic elsewhere)

```
js/
  balloonManager.js  — balloon state, rendering, drag, insert, renumber
  ocrEngine.js       — text extraction pipeline (PDF.js → Tesseract → Claude)
  circleDetector.js  — Phase 2.5 Hough circle detection
  pdfExport.js       — Phase 4 ballooned PDF export via pdf-lib
```

### History system (history.js — do not modify the file, just use its API)

```javascript
// BEFORE any mutation:
PSB.pushUndo(state, 'Add balloon #5');

// To undo:
var snapshot = PSB.undo(state);
if (snapshot) restoreState(snapshot);

// Audit log:
PSB.logChange(state.auditLog, {
  type: 'edit',         // 'edit' | 'add' | 'delete' | 'global'
  rowId: row.id,
  description: 'Moved balloon #5',
  details: [{ field: 'balloon.balloonOffset', from: oldOffset, to: newOffset }]
});
```

`cloneStateForSnapshot` already does `JSON.parse(JSON.stringify(row.user))` —
**balloon data stored in `user.balloon` gets undo/redo for free with no changes to history.js.**

-----

## ARCHITECTURE DECISION — Two Row Creation Paths

The app has two ways rows enter the system. Both must coexist permanently.

### Path A — CSV Import (existing, do not change)

- `raw` is **frozen** via `Object.freeze()`
- `raw.dimTag` is immutable
- `user.balloon` is absent (null / undefined)
- `computed.dimTag` reads from `raw.dimTag`
- This path is untouched

### Path B — Balloon Creation (new)

- `raw` is **NOT frozen** — it is a plain mutable object
- `raw._source = 'balloon'` marks it as balloon-created
- `raw.dimTag` is set at creation time but is NOT the live source of truth
- `user.balloon.dimTag` is the **live dimTag** — used for display, export, and renumbering
- `computed.dimTag` checks `user.balloon && user.balloon.dimTag != null` first, falls back to `raw.dimTag`

### Add to dataModel.js — `createBalloonRow()`

Add this function. Do not modify `createRow()`.

```javascript
/**
 * Create a new row from balloon OCR data (not CSV import).
 * raw is NOT frozen. user.balloon.dimTag is the live dimTag source of truth.
 */
function createBalloonRow(dimTag, parsedData, balloonData) {
  var row = {
    id: _nextId++,
    raw: {                          // mutable — not frozen
      _source: 'balloon',
      dimTag: String(dimTag),
      drawingSpec: parsedData.drawingSpec || '',
      nominal: parsedData.nominal || parsedData.drawingSpec || '',
      tolerance: parsedData.tolerance || '',
      specUnit1: parsedData.specUnit1 || '',
      specUnit2: parsedData.specUnit2 || '',
      specUnit3: parsedData.specUnit3 || '',
      toleranceText: parsedData.tolerance || '',
      nominalText: parsedData.nominal || parsedData.drawingSpec || '',
      refLoc: '',
      charDsg: '',
    },
    user: PSB.defaultUserState(),
    computed: {},
  };

  // Attach balloon spatial data
  row.user.balloon = {
    dimTag: dimTag,                 // live number — renumbering updates this only
    page: balloonData.page,
    anchorBox: balloonData.anchorBox,       // { x, y, w, h } in PDF coords
    balloonOffset: balloonData.balloonOffset, // { dx, dy } from anchor center, PDF coords
    leaderConnectionPoint: balloonData.leaderConnectionPoint, // { side: 'left'|'right'|'top'|'bottom', t: 0.0–1.0 }
    dragDirection: balloonData.dragDirection, // 'ltr' | 'rtl' (left-to-right or right-to-left draw)
    source: balloonData.source || 'manual', // 'manual' | 'detected'
    ocrConfidence: balloonData.ocrConfidence || null,
    ocrEngine: balloonData.ocrEngine || null, // 'pdfjs' | 'tesseract' | 'claude'
  };

  // Auto-detect notes/GD&T (same logic as createRow)
  var featureType = PSB.detectFeatureType(parsedData.drawingSpec || '');
  if (featureType === 'note' || featureType === 'gdt' || featureType === 'thread') {
    row.user.isNote = true;
  }

  return row;
}
```

### Modify recompute() in dataModel.js — dimTag source of truth

Find the line in `recompute()` that sets `computed.dimTag` and replace with:

```javascript
// Balloon-created rows use user.balloon.dimTag as live source of truth
var dimTag = (row.user.balloon && row.user.balloon.dimTag != null)
  ? String(row.user.balloon.dimTag)
  : (raw.dimTag || '');
```

Apply this change everywhere `raw.dimTag` is used to populate `computed.dimTag`. Do not change any other dimTag logic.

-----

## JSON SCHEMA — Project File Extension

The existing project `.json` schema has `version`, `globals`, `rows`, and `auditLog`.

### globals — add two fields

```json
"globals": {
  "pdfRevision": null,
  "pdfRevisionsHistory": []
}
```

- `pdfRevision` — string, e.g. `"Rev B"`, set when PDF is linked or updated
- `pdfRevisionsHistory` — array of `{ rev, linkedAt }` for record keeping

### rows — `user.balloon` shape

Balloon data lives on each row in `user.balloon`. Rows without balloons have `user.balloon = null`.

```json
"user": {
  "balloon": {
    "dimTag": 5,
    "page": 1,
    "anchorBox": { "x": 120.5, "y": 340.2, "w": 60.0, "h": 22.0 },
    "balloonOffset": { "dx": -45, "dy": 0 },
    "leaderConnectionPoint": { "side": "left", "t": 0.5 },
    "dragDirection": "ltr",
    "source": "manual",
    "ocrConfidence": 0.92,
    "ocrEngine": "pdfjs",
    "misalignedRev": null
  }
}
```

- `misalignedRev` — set to the old rev string when a new PDF rev is loaded, null otherwise

### No separate top-level `balloons` array — balloon data is on the row.

### Migration — on project load

```javascript
// If loading an older project file that has a top-level balloons array:
if (projectData.balloons && Array.isArray(projectData.balloons)) {
  // Migrate: match by dimTagId, attach to the correct row's user.balloon
  // Then delete projectData.balloons
  // This is a one-way migration — once saved in new format, old key is gone
}

// If any row is missing user.balloon, set it to null (not undefined)
rows.forEach(function(row) {
  if (!row.user.hasOwnProperty('balloon')) row.user.balloon = null;
});
```

-----

## API KEY — config.js approach

Create a file `config.js` in the project root (same folder as `index.html`).

**config.js** (this file lives on Google Drive, never committed to git):

```javascript
window.PSB_CONFIG = {
  anthropicApiKey: 'sk-ant-...'
};
```

**index.html** — add this script tag BEFORE all other scripts:

```html
<script src="config.js" onerror="window.PSB_CONFIG = { anthropicApiKey: null };"></script>
```

The `onerror` handler means the app degrades gracefully if config.js is absent — Claude OCR fallback simply won't be available.

**Add to `.gitignore`:**

```
config.js
```

**In ocrEngine.js**, read the key:

```javascript
function getApiKey() {
  return (window.PSB_CONFIG && window.PSB_CONFIG.anthropicApiKey) || null;
}
```

If `getApiKey()` returns null, skip the Claude fallback silently and surface: *"Claude OCR unavailable — add API key to config.js to enable."*

A tracked `config.example.js` template lives alongside `config.js` so new clones know the shape — copy it to `config.js` and fill in the real key.

-----

## PHASE 2 — Manual Ballooning

### 2A — Balloon Mode Toggle

- Add **"Balloon Mode"** toggle button to the PDF viewer toolbar
- **Active state**: crosshair cursor on PDF canvas, pan/zoom disabled, status bar shows *"● Balloon Mode — drag to draw a box around a dimension"*
- **Inactive state**: normal pan/zoom resumes
- Mode state is NOT saved to project — always starts off on load
- Keyboard shortcut: `B` toggles balloon mode

**In balloon mode, show insert "+" buttons in the table:**

- A small `+` icon appears in the left gutter between every pair of rows
- Also one above row 1 and below the last row
- Clicking a `+` enters "targeted insert" — the next balloon drawn inserts AT that position
- Show a highlight on the target gap while waiting for the user to draw
- `Escape` cancels the targeted insert and returns to normal balloon mode

### 2B — Draw Selection Box

- User clicks and drags on PDF canvas to define the anchor box
- Show a **dashed yellow rectangle** live as they drag
- On mouse-up: capture box in PDF coordinate space (convert from screen using current zoom/pan)
- **Drag direction detection**:
  - Left-to-right (start.x < end.x): default balloon position = LEFT side, vertically centered
    → `balloonOffset = { dx: -(anchorBox.w / 2 + 30), dy: 0 }`
    → `leaderConnectionPoint = { side: 'left', t: 0.5 }`
  - Right-to-left (start.x > end.x): default balloon position = RIGHT side, vertically centered
    → `balloonOffset = { dx: (anchorBox.w / 2 + 30), dy: 0 }`
    → `leaderConnectionPoint = { side: 'right', t: 0.5 }`
- Minimum box size: 10×5px screen pixels — smaller selections are ignored (show brief flash indicating too small)
- After mouse-up: immediately show a spinner inside the drawn box while OCR runs

### 2C — Text Extraction (ordered pipeline — stop at first usable result)

All coordinates and text extraction happen locally. Only the image crop may go to an API.

**Step 1 — PDF.js text layer (fully local)**

```javascript
page.getTextContent().then(function(content) {
  // Filter items whose transform position intersects the anchor box (with 5pt margin)
  // Concatenate matched items in reading order (sort by y desc, then x asc)
  // If result has at least one digit: use it, set engine = 'pdfjs'
});
```

**Step 2 — Tesseract.js (local WASM, no data leaves browser)**

- Render anchor box region to an offscreen canvas at 2x scale
- Apply mild contrast enhancement before OCR (helps with light prints)
- Initialize Tesseract worker ONCE on first use, reuse for all subsequent calls:

  ```javascript
  // In ocrEngine.js module scope:
  var _tesseractWorker = null;
  async function getTesseractWorker() {
    if (!_tesseractWorker) {
      _tesseractWorker = await Tesseract.createWorker('eng');
    }
    return _tesseractWorker;
  }
  ```
- CDN: `https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js`
- If confidence > 55% and result has at least one digit: use it, set engine = 'tesseract'

**Step 3 — Claude API vision fallback**

- Only reached if Steps 1 and 2 both fail or produce no digits
- Convert offscreen canvas crop to base64 PNG
- Send ONLY the base64 image — no PDF bytes, no filename, no part number, no metadata
- Show status: *"☁ Sending crop to Claude OCR…"*

```javascript
const OCR_FALLBACK_MODEL = 'claude-sonnet-4-6';

async function callClaudeOcr(base64ImagePng) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: OCR_FALLBACK_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64ImagePng }
          },
          {
            type: 'text',
            text: 'This is a crop from an engineering drawing. Extract all dimension text exactly as written. Include the nominal value, tolerance (if shown), and any modifiers like Thru, REF, °, ±, GD&T symbols. Return only the raw extracted text, nothing else.'
          }
        ]
      }]
    })
  });

  const data = await response.json();
  const text = data.content && data.content[0] && data.content[0].text;
  return text || null;
}
```

**On complete failure of all 3 steps:**

- Show the confirmation popover (2D) with empty fields and a message: *"OCR could not read this area — enter values manually"*
- Do NOT block the user — the popover is fully editable

### 2D — Parse Extracted Text

Pass the raw OCR string through the existing `parser.js` if it already handles tolerance parsing.
If not, implement parsing in `ocrEngine.js`:

|Target field |Pattern to detect                                                                                 |
|-------------|--------------------------------------------------------------------------------------------------|
|`drawingSpec`|Primary numeric value: `.187`, `0.750`, `1.250`, `45`                                             |
|`nominal`    |Same as drawingSpec unless overridden                                                             |
|`tolerance`  |`±0.002` → `"0.002"` symmetric; `+0.001/-0.000` → `"+0.001-0"` asymmetric                         |
|`specUnit2`  |`Thru`, `°`, `REF`, `MAX`, `MIN`, `TYP`, `PL`, `PLACES`                                           |
|`specUnit1`  |`Ø`, `R`, `SR`                                                                                    |
|`isNote`     |True if no numeric value found                                                                    |
|GD&T         |If GD&T symbols detected: store full raw text as `drawingSpec`, set `isGDT: true` in parsed result|

**Tolerance normalization:**

- `±0.002` → store as `"0.002"` (symmetric — let mathEngine handle it)
- `+0.001/−0.000` or `+.001−0` → store as `"+0.001-0"`
- No tolerance found → leave blank

**Confidence scoring:**

- Assign a confidence level: `'high'` | `'medium'` | `'low'`
  - high: numeric value found cleanly, tolerance pattern recognized
  - medium: numeric found but tolerance ambiguous or missing
  - low: non-numeric or GD&T only
- Store on `user.balloon.ocrConfidence`

### 2E — Confirmation Popover

Show a small popover anchored near the drawn box:

- Displays parsed fields: Drawing Spec, Tolerance, Spec Unit 2
- Fields are **directly editable** in the popover
- Low-confidence results show a yellow ⚠ badge: *"Low confidence — please verify"*
- **Keyboard-first**: `Enter` = confirm, `Escape` = cancel
- No mouse-click required to confirm if values look right
- "Cancel" discards everything — box, balloon, row — nothing is created

### 2F — Create the Row and Assign DimTag

On confirm:

**Determine the dimTag:**

- If user clicked a `+` insert button between rows N and N+1:
  - New dimTag = N + 1
  - **Renumber all rows where `user.balloon.dimTag >= newDimTag`**: increment each by 1
  - Reorder the `state.rows` array to match new dimTag order
  - Push undo BEFORE renumbering: `PSB.pushUndo(state, 'Insert balloon #' + newDimTag)`
  - Log renumber to audit log
- If no targeted insert (appending):
  - New dimTag = max existing dimTag + 1

**Create the row:**

```javascript
var newRow = PSB.createBalloonRow(newDimTag, parsedData, balloonData);
PSB.recompute(newRow, state.globals);
// Insert at correct position in state.rows
// Trigger table re-render
```

### 2G — Render Balloon Overlay

Use an **SVG element** positioned absolutely over the PDF canvas, same dimensions, updated on every zoom/pan/resize via `ResizeObserver`.

**Three coordinate systems — keep strictly separated with named functions:**

```javascript
// PDF coords → screen coords (for rendering)
function pdfToScreen(pdfX, pdfY, viewport) {
  // viewport is the PDF.js viewport object for current zoom
  var pt = viewport.convertToViewportPoint(pdfX, pdfY);
  return { x: pt[0], y: pt[1] };
}

// Screen coords → PDF coords (for saving from user interaction)
function screenToPdf(screenX, screenY, viewport) {
  var pt = viewport.convertToPdfPoint(screenX, screenY);
  return { x: pt[0], y: pt[1] };
}

// pdf-lib coords (Y flipped) — for export only, in pdfExport.js
function toPdfLibCoords(pdfJsX, pdfJsY, pageHeight) {
  return { x: pdfJsX, y: pageHeight - pdfJsY };
}
```

**Balloon appearance:**

- Filled red circle, white bold number, diameter scales with zoom (base 22px at 100%)
- SVG circle + text element, grouped in a `<g data-balloon-id="rowId">`
- Do not use HTML elements — SVG only for the overlay

**Leader line:**

- Thin red line from `leaderConnectionPoint` on the anchor box to the balloon circle edge
- Suppress leader line if balloon center is within 5px (screen) of the anchor box edge
- Leader line updates live during drag

**Anchor box:**

- Show a thin dashed red rectangle at anchor box position while balloon mode is active
- Hide anchor box rectangle when not in balloon mode (clean view for non-editing)

**Hover / selection sync:**

- Hovering a table row → balloon circle pulses (CSS animation, brief ring)
- Clicking a balloon → scrolls table to and highlights the corresponding row
- This is a two-way sync; implement with row `id` as the link (not dimTag)

### 2H — Dragging

Two drag targets, only active when NOT in balloon mode:

**1. Drag the balloon circle:**

- Updates `user.balloon.balloonOffset` (in PDF coords)
- Leader line redraws live
- On drop: `PSB.pushUndo()` → update offset → `PSB.logChange()`

**2. Drag the leader line connection point:**

- The connection point slides along the perimeter of the anchor box freely
- Parametric position: `{ side: 'left'|'right'|'top'|'bottom', t: 0.0–1.0 }`
  - t=0.0 is the start corner of that side, t=1.0 is the end corner
- Convert drag position to nearest point on box perimeter to compute side + t
- On drop: update `user.balloon.leaderConnectionPoint`

### 2I — Delete a Balloon

- Right-click balloon → context menu: *"Remove balloon #N"*
- Confirm dialog: *"Delete Dim Tag #N and its table row? This cannot be undone after saving."*
- `PSB.pushUndo(state, 'Delete balloon #' + dimTag)` before deletion
- Remove the row from `state.rows`
- Renumber: all `user.balloon.dimTag` values greater than deleted tag decrement by 1
- Reorder `state.rows` array
- Re-render table and SVG overlay

### 2J — Keyboard Shortcuts

|Key                      |Action                                                         |
|-------------------------|---------------------------------------------------------------|
|`B`                      |Toggle balloon mode                                            |
|`Enter`                  |Confirm popover                                                |
|`Escape`                 |Cancel current action / exit balloon mode                      |
|`Ctrl+Z`                 |Undo (already exists — balloon mutations hook in automatically)|
|`Ctrl+Y` / `Ctrl+Shift+Z`|Redo                                                           |
|`Ctrl+S`                 |Save project (already exists)                                  |
|Arrow keys               |Nudge selected balloon by 1pt in PDF coords                    |

-----

## PHASE 2.5 — Detect Existing Balloons

For prints that already have balloons from Ground Control, customers, or other software.

### Entry Point

- **"Detect Balloons"** button in PDF toolbar
- Processes current page only
- Show progress: *"Scanning page for balloons…"*

### Step 1 — PDF Annotation Layer

```javascript
page.getAnnotations().then(function(annotations) {
  // Look for Circle/Ellipse annotations or Widget annotations with numeric text
  // Also check appearance streams for circle shapes
  // Map annotation rects to PDF coordinate space
});
```

If annotation count ≥ 1: use annotation results and skip Step 2.

### Step 2 — Hough Circle Detection

If no annotations found:

- Render page to offscreen canvas at 2x
- Run a **self-contained Hough circle transform** — implement this directly in `circleDetector.js`, do NOT use OpenCV.js (too large)
- Target radius range: 8–28px at 100% zoom equivalent
- For each candidate circle:
  - Crop a small region centered on detected center
  - Run Tesseract on crop with `tessedit_char_whitelist = '0123456789'`
  - Accept only if result is a single integer 1–999
  - Reject if duplicate center within 8px

### Step 3 — Match Dimensions to Balloons

For each confirmed balloon position + number:

- Search PDF.js text layer within 80pt radius of balloon center
- Exclude text geometrically inside the circle
- Collect remaining text items → run through dimension parser (same as Phase 2D)
- If no text found in PDF.js layer: run Tesseract on a larger crop around the balloon

### Step 4 — Build Detected Rows

- Use detected balloon number directly as `user.balloon.dimTag`
- `user.balloon.source = 'detected'`
- If a row with that dimTag already exists: skip with a warning in the results summary
- Detected balloons render with **outlined red circle (stroke only, no fill)** to distinguish from manual

### Step 5 — Review UI

After detection completes:

- Show summary: *"Found 12 balloons. 10 matched dimension text. 2 need review."*
- Unmatched balloons are flagged in the table with a ⚠ badge
- User clicks any row to review and edit parsed values in the sidebar
- A **"Confirm All"** button commits all detected rows in one action

-----

## PHASE 3 — Automatic Ballooning (lower priority, build last)

### Overview

Fully automatic: finds all dimensions, creates rows, places balloons without user drawing.
Only implement after Phases 2 and 2.5 are complete and stable.

### Process

1. Extract all text items from `page.getTextContent()`
1. Group spatially close items into dimension clusters (within 12pt vertical, 70pt horizontal)
1. Run each cluster through the dimension parser
1. Filter out non-dimension clusters (title block, material callouts, notes sections)
- Heuristic: clusters near the bottom 20% of page (title block) are skipped by default
1. Assign dimTags in reading order: left-to-right, top-to-bottom
1. Auto-place balloons with collision avoidance:
- Default: above each cluster, vertically offset by 30pt
- Collision push-apart: if any two balloons overlap, push apart along connecting axis, repeat max 20 iterations
1. Show all auto-detected dimensions highlighted — user reviews, unchecks false positives
1. **"Commit All"** button creates all confirmed rows

### Scanned PDF fallback (no text layer)

- Detect if text layer is empty: `content.items.length === 0`
- If scanned: show message *"This appears to be a scanned drawing. Automatic mode works best with digital PDFs. Try Manual Mode instead."*
- Do NOT send full page image to Claude API for auto mode — security boundary

-----

## PHASE 4 — Export Ballooned PDF

### Library

```html
<script src="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
```

### Entry Point

- **"Export PDF ↓"** button in PDF toolbar
- Active only when PDF is loaded and at least one balloon exists
- Exports all pages; balloons appear only on pages where they were placed

### Process

```javascript
async function exportBalloonedPdf(state, pdfArrayBuffer) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  // Load from the ArrayBuffer already in memory — do not re-fetch
  const pdfDoc = await PDFDocument.load(pdfArrayBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = pdfDoc.getPages();

  // Group balloons by page
  const balloonsByPage = groupBalloonsByPage(state.rows);

  for (const [pageIndex, balloons] of Object.entries(balloonsByPage)) {
    const page = pages[parseInt(pageIndex) - 1];
    const { width, height } = page.getSize();

    for (const balloon of balloons) {
      // Convert PDF.js coords to pdf-lib coords (Y flip)
      const anchorCenter = {
        x: balloon.anchorBox.x + balloon.anchorBox.w / 2,
        y: balloon.anchorBox.y + balloon.anchorBox.h / 2,
      };
      const balloonCenter = toPdfLibCoords(
        anchorCenter.x + balloon.balloonOffset.dx,
        anchorCenter.y + balloon.balloonOffset.dy,
        height
      );

      // Leader line connection point
      const connPt = getConnectionPointCoords(balloon, height); // converts to pdf-lib coords

      // Draw leader line if distance warrants it
      const dist = Math.hypot(balloonCenter.x - connPt.x, balloonCenter.y - connPt.y);
      if (dist > 15) {
        page.drawLine({
          start: connPt,
          end: { x: balloonCenter.x, y: balloonCenter.y },
          thickness: 0.5,
          color: rgb(1, 0, 0),
        });
      }

      // Balloon radius: proportional to page width
      const radius = width * 0.013;

      // Draw circle
      page.drawEllipse({
        x: balloonCenter.x,
        y: balloonCenter.y,
        xScale: radius,
        yScale: radius,
        color: rgb(1, 0, 0),
      });

      // Draw number
      const label = String(balloon.dimTag);
      const fontSize = radius * 1.1;
      const textWidth = font.widthOfTextAtSize(label, fontSize);
      page.drawText(label, {
        x: balloonCenter.x - textWidth / 2,
        y: balloonCenter.y - fontSize / 3,
        size: fontSize,
        font: font,
        color: rgb(1, 1, 1),
      });
    }
  }

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  // Trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = deriveExportFilename(state.globals.pdfFileName);
  a.click();

  // Clean up
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
```

**Export filename:** `originalname-ballooned.pdf`
If `pdfFileName` is `"1500AS252-1_Rev_B.pdf"` → export as `"1500AS252-1_Rev_B-ballooned.pdf"`

### Coordinate conversion — mandatory named function

```javascript
// Use this function for EVERY coordinate drawn in pdfExport.js
// Never convert inline
function toPdfLibCoords(pdfJsX, pdfJsY, pageHeight) {
  return { x: pdfJsX, y: pageHeight - pdfJsY };
}
```

### Post-export verification checklist (implement as console warnings, not assertions)

```javascript
// Warn if any balloon is outside page bounds
// Warn if any balloon number doesn't match state.rows dimTag
// Warn if page count in export doesn't match source
```

-----

## REV UPDATE WORKFLOW

When the user loads a new revision of the same print:

1. Show a dialog: *"Loading a new PDF revision. Existing balloon positions may not align with the new print. Balloons will remain visible and editable. Continue?"*
1. On confirm:
- Update `globals.pdfFileName` and `globals.pdfRevision`
- Append to `globals.pdfRevisionsHistory`
- Set `user.balloon.misalignedRev = previousRev` on ALL rows that have `user.balloon != null`
1. **Visual indicator for misaligned balloons**: add a small orange dot or `△` badge on the balloon SVG element
1. The balloon position, dimTag, and all row data are preserved — nothing is deleted
1. User manually verifies each balloon, drags to correct position if needed, then clears the misaligned flag by right-clicking the balloon → *"Mark as verified for new rev"*

-----

## AUTOSAVE INTEGRATION

Balloon data lives in `row.user.balloon`, which is part of `state.rows`. The existing autosave in `storage.js` already serializes the full state — **balloon data is included automatically with no changes to storage.js.**

Verify this is the case before declaring implementation complete. If `storage.js` serializes rows by only copying specific user fields, update it to use a full `JSON.parse(JSON.stringify(row.user))` copy.

-----

## IMPLEMENTATION NOTES

### SVG overlay lifecycle

```javascript
// On PDF page render / zoom / pan:
function updateOverlayTransform(viewport) {
  svgOverlay.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
  svgOverlay.style.width = viewport.width + 'px';
  svgOverlay.style.height = viewport.height + 'px';
  // Re-render all balloon elements at new screen positions
  renderAllBalloons(state.rows, viewport);
}

// ResizeObserver on the PDF canvas container
const ro = new ResizeObserver(() => updateOverlayTransform(currentViewport));
ro.observe(pdfContainer);
```

### Tesseract worker teardown

Terminate the Tesseract worker when the page unloads:

```javascript
window.addEventListener('beforeunload', function() {
  if (_tesseractWorker) _tesseractWorker.terminate();
});
```

### Error handling — wrap all async balloon operations

```javascript
async function safeBalloonOperation(fn, context) {
  try {
    return await fn();
  } catch (err) {
    console.error('[Balloon]', context, err);
    showUserError('Balloon operation failed: ' + context + '. Your data was not changed.');
    return null;
  }
}
```

Every OCR call, every circle detection, every PDF export goes through `safeBalloonOperation`.

### Table row order

- When `state.rows` contains balloon-created rows, sort the render order by effective dimTag:

  ```javascript
  function effectiveDimTag(row) {
    return row.user.balloon ? row.user.balloon.dimTag : parseInt(row.raw.dimTag) || 0;
  }
  state.rows.sort((a, b) => effectiveDimTag(a) - effectiveDimTag(b));
  ```
- Do this sort in `balloonManager.js` after any insert/delete/renumber — not inside `dataModel.js`

### What NOT to do

- Do not re-initialize Tesseract on every crop — reuse the worker
- Do not send the full PDF to any API — only cropped canvas images
- Do not use `@latest` for any CDN dependency
- Do not put balloon rendering logic in `ui.js` — keep it in `balloonManager.js`
- Do not store balloon positions in screen pixels — always PDF coordinate space
- Do not modify `history.js` — only call its exported functions

-----

## CDN VERSIONS — pin these exactly

```html
<script src="https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script src="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
```

PDF.js version: use whatever is already pinned in `pdfViewer.js` — do not change it.

-----

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
