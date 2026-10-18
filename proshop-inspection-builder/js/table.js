/**
 * table.js — Table drawing (moved out of ui.js, no behavior change)
 *
 * - renderTable: draws the main table from row.computed
 * - Plan/Drawing rows (buildRowHTML) and FAI rows (buildFaiFamilyHTML)
 * - Column headers, sorting, SU1 / CMM tag column toggles
 * - FAI notes + re-tag editing, OP bubbles, balloon insert rows
 *
 * Shares ui.js globals (getAppState, sortColumn, currentViewConfig, ...).
 */

// Color palette for FAI run pills — cycles if more than 8 runs
var FAI_RUN_COLORS = [
  { bg: 'rgba(74,158,255,0.15)',  border: '#4a9eff', text: '#6bb3ff' },
  { bg: 'rgba(255,140,66,0.15)', border: '#ff8c42', text: '#ffaa60' },
  { bg: 'rgba(76,175,80,0.15)',  border: '#4caf50', text: '#6dc970' },
  { bg: 'rgba(224,64,251,0.15)', border: '#e040fb', text: '#ea70fb' },
  { bg: 'rgba(255,82,82,0.15)',  border: '#ff5252', text: '#ff7070' },
  { bg: 'rgba(0,188,212,0.15)',  border: '#00bcd4', text: '#40d4e8' },
  { bg: 'rgba(255,193,7,0.15)',  border: '#ffc107', text: '#ffcf3f' },
  { bg: 'rgba(255,110,64,0.15)', border: '#ff6e40', text: '#ff8a65' },
];

/**
 * Render the full table from rows.
 * Call this after any data change.
 *
 * @param {Object} stateOrRows — full state object { rows, globals, ... } OR array of rows (legacy)
 * @param {Object} [viewConfig] — view config object from VIEW_CONFIGS; defaults to setup view
 */
function renderTable(stateOrRows, viewConfig) {
  // Accept either a full state object or a rows array (backward compatibility)
  var rows;
  if (Array.isArray(stateOrRows)) {
    rows = stateOrRows;
  } else if (stateOrRows && stateOrRows.rows) {
    rows = stateOrRows.rows;
  } else {
    rows = [];
  }

  // Default to setup view if no config provided
  if (!viewConfig) {
    viewConfig = { id: 'setup' };
  }
  currentViewConfig = viewConfig;

  var isFaiView = viewConfig.id === 'fai';

  var tbody = document.getElementById('table-body');
  var table = document.getElementById('data-table');
  var emptyState = document.getElementById('empty-state');

  if (!rows || rows.length === 0) {
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  table.classList.remove('hidden');
  emptyState.classList.add('hidden');

  // Update table headers based on view
  updateTableHeaders(isFaiView);

  // Sort rows if sort is active
  var displayRows = rows.slice();
  if (sortColumn) {
    displayRows.sort(function(a, b) {
      var aVal = getCellValue(a, sortColumn);
      var bVal = getCellValue(b, sortColumn);
      var cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }

  // Build table rows
  tbody.innerHTML = '';
  var balloonMode = !isFaiView && PSB.isBalloonMode && PSB.isBalloonMode();
  for (var i = 0; i < displayRows.length; i++) {
    var row = displayRows[i];

    // FAI view: emit one or more complete <tr> elements and move on
    if (isFaiView) {
      tbody.insertAdjacentHTML('beforeend', buildFaiFamilyHTML(row));
      continue;
    }

    // Balloon-mode insert gutter: a thin row with a "+" that targets this row's dimTag.
    if (balloonMode) {
      tbody.appendChild(buildBalloonInsertTr(row, i, displayRows.length));
    }

    // Setup view path
    var tr = document.createElement('tr');
    tr.dataset.rowId = row.id;
    bindBalloonHoverSync(tr, row.id);

    if (row.computed.isNote) tr.classList.add('is-note');
    if (row.user.notOnPrint) tr.classList.add('not-on-print');
    if (row.id === selectedRowId) tr.classList.add('selected');

    tr.innerHTML = buildRowHTML(row);

    // Row click → select + open sidebar (only in setup view)
    (function(rowId) {
      tr.addEventListener('click', function() { selectRow(rowId); });
    })(row.id);

    // Inline editing for editable cells
    setupInlineEditing(tr, row);

    // OP bubble click → toggle on/off (same as sidebar)
    setupOpBubbleClicks(tr, row);

    // Delete row button
    (function(rowId) {
      var delBtn = tr.querySelector('.delete-row-btn');
      if (delBtn) {
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          PSB.showConfirmModal({
            title: 'Delete Row?',
            message: 'Delete row <strong>' + esc(String(row.computed.dimTag || rowId)) + '</strong>? This cannot be undone.',
            confirmLabel: 'Delete',
            confirmClass: 'btn-danger',
            onConfirm: function() { if (onDeleteRow) onDeleteRow(rowId); }
          });
        });
      }
    })(row.id);

    tbody.appendChild(tr);

    // Apply edit flash if this row/column was just edited
    if (flashCellKey) {
      var parts = flashCellKey.split('|');
      if (row.id === parseInt(parts[0])) {
        var flashTd = tr.querySelector('.' + parts[1]);
        if (flashTd) {
          flashTd.classList.add('edit-flash');
          setTimeout(function() { flashTd.classList.remove('edit-flash'); }, 600);
        }
        flashCellKey = null;
      }
    }
  }

  // Final gutter "+" below the last row (balloon mode only)
  if (balloonMode && displayRows.length > 0) {
    tbody.appendChild(buildBalloonInsertTr(null, displayRows.length, displayRows.length));
  }

  // Add row button at the bottom (setup view only)
  if (!isFaiView) {
    var addTr = document.createElement('tr');
    addTr.className = 'add-row-tr';
    addTr.innerHTML = '<td colspan="12" class="add-row-cell"><button class="add-row-btn" title="Add empty row">+</button></td>';
    addTr.querySelector('.add-row-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      if (onAddRow) onAddRow();
    });
    tbody.appendChild(addTr);
  }

  // FAI view: freeze Status / Dim Tag / Drawing Spec on horizontal scroll
  table.classList.toggle('fai-view', isFaiView);
  if (isFaiView) updateFaiFrozenOffsets();

  // Resolve tab-navigation target after full table is built
  if (navigateTarget) {
    resolveNavigateTarget(tbody, displayRows);
    navigateTarget = null;
  }
}

