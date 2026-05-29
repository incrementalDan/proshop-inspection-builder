/**
 * balloonManager.js — Manual ballooning state, rendering, and interaction.
 *
 * Responsibilities:
 *   - Maintain an SVG overlay aligned to the PDF canvas
 *   - Handle draw-box in balloon mode (left/right drag = balloon side)
 *   - Drive the OCR pipeline (ocrEngine.js), show a popover for confirmation
 *   - Create new rows via PSB.createBalloonRow and append/insert into state.rows
 *   - Render balloons + leader lines, support dragging/deleting/renumbering
 *   - Sync hover state with the table (row id ↔ balloon)
 *
 * All balloon coords are stored in PDF user space; conversion to/from screen
 * happens at render and event-handling boundaries only.
 */

window.PSB = window.PSB || {};

var SVG_NS = 'http://www.w3.org/2000/svg';
var BALLOON_BASE_RADIUS = 6;   // px at zoom 1.0 — fallback if globals.balloonRadius unset

// Base balloon radius in PDF points (= screen px at zoom 1.0). User-adjustable
// via the toolbar size control; persisted in globals.balloonRadius.
function getBalloonRadius() {
  var st = ctx && ctx.getState && ctx.getState();
  var r = st && st.globals && st.globals.balloonRadius;
  return (typeof r === 'number' && r > 0) ? r : BALLOON_BASE_RADIUS;
}
var MIN_BOX_PX = { w: 10, h: 5 };

// ── Module state ─────────────────────────────────────────
var ctx = null;                  // { getState, onChange, renderTable }
var svgRoot = null;              // <svg> overlay positioned above the PDF canvas
var pendingInsertAt = null;      // dimTag at which the next created balloon should land
var draftBox = null;             // current drag rectangle (PDF coords)
var draftRectEl = null;          // dashed yellow rectangle SVG element
var popoverEl = null;            // confirmation popover DOM
var hoveredRowId = null;
var draggingState = null;        // { rowId, kind: 'balloon'|'leader', startX, startY, ... }
var selectedRowId = null;        // for keyboard nudging
var activeEditRowId = null;      // rowId whose edit popover is currently open

// Datum-Mode state — drawing a circle around a datum symbol on the print.
var datumDraftCircle = null;     // dashed circle SVG element shown while dragging
var datumDraftBox = null;        // current { x, y, w, h } in PDF coords during drag
var datumLetterPicker = null;    // floating picker DOM (A B C D E F + Other…)

// ── Init ─────────────────────────────────────────────────
function initBalloonManager(opts) {
  ctx = opts;

  // Build the SVG overlay once and append it next to the canvas.
  svgRoot = document.createElementNS(SVG_NS, 'svg');
  svgRoot.id = 'pdf-balloon-overlay';
  svgRoot.style.position = 'absolute';
  svgRoot.style.left = '0';
  svgRoot.style.top = '0';
  svgRoot.style.pointerEvents = 'none'; // children opt in via pointer-events: all
  svgRoot.style.overflow = 'visible';

  var wrap = PSB.getPdfCanvasWrap();
  if (wrap) {
    var inner = document.createElement('div');
    inner.id = 'pdf-balloon-layer';
    inner.style.position = 'absolute';
    inner.style.left = '0';
    inner.style.top = '0';
    inner.style.pointerEvents = 'none';
    inner.appendChild(svgRoot);
    wrap.appendChild(inner);
  }

  // Re-render overlay whenever the PDF page is rendered/zoomed. Also close any
  // stale popover from a previous page — its anchor coordinates no longer apply.
  window.addEventListener('psb:pdfPageRendered', function(e) {
    closePopover();
    renderOverlay(e.detail.viewport);
  });
  // When balloon mode toggles, refresh the overlay (anchor box visibility differs).
  // Exiting balloon mode also cancels any pending targeted insert and the popover.
  window.addEventListener('psb:balloonModeChanged', function(e) {
    var active = !!(e && e.detail && e.detail.active);
    if (!active) {
      clearPendingInsert();
      closePopover();
      activeEditRowId = null;
    }
    renderOverlay(PSB.getPdfViewport());
  });

  // Canvas mouse handlers for draw-box in balloon mode.
  attachDrawBoxHandlers();
  // Canvas mouse handlers for draw-circle in datum mode.
  attachDatumDrawHandlers();
  // Exiting datum mode also closes the letter picker and clears the draft circle.
  window.addEventListener('psb:datumModeChanged', function(e) {
    var active = !!(e && e.detail && e.detail.active);
    if (!active) {
      removeDatumDraftCircle();
      closeDatumLetterPicker();
      datumDraftBox = null;
    }
    renderOverlay(PSB.getPdfViewport());
  });

  // Re-align the overlay whenever the canvas wrap changes size. The canvas is
  // flex-centered, so resizing the viewer (dragging the sidebar or table split,
  // not just the window) shifts the canvas's offset without firing a page
  // re-render — leaving balloons drifted off their dimensions until a manual
  // refresh. A plain renderOverlay() re-reads canvas.offsetLeft/Top and fixes it.
  // Safe from feedback loops: the overlay layer is absolutely positioned, so it
  // never changes the wrap's measured size.
  if (wrap && typeof ResizeObserver !== 'undefined') {
    var roQueued = false;
    var ro = new ResizeObserver(function() {
      if (roQueued) return;
      roQueued = true;
      requestAnimationFrame(function() {
        roQueued = false;
        if (PSB.hasPdf()) renderOverlay(PSB.getPdfViewport());
      });
    });
    ro.observe(wrap);
  }
}

// ── Coordinate helpers ───────────────────────────────────
function pdfToScreen(pdfX, pdfY, viewport) {
  var pt = viewport.convertToViewportPoint(pdfX, pdfY);
  return { x: pt[0], y: pt[1] };
}

function screenToPdf(screenX, screenY, viewport) {
  var pt = viewport.convertToPdfPoint(screenX, screenY);
  return { x: pt[0], y: pt[1] };
}

// Shortest distance from a point to a rectangle (0 if inside). Used to decide
// whether the balloon circle is clear of the anchor box (→ draw a leader).
function pointToRectDistance(px, py, r) {
  var dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  var dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Convert a PDF-space rectangle to a screen-space rectangle by mapping its
 * two opposite corners. Handles the Y-flip pdf.js viewports introduce.
 */
function pdfRectToScreen(rect, viewport) {
  var a = pdfToScreen(rect.x, rect.y, viewport);
  var b = pdfToScreen(rect.x + rect.w, rect.y + rect.h, viewport);
  var x = Math.min(a.x, b.x);
  var y = Math.min(a.y, b.y);
  return { x: x, y: y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/**
 * Hit-test screen point (sx, sy) against all balloons on the current page.
 * Checks both the balloon circle (+ paddingPx) and the anchor box (+ paddingPx).
 * Returns the nearest matching row, or null.
 */
function hitTestBalloon(sx, sy, viewport, paddingPx) {
  var state = ctx.getState();
  var pageNum = PSB.getPdfCurrentPage();
  var scale = viewport.scale || PSB.getPdfZoom() || 1.0;
  var radius = getBalloonRadius() * scale;
  var bestRow = null;
  var bestDist = Infinity;

  state.rows.forEach(function(row) {
    var b = row.user && row.user.balloon;
    if (!b || b.page !== pageNum) return;

    // Check balloon circle
    var balloonCenterPdf = {
      x: b.anchorBox.x + b.anchorBox.w / 2 + b.balloonOffset.dx,
      y: b.anchorBox.y + b.anchorBox.h / 2 + b.balloonOffset.dy,
    };
    var bs = pdfToScreen(balloonCenterPdf.x, balloonCenterPdf.y, viewport);
    var dist = Math.hypot(sx - bs.x, sy - bs.y);
    if (dist < radius + paddingPx) {
      if (dist < bestDist) { bestDist = dist; bestRow = row; }
      return;
    }

    // Check anchor box
    var s = pdfRectToScreen(b.anchorBox, viewport);
    if (sx >= s.x - paddingPx && sx <= s.x + s.w + paddingPx &&
        sy >= s.y - paddingPx && sy <= s.y + s.h + paddingPx) {
      var cx = s.x + s.w / 2;
      var cy = s.y + s.h / 2;
      var d = Math.hypot(sx - cx, sy - cy);
      if (d < bestDist) { bestDist = d; bestRow = row; }
    }
  });

  return bestRow;
}

// ── Draw-box (balloon mode) ──────────────────────────────
function attachDrawBoxHandlers() {
  var wrap = PSB.getPdfCanvasWrap();
  if (!wrap) return;

  var dragStart = null;

  wrap.addEventListener('mousedown', function(e) {
    if (!PSB.isBalloonMode() || !PSB.hasPdf()) return;
    if (e.button !== 0) return;

    // Let clicks inside the open popover pass through to the popover.
    if (popoverEl && popoverEl.contains(e.target)) return;

    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;

    // Hit test: click on an existing balloon/box → drag it, don't start a new box.
    var hitRow = hitTestBalloon(sx, sy, viewport, 10);
    if (hitRow) {
      e.preventDefault();
      e.stopPropagation();
      startBalloonDrag(hitRow, sx, sy, viewport);
      return;
    }

    // Clicking outside all balloons while a popover is open → close it.
    if (popoverEl) closePopoverAndClearEdit();

    dragStart = { sx: sx, sy: sy, ptStart: screenToPdf(sx, sy, viewport) };
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragStart) return;
    var canvas = PSB.getPdfCanvas();
    var viewport = PSB.getPdfViewport();
    if (!canvas || !viewport) return;
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    var ptEnd = screenToPdf(sx, sy, viewport);
    draftBox = {
      x: Math.min(dragStart.ptStart.x, ptEnd.x),
      y: Math.min(dragStart.ptStart.y, ptEnd.y),
      w: Math.abs(ptEnd.x - dragStart.ptStart.x),
      h: Math.abs(ptEnd.y - dragStart.ptStart.y),
      dragDirection: ptEnd.x >= dragStart.ptStart.x ? 'ltr' : 'rtl',
    };
    updateDraftRect(viewport);
  });

  document.addEventListener('mouseup', function(e) {
    if (!dragStart) return;
    var hadDrag = draftBox;
    var ds = dragStart;
    dragStart = null;
    removeDraftRect();
    if (!hadDrag) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var sxEnd = e.clientX - rect.left;
    var syEnd = e.clientY - rect.top;
    var widthPx = Math.abs(sxEnd - ds.sx);
    var heightPx = Math.abs(syEnd - ds.sy);
    if (widthPx < MIN_BOX_PX.w || heightPx < MIN_BOX_PX.h) {
      PSB.showToast && PSB.showToast('Selection too small — try again', 'info');
      draftBox = null;
      return;
    }
    var boxToRun = draftBox;
    draftBox = null;
    runOcrAndConfirm(boxToRun);
  });

  // Esc during an in-progress drag clears state and the draft rectangle, without
  // waiting for mouseup. The mousemove/mouseup listeners stay attached at the
  // document — they're gated by dragStart, so resetting it is sufficient.
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (dragStart == null && !draftBox) return;
    dragStart = null;
    draftBox = null;
    removeDraftRect();
  });
}

