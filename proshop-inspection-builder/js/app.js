/**
 * app.js — Main Application Entry Point
 *
 * Wires together all modules:
 * - parser.js for CSV import
 * - dataModel.js for row creation + recompute
 * - ui.js for rendering + interaction
 * - exportEngine.js for CSV export
 * - storage.js for save/load
 *
 * Owns the app state: { rows[], globals }
 */

// ═══════════════════════════════════════════════════════════
// APP STATE (single source of truth for the session)
// ═══════════════════════════════════════════════════════════
var state = {
  rows: [],
  globals: PSB.defaultGlobals(),
};

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function() {
  // Try to restore from auto-save
  var saved = PSB.autoLoad();
  if (saved) {
    state.globals = Object.assign(PSB.defaultGlobals(), saved.globals);
    state.rows = saved.rows;
    recomputeAll();
    console.log('Restored ' + state.rows.length + ' rows from auto-save');
  }

  // Initialize UI
  PSB.initUI({
    onRowUserChange: handleRowUserChange,
    onFileImport: handleFileImport,
    getAppState: function() { return state; },
  });

  // Bind header controls
  bindGlobalControls();
  bindFileButtons();
  bindOpBar();
  bindExportModal();
  bindSettingsModal();

  // Initial render
  syncGlobalsToUI();
  PSB.renderOpBar(state.globals.ops, handleRemoveOp);
  PSB.renderTable(state.rows);
});

// ═══════════════════════════════════════════════════════════
// GLOBAL CONTROLS
// ═══════════════════════════════════════════════════════════
function bindGlobalControls() {
  // Import units
  document.getElementById('import-units').addEventListener('change', function(e) {
    state.globals.importUnits = e.target.value;
    recomputeAll();
    scheduleAutoSave();
  });

  // Plating thickness
  document.getElementById('plating-thickness').addEventListener('input', function(e) {
    state.globals.platingThickness = parseFloat(e.target.value) || 0;
    recomputeAll();
    scheduleAutoSave();
  });

  // Plating units
  document.getElementById('plating-units').addEventListener('change', function(e) {
    state.globals.platingUnits = e.target.value;
    recomputeAll();
    scheduleAutoSave();
  });

  // Precision
  document.getElementById('inch-precision').addEventListener('input', function(e) {
    state.globals.inchPrecision = parseInt(e.target.value) || 4;
    recomputeAll();
    scheduleAutoSave();
  });

  document.getElementById('mm-precision').addEventListener('input', function(e) {
    state.globals.mmPrecision = parseInt(e.target.value) || 3;
    recomputeAll();
    scheduleAutoSave();
  });
}

function syncGlobalsToUI() {
  document.getElementById('import-units').value = state.globals.importUnits;
  document.getElementById('plating-thickness').value = state.globals.platingThickness || '';
  document.getElementById('plating-units').value = state.globals.platingUnits;
  document.getElementById('inch-precision').value = state.globals.inchPrecision;
  document.getElementById('mm-precision').value = state.globals.mmPrecision;
}