/**
 * Set the sticky left offsets for the frozen FAI columns.
 * Column widths depend on content, so they are measured after render.
 */
var faiFrozenObserver = null;
function updateFaiFrozenOffsets() {
  var table = document.getElementById('data-table');
  if (!table || !table.classList.contains('fai-view')) return;
  var statusTh = table.querySelector('thead th.col-fai-status');
  var dimTagTh = table.querySelector('thead th.col-dimtag');
  if (!statusTh || !dimTagTh) return;
  var w1 = statusTh.getBoundingClientRect().width;
  var w2 = dimTagTh.getBoundingClientRect().width;
  table.style.setProperty('--fai-frozen-left-2', w1 + 'px');
  table.style.setProperty('--fai-frozen-left-3', (w1 + w2) + 'px');
  if (!faiFrozenObserver && window.ResizeObserver) {
    faiFrozenObserver = new ResizeObserver(function() { updateFaiFrozenOffsets(); });
    faiFrozenObserver.observe(table);
  }
}

// ── CMM Tag column (FAI view) — opened/closed by the bar between Print and CMM data ──
var CMM_TAG_COL_KEY = 'psb_fai_cmm_tag_open';
var cmmTagColOpen = (function() {
  try { return localStorage.getItem(CMM_TAG_COL_KEY) === '1'; } catch (e) { return false; }
})();
var CMM_SEP_TD = '<td class="col-cmm-sep" title="Show / hide CMM dim tags"></td>';

function cmmSepHeaderHTML() {
  return '<th class="col-cmm-sep th-cmm-sep" rowspan="2" title="' +
    (cmmTagColOpen ? 'Hide CMM dim tags' : 'Show CMM dim tags — double-click a tag there to change it') + '">' +
    (cmmTagColOpen ? '‹' : '›') + '</th>';
}

function toggleCmmTagColumn() {
  cmmTagColOpen = !cmmTagColOpen;
  try { localStorage.setItem(CMM_TAG_COL_KEY, cmmTagColOpen ? '1' : '0'); } catch (e) {}
  var st = getAppState && getAppState();
  if (st) renderTable(st, currentViewConfig);
}

/** Click anywhere on the separator bar (header or body) toggles the CMM Tag column. */
function setupCmmSepToggle() {
  var table = document.getElementById('data-table');
  if (!table) return;
  table.addEventListener('click', function(e) {
    var sep = e.target.closest ? e.target.closest('.col-cmm-sep') : null;
    if (!sep) return;
    e.stopPropagation();
    toggleCmmTagColumn();
  });
}

// ── SU1 column: collapsed to a few characters (ProShop notes live here) ──
// Short values (Ø, ⌴, 2X) show in full. Longer text is clipped with "…";
// click it to open that cell, or the ⇔ button in the header to open all.
var SU1_ALL_OPEN_KEY = 'psb_su1_all_open';
var SU1_TOGGLE_BTN = ' <button type="button" class="su1-toggle-all" title="Show / hide full SU1 text">⇔</button>';
var SU1_SHORT_MAX = 4;

