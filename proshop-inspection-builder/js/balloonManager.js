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
var BALLOON_BASE_RADIUS = 11;  // px at zoom 1.0
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

  // Re-render overlay whenever the PDF page is rendered/zoomed.
  window.addEventListener('psb:pdfPageRendered', function(e) {
    renderOverlay(e.detail.viewport);
  });
  // When balloon mode toggles, refresh the overlay (anchor box visibility differs).
  window.addEventListener('psb:balloonModeChanged', function() {
    renderOverlay(PSB.getPdfViewport());
  });

  // Canvas mouse handlers for draw-box in balloon mode.
  attachDrawBoxHandlers();
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

// ── Draw-box (balloon mode) ──────────────────────────────
function attachDrawBoxHandlers() {
  var wrap = PSB.getPdfCanvasWrap();
  if (!wrap) return;

  var dragStart = null;

  wrap.addEventListener('mousedown', function(e) {
    if (!PSB.isBalloonMode() || !PSB.hasPdf()) return;
    if (e.button !== 0) return;

    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
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

// ── OCR + confirmation popover ───────────────────────────
function runOcrAndConfirm(anchorBox) {
  var doc = PSB.getPdfDoc();
  if (!doc) return;
  var pageNum = PSB.getPdfCurrentPage();
  showSpinner(anchorBox);

  doc.getPage(pageNum).then(function(page) {
    var viewport = PSB.getPdfViewport();
    return PSB.ocrEngine.extractDimension(page, anchorBox, viewport, {
      onProgress: function(stage) { updateSpinnerStage(stage); },
    });
  }).then(function(result) {
    hideSpinner();
    showPopover(anchorBox, pageNum, result);
  }).catch(function(err) {
    console.warn('[Balloon] OCR pipeline failed:', err);
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
  else if (stage === 'tesseract') lbl.textContent = 'OCR…';
  else if (stage === 'claude') lbl.textContent = '☁ Sending crop to Claude OCR…';
  else if (stage === 'done') lbl.textContent = 'Done';
}
function hideSpinner() {
  if (spinnerEl && spinnerEl.parentNode) {
    spinnerEl.parentNode.removeChild(spinnerEl);
  }
  spinnerEl = null;
}

function showPopover(anchorBox, pageNum, ocrResult) {
  if (popoverEl) closePopover();

  var viewport = PSB.getPdfViewport();
  if (!viewport) return;
  var sBox = pdfRectToScreen(anchorBox, viewport);
  var parsed = ocrResult.parsed || {};
  var lowConf = parsed.confidence === 'low' || ocrResult.ocrConfidence < 0.6;
  var ocrFailed = !ocrResult.engine;

  popoverEl = document.createElement('div');
  popoverEl.className = 'balloon-popover';
  popoverEl.innerHTML =
    '<div class="balloon-popover-arrow"></div>' +
    '<div class="balloon-popover-header">' +
      'New Balloon' +
      (ocrResult.engine ? ' <span class="balloon-popover-engine">via ' + ocrResult.engine + '</span>' : '') +
    '</div>' +
    (ocrFailed
      ? '<div class="balloon-popover-warn">OCR could not read this area — enter values manually</div>'
      : (lowConf ? '<div class="balloon-popover-warn">⚠ Low confidence — please verify</div>' : '')) +
    '<div class="balloon-popover-field"><label>Drawing Spec</label>' +
      '<input type="text" class="bp-spec" value="' + escapeAttr(parsed.drawingSpec || '') + '" /></div>' +
    '<div class="balloon-popover-field"><label>Tolerance</label>' +
      '<input type="text" class="bp-tol" value="' + escapeAttr(parsed.tolerance || '') + '" /></div>' +
    '<div class="balloon-popover-field"><label>Spec Unit 2</label>' +
      '<input type="text" class="bp-su2" value="' + escapeAttr(parsed.specUnit2 || '') + '" /></div>' +
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
  var inTol  = popoverEl.querySelector('.bp-tol');
  var inSu2  = popoverEl.querySelector('.bp-su2');
  popoverEl.querySelector('.bp-cancel').addEventListener('click', closePopover);
  popoverEl.querySelector('.bp-confirm').addEventListener('click', function() {
    confirmPopover(anchorBox, pageNum, ocrResult);
  });
  popoverEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); confirmPopover(anchorBox, pageNum, ocrResult); }
    if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
  });
  setTimeout(function() { inSpec && inSpec.focus(); inSpec && inSpec.select(); }, 0);

  // Stash inputs on the popover for confirmPopover to read.
  popoverEl._inputs = { spec: inSpec, tol: inTol, su2: inSu2 };
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
  var parsed = Object.assign({}, ocrResult.parsed || {}, {
    drawingSpec: ins.spec.value.trim(),
    tolerance: ins.tol.value.trim(),
    specUnit2: ins.su2.value.trim(),
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
    pendingInsertAt = null;
    renumberShiftUp(newDimTag);
  } else {
    newDimTag = existingMax + 1;
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
  PSB.recompute(row, state.globals);
  state.rows.push(row);
  sortRowsByEffectiveDimTag(state);

  PSB.logChange(state.auditLog, {
    type: 'add', rowId: row.id,
    description: 'Added balloon #' + newDimTag,
    details: [{ field: 'balloon', from: null, to: { dimTag: newDimTag, page: pageNum } }],
  });

  ctx.onChange && ctx.onChange({ kind: 'add', rowId: row.id });
  renderOverlay(PSB.getPdfViewport());
}

function defaultBalloonOffset(box, dir) {
  var pad = 30;
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

  // Align overlay to canvas.
  svgRoot.setAttribute('width', viewport.width);
  svgRoot.setAttribute('height', viewport.height);
  svgRoot.style.width = viewport.width + 'px';
  svgRoot.style.height = viewport.height + 'px';

  var state = ctx.getState();
  var pageNum = PSB.getPdfCurrentPage();
  var balloonMode = PSB.isBalloonMode();
  var radius = BALLOON_BASE_RADIUS * (viewport.scale || PSB.getPdfZoom() || 1.0);

  state.rows.forEach(function(row) {
    var b = row.user.balloon;
    if (!b || b.page !== pageNum) return;

    // Anchor box (dashed red, only in balloon mode)
    if (balloonMode) {
      var s = pdfRectToScreen(b.anchorBox, viewport);
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

    // Suppress leader if very close (≤5px screen)
    var dist = Math.hypot(balloonScreen.x - connScreen.x, balloonScreen.y - connScreen.y);
    if (dist > 5) {
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

    if (row.id === hoveredRowId) {
      var ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', 0); ring.setAttribute('cy', 0);
      ring.setAttribute('r', radius + 4);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#ffaa00');
      ring.setAttribute('stroke-width', '2');
      group.insertBefore(ring, circle);
    }

    bindBalloonInteractions(group, row);
    svgRoot.appendChild(group);

    // Leader connection-point handle (small square at connScreen) — only in balloon mode
    if (balloonMode) {
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

// ── Balloon drag / right-click / hover ──────────────────
function bindBalloonInteractions(group, row) {
  group.addEventListener('mousedown', function(e) {
    if (PSB.isBalloonMode()) return; // balloon mode reserves the canvas for drawing
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    var viewport = PSB.getPdfViewport();
    if (!viewport) return;
    var canvas = PSB.getPdfCanvas();
    var rect = canvas.getBoundingClientRect();
    var ptStart = screenToPdf(e.clientX - rect.left, e.clientY - rect.top, viewport);
    var origOffset = Object.assign({}, row.user.balloon.balloonOffset);
    var anchorCenter = {
      x: row.user.balloon.anchorBox.x + row.user.balloon.anchorBox.w / 2,
      y: row.user.balloon.anchorBox.y + row.user.balloon.anchorBox.h / 2,
    };

    var undoPushed = false;
    function onMove(ev) {
      var pt = screenToPdf(ev.clientX - rect.left, ev.clientY - rect.top, viewport);
      var dx = pt.x - ptStart.x;
      var dy = pt.y - ptStart.y;
      row.user.balloon.balloonOffset = { dx: origOffset.dx + dx, dy: origOffset.dy + dy };
      // Suppress anchorCenter unused warning
      void anchorCenter;
      renderOverlay(viewport);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!isOffsetSame(origOffset, row.user.balloon.balloonOffset)) {
        if (!undoPushed) { PSB.pushUndo(ctx.getState(), 'Move balloon #' + row.user.balloon.dimTag); undoPushed = true; }
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
  });

  group.addEventListener('click', function(e) {
    if (PSB.isBalloonMode()) return;
    selectedRowId = row.id;
    // Scroll & highlight the table row
    var rowEl = document.querySelector('tr[data-row-id="' + row.id + '"]');
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rowEl.classList.add('row-flash');
      setTimeout(function() { rowEl.classList.remove('row-flash'); }, 1200);
    }
    e.stopPropagation();
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
function setHoveredRow(rowId) {
  if (hoveredRowId === rowId) return;
  hoveredRowId = rowId;
  renderOverlay(PSB.getPdfViewport());
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
