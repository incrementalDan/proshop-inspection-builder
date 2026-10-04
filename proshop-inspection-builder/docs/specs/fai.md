> **Historical build spec.** Written as instructions for building this feature.
> Parts may be out of date. For output/math rules, `RULES.md` wins.

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