function su1CellHTML(text) {
  text = text == null ? '' : String(text);
  if (text.length <= SU1_SHORT_MAX) return esc(text);
  return '<span class="su1-long" title="' + esc(text) + '\n(click to expand)">' + esc(text) + '</span>';
}

function applySu1AllOpen() {
  var table = document.getElementById('data-table');
  if (!table) return;
  var open = false;
  try { open = localStorage.getItem(SU1_ALL_OPEN_KEY) === '1'; } catch (e) {}
  table.classList.toggle('su1-all-open', open);
}

function setupSu1Expand() {
  var table = document.getElementById('data-table');
  if (!table) return;
  applySu1AllOpen();
  table.addEventListener('click', function(e) {
    if (!e.target.closest) return;
    if (e.target.closest('.su1-toggle-all')) {
      e.stopPropagation();  // don't sort the column
      var open = !table.classList.contains('su1-all-open');
      try { localStorage.setItem(SU1_ALL_OPEN_KEY, open ? '1' : '0'); } catch (err) {}
      applySu1AllOpen();
      return;
    }
    var long = e.target.closest('.su1-long');
    if (long) {
      e.stopPropagation();  // don't select the row
      var td = long.closest('td');
      if (td) td.classList.toggle('su1-open');
    }
  }, true);
}

/**
 * Update table header cells based on the active view.
 */
function updateTableHeaders(isFaiView) {
  var thead = document.querySelector('#data-table thead');
  if (!thead) return;

  if (isFaiView) {
    thead.innerHTML =
      '<tr>' +
        '<th class="th-group-print fai-frozen-group" colspan="3">Print Data</th>' +
        '<th class="th-group-print" colspan="6"></th>' +
        cmmSepHeaderHTML() +
        '<th class="th-group-cmm" colspan="' + (cmmTagColOpen ? 6 : 5) + '">CMM Data</th>' +
      '</tr>' +
      '<tr>' +
        '<th class="col-fai-status">Status</th>' +
        '<th data-col="dimTag" class="col-dimtag">Dim Tag</th>' +
        '<th class="col-drawing-spec">Drawing Spec</th>' +
        '<th class="col-su1">SU1' + SU1_TOGGLE_BTN + '</th>' +
        '<th class="col-su2">SU2</th>' +
        '<th class="col-su3">SU3</th>' +
        '<th class="col-plating">Plating</th>' +
        '<th class="col-op2000-tol">OP2000 Tol</th>' +
        '<th class="col-out-tol">OUT Tol</th>' +
        (cmmTagColOpen ? '<th class="col-cmm-tag">CMM Tag</th>' : '') +
        '<th class="col-cmm-tol">CMM Tol</th>' +
        '<th class="col-cmm-nominal">Nominal</th>' +
        '<th class="col-measured">Measured</th>' +
        '<th class="col-deviation">Deviation</th>' +
        '<th class="col-run">Run</th>' +
      '</tr>';
  } else {
    thead.innerHTML =
      '<tr>' +
        '<th data-col="status" class="col-status">Status</th>' +
        '<th data-col="dimTag" class="col-dimtag">Dim Tag</th>' +
        '<th data-col="specUnit1" class="col-su1">SU1' + SU1_TOGGLE_BTN + '</th>' +
        '<th data-col="outDrawingSpec" class="col-drawspec">OUT Drawing Spec</th>' +
        '<th data-col="op2000Spec" class="col-inputspec">OP2000 Spec</th>' +
        '<th data-col="specUnit2" class="col-su2">SU2</th>' +
        '<th data-col="specUnit3" class="col-su3">SU3</th>' +
        '<th data-col="pinGage" class="col-pingage">Pin/Gage</th>' +
        '<th data-col="op2000Tol" class="col-inputtol">OP2000 Tol</th>' +
        '<th data-col="outTolerance" class="col-outtol">OUT Tol</th>' +
        '<th data-col="plating" class="col-plating">Plating</th>' +
        '<th data-col="ops" class="col-ops">OPs</th>' +
      '</tr>';
    // Re-bind header sorting after DOM change
    setupTableHeaderClicks();
  }
}

/**
 * Build one or more complete <tr>...</tr> HTML strings for a FAI view row.
 * Returns a parent row, and for multiple measurements also child rows.
 */
