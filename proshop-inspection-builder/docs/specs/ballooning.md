> **Historical build spec.** Written as instructions for building this feature.
> Parts may be out of date. For output/math rules, `RULES.md` wins.

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
