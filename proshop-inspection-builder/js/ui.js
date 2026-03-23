/**
 * ui.js — UI Rendering & Interaction
 *
 * Responsibilities:
 * - Render data table from computed values
 * - Handle row selection → sidebar population
 * - Inline editing for editable cells
 * - Sidebar controls → update user state → trigger recompute
 * - Sorting and filtering
 * - Theme toggle
 * - Sidebar resizing
 * - Drag & drop file handling
 */

window.PSB = window.PSB || {};

// ── State ─────────────────────────────────────────────────
var selectedRowId = null;
var sortColumn = null;
var sortDirection = 'asc'; // 'asc' or 'desc'

// Callback references (set by app.js)
var onRowUserChange = null;   // (rowId, userChanges) => void
var onFileImport = null;      // (fileContent, fileName) => void
var getAppState = null;       // () => { rows, globals }

// ── OP Color Palette ──────────────────────────────────────
// CSS vars: --op-color-0 (OP2000/orange), --op-color-1..7
var OP_COLORS = [
  '#ff8c42',  // 0: OP2000
  '#4a9eff',  // 1: blue
  '#4caf50',  // 2: green
  '#e040fb',  // 3: purple
  '#ff5252',  // 4: red
  '#00bcd4',  // 5: cyan
  '#ffc107',  // 6: yellow
  '#ff6e40',  // 7: deep orange
];

/**
 * Get the color for a given OP number.
 * OP2000 always gets index 0 (orange). Other OPs get 1-7 by position in globals.ops.
 */
function getOpColor(opNum) {
  if (opNum === 2000) return OP_COLORS[0];
  var state = getAppState();
  if (!state) return OP_COLORS[1];
  var nonTwoK = state.globals.ops.filter(function(o) { return o !== 2000; });
  var idx = nonTwoK.indexOf(opNum);
  if (idx < 0) idx = 0;
  return OP_COLORS[(idx % 7) + 1];
}

/**
 * Initialize the UI module.
 *
 * @param {Object} callbacks
 * @param {Function} callbacks.onRowUserChange — called when sidebar edits a row's user state
 * @param {Function} callbacks.onFileImport — called when a file is dropped or selected
 * @param {Function} callbacks.getAppState — returns current { rows, globals }
 */
function initUI(callbacks) {
  onRowUserChange = callbacks.onRowUserChange;
  onFileImport = callbacks.onFileImport;
  getAppState = callbacks.getAppState;

  setupDragDrop();
  setupSidebarResizer();
  setupThemeToggle();
  setupTableHeaderClicks();
}

/**
 * Render the full table from rows.
 * Call this after any data change.
 *
 * @param {Object[]} rows — array of row objects with computed values
 */
function renderTable(rows) {
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
  for (var i = 0; i < displayRows.length; i++) {
    var row = displayRows[i];
    var tr = document.createElement('tr');
    tr.dataset.rowId = row.id;

    if (row.computed.isNote) tr.classList.add('is-note');
    if (row.id === selectedRowId) tr.classList.add('selected');

    tr.innerHTML = buildRowHTML(row);

    // Row click → select + open sidebar (use IIFE for closure)
    (function(rowId) {
      tr.addEventListener('click', function() { selectRow(rowId); });
    })(row.id);

    // Inline editing for editable cells
    setupInlineEditing(tr, row);

    tbody.appendChild(tr);
  }
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
    opBubblesHTML += '<span class="op-bubble' + isActive + '" style="--op-c:' + color + ';">' + op + '</span>';
  }
  opBubblesHTML += '</div>';

  var ov = row.user.overrides || {};

  return '' +
    '<td class="col-status"><span class="status-dot ' + statusClass + '"></span></td>' +
    '<td class="col-dimtag">' + esc(c.dimTag) + '</td>' +
    '<td class="col-su1 editable">' + esc(c.specUnit1) + '</td>' +
    '<td class="col-drawspec editable">' + formatDualDisplay(c.outDrawingSpec) + '</td>' +
    '<td class="col-inputspec editable' + (ov.outDrawingSpec !== null ? ' has-override' : '') + '">' + formatDualDisplay(c.op2000DualSpec) + '</td>' +
    '<td class="col-su2 editable">' + esc(c.specUnit2) + '</td>' +
    '<td class="col-su3 editable">' + esc(c.specUnit3) + '</td>' +
    '<td class="col-outnom editable">' + formatDualDisplay(c.outNominal) + '</td>' +
    '<td class="col-pingage editable">' + esc(addLeadingZero(c.pinGage)) + '</td>' +
    '<td class="col-inputtol editable' + (ov.outTolerance !== null ? ' has-override' : '') + '">' + formatDualDisplay(tolDisplay(c.op2000DualTol)) + '</td>' +
    '<td class="col-outtol editable">' + formatDualDisplay(tolDisplay(c.outTolerance)) + '</td>' +
    '<td class="col-plating">' + esc(c.platingMode !== 'none' ? c.platingMode : '') + '</td>' +
    '<td class="col-ops">' + opBubblesHTML + '</td>';
}