function buildFaiFamilyHTML(row) {
  var c = row.computed;
  var fai = row.fai;
  var appState = getAppState();
  var compareMode = (currentViewConfig && currentViewConfig.compareMode) || 'op2000';
  var warnThreshold = (appState && appState.globals && appState.globals.faiWarnThreshold) || 0.80;
  var planUnits = PSB.getPrintUnits(appState && appState.globals);
  var isAngle = c.isAngle || false;

  // Plan tolerance values
  var op2kTolPlus  = c.op2kTolPlus  || 0;
  var op2kTolMinus = c.op2kTolMinus || 0;
  var outTolPlus   = (c.output && c.output.tolPlus  != null) ? c.output.tolPlus  : op2kTolPlus;
  var outTolMinus  = (c.output && c.output.tolMinus != null) ? c.output.tolMinus : op2kTolMinus;

  // Pass/fail limits: plan tol (by compare mode), or CMM tol when the plan has none
  function gradeMeasurement(m) {
    return PSB.computeFaiMeasurementStatus(c, m, compareMode, warnThreshold);
  }

  // Format tolerance string helper (inline)
  function tolStr(plus, minus) {
    if (!plus && !minus) return '—';
    if (Math.abs(plus - minus) < 1e-10) return '±' + String(plus);
    // Signed limits: minus is "below nominal", so a unilateral lower tol shows as +
    function signed(v) { return (v < 0 ? '-' : '+') + String(Math.abs(v)); }
    return signed(plus) + ' / ' + signed(-minus);
  }

  var op2kTolDisplay = tolStr(op2kTolPlus, op2kTolMinus);
  var outTolDisplay  = tolStr(outTolPlus, outTolMinus);
  var platingLabel = (c.platingMode && c.platingMode !== 'none') ? c.platingMode : '';

  var faiRuns = appState && appState.faiRuns;

  // The 9 print-data cells (same for parent and no-measurement rows)
  var specHtml = formatDualDisplay(c.op2000DualSpec || c.outDrawingSpec || '');
  var printCells =
    '<td class="col-fai-status">{STATUS}</td>' +
    '<td class="col-dimtag">' + esc(c.dimTag) + refBadgeHTML(row) + '</td>' +
    '<td class="col-drawing-spec">' + specHtml + '</td>' +
    '<td class="col-su1">' + su1CellHTML(c.specUnit1) + '</td>' +
    '<td class="col-su2">' + esc(c.specUnit2 || '') + '</td>' +
    '<td class="col-su3">' + esc(c.specUnit3 || '') + '</td>' +
    '<td class="col-plating">' + esc(platingLabel) + '</td>' +
    '<td class="col-op2000-tol">' + esc(op2kTolDisplay) + '</td>' +
    '<td class="col-out-tol">' + esc(outTolDisplay) + '</td>' +
    CMM_SEP_TD;

  // CMM Tag cell (only when the column is open): the tag the CMM report used,
  // "#8 → 9" if re-tagged, + the CMM feature name. Double-click to change.
  function cmmTagCell(mi, m) {
    if (!cmmTagColOpen) return '';
    var retagged = Object.prototype.hasOwnProperty.call(m, 'originalTag');
    var tagHtml = retagged
      ? '<span class="cmm-tag-old">' + (m.originalTag != null ? '#' + esc(String(m.originalTag)) : 'none') + '</span>' +
        ' → <span class="cmm-tag-new">' + esc(String(c.dimTag)) + '</span>'
      : '<span class="cmm-tag-num">#' + esc(String(c.dimTag)) + '</span>';
    return '<td class="col-cmm-tag" data-retag-row="' + esc(String(row.id)) + '" data-retag-mi="' + mi + '"' +
      ' data-retag-current="' + esc(String(c.dimTag)) + '"' +
      ' title="' + esc((m.cmmName || '') + '\nDouble-click to change the CMM dim tag') + '">' +
      tagHtml + ' <span class="cmm-tag-name">' + esc(m.cmmName || '') + '</span></td>';
  }

  // Status badge helper
  function statusBadge(status) {
    var cls = status ? 'fai-badge fai-' + status : 'fai-badge fai-none';
    var lbl = status ? status.toUpperCase() : '—';
    return '<span class="' + cls + '">' + esc(lbl) + '</span>';
  }

  // No measurements
  if (!fai || !fai.measurements || fai.measurements.length === 0) {
    return '<tr>' + printCells.replace('{STATUS}', statusBadge(null)) +
      (cmmTagColOpen ? '<td class="col-cmm-tag">—</td>' : '') +
      '<td class="col-cmm-tol">—</td>' +
      '<td class="col-cmm-nominal">—</td>' +
      '<td class="col-measured">—</td>' +
      '<td class="col-deviation">—</td>' +
      '<td class="col-run">—</td>' +
      '</tr>';
  }

  var measurements = fai.measurements;

  // Single measurement — simple full row
  if (measurements.length === 1) {
    var m = measurements[0];
    var status = gradeMeasurement(m);
    var devTint = status ? ' dev-tint-' + status : '';
    return '<tr>' +
      printCells.replace('{STATUS}', statusBadge(status)) +
      cmmTagCell(0, m) +
      '<td class="col-cmm-tol">' + esc(tolStr(m.plusTol, m.minusTol)) + '</td>' +
      '<td class="col-cmm-nominal">' + formatDualDisplay(buildCmmDualString(m.nominal, planUnits, isAngle)) + '</td>' +
      '<td class="col-measured">' + formatDualDisplay(buildCmmDualString(m.measured, planUnits, isAngle)) + '</td>' +
      '<td class="col-deviation' + devTint + '">' + formatDualDisplay(buildCmmDualString(m.deviation, planUnits, isAngle)) + '</td>' +
      '<td class="col-run" title="' + esc(m.cmmName || '') + '">' + getRunPill(m.runId, faiRuns) + '</td>' +
      '</tr>';
  }

  // Multiple measurements — parent row + child rows

  // Min/max across all measurements
  var measVals = measurements.map(function(m) { return m.measured; });
  var devVals  = measurements.map(function(m) { return m.deviation; });
  var measMin = Math.min.apply(null, measVals);
  var measMax = Math.max.apply(null, measVals);
  var devMin  = Math.min.apply(null, devVals);
  var devMax  = Math.max.apply(null, devVals);

  // Aggregate status for parent — same grading as the child rows
  var aggStatus = PSB.computeAggregateStatus(measurements.map(function(m) {
    return { status: gradeMeasurement(m) };
  }));

  // Parent CMM tol: use first measurement (assume same spec for all in group)
  var parentCmmTol = tolStr(measurements[0].plusTol, measurements[0].minusTol);

  // Stacked high/low cells with dual unit
  var measRangeHtml = buildCmmRangeStack(measMin, measMax, planUnits, isAngle);
  var devRangeHtml  = buildCmmRangeStack(devMin, devMax, planUnits, isAngle);

  // Collect distinct run IDs (in order of first appearance) for parent pills
  var seenRunIds = {};
  var uniqueRunIds = [];
  for (var mi2 = 0; mi2 < measurements.length; mi2++) {
    var rid = measurements[mi2].runId;
    if (!seenRunIds[rid]) { seenRunIds[rid] = true; uniqueRunIds.push(rid); }
  }
  var parentRunHtml = '';
  for (var ri2 = 0; ri2 < uniqueRunIds.length; ri2++) {
    parentRunHtml += '<div>' + getRunPill(uniqueRunIds[ri2], faiRuns) + '</div>';
  }

  var parentDevTint = aggStatus ? ' dev-tint-' + aggStatus : '';
  var html = '<tr class="fai-parent-row has-children">' +
    printCells.replace('{STATUS}', statusBadge(aggStatus)) +
    (cmmTagColOpen ? '<td class="col-cmm-tag"></td>' : '') +
    '<td class="col-cmm-tol">' + esc(parentCmmTol) + '</td>' +
    '<td class="col-cmm-nominal">—</td>' +
    '<td class="col-measured">' + measRangeHtml + '</td>' +
    '<td class="col-deviation' + parentDevTint + '">' + devRangeHtml + '</td>' +
    '<td class="col-run"><div class="cmm-range-stack">' + parentRunHtml + '</div></td>' +
    '</tr>';

  // Child rows
  for (var mi = 0; mi < measurements.length; mi++) {
    var m = measurements[mi];
    var mStatus = gradeMeasurement(m);
    var mDevTint = mStatus ? ' dev-tint-' + mStatus : '';
    var isLast = (mi === measurements.length - 1);
    html += '<tr class="fai-child-row' + (isLast ? ' fai-last-child' : '') + '">' +
      '<td class="col-fai-status">' + statusBadge(mStatus) + '</td>' +
      '<td class="col-dimtag fai-child-indent" title="' + esc(m.cmmName || '') + '">' + esc(String(c.dimTag)) + '</td>' +
      '<td class="col-drawing-spec"></td>' +
      '<td class="col-su1"></td>' +
      '<td class="col-su2"></td>' +
      '<td class="col-su3"></td>' +
      '<td class="col-plating"></td>' +
      '<td class="col-op2000-tol"></td>' +
      '<td class="col-out-tol"></td>' +
      CMM_SEP_TD +
      cmmTagCell(mi, m) +
      '<td class="col-cmm-tol">' + esc(tolStr(m.plusTol, m.minusTol)) + '</td>' +
      '<td class="col-cmm-nominal">' + formatDualDisplay(buildCmmDualString(m.nominal, planUnits, isAngle)) + '</td>' +
      '<td class="col-measured">' + formatDualDisplay(buildCmmDualString(m.measured, planUnits, isAngle)) + '</td>' +
      '<td class="col-deviation' + mDevTint + '">' + formatDualDisplay(buildCmmDualString(m.deviation, planUnits, isAngle)) + '</td>' +
      '<td class="col-run" title="' + esc(m.cmmName || '') + '">' + getRunPill(m.runId, faiRuns) + '</td>' +
      '</tr>';
  }

  return html;
}

