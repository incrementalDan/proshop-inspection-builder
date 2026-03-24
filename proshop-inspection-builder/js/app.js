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

var APP_VERSION = 'v1.2';

console.log('[PSB] app.js loaded, PSB namespace:', typeof PSB !== 'undefined' ? Object.keys(PSB).length + ' functions' : 'MISSING');

// ═══════════════════════════════════════════════════════════
// SAMPLE DATA (for quick testing)
// ═══════════════════════════════════════════════════════════
var SAMPLE_CSV = [
  'Internal Part #,Op #,Dim Tag #,Ref Loc,Char Dsg,Spec Unit 1,Drawing Spec,Spec Unit 2,Spec Unit 3,Inspec Equip,Nom Dim,Tol ±,IPC?,Inspection Frequency,Show Dim When?',
  ',,1,S1,,,33.0,,,,33.0,0.5,,,',
  ',,2,S1,,,25.0,,,,25.0,0.1,,,',
  ',,3,S1,,,8.00,,,,8.00,0.05,,,',
  ',,4,S1,,Ø,3.5,,,,3.5,0.1,,,',
  ',,5,S1,,Ø,9.0,,,,9.0,0.3,,,',
  ',,6,S1,,Ø,3.3,,2x,,3.3,0.1,,,',
  ',,7,S1,,,2.0,,4x,,2.0,0.1,,,',
  ',,8,S1,,,BREAK AND DEBURR ALL SHARP EDGES.,,,,,,,,'
].join('\n');

// ═══════════════════════════════════════════════════════════
// APP STATE (single source of truth for the session)
// ═══════════════════════════════════════════════════════════
var state = {
  rows: [],
  globals: PSB.defaultGlobals(),
};

// ═══════════════════════════════════════════════════════════
// DIRTY FLAG — tracks unsaved changes to warn before close
// ═══════════════════════════════════════════════════════════
var isDirty = false;

function markDirty() {
  isDirty = true;
  if (!document.title.startsWith('* ')) {
    document.title = '* ' + document.title;
  }
  var fnEl = document.getElementById('filename-text');
  if (fnEl && !fnEl.textContent.endsWith(' \u2022')) {
    fnEl.textContent = fnEl.textContent + ' \u2022';
  }
  var saveBtn = document.getElementById('btn-save');
  if (saveBtn) saveBtn.classList.add('btn-dirty');
}

function markClean() {
  isDirty = false;
  document.title = document.title.replace(/^\* /, '');
  var fnEl = document.getElementById('filename-text');
  if (fnEl) fnEl.textContent = fnEl.textContent.replace(/ \u2022$/, '');
  var saveBtn = document.getElementById('btn-save');
  if (saveBtn) saveBtn.classList.remove('btn-dirty');
}

window.addEventListener('beforeunload', function(e) {
  if (isDirty && state.rows.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function() {
  try {
    console.log('[PSB] DOMContentLoaded fired, initializing...');

    // Clear any corrupt auto-save from old ES module version
    try {
      var saved = PSB.autoLoad();
      if (saved) {
        state.globals = Object.assign(PSB.defaultGlobals(), saved.globals);
        state.rows = saved.rows;
        // deserializeState already normalizes user/overrides fields
        recomputeAll();
        console.log('[PSB] Restored ' + state.rows.length + ' rows from auto-save');
      }
    } catch (e) {
      console.warn('[PSB] Auto-load failed, clearing:', e);
      PSB.clearAutoSave();
    }

    // Initialize UI
    PSB.initUI({
      onRowUserChange: handleRowUserChange,
      onFileImport: handleFileImport,
      getAppState: function() { return state; },
    });
    console.log('[PSB] UI initialized');

    // Bind header controls
    bindGlobalControls();
    bindFileButtons();
    bindNewButton();
    bindSampleButton();
    bindOpBar();
    bindExportModal();
    bindSettingsModal();
    console.log('[PSB] All controls bound');

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        document.getElementById('btn-save').click();
      }
      if (mod && e.key === 'e') {
        e.preventDefault();
        openExportModal();
      }
      if (e.key === 'Escape') {
        var confirmModal = document.getElementById('confirm-modal');
        if (!confirmModal.classList.contains('hidden')) {
          confirmModal.classList.add('hidden');
          return;
        }
        var exportModal = document.getElementById('export-modal');
        var settingsModal = document.getElementById('settings-modal');
        if (!exportModal.classList.contains('hidden')) {
          exportModal.classList.add('hidden');
        } else if (!settingsModal.classList.contains('hidden')) {
          document.getElementById('settings-close').click();
        } else if (!document.getElementById('sidebar').classList.contains('hidden')) {
          PSB.closeSidebar();
        }
      }
    });

    // Initial render
    syncGlobalsToUI();
    applyUnitColors(state.globals.importUnits);
    PSB.renderOpBar(state.globals.ops, handleRemoveOp);
    PSB.renderTable(state.rows);
    // Set version from single source
    var versionEl = document.querySelector('.app-version');
    if (versionEl) versionEl.textContent = APP_VERSION;

    console.log('[PSB] Init complete');

  } catch (err) {
    console.error('[PSB] Init error:', err);
    // Show visible error
    var el = document.getElementById('empty-state');
    if (el) {
      el.innerHTML = '<div style="color:#f44336;padding:20px;"><h2>JS Init Error</h2><pre>' +
        err.message + '\n' + err.stack + '</pre></div>';
    }
  }
});

