# Working Style

I'm not an experienced developer. When you do something non-trivial, please:

## After completing a task, add a short "What I did & why" section:

- 1–3 bullet points max
- Plain English, no jargon (or explain the jargon inline)
- Focus on the *why*, not just the *what*
- Keep it separate from the work output so it's easy to skip if I just want the result

## Proactively suggest better approaches:

- If there's a built-in tool, library, or Claude feature that would do this better or more simply, mention it
- Flag if what I asked for is a workaround when a cleaner solution exists
- But don't overwhelm — one suggestion at a time

## Keep explanations digestible:

- Short sentences
- Analogies to physical/real-world things when possible
- Don't assume I know what acronyms mean

---

# ProShop Inspection Builder

## READ FIRST
- **`RULES.md`** — what the app outputs and why. Source of truth for math, precision, units, OP2000, tags.
- **Change a rule?** Update `RULES.md` → update/add a test → then code.
- **Run tests:** `node test/run-node.js` (must pass before any commit). Browser: open `test/index.html`.
- **Golden test:** `test/fixtures/gcInchSample.js` — a real GC CSV + hand-checked expected export.

## What This Is
A browser-based, local-first tool that turns inspection data into a ProShop-ready CSV.
- **Two input paths, one pipeline:** Ground Control CSV import, or ballooning on the PDF. Both create the same rows; everything after that is shared. Ballooning is just another way to get the same data GC gives.
- Applies deterministic math (centering, plating, unit conversion, pin/gage) for production OPs.
- Allows controlled user overrides via sidebar.
- Also: PDF viewer, ballooned PDF export, FAI view (CMM results).

## Architecture Rules (DO NOT VIOLATE)
- **Local-first**: NO backend. Runs entirely from `index.html` in a browser. The **single permitted** outbound network call is the Claude OCR fallback in `js/ocrEngine.js`, which sends only a small cropped image — never the PDF, filename, part number, or any project data. See `docs/specs/ballooning.md` for the boundary.
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
test/fixture.test.js    — Golden-file test + one test per RULES.md rule
test/fixtures/          — Real input files (part numbers removed) + expected exports
test/run-node.js        — Command-line test runner (node test/run-node.js)
RULES.md                — Output rules and why (source of truth)
docs/specs/             — Historical feature build specs (FAI, ballooning, GD&T)
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
- Dim Tag gets a prefix - formatted = frequency letter code+"REF-"+ Dim tag #(see RULES.md §9)
- Nom Dim includes plating annotation like `(+2xI)` or `(-2xE)`


## Override keys (implementation detail — rules are in RULES.md)
Override architecture for Spec/Tol:
- `outDrawingSpec` / `outTolPlus` / `outTolMinus` — OP2000 base overrides. These feed into the NUMERIC pipeline (update nominal/tolerance values), so all downstream calculations (centering, plating, OUT values) derive from the corrected base. Editing OP2000 Spec/Tol in the table or sidebar sets these keys.
- `outputSpec` / `outputTolPlus` / `outputTolMinus` — Independent OUT overrides. These bypass the pipeline entirely and set OUT display values directly. When an OP2000 base override is edited, any existing independent OUT override is cleared (with a toast notification).
- Tolerances are stored as separate plus/minus values (not single strings). Double-clicking a tolerance cell shows dual +/- inputs. Asymmetric tolerances auto-switch Pin/Gage to Gage Block mode.
- Other editable fields: SU1, SU2, SU3, Output Nominal, Input Tolerance, Pin Gage.

## Global Settings (stored in app state, shown in header bar)
- Import Units: mm or inch
- Display Units: mm, inch, or both
- Plating Thickness: numeric value
- Plating Units: mm or inch
- Custom OP list: array of op numbers (e.g., [2000, 50, 60])
- Inch Precision / MM Precision: decimals used when a value is unit-converted (defaults 4 / 3). Same-unit output keeps print decimals — see RULES.md §5
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

## Testing
- `node test/run-node.js` — runs every suite in Node (no browser). Exit code 1 on failure.
- `test/index.html` — same suites in a browser.
- `test/fixture.test.js` — golden-file test + one test per rule in `RULES.md`.
- Add a fixture: real export → strip part number/file name → add to `test/fixtures/` → hand-check expected output.

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


## Feature build specs (historical)
Original build instructions. May be out of date — `RULES.md` wins on output rules.
- `docs/specs/fai.md` — FAI view, CMM import, pass/warn/fail
- `docs/specs/ballooning.md` — ballooning, OCR pipeline, balloon PDF export, rev updates
- `docs/specs/gdt.md` — GD&T symbols, feature control frame format, datum tool
