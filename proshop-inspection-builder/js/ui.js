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
var currentViewConfig = { id: 'setup' }; // tracks active view for header sort re-renders

// Callback references (set by app.js)
var onRowUserChange = null;   // (rowId, userChanges) => void
var onFileImport = null;      // (fileContent, fileName) => void
var onAddRow = null;           // () => void
var onDeleteRow = null;        // (rowId) => void
var onFaiRetag = null;        // (rowId, measurementIndex, newTag) — move a CMM measurement
var getAppState = null;       // () => { rows, globals }

// Edit flash: tracks which cell should flash after re-render
var flashCellKey = null; // "rowId|col-classname"

// Tab navigation: tracks which cell to auto-enter edit mode after re-render
var navigateTarget = null; // { rowId, colClass, reverse }

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
  onAddRow = callbacks.onAddRow;
  onDeleteRow = callbacks.onDeleteRow;
  getAppState = callbacks.getAppState;
  onFaiRetag = callbacks.onFaiRetag;

  setupDragDrop();
  setupFaiRetagEditing();
  setupCmmSepToggle();
  setupSu1Expand();
  setupSidebarResizer();
  setupSetupPanelResizer();
  setupThemeToggle();
  setupTableHeaderClicks();
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

  // Close setup panel so the dimension sidebar can take its place
  closeSetupPanel();

  // Show sidebar
  var sidebar = document.getElementById('sidebar');
  var resizer = document.getElementById('sidebar-resizer');
  sidebar.classList.remove('sidebar-closed');
  resizer.classList.remove('sidebar-closed');

  // Populate sidebar
  populateSidebar(rowId);
}

/**
 * Open the Project Setup panel (closes dimension sidebar).
 */
function openSetupPanel() {
  // Close dimension sidebar first
  var sidebar = document.getElementById('sidebar');
  var sidebarResizer = document.getElementById('sidebar-resizer');
  if (sidebar && !sidebar.classList.contains('sidebar-closed')) {
    sidebar.classList.add('sidebar-closed');
    if (sidebarResizer) sidebarResizer.classList.add('sidebar-closed');
    selectedRowId = null;
    var allRows = document.querySelectorAll('#table-body tr');
    for (var i = 0; i < allRows.length; i++) {
      allRows[i].classList.remove('selected');
    }
  }
  var panel = document.getElementById('setup-panel');
  var panelResizer = document.getElementById('setup-panel-resizer');
  if (panel) panel.classList.remove('panel-closed');
  if (panelResizer) panelResizer.classList.remove('panel-closed');
  var btn = document.getElementById('btn-setup-panel');
  if (btn) btn.classList.add('active');
}

/**
 * Close the Project Setup panel.
 */
function closeSetupPanel() {
  var panel = document.getElementById('setup-panel');
  var panelResizer = document.getElementById('setup-panel-resizer');
  if (panel) panel.classList.add('panel-closed');
  if (panelResizer) panelResizer.classList.add('panel-closed');
  var btn = document.getElementById('btn-setup-panel');
  if (btn) btn.classList.remove('active');
}

/**
 * Toggle the Project Setup panel open/closed.
 */
