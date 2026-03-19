# ProShop Inspection Builder

## What This Is
A browser-based, local-first engineering tool that:
1. Imports inspection CSV data exported from Ground Control (AS9102C format)
2. Parses and structures dimension data (spec units, tolerances, notes)
3. Applies deterministic math (nominal centering, plating, unit conversion)
4. Allows controlled user overrides via sidebar
5. Exports ProShop-compatible CSV for direct import into ProShop ERP

## Architecture Rules (DO NOT VIOLATE)
- **Local-first**: NO backend, NO external API calls. Runs entirely from `index.html` in a browser.
- **No build step**: No bundlers, no npm, no frameworks. Vanilla JS with ES6 modules.
- **Single source of truth**: Every row follows `{ raw, user, computed }` pattern.
  - `raw` = immutable parsed import data
  - `user` = user overrides and settings for this row
  - `computed` = derived output values (what the table/sidebar/export reads)
- **All UI, sidebar, and export read from `computed`** — never duplicate calculations.
- **OP2000 is sacred**: NO math, NO unit conversion, NO nominal centering. Only parsing cleanup.

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
test/index.html         — Test runner page
test/testData.js        — Sample CSV data as JS constants for testing
test/parser.test.js     — Parser unit tests
test/mathEngine.test.js — Math engine unit tests
data/sample-input.csv   — Real Ground Control export (test fixture)
data/sample-output.csv  — Known-good ProShop import (validation target)
docs/spec.txt           — Full engineering spec
docs/proshop-field-mapping.png — ProShop UI field reference screenshot
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

### exportEngine.js
- `generateCSV(rows, selectedOps, globals)` → returns CSV string
- `formatExportRow(row, opNumber, globals)` → returns single CSV line

### storage.js
- `saveProject(state)` → saves to localStorage + triggers JSON download
- `loadProject(jsonString)` → returns full app state
- `autoSave(state)` → saves to localStorage only

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
- Dim Tag gets a prefix (user-configurable per op)
- Nom Dim includes plating annotation like `(+2xI)` or `(-2xE)`
- Values may be unit-converted (mm→inch or vice versa)
- IPC, Frequency, Equipment are populated from user selections

## Key Business Rules

### Parsing
- **Notes**: Rows with GD&T symbols, thread specs, or long text → `isNote = true`, skip all math
- **Diameter**: Normalize `⌀` to `Ø` internally. Always place in Spec Unit 1. Strip from other fields.
- **Spec Unit 1**: Ø, R (radius), base geometry identifiers
- **Spec Unit 2**: THRU, DEEP, TYP, MIN, MAX, Flatness, Position, Perpendicular, Parallel, Basic, etc.
- **Spec Unit 3**: Quantity notation → normalize to `Nx` format (e.g., "2 HOLES" → "2x", "4 PLACES" → "4x")
- **Tolerance**: Support `±0.005`, `+0.005 -0.002`, `+.005-.002` formats
- **Deduplication**: A value should only appear in ONE spec unit field, never repeated across fields

### Math (execution order)
1. Parse raw values
2. Extract numeric nominal + tolerances
3. Nominal centering (if asymmetric tolerance)
4. Plating adjustment (if plating mode set)
5. Unit conversion (if target units differ from import units)
6. Precision formatting

### Nominal Centering
- Symmetric: `Ø0.100 ±0.005` → nominal stays 0.100
- Asymmetric: `Ø0.100 +0.010 -0.002` → nominal = 0.100 + (0.010 - 0.002)/2 = 0.104, tol = ±0.006

### Plating (4 modes)
- `+1x Internal`: subtract 1× plating thickness from nominal
- `+2x Internal`: subtract 2× plating thickness from nominal
- `-1x External`: add 1× plating thickness to nominal
- `-2x External`: add 2× plating thickness to nominal
- **NEVER apply plating to tolerance — only to nominal**

### OP2000 (CRITICAL)
- NO math of any kind
- NO unit conversion
- NO nominal centering
- ONLY formatting/parsing cleanup
- Output must match print values exactly

### Pin Gage
- GO = nominal - tolerance
- NO GO = nominal + tolerance
- Format: `P(Ø{GO}+ | Ø{NOGO}-)`

### Gage Block
- Format: `G({low} | {high})`

## Global Settings (stored in app state, shown in header bar)
- Import Units: mm or inch
- Display Units: mm, inch, or both
- Plating Thickness: numeric value
- Plating Units: mm or inch
- Custom OP list: array of op numbers (e.g., [2000, 50, 60])
- Inch Precision: number of decimal places (default 4)
- MM Precision: number of decimal places (default 3)
- Equipment List: `["Calipers","Micrometer","Optical C.","CMM","Height Gage","Gage Block","GO / NO-GO","PASS/FAIL","Drop Indicator","N/A"]`

## UI Layout
- **Header bar**: Global settings (always visible)
- **Main area**: Data table (left/center) + Sidebar (right, resizable)
- **Table**: Sortable/filterable columns, alternating row colors, click to select
- **Sidebar**: Opens on row click. Dim Tag big at top. Output drawing spec + tolerance prominent. All controls below.
- **Row status**: none (untouched) → yellow (edited) → green (user marked complete)
- **Theme**: Dark default, blue (#4a9eff) / orange (#ff8c42) accents

## Testing Strategy
- Parser tests: verify each row of sample-input.csv parses correctly
- Math tests: known input/output pairs for centering, plating, unit conversion
- Integration test: import sample-input.csv → configure → export → compare against sample-output.csv
- Run tests by opening `test/index.html` in browser

## Git Workflow
- Commit after each working feature
- Use descriptive commit messages: `feat: add tolerance parsing`, `fix: OP2000 bypass`
- Tag milestones: `v0.1-import`, `v0.2-parsing`, `v0.3-math`, `v0.4-ui`, `v0.5-export`

## Common Pitfalls (from previous attempts)
- Do NOT duplicate calculation logic between UI and export — both read `computed`
- Do NOT apply math to OP2000 rows
- Do NOT lose the original raw data when user edits — raw is immutable
- Do NOT use frameworks or build tools — this must open from index.html directly
- Do NOT put plating adjustment on tolerance — only on nominal