/**
 * Set up inline notes editing for FAI view rows.
 */
function setupFaiNotesEditing(tr, row) {
  var notesTd = tr.querySelector('.col-fai-notes');
  if (!notesTd) return;

  notesTd.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    if (notesTd.querySelector('input')) return;

    var originalValue = notesTd.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = originalValue;
    input.className = 'inline-edit-input';
    notesTd.textContent = '';
    notesTd.appendChild(input);
    input.focus();
    input.select();

    var committed = false;
    var commit = function() {
      if (committed) return;
      committed = true;
      var newValue = input.value;
      notesTd.textContent = newValue;

      // Update the last measurement's notes
      if (row.fai && row.fai.measurements && row.fai.measurements.length > 0) {
        row.fai.measurements[row.fai.measurements.length - 1].notes = newValue;
        if (PSB.onProjectEdited) PSB.onProjectEdited();
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ke) {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') {
        committed = true;
        notesTd.textContent = originalValue;
      }
    });
  });
}

/**
 * FAI view: double-click a measurement's dim tag to move it to another tag.
 * One delegated listener on the table body (FAI rows are rebuilt as HTML).
 */
function setupFaiRetagEditing() {
  var tbody = document.getElementById('table-body');
  if (!tbody) return;
  tbody.addEventListener('dblclick', function(e) {
    var td = e.target.closest ? e.target.closest('td[data-retag-row]') : null;
    if (!td || td.querySelector('input')) return;
    e.stopPropagation();

    var rowId = td.getAttribute('data-retag-row');
    var mi = parseInt(td.getAttribute('data-retag-mi'), 10);
    var originalHtml = td.innerHTML;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = td.getAttribute('data-retag-current') || '';
    input.className = 'inline-edit-input';
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      var newTag = input.value.trim();
      td.innerHTML = originalHtml;
      if (save && newTag && onFaiRetag) onFaiRetag(rowId, mi, newTag);
    }
    input.addEventListener('blur', function() { finish(true); });
    input.addEventListener('keydown', function(ke) {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') finish(false);
    });
  });
}

