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

import { parseCSV } from './parser.js';
import { createRow, recompute, defaultGlobals, resetIdCounter } from './dataModel.js';
import { initUI, renderTable, renderOpBar, closeSidebar, getSelectedRowId } from './ui.js';
import { generateCSV, downloadCSV } from './exportEngine.js';
import { autoSave, autoLoad, saveProject, loadProject } from './storage.js';

// ═══════════════════════════════════════════════════════════
// APP STATE (single source of truth for the session)
// ═══════════════════════════════════════════════════════════
let state = {
  rows: [],
  globals: defaultGlobals(),
};

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Try to restore from auto-save
  const saved = autoLoad();
  if (saved) {
    state.globals = { ...defaultGlobals(), ...saved.globals };
    state.rows = saved.rows;
    recomputeAll();
    console.log(`Restored ${state.rows.length} rows from auto-save`);
  }

  // Initialize UI
  initUI({
    onRowUserChange: handleRowUserChange,
    onFileImport: handleFileImport,
    getAppState: () => state,
  });

  // Bind header controls
  bindGlobalControls();
  bindFileButtons();
  bindOpBar();
  bindExportModal();
  bindSettingsModal();

  // Initial render
  syncGlobalsToUI();
  renderOpBar(state.globals.ops, handleRemoveOp);
  renderTable(state.rows);
});

// ═══════════════════════════════════════════════════════════
// GLOBAL CONTROLS
// ═══════════════════════════════════════════════════════════
function bindGlobalControls() {
  // Import units
  document.getElementById('import-units').addEventListener('change', (e) => {
    state.globals.importUnits = e.target.value;
    recomputeAll();
    scheduleAutoSave();
  });

  // Plating thickness
  document.getElementById('plating-thickness').addEventListener('input', (e) => {
    state.globals.platingThickness = parseFloat(e.target.value) || 0;
    recomputeAll();
    scheduleAutoSave();
  });

  // Plating units
  document.getElementById('plating-units').addEventListener('change', (e) => {
    state.globals.platingUnits = e.target.value;
    recomputeAll();
    scheduleAutoSave();
  });

  // Precision
  document.getElementById('inch-precision').addEventListener('input', (e) => {
    state.globals.inchPrecision = parseInt(e.target.value) || 4;
    recomputeAll();
    scheduleAutoSave();
  });

  document.getElementById('mm-precision').addEventListener('input', (e) => {
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
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('file-import-csv').click();
  });

  document.getElementById('file-import-csv').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => handleFileImport(ev.target.result, file.name);
    reader.readAsText(file);
    e.target.value = ''; // Reset so same file can be re-imported
  });

  // Save project
  document.getElementById('btn-save').addEventListener('click', () => {
    saveProject(state);
  });

  // Load project button
  document.getElementById('btn-load').addEventListener('click', () => {
    document.getElementById('file-load-project').click();
  });

  document.getElementById('file-load-project').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const loaded = loadProject(ev.target.result);
        state.globals = { ...defaultGlobals(), ...loaded.globals };
        state.rows = loaded.rows;
        recomputeAll();
        syncGlobalsToUI();
        renderOpBar(state.globals.ops, handleRemoveOp);
        closeSidebar();
        console.log(`Loaded project with ${state.rows.length} rows`);
      } catch (err) {
        alert('Failed to load project file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Export button → open modal
  document.getElementById('btn-export').addEventListener('click', () => {
    openExportModal();
  });
}

// ═══════════════════════════════════════════════════════════
// OP BAR
// ═══════════════════════════════════════════════════════════
function bindOpBar() {
  const input = document.getElementById('op-add-input');
  const btn = document.getElementById('btn-add-op');

  const addOp = () => {
    const val = parseInt(input.value);
    if (isNaN(val) || val <= 0) return;
    if (state.globals.ops.includes(val)) return;

    state.globals.ops.push(val);
    state.globals.ops.sort((a, b) => a - b);

    // Initialize prefix if not exists
    if (!state.globals.opPrefixes[val]) {
      state.globals.opPrefixes[val] = '';
    }

    input.value = '';
    renderOpBar(state.globals.ops, handleRemoveOp);
    recomputeAll();
    scheduleAutoSave();
  };

  btn.addEventListener('click', addOp);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addOp();
  });
}

