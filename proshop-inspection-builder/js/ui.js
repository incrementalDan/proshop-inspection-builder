/**
 * ui.js — Shared UI pieces (loads first of the UI files)
 *
 * - Shared UI state + callbacks set by app.js (initUI)
 * - Toasts, confirm / history / loading pop-ups, modal open/close
 * - Theme toggle, setup panel, OP tags, drag & drop, GD&T tooltip
 *
 * The rest of the UI lives in:
 * - table.js      — table drawing, including the FAI rows
 * - sidebar.js    — the row sidebar
 * - inlineEdit.js — editing cells in place
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
