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

  // OP display: show which ops are enabled
  var ops = c.includeOps || {};
  var opParts = [];
  for (var k in ops) {
    if (ops[k]) opParts.push(k);
  }
  var opDisplay = opParts.join(', ');

  return '' +
    '<td class="col-status"><span class="status-dot ' + statusClass + '"></span></td>' +
    '<td class="col-dimtag">' + esc(c.dimTag) + '</td>' +
    '<td class="col-su1">' + esc(c.specUnit1) + '</td>' +
    '<td class="col-drawspec editable">' + esc(c.outDrawingSpec) + '</td>' +
    '<td class="col-inputspec">' + esc(c.inputSpec) + '</td>' +
    '<td class="col-su2">' + esc(c.specUnit2) + '</td>' +
    '<td class="col-su3">' + esc(c.specUnit3) + '</td>' +
    '<td class="col-outnom">' + esc(c.outNominal) + '</td>' +
    '<td class="col-pingage editable">' + esc(c.pinGage) + '</td>' +
    '<td class="col-inputtol">' + esc(c.inputTolerance) + '</td>' +
    '<td class="col-outtol editable">' + esc(c.outTolerance) + '</td>' +
    '<td class="col-plating">' + esc(c.platingMode !== 'none' ? c.platingMode : '') + '</td>' +
    '<td class="col-ops">' + esc(opDisplay) + '</td>';
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

  // Header
  document.getElementById('sidebar-dimtag').textContent = c.dimTag || '—';

  // Output preview
  document.getElementById('sidebar-out-spec').textContent = c.outDrawingSpec || '—';
  document.getElementById('sidebar-out-nominal').textContent = c.outNominal || '—';
  document.getElementById('sidebar-out-tol').textContent = c.outTolerance || '—';

  // OP toggles
  var opContainer = document.getElementById('sidebar-op-toggles');
  opContainer.innerHTML = '';
  for (var oi = 0; oi < state.globals.ops.length; oi++) {
    var op = state.globals.ops[oi];
    var btn = document.createElement('button');
    btn.className = 'op-toggle' + (u.includeOps[op] ? ' active' : '') + (op === 2000 ? ' op-2000' : '');
    btn.textContent = 'OP ' + op;
    (function(opNum) {
      btn.addEventListener('click', function() {
        var newInclude = Object.assign({}, u.includeOps);
        newInclude[opNum] = !newInclude[opNum];
        onRowUserChange(rowId, { includeOps: newInclude });
      });
    })(op);
    opContainer.appendChild(btn);
  }

  // Checkboxes
  setChecked('sidebar-ipc', u.ipc);
  setChecked('sidebar-is-note', u.isNote);
  setChecked('sidebar-auto-nominal', u.autoNominal);
  setChecked('sidebar-pin-gage-enabled', u.pinGageEnabled);

  // Plating
  document.getElementById('sidebar-plating-mode').value = u.platingMode;

  // Inspection
  populateEquipmentDropdown(state.globals.equipmentList, u.inspectionEquipment);
  document.getElementById('sidebar-frequency').value = u.inspectionFrequency || '';

  // Status buttons
  var statusBtns = document.querySelectorAll('.btn-status');
  for (var i = 0; i < statusBtns.length; i++) {
    if (statusBtns[i].dataset.status === u.status) {
      statusBtns[i].classList.add('active');
    } else {
      statusBtns[i].classList.remove('active');
    }
  }

  // Wire up change handlers (remove old ones first by replacing elements)
  wireUpSidebarHandlers(rowId);
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

  // Status buttons
  var statusBtns = document.querySelectorAll('.btn-status');
  for (var i = 0; i < statusBtns.length; i++) {
    var btn = statusBtns[i];
    var clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    (function(cloneBtn) {
      cloneBtn.addEventListener('click', function() {
        onRowUserChange(rowId, { status: cloneBtn.dataset.status });
      });
    })(clone);
  }

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
    var tag = document.createElement('span');
    tag.className = 'op-tag' + (op === 2000 ? ' op-2000' : '');
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
  if (row.computed.isNote) return;

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
          td.textContent = newValue || originalValue;

          // Determine which field was edited
          if (td.classList.contains('col-drawspec')) {
            onRowUserChange(row.id, { overrides: Object.assign({}, row.user.overrides, { outDrawingSpec: newValue || null }) });
          } else if (td.classList.contains('col-outtol')) {
            onRowUserChange(row.id, { overrides: Object.assign({}, row.user.overrides, { outTolerance: newValue || null }) });
          } else if (td.classList.contains('col-pingage')) {
            onRowUserChange(row.id, { overrides: Object.assign({}, row.user.overrides, { pinGageValue: newValue || null }) });
          }
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

// ── Helpers ───────────────────────────────────────────────

function getCellValue(row, col) {
  var c = row.computed;
  var map = {
    status: c.status,
    dimTag: c.dimTag,
    specUnit1: c.specUnit1,
    outDrawingSpec: c.outDrawingSpec,
    inputSpec: c.inputSpec,
    specUnit2: c.specUnit2,
    specUnit3: c.specUnit3,
    outNominal: c.outNominal,
    pinGage: c.pinGage,
    inputTol: c.inputTolerance,
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
PSB.getSelectedRowId = getSelectedRowId;