function handleRemoveOp(opNum) {
  state.globals.ops = state.globals.ops.filter(o => o !== opNum);
  renderOpBar(state.globals.ops, handleRemoveOp);
  recomputeAll();
  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// EXPORT MODAL
// ═══════════════════════════════════════════════════════════
function bindExportModal() {
  document.getElementById('export-close').addEventListener('click', () => {
    document.getElementById('export-modal').classList.add('hidden');
  });

  document.getElementById('btn-export-confirm').addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#export-op-checkboxes input:checked');
    const selectedOps = Array.from(checkboxes).map(cb => parseInt(cb.value));
    const exportUnits = document.getElementById('export-units').value;

    if (selectedOps.length === 0) {
      alert('Select at least one OP to export.');
      return;
    }

    state.globals.exportUnits = exportUnits;
    const csv = generateCSV(state.rows, selectedOps, state.globals);
    downloadCSV(csv);
    document.getElementById('export-modal').classList.add('hidden');
  });
}

function openExportModal() {
  const container = document.getElementById('export-op-checkboxes');
  container.innerHTML = '';

  for (const op of state.globals.ops) {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    label.style.padding = '4px 0';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = op;
    cb.checked = true;

    label.appendChild(cb);
    label.appendChild(document.createTextNode(`OP ${op}${op === 2000 ? ' (raw values)' : ''}`));
    container.appendChild(label);
  }

  document.getElementById('export-modal').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════
function bindSettingsModal() {
  document.getElementById('btn-settings').addEventListener('click', () => {
    // Populate equipment list
    document.getElementById('settings-equipment-list').value =
      state.globals.equipmentList.join('\n');

    // Populate op prefixes
    const prefixContainer = document.getElementById('settings-op-prefixes');
    prefixContainer.innerHTML = '';
    for (const op of state.globals.ops) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '4px 0';

      const label = document.createElement('label');
      label.textContent = `OP ${op}:`;
      label.style.width = '60px';
      label.style.fontSize = '12px';

      const input = document.createElement('input');
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

  document.getElementById('settings-close').addEventListener('click', () => {
    // Save equipment list
    const eqText = document.getElementById('settings-equipment-list').value;
    state.globals.equipmentList = eqText.split('\n')
      .map(s => s.trim())
      .filter(s => s !== '')
      .sort();

    // Save op prefixes
    document.querySelectorAll('.op-prefix-input').forEach(input => {
      state.globals.opPrefixes[input.dataset.op] = input.value;
    });

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
      const loaded = loadProject(content);
      state.globals = { ...defaultGlobals(), ...loaded.globals };
      state.rows = loaded.rows;
      recomputeAll();
      syncGlobalsToUI();
      renderOpBar(state.globals.ops, handleRemoveOp);
      closeSidebar();
    } catch (err) {
      alert('Failed to load project: ' + err.message);
    }
    return;
  }

  // Parse CSV
  const rawRows = parseCSV(content);
  if (rawRows.length === 0) {
    alert('No valid data found in CSV.');
    return;
  }

  // Create row objects
  resetIdCounter();
  state.rows = rawRows.map(raw => createRow(raw));

  // Recompute all and render
  recomputeAll();
  closeSidebar();

  console.log(`Imported ${state.rows.length} rows from ${fileName}`);
}

// ═══════════════════════════════════════════════════════════
// ROW USER CHANGE HANDLER
// ═══════════════════════════════════════════════════════════
function handleRowUserChange(rowId, changes) {
  const row = state.rows.find(r => r.id === rowId);
  if (!row) return;

  // Merge changes into user state
  Object.assign(row.user, changes);

  // Auto-set status to 'edited' if currently 'none'
  if (row.user.status === 'none') {
    row.user.status = 'edited';
  }

  // Recompute this row
  recompute(row, state.globals);

  // Re-render table and sidebar
  renderTable(state.rows);

  // Update sidebar if this row is selected
  if (getSelectedRowId() === rowId) {
    // The sidebar will be repopulated by selectRow in renderTable
    // But since renderTable rebuilds rows, we need to re-select
    const tr = document.querySelector(`#table-body tr[data-row-id="${rowId}"]`);
    if (tr) tr.classList.add('selected');

    // Update sidebar preview values
    const c = row.computed;
    document.getElementById('sidebar-out-spec').textContent = c.outDrawingSpec || '—';
    document.getElementById('sidebar-out-nominal').textContent = c.outNominal || '—';
    document.getElementById('sidebar-out-tol').textContent = c.outTolerance || '—';

    // Update status buttons
    document.querySelectorAll('.btn-status').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.status === row.user.status);
    });
  }

  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// RECOMPUTE ALL ROWS
// ═══════════════════════════════════════════════════════════
function recomputeAll() {
  for (const row of state.rows) {
    recompute(row, state.globals);
  }
  renderTable(state.rows);
  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// AUTO-SAVE (debounced)
// ═══════════════════════════════════════════════════════════
let autoSaveTimer = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSave(state);
  }, 1000);
}