function toggleSetupPanel() {
  var panel = document.getElementById('setup-panel');
  if (panel && panel.classList.contains('panel-closed')) {
    openSetupPanel();
  } else {
    closeSetupPanel();
  }
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

  // Header — split label and number for styling
  document.getElementById('sidebar-dimtag').innerHTML =
    '<span class="dimtag-label">DIM TAG# </span><span class="dimtag-number">' + esc(c.dimTag || '—') + '</span>' + refBadgeHTML(row);
  document.getElementById('sidebar-output-tag').textContent = c.outputTag || '';

  // GD&T info panel — only for GD&T rows. Inserted/removed between the header
  // and the comparison grid; container persists in DOM so we just toggle content.
  renderSidebarGdtPanel(row);

  // OP2000 values (left column — smaller/faded, dual-unit format)
  document.getElementById('sidebar-op2000-spec').innerHTML = formatDualDisplay(c.op2000DualSpec) || '—';
  document.getElementById('sidebar-op2000-nominal').innerHTML = formatDualDisplay(c.op2000DualSpec) || '—';
  document.getElementById('sidebar-op2000-tol').innerHTML = formatDualDisplay(tolDisplay(c.op2000DualTol)) || '—';

  // Output values (right column — bold/bright, dual-unit format)
  document.getElementById('sidebar-out-spec').innerHTML = formatDualDisplay(c.outDrawingSpec) || '—';
  var outNomEl = document.getElementById('sidebar-out-nominal');
  outNomEl.innerHTML = (u.pinGageEnabled ? '🔒 ' : '') + (formatDualDisplay(c.outNominal) || '—');
  outNomEl.classList.toggle('sidebar-locked', !!u.pinGageEnabled);
  outNomEl.title = u.pinGageEnabled ? 'Locked — Pin/Gage is on, so Nom Dim exports the pin/gage value' : '';
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

  if (u.overrides.outTolPlus !== null || u.overrides.outTolMinus !== null) {
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

  // Pin/Gage override indicator
  var oiPg = document.getElementById('oi-pingage');
  var origPg = document.getElementById('orig-pingage');
  if (u.overrides.pinGageValue !== null) {
    oiPg.classList.remove('hidden');
    origPg.textContent = c.pinGageAuto || '(auto-computed)';
  } else {
    oiPg.classList.add('hidden');
    origPg.classList.add('hidden');
    origPg.textContent = '';
  }
  setupOverrideIndicator('oi-pingage', 'orig-pingage');

  // Pin/Gage display (fixed area — always present, shows value only when enabled)
  var pgEl = document.getElementById('sidebar-pingage-value');
  if (pgEl) {
    if (u.pinGageEnabled && c.pinGage) {
      pgEl.textContent = addLeadingZero(c.pinGage);
      pgEl.classList.add('active');
    } else {
      pgEl.textContent = '—';
      pgEl.classList.remove('active');
    }
  }

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
  setChecked('sidebar-not-on-print', u.notOnPrint);
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

  // Row history (bottom of sidebar)
  populateSidebarHistory(rowId);
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

  bind('sidebar-not-on-print', 'change', function(e) {
    onRowUserChange(rowId, { notOnPrint: e.target.checked });
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

  // Editable sidebar preview values — double-click to edit
  // OP2000 values: set base overrides, clear independent OUT overrides + toast
  setupSidebarValueEdit('sidebar-op2000-spec', 'outDrawingSpec', rowId, 'outputSpec');
  setupSidebarTolEdit('sidebar-op2000-tol', 'outTolPlus', 'outTolMinus', rowId, 'outputTolPlus', 'outputTolMinus');
  // OUT values: set independent overrides only, don't affect OP2000
  setupSidebarValueEdit('sidebar-out-spec', 'outputSpec', rowId);
  setupSidebarValueEdit('sidebar-out-nominal', 'outNominal', rowId);
  setupSidebarTolEdit('sidebar-out-tol', 'outputTolPlus', 'outputTolMinus', rowId);
  setupSidebarValueEdit('sidebar-pingage-value', 'pinGageValue', rowId);

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
      // No-op if nothing actually changed
      if (newValue === originalValue.trim()) {
        otClone.textContent = originalValue;
        return;
      }
      otClone.textContent = newValue || originalValue;
      var state = getAppState();
      var row = state.rows.find(function(r) { return r.id === rowId; });
      if (!row) { otClone.textContent = originalValue; return; }
      var ov = Object.assign({}, row.user.overrides);
      ov.outputTag = newValue || null;
      onRowUserChange(rowId, { overrides: ov });
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
  document.getElementById('sidebar').classList.add('sidebar-closed');
  document.getElementById('sidebar-resizer').classList.add('sidebar-closed');
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
  var name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    if (PSB.loadPdfFromFile) PSB.loadPdfFromFile(file);
    return;
  }
  // Anything else would be read as a CSV and could replace the plan
  if (!name.endsWith('.csv') && !name.endsWith('.json')) {
    showToast('Can\'t open ' + file.name + '. Drop a CSV, project (.json) or PDF.', 'error');
    return;
  }
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

// ── Setup Panel Resizer ───────────────────────────────────

function setupSetupPanelResizer() {
  var resizer = document.getElementById('setup-panel-resizer');
  var panel   = document.getElementById('setup-panel');
  if (!resizer || !panel) return;
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
    panel.style.width = clamped + 'px';
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

// ── Sidebar Value Editing ──────────────────────────────

function setupSidebarValueEdit(elementId, overrideKey, rowId, clearKey) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  clone.classList.add('sidebar-editable');

  clone.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    if (clone.querySelector('input')) return;
    if (clone.classList.contains('sidebar-locked')) {
      if (PSB.showToast) PSB.showToast('Pin/Gage is on — Nom Dim exports the pin/gage value', 'info');
      return;
    }

    var originalHTML = clone.innerHTML;
    var originalValue = clone.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = originalValue;
    input.className = 'inline-edit-input';
    clone.textContent = '';
    clone.appendChild(input);
    input.focus();
    input.select();

    var committed = false;
    var commit = function() {
      if (committed) return;
      committed = true;
      var newValue = input.value.trim();
      // Strip "[secondary]" bracket notation (same as table inline edit)
      if (newValue && newValue.indexOf(' [') > 0) {
        newValue = newValue.split(' [')[0].trim();
      }
      // Strip leading ± for tolerance values
      if (newValue && newValue.charAt(0) === '\u00b1') {
        newValue = newValue.substring(1);
      }

      // Strip the same notation from originalValue for comparison
      var originalStripped = originalValue;
      if (originalStripped && originalStripped.indexOf(' [') > 0) {
        originalStripped = originalStripped.split(' [')[0].trim();
      }
      if (originalStripped && originalStripped.charAt(0) === '\u00b1') {
        originalStripped = originalStripped.substring(1);
      }

      // No-op if nothing actually changed — restore original HTML formatting
      if (newValue === originalStripped) {
        clone.innerHTML = originalHTML;
        return;
      }

      clone.textContent = newValue || originalValue;
      var state = getAppState();
      var row = state.rows.find(function(r) { return r.id === rowId; });
      if (!row) { clone.innerHTML = originalHTML; return; }
      var ov = Object.assign({}, row.user.overrides);
      ov[overrideKey] = newValue || null;
      // When editing OP2000 base, clear independent OUT override + toast
      if (clearKey && ov[clearKey] !== null) {
        ov[clearKey] = null;
        showToast('OP2000 changed — OUT override cleared', 'info');
      }
      onRowUserChange(rowId, { overrides: ov });
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ke) {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') {
        committed = true;
        clone.innerHTML = originalHTML;
      }
    });
  });
}