// ═══════════════════════════════════════════════════════════
// FILE IMPORT / EXPORT / SAVE / LOAD BUTTONS
// ═══════════════════════════════════════════════════════════
function bindFileButtons() {
  // Import CSV button
  document.getElementById('btn-import').addEventListener('click', function() {
    document.getElementById('file-import-csv').click();
  });

  document.getElementById('file-import-csv').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) { handleFileImport(ev.target.result, file.name); };
    reader.readAsText(file);
    e.target.value = ''; // Reset so same file can be re-imported
  });

  // Save project
  document.getElementById('btn-save').addEventListener('click', function() {
    PSB.saveProject(state);
  });

  // Load project button
  document.getElementById('btn-load').addEventListener('click', function() {
    document.getElementById('file-load-project').click();
  });

  document.getElementById('file-load-project').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var loaded = PSB.loadProject(ev.target.result);
        state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
        state.rows = loaded.rows;
        recomputeAll();
        syncGlobalsToUI();
        PSB.renderOpBar(state.globals.ops, handleRemoveOp);
        PSB.closeSidebar();
        console.log('Loaded project with ' + state.rows.length + ' rows');
      } catch (err) {
        alert('Failed to load project file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Export button → open modal
  document.getElementById('btn-export').addEventListener('click', function() {
    openExportModal();
  });
}

// ═══════════════════════════════════════════════════════════
// OP BAR
// ═══════════════════════════════════════════════════════════
function bindOpBar() {
  var input = document.getElementById('op-add-input');
  var btn = document.getElementById('btn-add-op');

  var addOp = function() {
    var val = parseInt(input.value);
    if (isNaN(val) || val <= 0) return;
    if (state.globals.ops.indexOf(val) !== -1) return;

    state.globals.ops.push(val);
    state.globals.ops.sort(function(a, b) { return a - b; });

    // Initialize prefix if not exists
    if (!state.globals.opPrefixes[val]) {
      state.globals.opPrefixes[val] = '';
    }

    input.value = '';
    PSB.renderOpBar(state.globals.ops, handleRemoveOp);
    recomputeAll();
    scheduleAutoSave();
  };

  btn.addEventListener('click', addOp);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') addOp();
  });
}

function handleRemoveOp(opNum) {
  state.globals.ops = state.globals.ops.filter(function(o) { return o !== opNum; });
  PSB.renderOpBar(state.globals.ops, handleRemoveOp);
  recomputeAll();
  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// EXPORT MODAL
// ═══════════════════════════════════════════════════════════
function bindExportModal() {
  document.getElementById('export-close').addEventListener('click', function() {
    document.getElementById('export-modal').classList.add('hidden');
  });

  document.getElementById('btn-export-confirm').addEventListener('click', function() {
    var checkboxes = document.querySelectorAll('#export-op-checkboxes input:checked');
    var selectedOps = [];
    for (var i = 0; i < checkboxes.length; i++) {
      selectedOps.push(parseInt(checkboxes[i].value));
    }
    var exportUnits = document.getElementById('export-units').value;

    if (selectedOps.length === 0) {
      alert('Select at least one OP to export.');
      return;
    }

    state.globals.exportUnits = exportUnits;
    var csv = PSB.generateCSV(state.rows, selectedOps, state.globals);
    PSB.downloadCSV(csv);
    document.getElementById('export-modal').classList.add('hidden');
  });
}

function openExportModal() {
  var container = document.getElementById('export-op-checkboxes');
  container.innerHTML = '';

  for (var i = 0; i < state.globals.ops.length; i++) {
    var op = state.globals.ops[i];
    var label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    label.style.padding = '4px 0';

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = op;
    cb.checked = true;

    label.appendChild(cb);
    label.appendChild(document.createTextNode('OP ' + op + (op === 2000 ? ' (raw values)' : '')));
    container.appendChild(label);
  }

  document.getElementById('export-modal').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════
function bindSettingsModal() {
  document.getElementById('btn-settings').addEventListener('click', function() {
    // Populate equipment list
    document.getElementById('settings-equipment-list').value =
      state.globals.equipmentList.join('\n');

    // Populate op prefixes
    var prefixContainer = document.getElementById('settings-op-prefixes');
    prefixContainer.innerHTML = '';
    for (var i = 0; i < state.globals.ops.length; i++) {
      var op = state.globals.ops[i];
      var row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '4px 0';

      var label = document.createElement('label');
      label.textContent = 'OP ' + op + ':';
      label.style.width = '60px';
      label.style.fontSize = '12px';

      var input = document.createElement('input');
      input.type = 'text';
      input.value = state.globals.opPrefixes[op] || '';
      input.placeholder = 'e.g., HREF-';
      input.style.flex = '1';
      input.dataset.op = op;
      input.className = 'op-prefix-input';

      row.appendChild(label);
      row.appendChild(input);
      prefixContainer.appendChild(row);
    }

    document.getElementById('settings-modal').classList.remove('hidden');
  });

  document.getElementById('settings-close').addEventListener('click', function() {
    // Save equipment list
    var eqText = document.getElementById('settings-equipment-list').value;
    state.globals.equipmentList = eqText.split('\n')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s !== ''; })
      .sort();

    // Save op prefixes
    var prefixInputs = document.querySelectorAll('.op-prefix-input');
    for (var i = 0; i < prefixInputs.length; i++) {
      state.globals.opPrefixes[prefixInputs[i].dataset.op] = prefixInputs[i].value;
    }

    document.getElementById('settings-modal').classList.add('hidden');
    scheduleAutoSave();
  });
}