/**
 * Select a row and open the sidebar.
 */
function selectRow(rowId) {
  selectedRowId = rowId;

  // Highlight row
  var allRows = document.querySelectorAll('#table-body tr');
  for (var i = 0; i < allRows.length; i++) {
    var tr = allRows[i];
    if (Number(tr.dataset.rowId) === rowId) {
      tr.classList.add('selected');
    } else {
      tr.classList.remove('selected');
    }
  }

  // Show sidebar
  var sidebar = document.getElementById('sidebar');
  var resizer = document.getElementById('sidebar-resizer');
  sidebar.classList.remove('hidden');
  resizer.classList.remove('hidden');

  // Populate sidebar
  populateSidebar(rowId);
}

/**
 * Populate sidebar with selected row's data.
 */
function populateSidebar(rowId) {
  var state = getAppState();
  var row = state.rows.find(function(r) { return r.id === rowId; });
  if (!row) return;

  var c = row.computed;
  var u = row.user;

  // Wire up handlers FIRST — cloneNode wipes select values, so we must
  // clone before setting any values, then set values on the clones in DOM.
  wireUpSidebarHandlers(rowId);

  // Header
  document.getElementById('sidebar-dimtag').textContent = 'DIM TAG# ' + (c.dimTag || '—');
  document.getElementById('sidebar-output-tag').textContent = c.outputTag || '';

  // OP2000 values (left column — smaller/faded, dual-unit format)
  document.getElementById('sidebar-op2000-spec').innerHTML = formatDualDisplay(c.op2000DualSpec) || '—';
  document.getElementById('sidebar-op2000-nominal').innerHTML = formatDualDisplay(c.op2000DualSpec) || '—';
  document.getElementById('sidebar-op2000-tol').innerHTML = formatDualDisplay(tolDisplay(c.op2000DualTol)) || '—';

  // Output values (right column — bold/bright, dual-unit format)
  document.getElementById('sidebar-out-spec').innerHTML = formatDualDisplay(c.outDrawingSpec) || '—';
  document.getElementById('sidebar-out-nominal').innerHTML = formatDualDisplay(c.outNominal) || '—';
  document.getElementById('sidebar-out-tol').innerHTML = formatDualDisplay(tolDisplay(c.outTolerance)) || '—';

  // Override indicators — show arrow icon when value was manually changed
  var oiSpec = document.getElementById('oi-spec');
  var oiTol = document.getElementById('oi-tol');
  var origSpec = document.getElementById('orig-spec');
  var origTol = document.getElementById('orig-tol');

  if (u.overrides.outDrawingSpec !== null) {
    oiSpec.classList.remove('hidden');
    origSpec.textContent = row.raw.drawingSpec || '';
  } else {
    oiSpec.classList.add('hidden');
    origSpec.classList.add('hidden');
    origSpec.textContent = '';
  }

  if (u.overrides.outTolerance !== null) {
    oiTol.classList.remove('hidden');
    origTol.textContent = row.raw.tolerance || '';
  } else {
    oiTol.classList.add('hidden');
    origTol.classList.add('hidden');
    origTol.textContent = '';
  }

  // Wire override indicator click — toggle showing original value
  setupOverrideIndicator('oi-spec', 'orig-spec');
  setupOverrideIndicator('oi-tol', 'orig-tol');

  // OP toggles
  var opContainer = document.getElementById('sidebar-op-toggles');
  opContainer.innerHTML = '';
  for (var oi = 0; oi < state.globals.ops.length; oi++) {
    var op = state.globals.ops[oi];
    if (op === 2000) continue; // OP2000 is export-only, not shown in sidebar
    var color = getOpColor(op);
    var btn = document.createElement('button');
    btn.className = 'op-toggle' + (u.includeOps[op] ? ' active' : '');
    btn.style.setProperty('--op-c', color);
    btn.textContent = 'OP ' + op;
    (function(opNum, btnEl) {
      btnEl.addEventListener('click', function() {
        var newInclude = Object.assign({}, u.includeOps);
        newInclude[opNum] = !newInclude[opNum];
        // Immediately toggle visual state
        if (newInclude[opNum]) {
          btnEl.classList.add('active');
        } else {
          btnEl.classList.remove('active');
        }
        onRowUserChange(rowId, { includeOps: newInclude });
      });
    })(op, btn);
    opContainer.appendChild(btn);
  }

  // Checkboxes
  setChecked('sidebar-ipc', u.ipc);
  setChecked('sidebar-is-note', u.isNote);
  setChecked('sidebar-auto-nominal', u.autoNominal);
  setChecked('sidebar-pin-gage-enabled', u.pinGageEnabled);

  // Plating — set AFTER wireUpSidebarHandlers so clone is already in DOM
  document.getElementById('sidebar-plating-mode').value = u.platingMode;

  // Inspection — populate options then set value
  populateEquipmentDropdown(state.globals.equipmentList, u.inspectionEquipment);
  document.getElementById('sidebar-frequency').value = u.inspectionFrequency || '';

  // Complete button — update active state
  var completeBtn = document.getElementById('sidebar-status-complete');
  if (u.status === 'complete') {
    completeBtn.classList.add('active');
  } else {
    completeBtn.classList.remove('active');
  }
}