// ── GD&T tooltip + sidebar panel ─────────────────────────
//
// One shared tooltip element, positioned absolutely on first hover. Uses
// PSB.getGdtTooltipHtml (reference data only, safe innerHTML — no user data).
// Hovering a `.gdt-info-badge[data-gdt-char]` shows the characteristic panel;
// hovering a `.gdt-modifier[data-modifier]` shows the modifier explanation.

var _gdtTooltipEl = null;
var _gdtTooltipHideTimer = null;

function ensureGdtTooltip() {
  if (_gdtTooltipEl) return _gdtTooltipEl;
  _gdtTooltipEl = document.createElement('div');
  _gdtTooltipEl.id = 'psb-gdt-tooltip';
  _gdtTooltipEl.style.display = 'none';
  _gdtTooltipEl.addEventListener('mouseenter', function() {
    if (_gdtTooltipHideTimer) { clearTimeout(_gdtTooltipHideTimer); _gdtTooltipHideTimer = null; }
  });
  _gdtTooltipEl.addEventListener('mouseleave', scheduleHideGdtTooltip);
  document.body.appendChild(_gdtTooltipEl);
  return _gdtTooltipEl;
}

function showGdtTooltipFor(target, html) {
  var tip = ensureGdtTooltip();
  if (_gdtTooltipHideTimer) { clearTimeout(_gdtTooltipHideTimer); _gdtTooltipHideTimer = null; }
  tip.innerHTML = html;
  tip.style.display = '';
  var rect = target.getBoundingClientRect();
  var pad = 8;
  // Default placement: above the target, centered.
  var left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  var top  = rect.top - tip.offsetHeight - pad;
  // Clamp to viewport. If above is clipped, flip to below.
  if (top < pad) top = rect.bottom + pad;
  if (left < pad) left = pad;
  if (left + tip.offsetWidth > window.innerWidth - pad) {
    left = window.innerWidth - tip.offsetWidth - pad;
  }
  tip.style.left = left + 'px';
  tip.style.top  = top  + 'px';
}

function scheduleHideGdtTooltip() {
  if (_gdtTooltipHideTimer) clearTimeout(_gdtTooltipHideTimer);
  _gdtTooltipHideTimer = setTimeout(function() {
    if (_gdtTooltipEl) _gdtTooltipEl.style.display = 'none';
  }, 200);
}