/**
 * Small "REF" badge for dims that are not on the print.
 */
function refBadgeHTML(row) {
  return row.user.notOnPrint
    ? ' <span class="ref-only-badge" title="Not on print — REF only, skipped in OP2000 export">REF</span>'
    : '';
}

/**
 * Build the HTML for a single table row.
 */
function buildRowHTML(row) {
  var c = row.computed;
  var statusClass = 'status-' + (c.status || 'none');

  // OP display: render colored bubbles for all available OPs
  var state = getAppState();
  var allOps = state ? state.globals.ops : [];
  var enabledOps = c.includeOps || {};
  var opBubblesHTML = '<div class="op-bubbles">';
  for (var oi = 0; oi < allOps.length; oi++) {
    var op = allOps[oi];
    if (op === 2000) continue; // OP2000 is export-only, not shown in table
    var color = getOpColor(op);
    var isActive = enabledOps[op] ? ' active' : '';
    opBubblesHTML += '<span class="op-bubble' + isActive + '" style="--op-c:' + color + ';" data-op="' + op + '">' + op + '</span>';
  }
  opBubblesHTML += '</div>';

  var ov = row.user.overrides || {};

  return '' +
    '<td class="col-status"><span class="status-dot ' + statusClass + '"></span><button class="delete-row-btn" title="Delete row">&times;</button></td>' +
    '<td class="col-dimtag">' + esc(c.dimTag) + refBadgeHTML(row) + '</td>' +
    '<td class="col-su1 editable">' + su1CellHTML(c.specUnit1) + '</td>' +
    '<td class="col-drawspec editable' + (ov.outputSpec !== null ? ' has-override' : '') + '">' + formatDualDisplay(c.outDrawingSpec) +
      (row.user.gdt
        ? ' <span class="gdt-info-badge" data-gdt-char="' + esc(row.user.gdt.characteristic) + '" tabindex="0" aria-label="GD&T info">ℹ</span>'
        : '') +
    '</td>' +
    '<td class="col-inputspec editable' + (ov.outDrawingSpec !== null ? ' has-override' : '') + '">' + formatDualDisplay(c.op2000DualSpec) + '</td>' +
    '<td class="col-su2 editable">' + esc(c.specUnit2) + '</td>' +
    '<td class="col-su3 editable">' + esc(c.specUnit3) + '</td>' +
    '<td class="col-pingage editable' + (ov.pinGageValue !== null ? ' has-override' : '') + '">' + esc(addLeadingZero(c.pinGage)) + '</td>' +
    '<td class="col-inputtol editable' + ((ov.outTolPlus !== null || ov.outTolMinus !== null) ? ' has-override' : '') + '">' + formatDualDisplay(tolDisplay(c.op2000DualTol)) + '</td>' +
    '<td class="col-outtol editable' + ((ov.outputTolPlus !== null || ov.outputTolMinus !== null) ? ' has-override' : '') + '">' + formatDualDisplay(tolDisplay(c.outTolerance)) + '</td>' +
    '<td class="col-plating">' + esc(c.platingMode !== 'none' ? c.platingMode : '') + '</td>' +
    '<td class="col-ops">' + opBubblesHTML + '</td>';
}