/**
 * Wire sidebar controls to emit user changes.
 */
function wireUpSidebarHandlers(rowId) {
  // Helper to bind a change handler
  function bind(id, event, handler) {
    var el = document.getElementById(id);
    // Clone to remove old listeners
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    clone.addEventListener(event, handler);
  }

  bind('sidebar-ipc', 'change', function(e) {
    onRowUserChange(rowId, { ipc: e.target.checked });
  });

  bind('sidebar-is-note', 'change', function(e) {
    onRowUserChange(rowId, { isNote: e.target.checked });
  });

  bind('sidebar-auto-nominal', 'change', function(e) {
    onRowUserChange(rowId, { autoNominal: e.target.checked });
  });

  bind('sidebar-pin-gage-enabled', 'change', function(e) {
    onRowUserChange(rowId, { pinGageEnabled: e.target.checked });
  });

  bind('sidebar-plating-mode', 'change', function(e) {
    onRowUserChange(rowId, { platingMode: e.target.value });
  });

  bind('sidebar-equipment', 'change', function(e) {
    onRowUserChange(rowId, { inspectionEquipment: e.target.value });
  });

  bind('sidebar-frequency', 'change', function(e) {
    onRowUserChange(rowId, { inspectionFrequency: e.target.value });
  });

  // Output Tag — double-click to edit (Rule 6: overrideable)
  var otEl = document.getElementById('sidebar-output-tag');
  var otClone = otEl.cloneNode(true);
  otEl.parentNode.replaceChild(otClone, otEl);
  otClone.addEventListener('dblclick', function() {
    if (otClone.querySelector('input')) return;
    var originalValue = otClone.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = originalValue;
    input.className = 'inline-edit-input';
    otClone.textContent = '';
    otClone.appendChild(input);
    input.focus();
    input.select();

    var committed = false;
    var commit = function() {
      if (committed) return;
      committed = true;
      var newValue = input.value.trim();
      otClone.textContent = newValue || originalValue;
      var state = getAppState();
      var row = state.rows.find(function(r) { return r.id === rowId; });
      if (row) {
        var ov = Object.assign({}, row.user.overrides);
        ov.outputTag = newValue || null;
        onRowUserChange(rowId, { overrides: ov });
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ke) {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') {
        committed = true;
        otClone.textContent = originalValue;
      }
    });
  });

  // Complete button — toggle complete status and auto-advance to next row
  var completeBtn = document.getElementById('sidebar-status-complete');
  var completeClone = completeBtn.cloneNode(true);
  completeBtn.parentNode.replaceChild(completeClone, completeBtn);
  completeClone.addEventListener('click', function() {
    var state = getAppState();
    var currentRow = state.rows.find(function(r) { return r.id === rowId; });
    var newStatus = (currentRow && currentRow.user.status === 'complete') ? 'none' : 'complete';
    onRowUserChange(rowId, { status: newStatus });
    // Auto-advance to next row
    if (newStatus === 'complete') {
      var idx = state.rows.findIndex(function(r) { return r.id === rowId; });
      if (idx >= 0 && idx < state.rows.length - 1) {
        selectRow(state.rows[idx + 1].id);
      }
    }
  });

  // Sidebar close
  var closeBtn = document.getElementById('sidebar-close');
  var closeClone = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(closeClone, closeBtn);
  closeClone.addEventListener('click', closeSidebar);
}