// Event delegation — single document listener handles all current and future
// GD&T badges/modifiers without per-render rebinding.
document.addEventListener('mouseover', function(e) {
  var badge = e.target && e.target.closest && e.target.closest('.gdt-info-badge[data-gdt-char]');
  if (badge) {
    var html = PSB.getGdtTooltipHtml(badge.getAttribute('data-gdt-char'));
    if (html) showGdtTooltipFor(badge, html);
    return;
  }
  var mod = e.target && e.target.closest && e.target.closest('.gdt-modifier[data-modifier]');
  if (mod) {
    var tips = PSB.MODIFIER_TOOLTIPS || {};
    var key = mod.getAttribute('data-modifier');
    if (tips[key]) {
      showGdtTooltipFor(mod, '<div class="gdt-tooltip"><div class="gdt-tooltip-modifier">' + esc(tips[key]) + '</div></div>');
    }
  }
});
document.addEventListener('mouseout', function(e) {
  var leftBadge = e.target && e.target.closest && (e.target.closest('.gdt-info-badge') || e.target.closest('.gdt-modifier'));
  if (leftBadge) scheduleHideGdtTooltip();
});

// Always-visible GD&T panel in the sidebar for GD&T rows.
function renderSidebarGdtPanel(row) {
  var panel = document.getElementById('sidebar-gdt-panel');
  if (!panel) return;
  if (!row.user.gdt) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  var gdt = row.user.gdt;
  panel.style.display = '';
  // The reference tooltip HTML is reused inline; it already includes the
  // category badge, controls/requires/common text, and the Learn-more link.
  panel.innerHTML =
    '<div class="sidebar-gdt-header">' +
      '<span class="gdt-symbol">' + esc(PSB.GDT_SYMBOLS[gdt.characteristic] || '') + '</span>' +
      '<span class="gdt-name">' + esc(gdt.characteristicName || '') + '</span>' +
    '</div>' +
    '<div class="sidebar-gdt-frame gdt-frame">' + esc(gdt.nominalFrame || '') + '</div>' +
    PSB.getGdtTooltipHtml(gdt.characteristic);
}

// ── Sidebar Tolerance Editing (dual +/- inputs) ──────

function setupSidebarTolEdit(elementId, plusKey, minusKey, rowId, clearPlusKey, clearMinusKey) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  clone.classList.add('sidebar-editable');

  clone.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    if (clone.querySelector('input')) return;

    var originalHTML = clone.innerHTML;
    var state = getAppState();
    var row = state.rows.find(function(r) { return r.id === rowId; });
    if (!row) return;

    var c = row.computed;
    var globals = state.globals || {};
    var importUnits = PSB.getPrintUnits(globals);
    var prec = importUnits === 'inch' ? (globals.inchPrecision || 4) : (globals.mmPrecision || 3);

    var isOp2k = plusKey === 'outTolPlus';
    var plusVal = isOp2k ? c.op2kTolPlus : c.outTolPlus;
    var minusVal = isOp2k ? c.op2kTolMinus : c.outTolMinus;
    var curMode = (row.user.overrides && row.user.overrides.tolMode) || 'sym';

    // Min/max bounds are derived from the print-spec nominal (OP2000) — plating/conversion
    // are applied downstream, not at the override layer.
    var nominalForBounds = parseFloat(c.op2000Nominal);
    if (isNaN(nominalForBounds)) nominalForBounds = parseFloat(c.nominal);

    clone.innerHTML = '<div class="tol-edit-container"></div>';
    var mount = clone.querySelector('.tol-edit-container');
    mount.style.flexDirection = 'column';
    mount.style.alignItems = 'stretch';

    var ctrl = PSB.renderTolModeInputs(mount, {
      mode: curMode, plus: plusVal, minus: minusVal,
      nominal: isNaN(nominalForBounds) ? null : nominalForBounds,
      precision: prec,
    });
    ctrl.focus();

    var committed = false;
    function revert() { committed = true; clone.innerHTML = originalHTML; }
    function commit() {
      if (committed) return;
      var r = ctrl.commit();
      if (!r.ok) return; // error shown inline; keep editor open
      committed = true;

      var pNum = r.tolPlus;
      var mNum = r.tolMinus;
      var newMode = r.tolMode;

      var freshState = getAppState();
      var freshRow = freshState.rows.find(function(rr) { return rr.id === rowId; });
      if (!freshRow) { clone.innerHTML = originalHTML; return; }

      var prevMode = (freshRow.user.overrides && freshRow.user.overrides.tolMode) || 'sym';
      var nothingChanged =
        Math.abs(pNum - plusVal) < 1e-10 &&
        Math.abs(mNum - minusVal) < 1e-10 &&
        newMode === prevMode;
      if (nothingChanged) { clone.innerHTML = originalHTML; return; }

      var ov = Object.assign({}, freshRow.user.overrides);
      ov[plusKey] = String(pNum);
      ov[minusKey] = String(mNum);
      ov.tolMode = newMode;

      if (clearPlusKey && (ov[clearPlusKey] !== null || ov[clearMinusKey] !== null)) {
        ov[clearPlusKey] = null;
        ov[clearMinusKey] = null;
        showToast('OP2000 Tol changed — OUT Tol override cleared', 'info');
      }
      onRowUserChange(rowId, { overrides: ov });
    }

    // Blur-commit, but only when focus leaves the entire control (not when
    // switching between mode chip and input).
    function onBlur() {
      setTimeout(function() {
        if (!clone.contains(document.activeElement)) commit();
      }, 0);
    }
    var inputs = ctrl.getInputs();
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('blur', onBlur);
      inputs[i].addEventListener('keydown', function(ke) {
        if (ke.key === 'Enter')  { ke.preventDefault(); commit(); }
        if (ke.key === 'Escape') { ke.preventDefault(); revert(); }
      });
    }

    // When the mode chip is clicked, fields re-render — re-bind blur/keydown to the new inputs.
    var chips = clone.querySelectorAll('.tol-mode-chip');
    for (var ci = 0; ci < chips.length; ci++) {
      chips[ci].addEventListener('click', function() {
        setTimeout(function() {
          var fresh = ctrl.getInputs();
          for (var k = 0; k < fresh.length; k++) {
            fresh[k].addEventListener('blur', onBlur);
            fresh[k].addEventListener('keydown', function(ke) {
              if (ke.key === 'Enter')  { ke.preventDefault(); commit(); }
              if (ke.key === 'Escape') { ke.preventDefault(); revert(); }
            });
          }
        }, 0);
      });
    }
  });
}