function updateDraftRect(viewport) {
  if (!draftBox || !viewport) return;
  var s = pdfRectToScreen(draftBox, viewport);
  if (!draftRectEl) {
    draftRectEl = document.createElementNS(SVG_NS, 'rect');
    draftRectEl.setAttribute('class', 'balloon-draft-rect');
    draftRectEl.setAttribute('fill', 'none');
    draftRectEl.setAttribute('stroke', '#e6c200');
    draftRectEl.setAttribute('stroke-width', '1.5');
    draftRectEl.setAttribute('stroke-dasharray', '5,3');
    svgRoot.appendChild(draftRectEl);
  }
  draftRectEl.setAttribute('x', s.x);
  draftRectEl.setAttribute('y', s.y);
  draftRectEl.setAttribute('width', s.w);
  draftRectEl.setAttribute('height', s.h);
}

function removeDraftRect() {
  if (draftRectEl && draftRectEl.parentNode) {
    draftRectEl.parentNode.removeChild(draftRectEl);
    draftRectEl = null;
  }
}

// ── Datum Mode: draw → letter picker → save ──────────────
//
// Same pattern as the balloon draw-box, but produces a yellow datum circle
// (not a balloon row). Datums are visual aids only; they never export.

function attachDatumDrawHandlers() {
  var wrap = PSB.getPdfCanvasWrap();
  if (!wrap) return;
  var dragStart = null;

  wrap.addEventListener('mousedown', function(e) {
    if (!PSB.isDatumMode || !PSB.isDatumMode() || !PSB.hasPdf()) return;
    if (e.button !== 0) return;
    // If the letter picker is open, a click outside dismisses it without
    // starting a new draw — let the picker's own listener handle that.
    if (datumLetterPicker && datumLetterPicker.contains(e.target)) return;

    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    dragStart = { sx: sx, sy: sy, ptStart: screenToPdf(sx, sy, viewport) };
    // Drawing a new circle dismisses any open picker from a previous draw.
    closeDatumLetterPicker();
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragStart) return;
    var viewport = PSB.getPdfViewport();
    var canvas = PSB.getPdfCanvas();
    if (!viewport || !canvas) return;
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    var ptEnd = screenToPdf(sx, sy, viewport);
    datumDraftBox = {
      x: Math.min(dragStart.ptStart.x, ptEnd.x),
      y: Math.min(dragStart.ptStart.y, ptEnd.y),
      w: Math.abs(ptEnd.x - dragStart.ptStart.x),
      h: Math.abs(ptEnd.y - dragStart.ptStart.y),
    };
    updateDatumDraftCircle(viewport);
  });

  document.addEventListener('mouseup', function() {
    if (!dragStart) return;
    var box = datumDraftBox;
    dragStart = null;
    if (!box) { removeDatumDraftCircle(); return; }
    // Minimum-size guard mirrors balloon draw-box. 8pt covers a typical datum
    // letter callout circle on a Letter-sized print at 100% zoom.
    if (box.w < 4 && box.h < 4) {
      removeDatumDraftCircle();
      datumDraftBox = null;
      PSB.showToast && PSB.showToast('Datum circle too small — drag a larger area', 'info');
      return;
    }
    showDatumLetterPicker(box);
  });

  // Esc during datum drag clears state cleanly.
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (dragStart == null && !datumDraftBox && !datumLetterPicker) return;
    dragStart = null;
    datumDraftBox = null;
    removeDatumDraftCircle();
    closeDatumLetterPicker();
  });
}

function updateDatumDraftCircle(viewport) {
  if (!datumDraftBox || !viewport) return;
  var s = pdfRectToScreen(datumDraftBox, viewport);
  var cx = s.x + s.w / 2;
  var cy = s.y + s.h / 2;
  var r = Math.max(s.w, s.h) / 2;
  if (!datumDraftCircle) {
    datumDraftCircle = document.createElementNS(SVG_NS, 'circle');
    datumDraftCircle.setAttribute('class', 'datum-draft-circle');
    datumDraftCircle.setAttribute('fill', 'none');
    datumDraftCircle.setAttribute('stroke', '#e6c200');
    datumDraftCircle.setAttribute('stroke-width', '1.5');
    datumDraftCircle.setAttribute('stroke-dasharray', '5,3');
    svgRoot.appendChild(datumDraftCircle);
  }
  datumDraftCircle.setAttribute('cx', cx);
  datumDraftCircle.setAttribute('cy', cy);
  datumDraftCircle.setAttribute('r', r);
}

function removeDatumDraftCircle() {
  if (datumDraftCircle && datumDraftCircle.parentNode) {
    datumDraftCircle.parentNode.removeChild(datumDraftCircle);
  }
  datumDraftCircle = null;
}

// Show A B C D E F buttons plus an "Other…" input near the just-drawn circle.
// User clicks a letter (or types a custom one) → createDatumRef → render.
function showDatumLetterPicker(box) {
  closeDatumLetterPicker();
  var viewport = PSB.getPdfViewport();
  if (!viewport) return;
  var s = pdfRectToScreen(box, viewport);

  datumLetterPicker = document.createElement('div');
  datumLetterPicker.className = 'datum-letter-picker';
  datumLetterPicker.innerHTML =
    '<div class="datum-picker-label">Datum letter</div>' +
    '<div class="datum-picker-buttons">' +
      ['A','B','C','D','E','F'].map(function(L) {
        return '<button type="button" class="datum-letter-btn" data-letter="' + L + '">' + L + '</button>';
      }).join('') +
    '</div>' +
    '<div class="datum-picker-other">' +
      '<input type="text" class="datum-letter-input" maxlength="1" placeholder="Other (G–Z)" />' +
      '<button type="button" class="btn btn-primary datum-letter-go">OK</button>' +
    '</div>' +
    '<div class="datum-picker-cancel">' +
      '<button type="button" class="btn btn-secondary datum-letter-cancel">Cancel</button>' +
    '</div>';
  datumLetterPicker.style.position = 'absolute';
  // Place picker to the right of the box; clamp to the viewer width.
  var wrap = PSB.getPdfCanvasWrap();
  var wrapRect = wrap.getBoundingClientRect();
  var preferLeft = (s.x + s.w + 220) > wrapRect.width;
  datumLetterPicker.style.left = preferLeft
    ? (Math.max(8, s.x - 220) + 'px')
    : ((s.x + s.w + 8) + 'px');
  datumLetterPicker.style.top = Math.max(8, s.y) + 'px';

  var layer = document.getElementById('pdf-balloon-layer');
  if (layer) layer.appendChild(datumLetterPicker);
  else wrap.appendChild(datumLetterPicker);

  function commit(letter) {
    letter = String(letter || '').toUpperCase().charAt(0);
    if (!/^[A-Z]$/.test(letter)) {
      PSB.showToast && PSB.showToast('Datum letter must be A–Z', 'error');
      return;
    }
    var pageNum = PSB.getPdfCurrentPage();
    // Mutex on (page, letter): no duplicate datums per page.
    if (findDatumRef(pageNum, letter)) {
      PSB.showToast && PSB.showToast('Datum ' + letter + ' already placed on this page', 'error');
      return;
    }
    createDatumRef(letter, box, pageNum);
    closeDatumLetterPicker();
    removeDatumDraftCircle();
    datumDraftBox = null;
  }

  datumLetterPicker.querySelectorAll('.datum-letter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { commit(btn.getAttribute('data-letter')); });
  });
  var otherInput = datumLetterPicker.querySelector('.datum-letter-input');
  var otherGo = datumLetterPicker.querySelector('.datum-letter-go');
  otherGo.addEventListener('click', function() { commit(otherInput.value); });
  otherInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(otherInput.value); }
    if (e.key === 'Escape') { e.preventDefault(); closeDatumLetterPicker(); removeDatumDraftCircle(); datumDraftBox = null; }
  });
  datumLetterPicker.querySelector('.datum-letter-cancel').addEventListener('click', function() {
    closeDatumLetterPicker();
    removeDatumDraftCircle();
    datumDraftBox = null;
  });

  // Default focus on first letter so keyboard users can pick fast.
  var firstBtn = datumLetterPicker.querySelector('.datum-letter-btn');
  if (firstBtn) firstBtn.focus();
}

function closeDatumLetterPicker() {
  if (datumLetterPicker && datumLetterPicker.parentNode) {
    datumLetterPicker.parentNode.removeChild(datumLetterPicker);
  }
  datumLetterPicker = null;
}

function findDatumRef(pageNum, letter) {
  var state = ctx.getState();
  var refs = state.datumRefs || [];
  for (var i = 0; i < refs.length; i++) {
    if (refs[i].page === pageNum && refs[i].letter === letter) return refs[i];
  }
  return null;
}