// ── Table Header Sorting ──────────────────────────────────

function setupTableHeaderClicks() {
  var headers = document.querySelectorAll('#data-table th[data-col]');
  for (var i = 0; i < headers.length; i++) {
    (function(th) {
      th.addEventListener('click', function() {
        var col = th.dataset.col;
        if (sortColumn === col) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = col;
          sortDirection = 'asc';
        }

        // Update header classes
        var allHeaders = document.querySelectorAll('#data-table th');
        for (var j = 0; j < allHeaders.length; j++) {
          allHeaders[j].classList.remove('sorted-asc', 'sorted-desc');
        }
        th.classList.add('sorted-' + sortDirection);

        // Re-render with current data
        var state = getAppState();
        if (state) renderTable(state, currentViewConfig);
      });
    })(headers[i]);
  }
}

// ── OP Bubble Clicks (table) ──────────────────────────────

function setupOpBubbleClicks(tr, row) {
  var bubbles = tr.querySelectorAll('.op-bubble[data-op]');
  for (var i = 0; i < bubbles.length; i++) {
    (function(bubble) {
      bubble.addEventListener('click', function(e) {
        e.stopPropagation(); // Don't trigger row select
        var opNum = parseInt(bubble.dataset.op);
        var newInclude = Object.assign({}, row.user.includeOps);
        newInclude[opNum] = !newInclude[opNum];
        // Immediate visual toggle
        if (newInclude[opNum]) {
          bubble.classList.add('active');
        } else {
          bubble.classList.remove('active');
        }
        onRowUserChange(row.id, { includeOps: newInclude });
      });
    })(bubbles[i]);
  }
}

/**
 * Add leading zero to bare decimals (UI only).
 * ".1388" → "0.1388", "-.005" → "-0.005", "3.500" unchanged.
 * Works inside bracket notation: ".1388 [.005]" → "0.1388 [0.005]"
 */
function addLeadingZero(str) {
  if (!str) return str;
  return String(str).replace(/(^|[^0-9])\.(\d)/g, '$10.$2');
}

/**
 * Build a dual-unit display string for a CMM numeric value.
 * Primary keeps all CMM decimals; secondary is padded to 4 (mm) / 5 (inch) decimals.
 */
function buildCmmDualString(value, planUnits, isAngle) {
  if (value == null || isNaN(value)) return '—';
  var primary = String(value);
  if (isAngle) return primary + ' [Angle]';
  var otherUnit = planUnits === 'mm' ? 'inch' : 'mm';
  var converted = PSB.convertUnits(value, planUnits, otherUnit);
  // Secondary is fixed-width: 4 decimals for mm, 5 for inch
  var secondary = converted.toFixed(otherUnit === 'mm' ? 4 : 5);
  return primary + ' [' + secondary + ']';
}

/**
 * Build a stacked high/low display for multiple CMM measurements.
 * High on the top line, low on the bottom; each line keeps its dual-unit bracket.
 * Returns HTML (already escaped).
 */
function buildCmmRangeStack(minVal, maxVal, planUnits, isAngle) {
  if (minVal == null || maxVal == null) return '—';
  return '<div class="cmm-range-stack">' +
    '<div class="cmm-range-hi">' + formatDualDisplay(buildCmmDualString(maxVal, planUnits, isAngle)) + '</div>' +
    '<div class="cmm-range-lo">' + formatDualDisplay(buildCmmDualString(minVal, planUnits, isAngle)) + '</div>' +
    '</div>';
}