// ── Inline Editing ────────────────────────────────────

function setupInlineEditing(tr, row) {
  var editableCells = tr.querySelectorAll('td.editable');
  for (var i = 0; i < editableCells.length; i++) {
    (function(td) {
      var isTolCell = td.classList.contains('col-inputtol') || td.classList.contains('col-outtol');

      td.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        if (td.querySelector('input')) return;

        var originalHTML = td.innerHTML;

        if (isTolCell) {
          setupDualTolEdit(td, row, originalHTML);
        } else {
          setupSingleEdit(td, row, originalHTML);
        }
      });
    })(editableCells[i]);
  }
}

function setupDualTolEdit(td, row, originalHTML) {
  var c = row.computed;
  var isInput = td.classList.contains('col-inputtol');
  var plusVal = isInput ? c.op2kTolPlus : c.outTolPlus;
  var minusVal = isInput ? c.op2kTolMinus : c.outTolMinus;

  var state = getAppState();
  var globals = state ? state.globals : {};
  var importUnits = PSB.getPrintUnits(globals);
  var prec = importUnits === 'inch' ? (globals.inchPrecision || 4) : (globals.mmPrecision || 3);

  var plusStr = PSB.formatPrecision(plusVal, prec);
  var minusStr = PSB.formatPrecision(minusVal, prec);

  td.innerHTML = '<div class="tol-edit-container">' +
    '<div class="tol-input-wrap"><span class="tol-sign-label">+</span><input class="tol-input tol-plus" value="' + esc(plusStr) + '"></div>' +
    '<div class="tol-input-wrap"><span class="tol-sign-label">−</span><input class="tol-input tol-minus" value="' + esc(minusStr) + '"></div>' +
    '</div>';

  var plusInput = td.querySelector('.tol-plus');
  var minusInput = td.querySelector('.tol-minus');
  plusInput.focus();
  plusInput.select();

  var committed = false;
  var commit = function() {
    if (committed) return;
    committed = true;

    var pv = plusInput.value.trim();
    var mv = minusInput.value.trim();
    if (pv.charAt(0) === '+') pv = pv.substring(1);
    if (mv.charAt(0) === '-' || mv.charAt(0) === '−') mv = mv.substring(1);

    var pNum = parseFloat(pv);
    var mNum = parseFloat(mv);

    if (isNaN(pNum) && isNaN(mNum)) {
      td.innerHTML = originalHTML;
      return;
    }

    if (isNaN(pNum)) pNum = mNum;
    if (isNaN(mNum)) mNum = pNum;

    var origPlus = td.classList.contains('col-inputtol') ? row.computed.op2kTolPlus : row.computed.outTolPlus;
    var origMinus = td.classList.contains('col-inputtol') ? row.computed.op2kTolMinus : row.computed.outTolMinus;
    if (Math.abs(pNum - origPlus) < 1e-10 && Math.abs(mNum - origMinus) < 1e-10) {
      td.innerHTML = originalHTML;
      return;
    }

    var colClass = '';
    var classes = td.className.split(' ');
    for (var ci = 0; ci < classes.length; ci++) {
      if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
    }
    if (colClass) flashCellKey = row.id + '|' + colClass;

    var ov = Object.assign({}, row.user.overrides);
    if (td.classList.contains('col-inputtol')) {
      if (ov.outputTolPlus !== null || ov.outputTolMinus !== null) {
        ov.outputTolPlus = null;
        ov.outputTolMinus = null;
        showToast('OP2000 Tol changed — OUT Tol override cleared', 'info');
      }
      ov.outTolPlus = String(pNum);
      ov.outTolMinus = String(mNum);
    } else {
      ov.outputTolPlus = String(pNum);
      ov.outputTolMinus = String(mNum);
    }
    onRowUserChange(row.id, { overrides: ov });
  };

  var blurTimeout;
  var onBlur = function() {
    blurTimeout = setTimeout(function() {
      if (!td.contains(document.activeElement) || !td.querySelector('.tol-input')) {
        commit();
      }
    }, 0);
  };

  plusInput.addEventListener('blur', onBlur);
  minusInput.addEventListener('blur', onBlur);

  var handleKey = function(ke, isPlus) {
    if (ke.key === 'Enter') {
      ke.target.blur();
      setTimeout(commit, 0);
    }
    if (ke.key === 'Escape') {
      committed = true;
      td.innerHTML = originalHTML;
    }
    if (ke.key === 'Tab') {
      if (isPlus && !ke.shiftKey) {
        ke.preventDefault();
        minusInput.focus();
        minusInput.select();
      } else if (!isPlus && ke.shiftKey) {
        ke.preventDefault();
        plusInput.focus();
        plusInput.select();
      } else {
        ke.preventDefault();
        var colClass = '';
        var classes = td.className.split(' ');
        for (var ci = 0; ci < classes.length; ci++) {
          if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
        }
        navigateTarget = { rowId: row.id, colClass: colClass, reverse: ke.shiftKey };
        commit();
      }
    }
  };

  plusInput.addEventListener('keydown', function(ke) { handleKey(ke, true); });
  minusInput.addEventListener('keydown', function(ke) { handleKey(ke, false); });
}