function createDatumRef(letter, box, pageNum) {
  var state = ctx.getState();
  if (!state.datumRefs) state.datumRefs = [];
  PSB.pushUndo(state, 'Add datum ' + letter);
  var cx = box.x + box.w / 2;
  var cy = box.y + box.h / 2;
  var radius = Math.max(box.w, box.h) / 2;
  if (radius < 8) radius = 8;
  state.datumRefs.push({
    id: 'datum_' + letter + '_' + Date.now(),
    letter: letter,
    page: pageNum,
    center: { x: cx, y: cy },
    radius: radius,
    label: letter,
    notes: '',
  });
  PSB.logChange(state.auditLog, {
    type: 'add',
    rowId: null,
    description: 'Added datum ' + letter + ' on page ' + pageNum,
    details: [{ field: 'datumRefs', from: null, to: { letter: letter, page: pageNum } }],
  });
  ctx.onChange && ctx.onChange({ kind: 'datum-add', letter: letter });
  renderOverlay(PSB.getPdfViewport());
}

function deleteDatumRef(id) {
  var state = ctx.getState();
  var refs = state.datumRefs || [];
  var i = -1, ref = null;
  for (var k = 0; k < refs.length; k++) {
    if (refs[k].id === id) { i = k; ref = refs[k]; break; }
  }
  if (!ref) return;
  if (!confirm('Delete datum ' + ref.letter + ' on page ' + ref.page + '?')) return;
  PSB.pushUndo(state, 'Delete datum ' + ref.letter);
  refs.splice(i, 1);
  PSB.logChange(state.auditLog, {
    type: 'delete',
    rowId: null,
    description: 'Deleted datum ' + ref.letter + ' from page ' + ref.page,
  });
  ctx.onChange && ctx.onChange({ kind: 'datum-delete', letter: ref.letter });
  renderOverlay(PSB.getPdfViewport());
}

// ── Title block default tolerance injection ──────────────
/**
 * Look up the symmetrical title-block default tolerance for a given drawing
 * spec string. Returns { tol: '0.005', source: true | 'gdt-profile' } when a
 * matching default exists, otherwise null. The drawing spec must be a clean
 * decimal — its decimal-place count selects the bucket. A configured GD&T
 * profile tolerance overrides the decimal buckets. Converts between the
 * title-block unit and the drawing (import) unit when they differ.
 */
function lookupTitleBlockTol(spec, globals) {
  if (!globals) return null;
  spec = String(spec || '').trim();
  if (!spec || !/\d/.test(spec)) return null;

  var defaultTol = '';
  var source = false;

  if (globals.titleBlockTolGdt) {
    // GD&T profile global override takes precedence over decimal-based entries.
    defaultTol = globals.titleBlockTolGdt;
    source = 'gdt-profile';
  } else {
    var decimals = PSB.detectPrecision ? PSB.detectPrecision(spec) : null;
    if (decimals === null || decimals === 0) return null;
    if      (decimals === 1 && globals.titleBlockTol1d) { defaultTol = globals.titleBlockTol1d; source = true; }
    else if (decimals === 2 && globals.titleBlockTol2d) { defaultTol = globals.titleBlockTol2d; source = true; }
    else if (decimals === 3 && globals.titleBlockTol3d) { defaultTol = globals.titleBlockTol3d; source = true; }
    else if (decimals >= 4 && globals.titleBlockTol4d)  { defaultTol = globals.titleBlockTol4d; source = true; }
  }

  if (!defaultTol || !source) return null;

  // Unit conversion: title block tolerances may be stored in a different unit
  // than the drawing dimensions (importUnits). Convert if needed.
  var tolUnits = globals.titleBlockTolUnits || 'inch';
  var drawingUnits = globals.importUnits || 'inch';
  var tolStr;
  if (tolUnits === drawingUnits) {
    // No conversion — use the entered string exactly to avoid floating-point noise.
    tolStr = defaultTol;
  } else if (PSB.convertUnits) {
    var tolNum = parseFloat(defaultTol);
    if (isNaN(tolNum)) return null;
    tolNum = PSB.convertUnits(tolNum, tolUnits, drawingUnits);
    var prec = (drawingUnits === 'mm') ? 3 : 4;
    tolStr = tolNum.toFixed(prec).replace(/0+$/, '').replace(/\.$/, '') || tolNum.toString();
  } else {
    tolStr = defaultTol;
  }

  return { tol: tolStr, source: source };
}

/**
 * If the OCR result has no tolerance and the drawing spec has a recognisable
 * decimal count, fill in the matching title-block default from globals.
 * The result is returned with `titleBlockDefault` truthy so the popover can
 * show a visual indicator that the tolerance was not read from the drawing.
 */
function applyTitleBlockDefault(ocrResult, globals) {
  if (!ocrResult) return ocrResult;
  var parsed = ocrResult.parsed;
  if (!parsed || parsed.tolerance || parsed.isNote || parsed.isGDT) return ocrResult;

  var hit = lookupTitleBlockTol(parsed.drawingSpec, globals);
  if (!hit) return ocrResult;

  var newParsed = Object.assign({}, parsed, {
    tolerance: hit.tol,
    tolMode: 'sym',
  });

  return Object.assign({}, ocrResult, {
    parsed: newParsed,
    titleBlockDefault: hit.source,
  });
}

// ── OCR + confirmation popover ───────────────────────────
function runOcrAndConfirm(anchorBox) {
  var doc = PSB.getPdfDoc();
  if (!doc) return;
  var pageNum = PSB.getPdfCurrentPage();
  showSpinner(anchorBox);

  doc.getPage(pageNum).then(function(page) {
    var viewport = PSB.getPdfViewport();
    var globals = ctx.getState && ctx.getState().globals;
    return PSB.ocrEngine.extractDimension(page, anchorBox, viewport, {
      onProgress: function(stage) { updateSpinnerStage(stage); },
      ocrMode: globals && globals.ocrMode,
    });
  }).then(function(result) {
    hideSpinner();
    var globals = ctx.getState && ctx.getState().globals;
    result = applyTitleBlockDefault(result, globals);
    showPopover(anchorBox, pageNum, result);
  }).catch(function(err) {
    console.warn('[Balloon] OCR pipeline failed:', err);
    var msg = (err && err.message) ? err.message : String(err);
    PSB.showToast && PSB.showToast('OCR pipeline failed — enter values manually (' + msg + ')', 'error');
    hideSpinner();
    showPopover(anchorBox, pageNum, {
      parsed: PSB.ocrEngine.parseOcrText(''),
      engine: null, rawText: '', ocrConfidence: 0,
    });
  });
}

var spinnerEl = null;
function showSpinner(anchorBox) {
  hideSpinner();
  var viewport = PSB.getPdfViewport();
  if (!viewport) return;
  var s = pdfRectToScreen(anchorBox, viewport);
  spinnerEl = document.createElement('div');
  spinnerEl.className = 'balloon-spinner';
  spinnerEl.innerHTML = '<div class="balloon-spinner-dot"></div><div class="balloon-spinner-label">Reading…</div>';
  spinnerEl.style.position = 'absolute';
  spinnerEl.style.left = s.x + 'px';
  spinnerEl.style.top = s.y + 'px';
  spinnerEl.style.width = s.w + 'px';
  spinnerEl.style.height = s.h + 'px';
  spinnerEl.style.pointerEvents = 'none';
  var inner = document.getElementById('pdf-balloon-layer');
  if (inner) inner.appendChild(spinnerEl);
}
function updateSpinnerStage(stage) {
  if (!spinnerEl) return;
  var lbl = spinnerEl.querySelector('.balloon-spinner-label');
  if (!lbl) return;
  if (stage === 'pdfjs') lbl.textContent = 'Reading PDF text…';
  else if (stage === 'claude') lbl.textContent = '☁ Sending crop to Claude OCR…';
  else if (stage === 'claude-gdt') lbl.textContent = '☁ Reading GD&T with Claude…';
  else if (stage === 'done') lbl.textContent = 'Done';
}
function hideSpinner() {
  if (spinnerEl && spinnerEl.parentNode) {
    spinnerEl.parentNode.removeChild(spinnerEl);
  }
  spinnerEl = null;
}

