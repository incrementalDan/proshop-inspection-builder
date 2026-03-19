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

// ── State ─────────────────────────────────────────────────
let selectedRowId = null;
let sortColumn = null;
let sortDirection = 'asc'; // 'asc' or 'desc'

// Callback references (set by app.js)
let onRowUserChange = null;   // (rowId, userChanges) => void
let onFileImport = null;      // (fileContent, fileName) => void
let getAppState = null;       // () => { rows, globals }

/**
 * Initialize the UI module.
 *
 * @param {Object} callbacks
 * @param {Function} callbacks.onRowUserChange — called when sidebar edits a row's user state
 * @param {Function} callbacks.onFileImport — called when a file is dropped or selected
 * @param {Function} callbacks.getAppState — returns current { rows, globals }
 */
export function initUI(callbacks) {
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
export function renderTable(rows) {
  const tbody = document.getElementById('table-body');
  const table = document.getElementById('data-table');
  const emptyState = document.getElementById('empty-state');

  if (!rows || rows.length === 0) {
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  table.classList.remove('hidden');
  emptyState.classList.add('hidden');

  // Sort rows if sort is active
  let displayRows = [...rows];
  if (sortColumn) {
    displayRows.sort((a, b) => {
      const aVal = getCellValue(a, sortColumn);
      const bVal = getCellValue(b, sortColumn);
      const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }

  // Build table rows
  tbody.innerHTML = '';
  for (const row of displayRows) {
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.id;

    if (row.computed.isNote) tr.classList.add('is-note');
    if (row.id === selectedRowId) tr.classList.add('selected');

    tr.innerHTML = buildRowHTML(row);

    // Row click → select + open sidebar
    tr.addEventListener('click', () => selectRow(row.id));

    tbody.appendChild(tr);
  }
}

/**
 * Build the HTML for a single table row.
 */
function buildRowHTML(row) {
  const c = row.computed;
  const statusClass = `status-${c.status || 'none'}`;

  // OP display: show which ops are enabled
  const opDisplay = Object.entries(c.includeOps || {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');

  return `
    <td class="col-status"><span class="status-dot ${statusClass}"></span></td>
    <td class="col-dimtag">${esc(c.dimTag)}</td>
    <td class="col-su1">${esc(c.specUnit1)}</td>
    <td class="col-drawspec editable">${esc(c.outDrawingSpec)}</td>
    <td class="col-inputspec">${esc(c.inputSpec)}</td>
    <td class="col-su2">${esc(c.specUnit2)}</td>
    <td class="col-su3">${esc(c.specUnit3)}</td>
    <td class="col-outnom">${esc(c.outNominal)}</td>
    <td class="col-pingage editable">${esc(c.pinGage)}</td>
    <td class="col-inputtol">${esc(c.inputTolerance)}</td>
    <td class="col-outtol editable">${esc(c.outTolerance)}</td>
    <td class="col-plating">${esc(c.platingMode !== 'none' ? c.platingMode : '')}</td>
    <td class="col-ops">${esc(opDisplay)}</td>
  `;
}

/**
 * Select a row and open the sidebar.
 */
function selectRow(rowId) {
  selectedRowId = rowId;

  // Highlight row
  document.querySelectorAll('#table-body tr').forEach(tr => {
    tr.classList.toggle('selected', Number(tr.dataset.rowId) === rowId);
  });

  // Show sidebar
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebar-resizer');
  sidebar.classList.remove('hidden');
  resizer.classList.remove('hidden');

  // Populate sidebar
  populateSidebar(rowId);
}

/**
 * Populate sidebar with selected row's data.
 */
function populateSidebar(rowId) {
  const state = getAppState();
  const row = state.rows.find(r => r.id === rowId);
  if (!row) return;

  const c = row.computed;
  const u = row.user;

  // Header
  document.getElementById('sidebar-dimtag').textContent = c.dimTag || '—';

  // Output preview
  document.getElementById('sidebar-out-spec').textContent = c.outDrawingSpec || '—';
  document.getElementById('sidebar-out-nominal').textContent = c.outNominal || '—';
  document.getElementById('sidebar-out-tol').textContent = c.outTolerance || '—';

  // OP toggles
  const opContainer = document.getElementById('sidebar-op-toggles');
  opContainer.innerHTML = '';
  for (const op of state.globals.ops) {
    const btn = document.createElement('button');
    btn.className = `op-toggle${u.includeOps[op] ? ' active' : ''}${op === 2000 ? ' op-2000' : ''}`;
    btn.textContent = `OP ${op}`;
    btn.addEventListener('click', () => {
      const newInclude = { ...u.includeOps, [op]: !u.includeOps[op] };
      onRowUserChange(rowId, { includeOps: newInclude });
    });
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
  document.querySelectorAll('.btn-status').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === u.status);
  });

  // Wire up change handlers (remove old ones first by replacing elements)
  wireUpSidebarHandlers(rowId);
}

/**
 * Wire sidebar controls to emit user changes.
 */
function wireUpSidebarHandlers(rowId) {
  // Helper to bind a change handler
  const bind = (id, event, handler) => {
    const el = document.getElementById(id);
    // Clone to remove old listeners
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    clone.addEventListener(event, handler);
  };

  bind('sidebar-ipc', 'change', (e) => {
    onRowUserChange(rowId, { ipc: e.target.checked });
  });

  bind('sidebar-is-note', 'change', (e) => {
    onRowUserChange(rowId, { isNote: e.target.checked });
  });

  bind('sidebar-auto-nominal', 'change', (e) => {
    onRowUserChange(rowId, { autoNominal: e.target.checked });
  });

  bind('sidebar-pin-gage-enabled', 'change', (e) => {
    onRowUserChange(rowId, { pinGageEnabled: e.target.checked });
  });

  bind('sidebar-plating-mode', 'change', (e) => {
    onRowUserChange(rowId, { platingMode: e.target.value });
  });

  bind('sidebar-equipment', 'change', (e) => {
    onRowUserChange(rowId, { inspectionEquipment: e.target.value });
  });

  bind('sidebar-frequency', 'input', (e) => {
    onRowUserChange(rowId, { inspectionFrequency: e.target.value });
  });

  // Status buttons
  document.querySelectorAll('.btn-status').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('click', () => {
      onRowUserChange(rowId, { status: clone.dataset.status });
    });
  });

  // Sidebar close
  const closeBtn = document.getElementById('sidebar-close');
  const closeClone = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(closeClone, closeBtn);
  closeClone.addEventListener('click', closeSidebar);
}

/**
 * Close the sidebar.
 */
export function closeSidebar() {
  selectedRowId = null;
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('sidebar-resizer').classList.add('hidden');
  document.querySelectorAll('#table-body tr').forEach(tr => tr.classList.remove('selected'));
}

/**
 * Populate the equipment dropdown.
 */
function populateEquipmentDropdown(equipmentList, currentValue) {
  const select = document.getElementById('sidebar-equipment');
  select.innerHTML = '<option value="">— Select —</option>';
  for (const item of equipmentList) {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    if (item === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
}

/**
 * Render the OP tags in the OP bar.
 */
export function renderOpBar(ops, onRemoveOp) {
  const container = document.getElementById('op-tags');
  container.innerHTML = '';
  for (const op of ops) {
    const tag = document.createElement('span');
    tag.className = `op-tag${op === 2000 ? ' op-2000' : ''}`;
    tag.innerHTML = `OP ${op} <span class="remove-op" title="Remove">✕</span>`;
    tag.querySelector('.remove-op').addEventListener('click', () => onRemoveOp(op));
    container.appendChild(tag);
  }
}

// ── Drag & Drop ───────────────────────────────────────────

function setupDragDrop() {
  const dropZone = document.getElementById('drop-zone');
  const body = document.body;

  let dragCounter = 0;

  body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.remove('hidden');
  });

  body.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) dropZone.classList.add('hidden');
  });

  body.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  body.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.add('hidden');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      readFile(files[0]);
    }
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    if (onFileImport) {
      onFileImport(e.target.result, file.name);
    }
  };
  reader.readAsText(file);
}

// ── Sidebar Resizer ───────────────────────────────────────

function setupSidebarResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = window.innerWidth - e.clientX;
    const clamped = Math.max(280, Math.min(600, newWidth));
    sidebar.style.width = `${clamped}px`;
  });

  document.addEventListener('mouseup', () => {
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
  document.getElementById('btn-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
  });
}

// ── Table Header Sorting ──────────────────────────────────

function setupTableHeaderClicks() {
  document.querySelectorAll('#data-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortColumn === col) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = col;
        sortDirection = 'asc';
      }

      // Update header classes
      document.querySelectorAll('#data-table th').forEach(h => {
        h.classList.remove('sorted-asc', 'sorted-desc');
      });
      th.classList.add(`sorted-${sortDirection}`);

      // Re-render with current data
      const state = getAppState();
      if (state) renderTable(state.rows);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────

function getCellValue(row, col) {
  const c = row.computed;
  const map = {
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
    ops: Object.keys(c.includeOps || {}).filter(k => c.includeOps[k]).join(','),
  };
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
export function getSelectedRowId() {
  return selectedRowId;
}