function setupSingleEdit(td, row, originalHTML) {
  var originalValue = td.textContent;
  var input = document.createElement('input');
  input.type = 'text';
  input.value = originalValue;
  td.textContent = '';
  // SU1 holds ProShop notes — give the editor room instead of the narrow cell
  if (td.classList.contains('col-su1')) {
    input.className = 'su1-wide-input';
    td.classList.add('su1-editing');
  }
  td.appendChild(input);
  input.focus();
  input.select();

  var committed = false;
  var commit = function() {
    if (committed) return;
    committed = true;
    var newValue = input.value.trim();
    if (newValue && newValue.indexOf(' [') > 0) {
      newValue = newValue.split(' [')[0].trim();
    }

    var originalStripped = originalValue;
    if (originalStripped && originalStripped.indexOf(' [') > 0) {
      originalStripped = originalStripped.split(' [')[0].trim();
    }

    if (newValue === originalStripped) {
      td.innerHTML = originalHTML;
      return;
    }

    td.textContent = newValue || originalValue;

    var colClass = '';
    var classes = td.className.split(' ');
    for (var ci = 0; ci < classes.length; ci++) {
      if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
    }
    if (colClass) flashCellKey = row.id + '|' + colClass;

    var ov = Object.assign({}, row.user.overrides);
    if (td.classList.contains('col-inputspec')) {
      if (ov.outputSpec !== null) {
        ov.outputSpec = null;
        showToast('OP2000 Spec changed — OUT Spec override cleared', 'info');
      }
      ov.outDrawingSpec = newValue || null;
    } else if (td.classList.contains('col-drawspec')) {
      ov.outputSpec = newValue || null;
    } else if (td.classList.contains('col-pingage')) {
      ov.pinGageValue = newValue || null;
    } else if (td.classList.contains('col-su1')) {
      ov.specUnit1 = newValue || null;
    } else if (td.classList.contains('col-su2')) {
      ov.specUnit2 = newValue || null;
    } else if (td.classList.contains('col-su3')) {
      ov.specUnit3 = newValue || null;
    }
    onRowUserChange(row.id, { overrides: ov });
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', function(ke) {
    if (ke.key === 'Enter') input.blur();
    if (ke.key === 'Escape') {
      committed = true;
      td.innerHTML = originalHTML;
    }
    if (ke.key === 'Tab') {
      ke.preventDefault();
      var colClass = '';
      var classes = td.className.split(' ');
      for (var ci = 0; ci < classes.length; ci++) {
        if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
      }
      navigateTarget = {
        rowId: row.id,
        colClass: colClass,
        reverse: ke.shiftKey
      };
      input.blur();
    }
  });
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