// editRow: optional — when set, the popover edits an existing balloon row instead of creating a new one.
function showPopover(anchorBox, pageNum, ocrResult, editRow) {
  if (popoverEl) closePopover();

  // GD&T branch: a different popover layout entirely (characteristic dropdown,
  // material-condition selector, datums editor, live frame preview).
  if (!editRow && ocrResult && (ocrResult.gdt || ocrResult.gdtError)) {
    showGdtPopover(anchorBox, pageNum, ocrResult);
    return;
  }

  var viewport = PSB.getPdfViewport();
  if (!viewport) return;
  var sBox = pdfRectToScreen(anchorBox, viewport);
  var parsed = ocrResult.parsed || {};
  var lowConf = !editRow && (parsed.confidence === 'low' || ocrResult.ocrConfidence < 0.6);
  var ocrFailed = !editRow && !ocrResult.engine;
  var headerText = editRow
    ? ('Edit Balloon #' + editRow.user.balloon.dimTag)
    : 'New Balloon';

  popoverEl = document.createElement('div');
  popoverEl.className = 'balloon-popover';
  popoverEl.innerHTML =
    '<div class="balloon-popover-arrow"></div>' +
    '<div class="balloon-popover-header">' +
      headerText +
      (!editRow && ocrResult.engine ? ' <span class="balloon-popover-engine">via ' + ocrResult.engine + '</span>' : '') +
    '</div>' +
    (ocrFailed
      ? '<div class="balloon-popover-warn">OCR could not read this area — enter values manually</div>'
      : (lowConf ? '<div class="balloon-popover-warn">⚠ Low confidence — please verify</div>' : '')) +
    '<div class="balloon-popover-tblock-default" style="display:' +
      (ocrResult.titleBlockDefault ? 'block' : 'none') + '">ⓘ Tolerance from title block default</div>' +
    '<div class="balloon-popover-grid">' +
      '<div class="balloon-popover-field bp-col-2"><label>Drawing Spec</label>' +
        '<input type="text" class="bp-spec" value="' + escapeAttr(parsed.drawingSpec || '') + '" /></div>' +
      '<div class="balloon-popover-field bp-col-2"><label>Tolerance</label>' +
        '<div class="bp-tol-mount"></div></div>' +
      '<div class="balloon-popover-field"><label>Spec Unit 1</label>' +
        '<input type="text" class="bp-su1" value="' + escapeAttr(parsed.specUnit1 || '') + '" title="Ø, R, SR" /></div>' +
      '<div class="balloon-popover-field"><label>Spec Unit 2</label>' +
        '<input type="text" class="bp-su2" value="' + escapeAttr(parsed.specUnit2 || '') + '" title="Thru, REF, MAX, MIN, TYP, °" /></div>' +
      '<div class="balloon-popover-field"><label>Spec Unit 3</label>' +
        '<input type="text" class="bp-su3" value="' + escapeAttr(parsed.specUnit3 || '') + '" title="2x, 4x, PLACES, HOLES" /></div>' +
    '</div>' +
    '<div class="balloon-popover-actions">' +
      '<button type="button" class="btn btn-secondary bp-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary bp-confirm">Confirm (Enter)</button>' +
    '</div>';

  popoverEl.style.position = 'absolute';
  // Place popover to the right of the anchor box, fall back to left if it overflows.
  var wrap = PSB.getPdfCanvasWrap();
  var wrapRect = wrap.getBoundingClientRect();
  var preferLeft = (sBox.x + sBox.w + 280) > wrapRect.width;
  popoverEl.style.left = preferLeft ? (Math.max(8, sBox.x - 280) + 'px') : ((sBox.x + sBox.w + 8) + 'px');
  popoverEl.style.top = Math.max(8, sBox.y) + 'px';

  var layer = document.getElementById('pdf-balloon-layer');
  if (layer) layer.appendChild(popoverEl);
  else wrap.appendChild(popoverEl);

  // Wire actions
  var inSpec = popoverEl.querySelector('.bp-spec');
  var tolMount = popoverEl.querySelector('.bp-tol-mount');
  var inSu1  = popoverEl.querySelector('.bp-su1');
  var inSu2  = popoverEl.querySelector('.bp-su2');
  var inSu3  = popoverEl.querySelector('.bp-su3');

  // Build the mode-aware tolerance controller. Seed plus/minus from parsed.tolerance string.
  var seed = parseToleranceSeed(parsed.tolerance);
  var initialMode = parsed.tolMode || seed.mode || 'sym';
  var nominalForBounds = parseFloat(parsed.drawingSpec);
  var tolCtrl = PSB.renderTolModeInputs(tolMount, {
    mode: initialMode,
    plus: seed.plus,
    minus: seed.minus,
    nominal: isNaN(nominalForBounds) ? null : nominalForBounds,
    precision: 4,
  });
  // Title-block default re-application. If OCR read a real (non-default)
  // tolerance, the user owns it from the start and we never auto-fill. Once the
  // user types anything into the tolerance inputs, they own it too. Until then,
  // correcting the Drawing Spec re-derives the default for the new decimal count
  // — this is the common case when OCR returns junk and the user fixes the spec.
  var tbBadge = popoverEl.querySelector('.balloon-popover-tblock-default');
  var tolUserOwned = !!(parsed.tolerance && !ocrResult.titleBlockDefault);
  tolMount.addEventListener('input', function() { tolUserOwned = true; });

  // Keep nominal in sync if user edits Drawing Spec before confirm, and
  // re-derive the title-block default tolerance from the corrected spec.
  inSpec && inSpec.addEventListener('input', function() {
    var n = parseFloat(inSpec.value);
    tolCtrl.setNominal(isNaN(n) ? null : n);
    if (tolUserOwned) return;
    var globals = ctx.getState && ctx.getState().globals;
    var hit = lookupTitleBlockTol(inSpec.value, globals);
    if (hit) {
      if (tolCtrl.getMode() !== 'sym') tolCtrl.setMode('sym');
      tolCtrl.setValue(hit.tol, hit.tol);
      if (tbBadge) tbBadge.style.display = 'block';
    } else {
      tolCtrl.setValue(0, 0);
      if (tbBadge) tbBadge.style.display = 'none';
    }
  });

  popoverEl.querySelector('.bp-cancel').addEventListener('click', function() {
    if (editRow) closePopoverAndClearEdit();
    else closePopover();
  });
  popoverEl.querySelector('.bp-confirm').addEventListener('click', function() {
    if (editRow) confirmEditPopover(anchorBox, pageNum, editRow);
    else confirmPopover(anchorBox, pageNum, ocrResult);
  });
  popoverEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      if (e.target && e.target.classList && e.target.classList.contains('tol-mode-chip')) return;
      e.preventDefault();
      if (editRow) confirmEditPopover(anchorBox, pageNum, editRow);
      else confirmPopover(anchorBox, pageNum, ocrResult);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (editRow) closePopoverAndClearEdit();
      else closePopover();
    }
  });
  setTimeout(function() { inSpec && inSpec.focus(); inSpec && inSpec.select(); }, 0);

  // Stash inputs on the popover for confirm handlers to read.
  popoverEl._inputs = { spec: inSpec, tolCtrl: tolCtrl, su1: inSu1, su2: inSu2, su3: inSu3 };
}

// Parse the tolerance string emitted by ocrEngine.parseOcrText into { plus, minus, mode }
// so the popover can prefill the right inputs.
//   ""              → mode 'sym', 0/0
//   "0.005"         → mode 'sym', 0.005/0.005
//   "+0.003-0.001"  → mode 'asym', 0.003/0.001
function parseToleranceSeed(tolStr) {
  var s = String(tolStr == null ? '' : tolStr).trim();
  if (!s) return { plus: 0, minus: 0, mode: 'sym' };
  var asym = s.match(/^\+?\s*(\.?[0-9.]+)\s*[-−]\s*(\.?[0-9.]+)\s*$/);
  if (asym) {
    var p = parseFloat(asym[1]);
    var m = parseFloat(asym[2]);
    if (!isNaN(p) && !isNaN(m)) {
      return { plus: p, minus: m, mode: (p === m ? 'sym' : 'asym') };
    }
  }
  var n = parseFloat(s);
  if (!isNaN(n)) return { plus: Math.abs(n), minus: Math.abs(n), mode: 'sym' };
  return { plus: 0, minus: 0, mode: 'sym' };
}