/**
 * Close the sidebar.
 */
function closeSidebar() {
  selectedRowId = null;
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('sidebar-resizer').classList.add('hidden');
  var allRows = document.querySelectorAll('#table-body tr');
  for (var i = 0; i < allRows.length; i++) {
    allRows[i].classList.remove('selected');
  }
}

/**
 * Populate the equipment dropdown.
 */
function populateEquipmentDropdown(equipmentList, currentValue) {
  var select = document.getElementById('sidebar-equipment');
  select.innerHTML = '<option value="">— Select —</option>';
  for (var i = 0; i < equipmentList.length; i++) {
    var item = equipmentList[i];
    var opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    if (item === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
}

/**
 * Render the OP tags in the OP bar.
 */
function renderOpBar(ops, onRemoveOp) {
  var container = document.getElementById('op-tags');
  container.innerHTML = '';
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op === 2000) continue; // OP2000 is export-only, not shown in OP bar
    var color = getOpColor(op);
    var tag = document.createElement('span');
    tag.className = 'op-tag';
    tag.style.setProperty('--op-c', color);
    tag.innerHTML = 'OP ' + op + ' <span class="remove-op" title="Remove">✕</span>';
    (function(opNum) {
      tag.querySelector('.remove-op').addEventListener('click', function() { onRemoveOp(opNum); });
    })(op);
    container.appendChild(tag);
  }
}

// ── Drag & Drop ───────────────────────────────────────────

function setupDragDrop() {
  var dropZone = document.getElementById('drop-zone');
  var body = document.body;

  var dragCounter = 0;

  body.addEventListener('dragenter', function(e) {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.remove('hidden');
  });

  body.addEventListener('dragleave', function(e) {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) dropZone.classList.add('hidden');
  });

  body.addEventListener('dragover', function(e) {
    e.preventDefault();
  });

  body.addEventListener('drop', function(e) {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.add('hidden');

    var files = e.dataTransfer.files;
    if (files.length > 0) {
      readFile(files[0]);
    }
  });
}

function readFile(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    if (onFileImport) {
      onFileImport(e.target.result, file.name);
    }
  };
  reader.readAsText(file);
}