// ── Toast Notifications ──────────────────────────────────

function showToast(message, type) {
  type = type || 'info';
  var container = document.getElementById('toast-container');

  // Cap at 3 toasts — remove oldest if over limit
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 3) {
    container.removeChild(toasts[0]);
    toasts = container.querySelectorAll('.toast');
  }

  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(function() {
    el.classList.add('toast-out');
    el.addEventListener('animationend', function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }, 3000);
}

// ── Tab Navigation Helper ─────────────────────────────────

function resolveNavigateTarget(tbody, displayRows) {
  var nav = navigateTarget;
  var editableCols = ['col-su1', 'col-drawspec', 'col-inputspec', 'col-su2', 'col-su3',
                      'col-pingage', 'col-inputtol', 'col-outtol'];

  var rowIdx = -1;
  for (var ri = 0; ri < displayRows.length; ri++) {
    if (displayRows[ri].id === nav.rowId) { rowIdx = ri; break; }
  }
  if (rowIdx < 0) return;

  var colIdx = editableCols.indexOf(nav.colClass);
  if (colIdx < 0) return;

  if (nav.reverse) {
    colIdx--;
    if (colIdx < 0) { colIdx = editableCols.length - 1; rowIdx--; }
  } else {
    colIdx++;
    if (colIdx >= editableCols.length) { colIdx = 0; rowIdx++; }
  }

  if (rowIdx < 0 || rowIdx >= displayRows.length) return;

  var targetRowId = displayRows[rowIdx].id;
  var targetColClass = editableCols[colIdx];

  var targetTr = tbody.querySelector('tr[data-row-id="' + targetRowId + '"]');
  if (!targetTr) return;
  var targetTd = targetTr.querySelector('.' + targetColClass);
  if (!targetTd) return;

  setTimeout(function() {
    targetTd.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, 0);
}

// ── Confirm Modal ─────────────────────────────────────────

function showConfirmModal(opts) {
  var modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-title').textContent = opts.title || 'Confirm';
  document.getElementById('confirm-modal-message').innerHTML = opts.message || '';

  var okBtn = document.getElementById('confirm-modal-ok');
  var cancelBtn = document.getElementById('confirm-modal-cancel');

  okBtn.textContent = opts.confirmLabel || 'Confirm';
  okBtn.className = 'btn ' + (opts.confirmClass || 'btn-primary');

  // Clone buttons to remove old listeners
  var okClone = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(okClone, okBtn);
  var cancelClone = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(cancelClone, cancelBtn);

  openModal('confirm-modal');

  cancelClone.addEventListener('click', function() {
    closeModal('confirm-modal');
  });
  okClone.addEventListener('click', function() {
    closeModal('confirm-modal');
    if (opts.onConfirm) opts.onConfirm();
  });
}

// ── Sidebar Row History ──────────────────────────────────

function populateSidebarHistory(rowId) {
  var listEl = document.getElementById('sidebar-history-list');
  if (!listEl) return;
  var state = getAppState();
  var entries = PSB.getRowHistory(state.auditLog || [], rowId);

  if (entries.length === 0) {
    listEl.innerHTML = '<span class="text-muted">No changes yet</span>';
  } else {
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      html += '<div class="history-entry">' +
        '<span class="history-time">' + PSB.formatHistoryTime(e.timestamp) + '</span>' +
        '<span class="history-desc">' + esc(e.description) + '</span>' +
        '</div>';
    }
    listEl.innerHTML = html;
  }

  // Wire "View All" — shows only this row's history
  var viewAllBtn = document.getElementById('btn-row-history');
  if (viewAllBtn) {
    var clone = viewAllBtn.cloneNode(true);
    viewAllBtn.parentNode.replaceChild(clone, viewAllBtn);
    clone.addEventListener('click', function() { openHistoryModal(rowId); });
  }
}