function closePopover() {
  if (popoverEl && popoverEl.parentNode) {
    popoverEl.parentNode.removeChild(popoverEl);
  }
  popoverEl = null;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function confirmPopover(anchorBox, pageNum, ocrResult) {
  if (!popoverEl) return;
  var ins = popoverEl._inputs;

  // Run tolerance validation BEFORE closing the popover. If invalid, keep it open.
  var tolResult = ins.tolCtrl.commit();
  if (!tolResult.ok) return;

  // Re-format the tolerance string for downstream parser (parseOcrText emits same shape).
  var tolStr;
  if (tolResult.tolPlus === tolResult.tolMinus) {
    tolStr = tolResult.tolPlus > 0 ? String(tolResult.tolPlus) : '';
  } else {
    tolStr = '+' + tolResult.tolPlus + '-' + tolResult.tolMinus;
  }

  var parsed = Object.assign({}, ocrResult.parsed || {}, {
    drawingSpec: ins.spec.value.trim(),
    tolerance: tolStr,
    tolMode: tolResult.tolMode,
    tolPlus: tolResult.tolPlus,
    tolMinus: tolResult.tolMinus,
    specUnit1: ins.su1 ? ins.su1.value.trim() : (ocrResult.parsed && ocrResult.parsed.specUnit1) || '',
    specUnit2: ins.su2 ? ins.su2.value.trim() : '',
    specUnit3: ins.su3 ? ins.su3.value.trim() : (ocrResult.parsed && ocrResult.parsed.specUnit3) || '',
    nominal: ins.spec.value.trim(),
  });
  closePopover();

  var state = ctx.getState();
  var existingMax = 0;
  state.rows.forEach(function(r) {
    var t = parseInt(PSB.effectiveDimTag(r), 10);
    if (!isNaN(t) && t > existingMax) existingMax = t;
  });

  var newDimTag;
  if (pendingInsertAt != null) {
    newDimTag = pendingInsertAt;
    // Collision check: a CSV row (not a balloon row) holds this dimTag and
    // cannot be renumbered because raw is frozen. Abort the insert.
    var collidingCsvRow = findCsvRowWithDimTag(state, newDimTag);
    if (collidingCsvRow) {
      PSB.showToast && PSB.showToast(
        'Dim Tag #' + newDimTag + ' is held by a CSV-imported row — pick a different gap',
        'error'
      );
      pendingInsertAt = null;
      return;
    }
    pendingInsertAt = null;
    renumberShiftUp(newDimTag);
  } else {
    newDimTag = existingMax + 1;
    // Same guard for plain append — extremely rare, but a CSV row could already
    // be at existingMax+1 if dimTags weren't contiguous in the import.
    var collide = findCsvRowWithDimTag(state, newDimTag);
    while (collide) {
      newDimTag++;
      collide = findCsvRowWithDimTag(state, newDimTag);
    }
  }

  PSB.pushUndo(state, 'Add balloon #' + newDimTag);

  var balloonData = {
    page: pageNum,
    anchorBox: { x: anchorBox.x, y: anchorBox.y, w: anchorBox.w, h: anchorBox.h },
    balloonOffset: defaultBalloonOffset(anchorBox, anchorBox.dragDirection),
    leaderConnectionPoint: defaultLeaderPoint(anchorBox.dragDirection),
    dragDirection: anchorBox.dragDirection || 'ltr',
    source: 'manual',
    ocrConfidence: ocrResult.ocrConfidence || null,
    ocrEngine: ocrResult.engine || null,
  };

  var row = PSB.createBalloonRow(newDimTag, parsed, balloonData);
  if (parsed.tolMode && row.user && row.user.overrides) {
    row.user.overrides.tolMode = parsed.tolMode;
  }
  PSB.recompute(row, state.globals);
  state.rows.push(row);
  sortRowsByEffectiveDimTag(state);
  selectedRowId = row.id;  // arrow keys nudge the new balloon immediately

  PSB.logChange(state.auditLog, {
    type: 'add', rowId: row.id,
    description: 'Added balloon #' + newDimTag,
    details: [{ field: 'balloon', from: null, to: { dimTag: newDimTag, page: pageNum } }],
  });

  ctx.onChange && ctx.onChange({ kind: 'add', rowId: row.id });
  renderOverlay(PSB.getPdfViewport());
}

// ── Edit existing balloon popover ────────────────────────

/**
 * Save edits from the open popover back to an existing balloon row.
 * Updates raw (balloon rows are mutable), recomputes, logs undo.
 */
function confirmEditPopover(anchorBox, pageNum, editRow) {
  if (!popoverEl) return;
  var ins = popoverEl._inputs;

  var tolResult = ins.tolCtrl.commit();
  if (!tolResult.ok) return;

  var tolStr;
  if (tolResult.tolPlus === tolResult.tolMinus) {
    tolStr = tolResult.tolPlus > 0 ? String(tolResult.tolPlus) : '';
  } else {
    tolStr = '+' + tolResult.tolPlus + '-' + tolResult.tolMinus;
  }

  var state = ctx.getState();
  PSB.pushUndo(state, 'Edit balloon #' + editRow.user.balloon.dimTag);

  var newSpec = ins.spec.value.trim();
  editRow.raw.drawingSpec = newSpec;
  editRow.raw.nominal     = newSpec;
  editRow.raw.nominalText = newSpec;
  editRow.raw.tolerance     = tolStr;
  editRow.raw.toleranceText = tolStr;
  if (ins.su1) editRow.raw.specUnit1 = ins.su1.value.trim();
  if (ins.su2) editRow.raw.specUnit2 = ins.su2.value.trim();
  if (ins.su3) editRow.raw.specUnit3 = ins.su3.value.trim();
  editRow.user.overrides = editRow.user.overrides || {};
  editRow.user.overrides.tolMode = tolResult.tolMode;

  PSB.recompute(editRow, state.globals);

  PSB.logChange(state.auditLog, {
    type: 'edit', rowId: editRow.id,
    description: 'Edited balloon #' + editRow.user.balloon.dimTag,
    details: [{ field: 'balloon.spec', from: null, to: newSpec }],
  });

  closePopoverAndClearEdit();
  ctx.onChange && ctx.onChange({ kind: 'edit', rowId: editRow.id });
}

/**
 * Open the edit popover for an existing balloon row.
 * Called on double-click (balloon circle or anchor-box hitzone).
 * Activates balloon mode so handles are visible while editing.
 */
function openEditPopover(row) {
  if (!row || !row.user || !row.user.balloon) return;

  if (row.user.gdt) {
    PSB.showToast && PSB.showToast('GD&T balloon editing: use the sidebar for now', 'info');
    return;
  }

  if (!PSB.isBalloonMode()) PSB.setBalloonMode(true);

  activeEditRowId = row.id;
  selectedRowId   = row.id;
  renderOverlay(PSB.getPdfViewport()); // apply edit ring before popover appears

  var b = row.user.balloon;
  var ocrResult = {
    parsed: {
      drawingSpec: row.raw.drawingSpec || '',
      tolerance:   row.raw.tolerance   || '',
      tolMode: (row.user.overrides && row.user.overrides.tolMode) || 'sym',
      specUnit1: row.raw.specUnit1 || '',
      specUnit2: row.raw.specUnit2 || '',
      specUnit3: row.raw.specUnit3 || '',
      confidence: 'high',
    },
    engine: null,
    ocrConfidence: 1.0,
    titleBlockDefault: false,
  };

  showPopover(b.anchorBox, b.page, ocrResult, row);
}

// ── GD&T popover ──────────────────────────────────────────
//
// Shown when the OCR pipeline returns ocrResult.gdt (validated user.gdt
// object) or ocrResult.gdtError (Claude failed / no API key). Lets the user
// pick a characteristic, toggle Ø, edit tolerance + material condition, and
// edit datums + their modifiers. A live preview of the feature control frame
// updates as the user edits. Confirm → createBalloonRow with user.gdt and
// user.isNote=true; recompute skips the math pipeline for note rows.

var GDT_CHAR_LIST = [
  'position','flatness','straightness','circularity','cylindricity',
  'profileLine','profileSurface','angularity','perpendicularity','parallelism',
  'concentricity','symmetry','circularRunout','totalRunout',
];

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function showGdtPopover(anchorBox, pageNum, ocrResult) {
  var viewport = PSB.getPdfViewport();
  if (!viewport) return;
  var sBox = pdfRectToScreen(anchorBox, viewport);

  // Seed the form from the validated gdt object, or sensible empty defaults
  // when the Claude call failed (user fills in manually).
  var gdt = ocrResult.gdt || {
    characteristic: 'position', hasDiameter: false, tolerance: '',
    materialCondition: null, datums: [], isComposite: false,
  };
  var errorBanner = '';
  if (ocrResult.gdtError) {
    errorBanner = '<div class="balloon-popover-warn">GD&amp;T OCR failed (' +
      _esc(ocrResult.gdtError) + ') — enter values manually</div>';
  } else if (gdt.isComposite) {
    errorBanner = '<div class="balloon-popover-warn">Composite frame detected — only the upper segment is editable in this release</div>';
  }

  var charOptions = GDT_CHAR_LIST.map(function(k) {
    var ref = PSB.GDT_REFERENCE[k];
    var sel = (k === gdt.characteristic) ? ' selected' : '';
    return '<option value="' + k + '"' + sel + '">' +
      _esc(PSB.GDT_SYMBOLS[k]) + '  ' + _esc(ref.name) + '</option>';
  }).join('');

  var mcOptions = [
    ['', 'None (RFS implied)'],
    ['mmc', 'Ⓜ MMC'],
    ['lmc', 'Ⓛ LMC'],
    ['rfs', 'Ⓢ RFS'],
  ].map(function(p) {
    var sel = ((gdt.materialCondition || '') === p[0]) ? ' selected' : '';
    return '<option value="' + p[0] + '"' + sel + '">' + _esc(p[1]) + '</option>';
  }).join('');

  popoverEl = document.createElement('div');
  popoverEl.className = 'balloon-popover gdt-popover';
  popoverEl.innerHTML =
    '<div class="balloon-popover-arrow"></div>' +
    '<div class="balloon-popover-header">' +
      'GD&amp;T Feature Control Frame' +
      (ocrResult.engine ? ' <span class="balloon-popover-engine">via ' + _esc(ocrResult.engine) + '</span>' : '') +
    '</div>' +
    errorBanner +
    '<div class="gdt-popover-grid">' +
      '<div class="gdt-popover-field gdt-col-2"><label>Characteristic</label>' +
        '<select class="gp-char">' + charOptions + '</select></div>' +
      '<div class="gdt-popover-field"><label>Ø</label>' +
        '<input type="checkbox" class="gp-dia"' + (gdt.hasDiameter ? ' checked' : '') + ' /></div>' +
      '<div class="gdt-popover-field"><label>Tolerance</label>' +
        '<input type="text" class="gp-tol" value="' + _esc(gdt.tolerance) + '" /></div>' +
      '<div class="gdt-popover-field"><label>Tol modifier</label>' +
        '<select class="gp-mc">' + mcOptions + '</select></div>' +
      '<div class="gdt-popover-field gdt-col-2"><label>Datums (e.g. <code>A B(MMC) C</code>)</label>' +
        '<input type="text" class="gp-datums" value="' + _esc(formatDatumsForInput(gdt.datums)) + '" /></div>' +
      '<div class="gdt-popover-field gdt-col-2"><label>Frame preview</label>' +
        '<div class="gp-preview gdt-frame">—</div></div>' +
      '<div class="gdt-popover-field gdt-col-2 gp-fields-preview">' +
        '<div class="gp-fields-row"><span class="gp-fields-label">SU1</span><span class="gp-su1 gdt-frame">—</span></div>' +
        '<div class="gp-fields-row"><span class="gp-fields-label">SU2</span><span class="gp-su2 gdt-frame">—</span></div>' +
        '<div class="gp-fields-row"><span class="gp-fields-label">Dim Spec</span><span class="gp-dimspec">—</span></div>' +
      '</div>' +
    '</div>' +
    '<div class="balloon-popover-actions">' +
      '<button type="button" class="btn btn-secondary bp-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary bp-confirm">Confirm (Enter)</button>' +
    '</div>';

  popoverEl.style.position = 'absolute';
  var wrap = PSB.getPdfCanvasWrap();
  var wrapRect = wrap.getBoundingClientRect();
  var preferLeft = (sBox.x + sBox.w + 380) > wrapRect.width;
  popoverEl.style.left = preferLeft ? (Math.max(8, sBox.x - 380) + 'px') : ((sBox.x + sBox.w + 8) + 'px');
  popoverEl.style.top = Math.max(8, sBox.y) + 'px';

  var layer = document.getElementById('pdf-balloon-layer');
  if (layer) layer.appendChild(popoverEl);
  else wrap.appendChild(popoverEl);

  var elChar    = popoverEl.querySelector('.gp-char');
  var elDia     = popoverEl.querySelector('.gp-dia');
  var elTol     = popoverEl.querySelector('.gp-tol');
  var elMc      = popoverEl.querySelector('.gp-mc');
  var elDatums  = popoverEl.querySelector('.gp-datums');
  var elPreview = popoverEl.querySelector('.gp-preview');
  var elSu1     = popoverEl.querySelector('.gp-su1');
  var elSu2     = popoverEl.querySelector('.gp-su2');
  var elDimSpec = popoverEl.querySelector('.gp-dimspec');

  function readCurrent() {
    var mc = elMc.value || null;
    return {
      characteristic: elChar.value,
      hasDiameter: !!elDia.checked,
      tolerance: elTol.value.trim(),
      materialCondition: mc,
      datums: parseDatumsInput(elDatums.value),
      isComposite: false, compositeUpper: null, compositeLower: null,
    };
  }
  function refreshPreview() {
    var g = readCurrent();
    elPreview.textContent = PSB.buildNominalFrame(g);
    elSu1.textContent     = PSB.buildSu1(g);
    elSu2.textContent     = PSB.buildSu2(g);
    elDimSpec.textContent = g.tolerance || '—';
  }
  [elChar, elDia, elTol, elMc, elDatums].forEach(function(el) {
    el.addEventListener('input', refreshPreview);
    el.addEventListener('change', refreshPreview);
  });
  refreshPreview();

  popoverEl.querySelector('.bp-cancel').addEventListener('click', closePopover);
  popoverEl.querySelector('.bp-confirm').addEventListener('click', function() {
    confirmGdtPopover(anchorBox, pageNum, ocrResult, readCurrent());
  });
  popoverEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      // Don't fire confirm if focus is inside a textarea-like control.
      if (e.target.tagName === 'SELECT') return;
      e.preventDefault();
      confirmGdtPopover(anchorBox, pageNum, ocrResult, readCurrent());
    }
    if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
  });
  setTimeout(function() { elChar.focus(); }, 0);
}