/**
 * Render a run ID as a colored pill using the run's position in faiRuns for color.
 * Returns HTML string (not escaped — contains span tags).
 */
function getRunPill(runId, faiRuns) {
  var label = '—';
  var colorIdx = -1;
  if (faiRuns) {
    for (var ri = 0; ri < faiRuns.length; ri++) {
      if (faiRuns[ri].id === runId) {
        label = faiRuns[ri].label || faiRuns[ri].fileName || runId;
        colorIdx = ri;
        break;
      }
    }
  }
  if (colorIdx < 0) return esc(label);
  var c = FAI_RUN_COLORS[colorIdx % FAI_RUN_COLORS.length];
  return '<span class="run-pill" style="background:' + c.bg + ';border-color:' + c.border + ';color:' + c.text + '">' + esc(label) + '</span>';
}

/**
 * Format a dual-unit string for display:
 * 1. Adds leading zeros
 * 2. Wraps the [secondary] portion in a <span class="secondary-unit">
 * Returns HTML (already escaped).
 */
function formatDualDisplay(str) {
  if (!str) return '';
  var s = addLeadingZero(String(str));
  var match = s.match(/^(.*?)(\s*\[.*\])$/);
  if (match) {
    return '<span class="primary-unit">' + esc(match[1]) + '</span><span class="secondary-unit">' + esc(match[2]) + '</span>';
  }
  return esc(s);
}

/**
 * Format tolerance for UI display — prepend ± if the string is a plain
 * number without an existing sign prefix. Export is NOT affected.
 */
function tolDisplay(str) {
  if (!str || str === '—') return str;
  var s = String(str).trim();
  if (!s) return s;
  // Already has a sign prefix or ±
  if (/^[±+\-]/.test(s)) return s;
  return '±' + s;
}

// ── Helpers ───────────────────────────────────────────────

function getCellValue(row, col) {
  var c = row.computed;
  var map = {
    status: c.status,
    dimTag: c.dimTag,
    specUnit1: c.specUnit1,
    outDrawingSpec: c.outDrawingSpec,
    op2000Spec: c.op2000DrawingSpec,
    specUnit2: c.specUnit2,
    specUnit3: c.specUnit3,
    outNominal: c.outNominal,
    pinGage: c.pinGage,
    op2000Tol: c.op2000Tolerance,
    outTolerance: c.outTolerance,
    plating: c.platingMode,
    ops: '',
  };
  if (c.includeOps) {
    var parts = [];
    for (var k in c.includeOps) {
      if (c.includeOps[k]) parts.push(k);
    }
    map.ops = parts.join(',');
  }
  return map[col] || '';
}

// ── Balloon-mode helpers ──────────────────────────────────
function buildBalloonInsertTr(targetRow, index, total) {
  var tr = document.createElement('tr');
  tr.className = 'balloon-insert-tr';
  var td = document.createElement('td');
  td.colSpan = 12;
  td.className = 'balloon-insert-cell';
  var btn = document.createElement('button');
  btn.className = 'balloon-insert-btn';
  btn.title = 'Insert balloon here';
  btn.textContent = '+';
  // Target dimTag: insert AT targetRow's effective dimTag (shifts targetRow up).
  // If targetRow is null, append after the last.
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    var insertAt = null;
    if (targetRow) {
      var t = parseInt(PSB.effectiveDimTag(targetRow), 10);
      if (!isNaN(t)) insertAt = t;
    }
    PSB.setPendingBalloonInsert(insertAt);
    // Highlight the gap (CSS handles via .pending class)
    var prev = document.querySelector('.balloon-insert-cell.pending');
    if (prev) prev.classList.remove('pending');
    td.classList.add('pending');
    PSB.showToast && PSB.showToast('Draw a box on the PDF to insert balloon' + (insertAt != null ? ' #' + insertAt : ''), 'info');
  });
  td.appendChild(btn);
  tr.appendChild(td);
  return tr;
}

function bindBalloonHoverSync(tr, rowId) {
  tr.addEventListener('mouseenter', function() {
    if (PSB.setHoveredBalloonRow) PSB.setHoveredBalloonRow(rowId);
  });
  tr.addEventListener('mouseleave', function() {
    if (PSB.setHoveredBalloonRow) PSB.setHoveredBalloonRow(null);
  });
}

// Re-render table when balloon mode toggles so the + gutter appears/disappears.
window.addEventListener('psb:balloonModeChanged', function() {
  if (currentViewConfig && currentViewConfig.id !== 'fai' && getAppState) {
    var st = getAppState();
    if (st) renderTable(st, currentViewConfig);
  }
});
PSB.renderTable = renderTable;