// ── History Overlay Modal ────────────────────────────────

// rowId optional — if provided shows only that row's history
function openHistoryModal(rowId) {
  var state = getAppState();
  var log = state.auditLog || [];
  var listEl = document.getElementById('history-modal-list');
  var titleEl = document.querySelector('#history-modal .modal-header h2');

  var entries = rowId
    ? log.filter(function(e) { return e.rowId === rowId; })
    : log;

  if (titleEl) {
    if (rowId) {
      var rowObj = state.rows.find(function(r) { return r.id === rowId; });
      var tag = rowObj ? (rowObj.computed.dimTag || rowId) : rowId;
      titleEl.textContent = 'Row ' + tag + ' — History';
    } else {
      titleEl.textContent = 'Change History — All Rows';
    }
  }

  if (entries.length === 0) {
    listEl.innerHTML = '<p class="text-muted">No changes recorded yet.</p>';
  } else {
    var html = '';
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      var typeClass = 'history-type-' + e.type;
      var detailsHtml = '';
      if (e.details && e.details.length > 0) {
        detailsHtml = '<div class="history-details">';
        for (var j = 0; j < e.details.length; j++) {
          var d = e.details[j];
          detailsHtml += '<div class="history-detail-row">' +
            '<span class="history-field">' + esc(d.field) + '</span> ' +
            (d.from ? '<span class="history-from">' + esc(d.from) + '</span> → ' : '') +
            '<span class="history-to">' + esc(d.to) + '</span>' +
            '</div>';
        }
        detailsHtml += '</div>';
      }
      html += '<div class="history-modal-entry ' + typeClass + '">' +
        '<div class="history-modal-header">' +
        '<span class="history-time">' + PSB.formatHistoryTime(e.timestamp) + '</span>' +
        '<span class="history-type-badge">' + esc(e.type) + '</span>' +
        '</div>' +
        '<div class="history-desc">' + esc(e.description) + '</div>' +
        detailsHtml +
        '</div>';
    }
    listEl.innerHTML = html;
  }

  openModal('history-modal');

  var closeBtn = document.getElementById('history-close');
  var closeClone = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(closeClone, closeBtn);
  closeClone.addEventListener('click', function() {
    closeModal('history-modal');
  });
}

// ── Loading Spinner ──────────────────────────────────────

function showLoading(text) {
  var overlay = document.getElementById('loading-overlay');
  if (text) {
    var span = overlay.querySelector('.spinner-text');
    if (span) span.textContent = text;
  }
  overlay.classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ── Modal Open/Close Helpers (animated) ──────────────────

function openModal(id) {
  var modal = document.getElementById(id);
  modal.classList.remove('hidden');
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      modal.classList.add('modal-open');
    });
  });
}

function closeModal(id) {
  var modal = document.getElementById(id);
  modal.classList.remove('modal-open');
  var onEnd = function() {
    modal.classList.add('hidden');
    modal.removeEventListener('transitionend', onEnd);
  };
  modal.addEventListener('transitionend', onEnd);
  // Fallback in case transitionend doesn't fire
  setTimeout(function() {
    modal.classList.add('hidden');
  }, 200);
}

// ── Export to namespace ───────────────────────────────────
PSB.initUI = initUI;
PSB.renderOpBar = renderOpBar;
PSB.closeSidebar = closeSidebar;
PSB.populateSidebar = populateSidebar;
PSB.getSelectedRowId = getSelectedRowId;
PSB.getOpColor = getOpColor;
PSB.showToast = showToast;
PSB.showConfirmModal = showConfirmModal;
PSB.openHistoryModal = openHistoryModal;
PSB.openModal = openModal;
PSB.closeModal = closeModal;
PSB.showLoading = showLoading;
PSB.hideLoading = hideLoading;
PSB.esc = esc;
PSB.openSetupPanel = openSetupPanel;
PSB.closeSetupPanel = closeSetupPanel;
PSB.toggleSetupPanel = toggleSetupPanel;