// Datums input format: "A B(MMC) C" or "A,B(mmc),C". Modifier in parens, any case.
function parseDatumsInput(text) {
  var s = String(text || '').trim();
  if (!s) return [];
  var parts = s.split(/[\s,]+/).filter(Boolean);
  var out = [];
  parts.forEach(function(p) {
    var m = p.match(/^([A-Za-z])(?:\(([A-Za-z]+)\))?$/);
    if (!m) return;
    var letter = m[1].toUpperCase();
    var mc = m[2] ? m[2].toLowerCase() : null;
    if (mc && ['mmc','lmc','rfs'].indexOf(mc) === -1) mc = null;
    out.push({ letter: letter, materialCondition: mc });
  });
  return out;
}
function formatDatumsForInput(datums) {
  return (datums || []).map(function(d) {
    return d.materialCondition ? (d.letter + '(' + d.materialCondition.toUpperCase() + ')') : d.letter;
  }).join(' ');
}

function confirmGdtPopover(anchorBox, pageNum, ocrResult, formData) {
  // Hand the form payload through parseGdtResponse for validation + field-string
  // generation. parseGdtResponse expects a flat shape compatible with the
  // Claude-API JSON, so wrap form data the same way.
  var gdt = PSB.parseGdtResponse({
    characteristic: formData.characteristic,
    hasDiameter: formData.hasDiameter,
    tolerance: formData.tolerance,
    materialCondition: formData.materialCondition,
    datums: formData.datums,
    isComposite: false,
  });
  if (!gdt || gdt._error) {
    PSB.showToast && PSB.showToast('Invalid GD&T data: ' + (gdt && gdt._error), 'error');
    return;
  }
  closePopover();

  var state = ctx.getState();
  var existingMax = 0;
  state.rows.forEach(function(r) {
    var t = parseInt(PSB.effectiveDimTag(r), 10);
    if (!isNaN(t) && t > existingMax) existingMax = t;
  });

  var newDimTag;
  if (pendingInsertAt != null) {
    newDimTag = pendingInsertAt;
    var coll = findCsvRowWithDimTag(state, newDimTag);
    if (coll) {
      PSB.showToast && PSB.showToast(
        'Dim Tag #' + newDimTag + ' is held by a CSV row — pick a different gap', 'error');
      pendingInsertAt = null;
      return;
    }
    pendingInsertAt = null;
    renumberShiftUp(newDimTag);
  } else {
    newDimTag = existingMax + 1;
    var c2 = findCsvRowWithDimTag(state, newDimTag);
    while (c2) {
      newDimTag++;
      c2 = findCsvRowWithDimTag(state, newDimTag);
    }
  }

  PSB.pushUndo(state, 'Add GD&T balloon #' + newDimTag);

  // GD&T row uses the same balloon spatial shape as dimension balloons.
  var balloonData = {
    page: pageNum,
    anchorBox: { x: anchorBox.x, y: anchorBox.y, w: anchorBox.w, h: anchorBox.h },
    balloonOffset: defaultBalloonOffset(anchorBox, anchorBox.dragDirection),
    leaderConnectionPoint: defaultLeaderPoint(anchorBox.dragDirection),
    dragDirection: anchorBox.dragDirection || 'ltr',
    source: 'manual',
    ocrConfidence: ocrResult.ocrConfidence || null,
    ocrEngine: ocrResult.engine || null,
  };

  // Build the parsed shape with GD&T-derived field strings. createBalloonRow
  // will fold this into row.raw; we then attach the structured gdt object and
  // mark the row as a note so recompute() skips the math pipeline.
  var parsed = {
    drawingSpec: gdt.tolerance,
    nominal: gdt.tolerance,
    tolerance: '',
    specUnit1: gdt.su1,
    specUnit2: gdt.su2,
    specUnit3: '',
  };

  var row = PSB.createBalloonRow(newDimTag, parsed, balloonData);
  row.user.gdt = gdt;
  row.user.isNote = true;
  // Per CLAUDE.md mapping, Nominal stores the full frame string (informational).
  row.raw.nominal = gdt.nominalFrame;
  row.raw.nominalText = gdt.nominalFrame;
  row.raw.toleranceText = '';

  PSB.recompute(row, state.globals);
  state.rows.push(row);
  sortRowsByEffectiveDimTag(state);
  selectedRowId = row.id;

  PSB.logChange(state.auditLog, {
    type: 'add', rowId: row.id,
    description: 'Added GD&T balloon #' + newDimTag + ' (' + gdt.characteristicName + ')',
    details: [{ field: 'gdt', from: null, to: { characteristic: gdt.characteristic } }],
  });

  ctx.onChange && ctx.onChange({ kind: 'add', rowId: row.id });
  renderOverlay(PSB.getPdfViewport());
}

// Find a CSV-imported row whose immutable raw.dimTag equals the given dimTag.
// Balloon rows use user.balloon.dimTag and can be renumbered freely; CSV rows cannot.
function findCsvRowWithDimTag(state, dimTag) {
  for (var i = 0; i < state.rows.length; i++) {
    var r = state.rows[i];
    if (r.raw && r.raw._source !== 'balloon') {
      var t = parseInt(r.raw.dimTag, 10);
      if (!isNaN(t) && t === dimTag) return r;
    }
  }
  return null;
}

// New balloons sit with their circle just touching the box edge (no leader by
// default — see the leader rule in renderOverlay). pad = radius places the
// circle edge against the box edge.
function defaultBalloonOffset(box, dir) {
  var pad = getBalloonRadius();
  if (dir === 'rtl') return { dx: box.w / 2 + pad, dy: 0 };
  return { dx: -(box.w / 2 + pad), dy: 0 };
}
function defaultLeaderPoint(dir) {
  if (dir === 'rtl') return { side: 'right', t: 0.5 };
  return { side: 'left', t: 0.5 };
}

// ── Renumbering ──────────────────────────────────────────
function renumberShiftUp(fromDimTag) {
  var state = ctx.getState();
  state.rows.forEach(function(r) {
    if (r.user.balloon && r.user.balloon.dimTag >= fromDimTag) {
      r.user.balloon.dimTag = r.user.balloon.dimTag + 1;
      PSB.recompute(r, state.globals);
    }
  });
}

function renumberShiftDown(deletedDimTag) {
  var state = ctx.getState();
  state.rows.forEach(function(r) {
    if (r.user.balloon && r.user.balloon.dimTag > deletedDimTag) {
      r.user.balloon.dimTag = r.user.balloon.dimTag - 1;
      PSB.recompute(r, state.globals);
    }
  });
}

function sortRowsByEffectiveDimTag(state) {
  state.rows.sort(function(a, b) {
    var ta = parseInt(PSB.effectiveDimTag(a), 10);
    var tb = parseInt(PSB.effectiveDimTag(b), 10);
    if (isNaN(ta)) ta = 1e9;
    if (isNaN(tb)) tb = 1e9;
    return ta - tb;
  });
}

// ── Delete ───────────────────────────────────────────────
function deleteBalloon(rowId) {
  var state = ctx.getState();
  var row = null;
  for (var i = 0; i < state.rows.length; i++) {
    if (state.rows[i].id === rowId) { row = state.rows[i]; break; }
  }
  if (!row || !row.user.balloon) return;
  var dimTag = row.user.balloon.dimTag;
  if (!confirm('Delete Dim Tag #' + dimTag + ' and its table row? This cannot be undone after saving.')) return;
  PSB.pushUndo(state, 'Delete balloon #' + dimTag);
  state.rows = state.rows.filter(function(r) { return r.id !== rowId; });
  renumberShiftDown(dimTag);
  sortRowsByEffectiveDimTag(state);
  PSB.logChange(state.auditLog, {
    type: 'delete', rowId: rowId,
    description: 'Deleted balloon #' + dimTag,
  });
  ctx.onChange && ctx.onChange({ kind: 'delete', rowId: rowId });
  renderOverlay(PSB.getPdfViewport());
}

// ── Targeted insert API (called from ui.js + buttons) ───
function setPendingInsertAt(dimTag) {
  pendingInsertAt = dimTag;
}
function clearPendingInsert() {
  pendingInsertAt = null;
}