// ═══════════════════════════════════════════════════════════
// NEW FILE BUTTON
// ═══════════════════════════════════════════════════════════
function bindNewButton() {
  document.getElementById('btn-new').addEventListener('click', function() {
    var doNew = function() {
      PSB.clearAutoSave();
      PSB.clearProjectFileHandle();
      state.rows = [];
      state.globals = PSB.defaultGlobals();
      syncGlobalsToUI();
      PSB.renderOpBar(state.globals.ops, handleRemoveOp);
      PSB.renderTable(state.rows);
      PSB.closeSidebar();
      setFilename(null);
      markClean();
      console.log('[PSB] New file — state cleared');
    };

    if (state.rows.length > 0) {
      var fnEl = document.getElementById('filename-text');
      var currentName = fnEl ? fnEl.textContent.replace(/ \u2022$/, '') : 'current file';
      PSB.showConfirmModal({
        title: 'Clear All Data?',
        message: 'This will clear <strong>' + state.rows.length + '</strong> rows from <strong>' + PSB.esc(currentName) + '</strong>. This cannot be undone.',
        confirmLabel: 'Clear All Data',
        confirmClass: 'btn-danger',
        onConfirm: doNew
      });
    } else {
      doNew();
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SAMPLE DATA BUTTON
// ═══════════════════════════════════════════════════════════
function bindSampleButton() {
  document.getElementById('btn-sample').addEventListener('click', function() {
    console.log('[PSB] Loading sample data...');
    handleFileImport(SAMPLE_CSV, 'sample.csv');
  });
}

// ═══════════════════════════════════════════════════════════
// GLOBAL CONTROLS
// ═══════════════════════════════════════════════════════════
function bindGlobalControls() {
  // Import units — iOS-style toggle
  var unitToggle = document.getElementById('unit-toggle');
  if (unitToggle) {
    unitToggle.addEventListener('click', function() {
      var isMm = unitToggle.getAttribute('aria-checked') === 'true';
      var newUnit = isMm ? 'inch' : 'mm';
      unitToggle.setAttribute('aria-checked', newUnit === 'mm' ? 'true' : 'false');
      document.getElementById('import-units').value = newUnit;
      state.globals.importUnits = newUnit;
      applyUnitColors(newUnit);
      recomputeAll();
      markDirty();
      scheduleAutoSave();
    });
    unitToggle.addEventListener('keydown', function(e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); unitToggle.click(); }
    });
  }

  // Fallback: hidden select (for programmatic sync)
  document.getElementById('import-units').addEventListener('change', function(e) {
    state.globals.importUnits = e.target.value;
    syncUnitToggle(e.target.value);
    applyUnitColors(e.target.value);
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  // Plating thickness
  document.getElementById('plating-thickness').addEventListener('input', function(e) {
    state.globals.platingThickness = parseFloat(e.target.value) || 0;
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  // Plating units
  document.getElementById('plating-units').addEventListener('change', function(e) {
    state.globals.platingUnits = e.target.value;
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  // Precision
  document.getElementById('inch-precision').addEventListener('input', function(e) {
    state.globals.inchPrecision = parseInt(e.target.value) || 4;
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  document.getElementById('mm-precision').addEventListener('input', function(e) {
    state.globals.mmPrecision = parseInt(e.target.value) || 3;
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });
}

function syncGlobalsToUI() {
  document.getElementById('import-units').value = state.globals.importUnits;
  syncUnitToggle(state.globals.importUnits);
  applyUnitColors(state.globals.importUnits);
  document.getElementById('plating-thickness').value = state.globals.platingThickness || '';
  document.getElementById('plating-units').value = state.globals.platingUnits;
  document.getElementById('inch-precision').value = state.globals.inchPrecision;
  document.getElementById('mm-precision').value = state.globals.mmPrecision;
}

function syncUnitToggle(unit) {
  var toggle = document.getElementById('unit-toggle');
  if (toggle) toggle.setAttribute('aria-checked', unit === 'mm' ? 'true' : 'false');
}

function applyUnitColors(unit) {
  var root = document.documentElement;
  var style = getComputedStyle(root);
  if (unit === 'mm') {
    root.style.setProperty('--unit-primary', style.getPropertyValue('--unit-mm').trim());
    root.style.setProperty('--unit-secondary', style.getPropertyValue('--unit-inch').trim());
  } else {
    root.style.setProperty('--unit-primary', style.getPropertyValue('--unit-inch').trim());
    root.style.setProperty('--unit-secondary', style.getPropertyValue('--unit-mm').trim());
  }
}

function setFilename(name) {
  var el = document.getElementById('filename-text');
  if (!el) return;
  if (name) {
    el.textContent = name;
    el.classList.add('has-file');
  } else {
    el.textContent = 'No file loaded';
    el.classList.remove('has-file');
  }
}

// ═══════════════════════════════════════════════════════════
// FILE IMPORT / EXPORT / SAVE / LOAD BUTTONS
// ═══════════════════════════════════════════════════════════
function bindFileButtons() {
  // Import CSV button
  document.getElementById('btn-import').addEventListener('click', function() {
    console.log('[PSB] Import button clicked');
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
    var result = PSB.saveProject(state);
    if (result && result.then) {
      result.then(function(ok) { if (ok) { markClean(); PSB.showToast('Project saved.', 'success'); } });
    } else {
      markClean();
      PSB.showToast('Project saved.', 'success');
    }
  });

  // Load project button
  document.getElementById('btn-load').addEventListener('click', function() {
    document.getElementById('file-load-project').click();
  });

  document.getElementById('file-load-project').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    var loadFileName = file.name;
    reader.onload = function(ev) {
      try {
        var loaded = PSB.loadProject(ev.target.result);
        state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
        state.rows = loaded.rows;
        recomputeAll();
        syncGlobalsToUI();
        PSB.renderOpBar(state.globals.ops, handleRemoveOp);
        PSB.closeSidebar();
        setFilename(loadFileName);
        markClean();
        console.log('[PSB] Loaded project with ' + state.rows.length + ' rows');
      } catch (err) {
        PSB.showToast('Failed to load project file: ' + err.message, 'error');
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
    if (val === 2000) { input.value = ''; PSB.showToast('OP2000 is included automatically in every export.', 'info'); return; }
    if (state.globals.ops.indexOf(val) !== -1) return;

    state.globals.ops.push(val);
    state.globals.ops.sort(function(a, b) { return a - b; });

    input.value = '';
    PSB.renderOpBar(state.globals.ops, handleRemoveOp);
    recomputeAll();
    markDirty();
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
  markDirty();
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
      PSB.showToast('Select at least one OP to export.', 'error');
      return;
    }

    state.globals.exportUnits = exportUnits;
    // Recompute so exportNominal/exportTolerance use the selected export units
    recomputeAll();
    var csv = PSB.generateCSV(state.rows, selectedOps, state.globals);
    PSB.downloadCSV(csv);
    PSB.showToast('CSV exported.', 'success');
    document.getElementById('export-modal').classList.add('hidden');

    // Auto-save project file alongside the CSV export
    // Uses silent mode — writes to the existing file handle without prompting.
    // If no handle exists yet (first export without prior save), prompts once.
    setTimeout(function() {
      var result = PSB.saveProject(state, { silent: true });
      if (result && result.then) {
        result.then(function(ok) { if (ok) markClean(); });
      } else {
        markClean();
      }
    }, 1500);
  });
}

function openExportModal() {
  var container = document.getElementById('export-op-checkboxes');
  container.innerHTML = '';

  // Build list: all user ops + always include OP2000
  var exportOps = state.globals.ops.slice();
  if (exportOps.indexOf(2000) === -1) {
    exportOps.push(2000);
    exportOps.sort(function(a, b) { return a - b; });
  }

  for (var i = 0; i < exportOps.length; i++) {
    var op = exportOps[i];
    var color = PSB.getOpColor ? PSB.getOpColor(op) : '#4a9eff';
    var label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    label.style.padding = '4px 0';

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = op;
    cb.checked = true; // All OPs including OP2000 checked by default

    var opSpan = document.createElement('span');
    opSpan.className = 'op-bubble active';
    opSpan.style.setProperty('--op-c', color);
    opSpan.textContent = 'OP ' + op;

    var extraText = op === 2000 ? ' (raw values)' : '';

    label.appendChild(cb);
    label.appendChild(opSpan);
    if (extraText) label.appendChild(document.createTextNode(extraText));
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

    document.getElementById('settings-modal').classList.remove('hidden');
  });

  document.getElementById('settings-close').addEventListener('click', function() {
    // Save equipment list
    var eqText = document.getElementById('settings-equipment-list').value;
    state.globals.equipmentList = eqText.split('\n')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s !== ''; })
      .sort();

    document.getElementById('settings-modal').classList.add('hidden');
    markDirty();
    scheduleAutoSave();
  });
}

// ═══════════════════════════════════════════════════════════
// FILE IMPORT HANDLER
// ═══════════════════════════════════════════════════════════
function handleFileImport(content, fileName) {
  var doImport = function() {
    if (fileName.endsWith('.json')) {
      try {
        var loaded = PSB.loadProject(content);
        state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
        state.rows = loaded.rows;
        recomputeAll();
        syncGlobalsToUI();
        PSB.renderOpBar(state.globals.ops, handleRemoveOp);
        PSB.closeSidebar();
        setFilename(fileName);
        markClean();
      } catch (err) {
        PSB.showToast('Failed to load project: ' + err.message, 'error');
      }
      return;
    }

    var rawRows = PSB.parseCSV(content);
    if (rawRows.length === 0) {
      PSB.showToast('No valid data found in CSV.', 'error');
      return;
    }

    PSB.resetIdCounter();
    state.rows = rawRows.map(function(raw) { return PSB.createRow(raw); });
    recomputeAll();
    PSB.closeSidebar();
    setFilename(fileName);
    markDirty();
    console.log('[PSB] Imported ' + state.rows.length + ' rows from ' + fileName);
    PSB.showToast('Imported ' + state.rows.length + ' rows from ' + fileName, 'success');
  };

  if (state.rows.length > 0) {
    PSB.showConfirmModal({
      title: 'Replace Existing Data?',
      message: 'You have <strong>' + state.rows.length + '</strong> rows with edits. Importing will replace all data.',
      confirmLabel: 'Replace',
      confirmClass: 'btn-danger',
      onConfirm: doImport
    });
  } else {
    doImport();
  }
}

// ═══════════════════════════════════════════════════════════
// ROW USER CHANGE HANDLER
// ═══════════════════════════════════════════════════════════
function handleRowUserChange(rowId, changes) {
  var row = state.rows.find(function(r) { return r.id === rowId; });
  if (!row) return;

  // Merge changes into user state
  Object.assign(row.user, changes);

  // Auto-sync IPC when OPs change: on if any OP selected, off if none
  if (changes.includeOps) {
    var anyOpOn = false;
    for (var k in row.user.includeOps) {
      if (row.user.includeOps[k]) { anyOpOn = true; break; }
    }
    row.user.ipc = anyOpOn;
  }

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

    // Full sidebar refresh (uses formatDualDisplay, leading zeros, etc.)
    PSB.populateSidebar(rowId);
  }

  markDirty();
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