// ── Sidebar Resizer ───────────────────────────────────────

function setupSidebarResizer() {
  var resizer = document.getElementById('sidebar-resizer');
  var sidebar = document.getElementById('sidebar');
  var isResizing = false;

  resizer.addEventListener('mousedown', function(e) {
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!isResizing) return;
    var newWidth = window.innerWidth - e.clientX;
    var clamped = Math.max(280, Math.min(600, newWidth));
    sidebar.style.width = clamped + 'px';
  });

  document.addEventListener('mouseup', function() {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ── Theme Toggle ──────────────────────────────────────────

function setupThemeToggle() {
  document.getElementById('btn-theme').addEventListener('click', function() {
    var html = document.documentElement;
    var current = html.getAttribute('data-theme');
    html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
  });
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
        if (state) renderTable(state.rows);
      });
    })(headers[i]);
  }
}

// ── Inline Editing ────────────────────────────────────

function setupInlineEditing(tr, row) {
  var editableCells = tr.querySelectorAll('td.editable');
  for (var i = 0; i < editableCells.length; i++) {
    (function(td) {
      td.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        if (td.querySelector('input')) return; // Already editing

        var originalValue = td.textContent;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = originalValue;
        td.textContent = '';
        td.appendChild(input);
        input.focus();
        input.select();

        var committed = false;
        var commit = function() {
          if (committed) return;
          committed = true;
          var newValue = input.value.trim();
          // Strip "[secondary]" bracket notation from dual-display columns
          // so overrides store the raw value, not the UI-formatted string
          if (newValue && newValue.indexOf(' [') > 0) {
            newValue = newValue.split(' [')[0].trim();
          }
          td.textContent = newValue || originalValue;

          // Determine which field was edited
          var ov = Object.assign({}, row.user.overrides);
          if (td.classList.contains('col-drawspec') || td.classList.contains('col-inputspec')) {
            ov.outDrawingSpec = newValue || null;
          } else if (td.classList.contains('col-outtol') || td.classList.contains('col-inputtol')) {
            ov.outTolerance = newValue || null;
          } else if (td.classList.contains('col-pingage')) {
            ov.pinGageValue = newValue || null;
          } else if (td.classList.contains('col-su1')) {
            ov.specUnit1 = newValue || null;
          } else if (td.classList.contains('col-su2')) {
            ov.specUnit2 = newValue || null;
          } else if (td.classList.contains('col-su3')) {
            ov.specUnit3 = newValue || null;
          } else if (td.classList.contains('col-outnom')) {
            ov.outNominal = newValue || null;
          }
          onRowUserChange(row.id, { overrides: ov });
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function(ke) {
          if (ke.key === 'Enter') input.blur();
          if (ke.key === 'Escape') {
            committed = true; // Prevent commit on blur
            td.textContent = originalValue;
          }
        });
      });
    })(editableCells[i]);
  }
}

// ── Override Indicator ─────────────────────────────────────

function setupOverrideIndicator(btnId, origId) {
  var btn = document.getElementById(btnId);
  var orig = document.getElementById(origId);
  // Clone to remove old listeners
  var clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);
  clone.addEventListener('click', function(e) {
    e.stopPropagation();
    orig.classList.toggle('hidden');
  });
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
    return esc(match[1]) + '<span class="secondary-unit">' + esc(match[2]) + '</span>';
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

function setChecked(id, value) {
  document.getElementById(id).checked = !!value;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Get the currently selected row ID.
 */
function getSelectedRowId() {
  return selectedRowId;
}

// ── Export to namespace ───────────────────────────────────
PSB.initUI = initUI;
PSB.renderTable = renderTable;
PSB.renderOpBar = renderOpBar;
PSB.closeSidebar = closeSidebar;
PSB.populateSidebar = populateSidebar;
PSB.getSelectedRowId = getSelectedRowId;
PSB.getOpColor = getOpColor;