// ── Rendering ────────────────────────────────────────────
function renderOverlay(viewport) {
  if (!svgRoot) return;
  // Clear all children.
  while (svgRoot.firstChild) svgRoot.removeChild(svgRoot.firstChild);

  if (!viewport || !PSB.hasPdf()) return;

  // Align overlay to the canvas. The canvas is flex-centered inside the wrap,
  // so the overlay layer needs to track the canvas's offsetLeft/Top each render.
  var canvas = PSB.getPdfCanvas();
  var layer = document.getElementById('pdf-balloon-layer');
  if (canvas && layer) {
    layer.style.left = canvas.offsetLeft + 'px';
    layer.style.top  = canvas.offsetTop  + 'px';
    layer.style.width  = viewport.width  + 'px';
    layer.style.height = viewport.height + 'px';
  }
  svgRoot.setAttribute('width', viewport.width);
  svgRoot.setAttribute('height', viewport.height);
  svgRoot.style.width = viewport.width + 'px';
  svgRoot.style.height = viewport.height + 'px';

  var state = ctx.getState();
  var pageNum = PSB.getPdfCurrentPage();
  var balloonMode = PSB.isBalloonMode();
  var datumMode = PSB.isDatumMode && PSB.isDatumMode();
  var radius = getBalloonRadius() * (viewport.scale || PSB.getPdfZoom() || 1.0);

  // Datum pass — render before balloons so balloon circles sit on top.
  // In datum mode, datums are click-through (pointer-events: none) so the
  // user can draw a fresh circle over an existing one.
  var datumRefs = state.datumRefs || [];
  datumRefs.forEach(function(d) {
    if (d.page !== pageNum) return;
    var centerScreen = pdfToScreen(d.center.x, d.center.y, viewport);
    var screenR = d.radius * (viewport.scale || PSB.getPdfZoom() || 1.0);
    if (screenR < 12) screenR = 12;
    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'datum-group');
    g.setAttribute('data-datum-id', d.id);
    g.setAttribute('data-datum-letter', d.letter);
    g.setAttribute('transform', 'translate(' + centerScreen.x + ',' + centerScreen.y + ')');
    if (datumMode) {
      g.style.pointerEvents = 'none';
    } else {
      g.style.pointerEvents = 'all';
      g.style.cursor = 'grab';
    }

    var circ = document.createElementNS(SVG_NS, 'circle');
    circ.setAttribute('cx', 0); circ.setAttribute('cy', 0);
    circ.setAttribute('r', screenR);
    circ.setAttribute('fill', '#F5C518');
    circ.setAttribute('stroke', '#7a6500');
    circ.setAttribute('stroke-width', '1');
    g.appendChild(circ);

    var txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'central');
    txt.setAttribute('font-size', screenR * 1.0);
    txt.setAttribute('font-weight', 'bold');
    txt.setAttribute('fill', '#000');
    txt.style.userSelect = 'none';
    txt.textContent = String(d.label || d.letter);
    g.appendChild(txt);

    if (!datumMode) bindDatumInteractions(g, d);
    svgRoot.appendChild(g);
  });

  state.rows.forEach(function(row) {
    var b = row.user.balloon;
    if (!b || b.page !== pageNum) return;

    // Anchor box area — always render a transparent hitzone for double-click
    // (works in any mode); also render the visible dashed box in balloon mode.
    var s = pdfRectToScreen(b.anchorBox, viewport);
    var pad = 8;
    var hitZone = document.createElementNS(SVG_NS, 'rect');
    hitZone.setAttribute('class', 'balloon-anchor-hitzone');
    hitZone.setAttribute('x', s.x - pad);
    hitZone.setAttribute('y', s.y - pad);
    hitZone.setAttribute('width', s.w + pad * 2);
    hitZone.setAttribute('height', s.h + pad * 2);
    hitZone.setAttribute('fill', 'transparent');
    hitZone.style.pointerEvents = 'all';
    hitZone.style.cursor = balloonMode ? 'crosshair' : 'default';
    (function(capturedRow) {
      hitZone.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        e.preventDefault();
        openEditPopover(capturedRow);
      });
    })(row);
    svgRoot.appendChild(hitZone);

    if (balloonMode) {
      var box = document.createElementNS(SVG_NS, 'rect');
      box.setAttribute('class', 'balloon-anchor-box');
      box.setAttribute('x', s.x);
      box.setAttribute('y', s.y);
      box.setAttribute('width', s.w);
      box.setAttribute('height', s.h);
      box.setAttribute('fill', 'none');
      box.setAttribute('stroke', '#cc0000');
      box.setAttribute('stroke-width', '1');
      box.setAttribute('stroke-dasharray', '3,2');
      svgRoot.appendChild(box);
    }

    // Compute centers and connection point in screen space.
    var anchorCenterPdf = {
      x: b.anchorBox.x + b.anchorBox.w / 2,
      y: b.anchorBox.y + b.anchorBox.h / 2,
    };
    var balloonCenterPdf = {
      x: anchorCenterPdf.x + b.balloonOffset.dx,
      y: anchorCenterPdf.y + b.balloonOffset.dy,
    };
    var balloonScreen = pdfToScreen(balloonCenterPdf.x, balloonCenterPdf.y, viewport);
    var connPdf = leaderPointToPdf(b.anchorBox, b.leaderConnectionPoint);
    var connScreen = pdfToScreen(connPdf.x, connPdf.y, viewport);

    // Leader line only when the balloon circle has been dragged clear of the
    // anchor box. While the circle still touches/overlaps the box (the default
    // placement), no leader is drawn. anchorScreen is the box in screen space;
    // gap = distance from the balloon center to the nearest box edge.
    var anchorScreen = pdfRectToScreen(b.anchorBox, viewport);
    var gap = pointToRectDistance(balloonScreen.x, balloonScreen.y, anchorScreen);
    if (gap > radius + 2) {
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'balloon-leader');
      line.setAttribute('x1', connScreen.x);
      line.setAttribute('y1', connScreen.y);
      line.setAttribute('x2', balloonScreen.x);
      line.setAttribute('y2', balloonScreen.y);
      line.setAttribute('stroke', '#cc0000');
      line.setAttribute('stroke-width', '1.25');
      svgRoot.appendChild(line);
    }

    // Balloon group (circle + number, draggable)
    var group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'balloon-group' + (b.source === 'detected' ? ' detected' : ''));
    group.setAttribute('data-row-id', String(row.id));
    group.setAttribute('transform', 'translate(' + balloonScreen.x + ',' + balloonScreen.y + ')');
    group.style.pointerEvents = 'all';
    group.style.cursor = balloonMode ? 'crosshair' : 'grab';

    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', radius);
    circle.setAttribute('cx', 0);
    circle.setAttribute('cy', 0);
    if (b.source === 'detected') {
      circle.setAttribute('fill', '#ffffff');
      circle.setAttribute('stroke', '#cc0000');
      circle.setAttribute('stroke-width', '1.5');
    } else {
      circle.setAttribute('fill', '#cc0000');
    }
    group.appendChild(circle);

    var label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('font-size', radius * 1.0);
    label.setAttribute('font-weight', 'bold');
    label.setAttribute('fill', b.source === 'detected' ? '#cc0000' : '#ffffff');
    label.style.userSelect = 'none';
    label.textContent = String(b.dimTag);
    group.appendChild(label);

    if (b.misalignedRev) {
      var badge = document.createElementNS(SVG_NS, 'circle');
      badge.setAttribute('cx', radius * 0.75);
      badge.setAttribute('cy', -radius * 0.75);
      badge.setAttribute('r', radius * 0.35);
      badge.setAttribute('fill', '#ff8800');
      group.appendChild(badge);
    }

    // Always render a hover ring; visibility is controlled by .hovered class via CSS.
    var hoverRing = document.createElementNS(SVG_NS, 'circle');
    hoverRing.setAttribute('class', 'balloon-hover-ring');
    hoverRing.setAttribute('cx', 0); hoverRing.setAttribute('cy', 0);
    hoverRing.setAttribute('r', radius + 4);
    hoverRing.setAttribute('fill', 'none');
    hoverRing.setAttribute('stroke', '#ffaa00');
    hoverRing.setAttribute('stroke-width', '2');
    group.insertBefore(hoverRing, circle);
    if (row.id === hoveredRowId) group.classList.add('hovered');

    // Calm pulsing ring while this balloon's edit popover is open.
    if (row.id === activeEditRowId) {
      group.classList.add('balloon-editing');
      var editRing = document.createElementNS(SVG_NS, 'circle');
      editRing.setAttribute('class', 'balloon-edit-ring');
      editRing.setAttribute('cx', 0);
      editRing.setAttribute('cy', 0);
      editRing.setAttribute('r', radius + 7);
      editRing.setAttribute('fill', 'none');
      editRing.setAttribute('stroke', '#4a9eff');
      editRing.setAttribute('stroke-width', '2.5');
      group.insertBefore(editRing, hoverRing);
    }

    bindBalloonInteractions(group, row);
    svgRoot.appendChild(group);

    // Leader connection-point handle (small square at connScreen) — in balloon mode
    // or while this balloon's edit popover is open.
    if (balloonMode || row.id === activeEditRowId) {
      var handle = document.createElementNS(SVG_NS, 'rect');
      handle.setAttribute('class', 'balloon-leader-handle');
      handle.setAttribute('x', connScreen.x - 4);
      handle.setAttribute('y', connScreen.y - 4);
      handle.setAttribute('width', 8);
      handle.setAttribute('height', 8);
      handle.setAttribute('fill', '#ffffff');
      handle.setAttribute('stroke', '#cc0000');
      handle.setAttribute('stroke-width', '1');
      handle.style.pointerEvents = 'all';
      handle.style.cursor = 'move';
      handle.setAttribute('data-row-id', String(row.id));
      bindLeaderHandle(handle, row);
      svgRoot.appendChild(handle);
    }
  });
}

// Leader-point convention (PDF user space, Y up):
//   side='top'    → y = box.y + box.h   (max Y)
//   side='bottom' → y = box.y           (min Y)
//   For all sides, t=0 = visual top/left, t=1 = visual bottom/right.
function leaderPointToPdf(box, lp) {
  if (!lp) return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  var t = lp.t == null ? 0.5 : lp.t;
  switch (lp.side) {
    case 'left':   return { x: box.x,            y: box.y + box.h * (1 - t) };
    case 'right':  return { x: box.x + box.w,    y: box.y + box.h * (1 - t) };
    case 'top':    return { x: box.x + box.w * t, y: box.y + box.h };
    case 'bottom': return { x: box.x + box.w * t, y: box.y };
    default:       return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }
}