// ═══════════════════════════════════════════════════════════
// FILE IMPORT HANDLER
// ═══════════════════════════════════════════════════════════
function handleFileImport(content, fileName) {
  if (fileName.endsWith('.json')) {
    // Load project file
    try {
      var loaded = PSB.loadProject(content);
      state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
      state.rows = loaded.rows;
      recomputeAll();
      syncGlobalsToUI();
      PSB.renderOpBar(state.globals.ops, handleRemoveOp);
      PSB.closeSidebar();
    } catch (err) {
      alert('Failed to load project: ' + err.message);
    }
    return;
  }

  // Parse CSV
  var rawRows = PSB.parseCSV(content);
  if (rawRows.length === 0) {
    alert('No valid data found in CSV.');
    return;
  }

  // Create row objects
  PSB.resetIdCounter();
  state.rows = rawRows.map(function(raw) { return PSB.createRow(raw); });

  // Recompute all and render
  recomputeAll();
  PSB.closeSidebar();

  console.log('Imported ' + state.rows.length + ' rows from ' + fileName);
}

// ═══════════════════════════════════════════════════════════
// ROW USER CHANGE HANDLER
// ═══════════════════════════════════════════════════════════
function handleRowUserChange(rowId, changes) {
  var row = state.rows.find(function(r) { return r.id === rowId; });
  if (!row) return;

  // Merge changes into user state
  Object.assign(row.user, changes);

  // Auto-set status to 'edited' if currently 'none'
  if (row.user.status === 'none') {
    row.user.status = 'edited';
  }

  // Recompute this row
  PSB.recompute(row, state.globals);

  // Re-render table and sidebar
  PSB.renderTable(state.rows);

  // Update sidebar if this row is selected
  if (PSB.getSelectedRowId() === rowId) {
    // Re-select the row in the table
    var tr = document.querySelector('#table-body tr[data-row-id="' + rowId + '"]');
    if (tr) tr.classList.add('selected');

    // Update sidebar preview values
    var c = row.computed;
    document.getElementById('sidebar-out-spec').textContent = c.outDrawingSpec || '—';
    document.getElementById('sidebar-out-nominal').textContent = c.outNominal || '—';
    document.getElementById('sidebar-out-tol').textContent = c.outTolerance || '—';

    // Update status buttons
    var statusBtns = document.querySelectorAll('.btn-status');
    for (var i = 0; i < statusBtns.length; i++) {
      if (statusBtns[i].dataset.status === row.user.status) {
        statusBtns[i].classList.add('active');
      } else {
        statusBtns[i].classList.remove('active');
      }
    }
  }

  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// RECOMPUTE ALL ROWS
// ═══════════════════════════════════════════════════════════
function recomputeAll() {
  for (var i = 0; i < state.rows.length; i++) {
    PSB.recompute(state.rows[i], state.globals);
  }
  PSB.renderTable(state.rows);
  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// AUTO-SAVE (debounced)
// ═══════════════════════════════════════════════════════════
var autoSaveTimer = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(function() {
    PSB.autoSave(state);
  }, 1000);
}