function pdfPointToLeader(box, pt) {
  // Project to the closest perimeter side, return { side, t } in visual convention.
  var leftD   = Math.abs(pt.x - box.x);
  var rightD  = Math.abs((box.x + box.w) - pt.x);
  var topD    = Math.abs((box.y + box.h) - pt.y);
  var botD    = Math.abs(pt.y - box.y);
  var min = Math.min(leftD, rightD, topD, botD);
  if (min === leftD)  return { side: 'left',   t: clamp01(1 - (pt.y - box.y) / box.h) };
  if (min === rightD) return { side: 'right',  t: clamp01(1 - (pt.y - box.y) / box.h) };
  if (min === topD)   return { side: 'top',    t: clamp01((pt.x - box.x) / box.w) };
  return                     { side: 'bottom', t: clamp01((pt.x - box.x) / box.w) };
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * Begin dragging a balloon's circle to a new offset position.
 * Works in both balloon mode and normal mode — called from the draw-box
 * hit-test path (balloon mode) and from the balloon group's mousedown (either mode).
 */
function startBalloonDrag(row, sx, sy, viewport) {
  var canvas = PSB.getPdfCanvas();
  if (!canvas) return;
  var rect = canvas.getBoundingClientRect();
  var ptStart = screenToPdf(sx, sy, viewport);
  var origOffset = Object.assign({}, row.user.balloon.balloonOffset);
  var undoPushed = false;

  function onMove(ev) {
    var pt = screenToPdf(ev.clientX - rect.left, ev.clientY - rect.top, viewport);
    row.user.balloon.balloonOffset = {
      dx: origOffset.dx + (pt.x - ptStart.x),
      dy: origOffset.dy + (pt.y - ptStart.y),
    };
    renderOverlay(viewport);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!isOffsetSame(origOffset, row.user.balloon.balloonOffset)) {
      if (!undoPushed) {
        PSB.pushUndo(ctx.getState(), 'Move balloon #' + row.user.balloon.dimTag);
        undoPushed = true;
      }
      PSB.logChange(ctx.getState().auditLog, {
        type: 'edit', rowId: row.id,
        description: 'Moved balloon #' + row.user.balloon.dimTag,
        details: [{ field: 'balloon.balloonOffset', from: origOffset, to: row.user.balloon.balloonOffset }],
      });
      ctx.onChange && ctx.onChange({ kind: 'move', rowId: row.id });
    }
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * Close the popover AND clear edit-mode state (active ring disappears).
 * Use this instead of closePopover() whenever the user explicitly closes
 * an edit session (cancel, confirm, click-outside, Escape).
 */
function closePopoverAndClearEdit() {
  closePopover();
  activeEditRowId = null;
  renderOverlay(PSB.getPdfViewport());
}

// ── Balloon drag / right-click / hover ──────────────────
function bindBalloonInteractions(group, row) {
  // Hover-link to datum circles for GD&T rows (one-way: balloon → datum).
  group.addEventListener('mouseenter', function() { setHoveredRow(row.id); });
  group.addEventListener('mouseleave', function() { setHoveredRow(null); });

  group.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    startBalloonDrag(row, e.clientX - rect.left, e.clientY - rect.top, viewport);
  });

  group.addEventListener('click', function(e) {
    if (PSB.isBalloonMode()) return; // in balloon mode clicks are part of drag; skip table scroll
    selectedRowId = row.id;
    var rowEl = document.querySelector('tr[data-row-id="' + row.id + '"]');
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rowEl.classList.add('row-flash');
      setTimeout(function() { rowEl.classList.remove('row-flash'); }, 1200);
    }
    e.stopPropagation();
  });

  group.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    e.preventDefault();
    openEditPopover(row);
  });

  group.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    deleteBalloon(row.id);
  });
}

function isOffsetSame(a, b) {
  return Math.abs(a.dx - b.dx) < 1e-6 && Math.abs(a.dy - b.dy) < 1e-6;
}

function bindLeaderHandle(handleEl, row) {
  handleEl.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var origLp = Object.assign({}, row.user.balloon.leaderConnectionPoint);

    function onMove(ev) {
      var pt = screenToPdf(ev.clientX - rect.left, ev.clientY - rect.top, viewport);
      row.user.balloon.leaderConnectionPoint = pdfPointToLeader(row.user.balloon.anchorBox, pt);
      renderOverlay(viewport);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      var nlp = row.user.balloon.leaderConnectionPoint;
      if (nlp.side !== origLp.side || Math.abs(nlp.t - origLp.t) > 1e-3) {
        PSB.pushUndo(ctx.getState(), 'Move leader #' + row.user.balloon.dimTag);
        PSB.logChange(ctx.getState().auditLog, {
          type: 'edit', rowId: row.id,
          description: 'Moved leader of #' + row.user.balloon.dimTag,
          details: [{ field: 'balloon.leaderConnectionPoint', from: origLp, to: nlp }],
        });
        ctx.onChange && ctx.onChange({ kind: 'leader', rowId: row.id });
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Hover sync (called by ui.js) ─────────────────────────
// Toggle a .hovered class on the matching balloon group instead of re-rendering
// the entire overlay — avoids dozens of SVG rebuilds per second on hover.
// For GD&T rows, also pulse the matching datum circles so the inspector can
// visually locate them on the print.
function setHoveredRow(rowId) {
  if (hoveredRowId === rowId) return;
  hoveredRowId = rowId;
  if (!svgRoot) return;
  var groups = svgRoot.querySelectorAll('.balloon-group');
  for (var i = 0; i < groups.length; i++) {
    groups[i].classList.toggle('hovered', String(rowId) === groups[i].getAttribute('data-row-id'));
  }
  // Datum hover linking — runs only for GD&T rows.
  clearDatumHighlights();
  if (rowId == null || !ctx) return;
  var state = ctx.getState();
  var row = null;
  for (var k = 0; k < state.rows.length; k++) {
    if (state.rows[k].id === rowId) { row = state.rows[k]; break; }
  }
  if (!row || !row.user.gdt || !row.user.gdt.datums) return;
  var letters = row.user.gdt.datums.map(function(d) { return d.letter; });
  letters.forEach(function(L) {
    var els = svgRoot.querySelectorAll('.datum-group[data-datum-letter="' + L + '"]');
    for (var m = 0; m < els.length; m++) els[m].classList.add('datum-highlight');
  });
}

function clearDatumHighlights() {
  if (!svgRoot) return;
  var els = svgRoot.querySelectorAll('.datum-highlight');
  for (var i = 0; i < els.length; i++) els[i].classList.remove('datum-highlight');
}

// Datum drag + right-click delete (only bound when NOT in datum mode).
function bindDatumInteractions(group, datum) {
  group.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var ptStart = screenToPdf(e.clientX - rect.left, e.clientY - rect.top, viewport);
    var origCenter = { x: datum.center.x, y: datum.center.y };
    var moved = false;

    function onMove(ev) {
      var pt = screenToPdf(ev.clientX - rect.left, ev.clientY - rect.top, viewport);
      datum.center.x = origCenter.x + (pt.x - ptStart.x);
      datum.center.y = origCenter.y + (pt.y - ptStart.y);
      moved = true;
      renderOverlay(viewport);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) {
        PSB.pushUndo(ctx.getState(), 'Move datum ' + datum.letter);
        PSB.logChange(ctx.getState().auditLog, {
          type: 'edit', rowId: null,
          description: 'Moved datum ' + datum.letter,
          details: [{ field: 'datumRefs.center', from: origCenter, to: datum.center }],
        });
        ctx.onChange && ctx.onChange({ kind: 'datum-move', letter: datum.letter });
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  group.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    deleteDatumRef(datum.id);
  });
}

// Public: clear the entire SVG overlay and reset transient state. Called by
// pdfViewer.closePdf so a fresh PDF doesn't inherit stale balloons.
function clearBalloonOverlay() {
  if (svgRoot) {
    while (svgRoot.firstChild) svgRoot.removeChild(svgRoot.firstChild);
  }
  closePopover();
  hideSpinner();
  closeDatumLetterPicker();
  removeDatumDraftCircle();
  draftBox = null;
  draftRectEl = null;
  datumDraftBox = null;
  pendingInsertAt = null;
  hoveredRowId = null;
  selectedRowId = null;
}

// ── Keyboard nudge ───────────────────────────────────────
function nudgeSelected(dx, dy) {
  if (!selectedRowId) return;
  var state = ctx.getState();
  var row = null;
  for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === selectedRowId) { row = state.rows[i]; break; }
  if (!row || !row.user.balloon) return;
  PSB.pushUndo(state, 'Nudge balloon #' + row.user.balloon.dimTag);
  row.user.balloon.balloonOffset.dx += dx;
  row.user.balloon.balloonOffset.dy += dy;
  PSB.logChange(state.auditLog, {
    type: 'edit', rowId: row.id,
    description: 'Nudged balloon #' + row.user.balloon.dimTag,
  });
  ctx.onChange && ctx.onChange({ kind: 'nudge', rowId: row.id });
  renderOverlay(PSB.getPdfViewport());
}

// ── Public API ───────────────────────────────────────────
PSB.initBalloonManager = initBalloonManager;
PSB.renderBalloonOverlay = function() { renderOverlay(PSB.getPdfViewport()); };
PSB.setHoveredBalloonRow = setHoveredRow;
PSB.deleteBalloonForRow = deleteBalloon;
PSB.setPendingBalloonInsert = setPendingInsertAt;
PSB.clearPendingBalloonInsert = clearPendingInsert;
PSB.nudgeSelectedBalloon = nudgeSelected;
PSB.getSelectedBalloonRowId = function() { return selectedRowId; };
PSB.clearBalloonOverlay = clearBalloonOverlay;
PSB.deleteDatumRef = deleteDatumRef;
