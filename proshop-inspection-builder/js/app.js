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

// ONE version for the app: shown top-left AND used as ?v= on every file in
// index.html (so browsers reload new files). Bump both together — see
// CLAUDE.md "Versioning". test/run-node.js fails if they don't match.
var APP_VERSION = 'v2.0.0';

console.log('[PSB] app.js loaded, PSB namespace:', typeof PSB !== 'undefined' ? Object.keys(PSB).length + ' functions' : 'MISSING');

// ═══════════════════════════════════════════════════════════
// APP STATE (single source of truth for the session)
// ═══════════════════════════════════════════════════════════
var state = {
  rows: [],
  globals: PSB.defaultGlobals(),
  auditLog: [],
  faiRuns: [],
  datumRefs: [],
};

/**
 * Restore app state from an undo/redo snapshot.
 */
function applySnapshot(snapshot) {
  // Export options aren't undoable edits — keep the current ones
  // Not undoable: export options and which project/PDF this is.
  // (Undoing past the first save must not wipe the project id or PDF link.)
  var keep = {
    faiExport: state.globals.faiExport,
    projectId: state.globals.projectId,
    pdfFileName: state.globals.pdfFileName,
  };
  state.globals = snapshot.globals;
  Object.keys(keep).forEach(function(k) {
    if (keep[k] !== undefined) state.globals[k] = keep[k];
  });
  state.rows = snapshot.rows.map(function(r) {
    // Balloon-created rows keep mutable raw; CSV rows stay frozen.
    var rawCopy = Object.assign({}, r.raw);
    var raw = (rawCopy._source === 'balloon') ? rawCopy : Object.freeze(rawCopy);
    return {
      id: r.id,
      raw: raw,
      user: r.user,
      computed: {},
      fai: r.fai || null,
    };
  });
  if (snapshot.faiRuns) state.faiRuns = snapshot.faiRuns;
  if (snapshot.datumRefs) state.datumRefs = snapshot.datumRefs;
}

function refreshAfterRestore() {
  recomputeAll();
  updateCmmPartBadge(state.globals.cmmPartName);
  if (PSB.renderBalloonOverlay) PSB.renderBalloonOverlay();
  syncGlobalsToUI();
  PSB.renderOpBar(state.globals.ops, handleRemoveOp);
  updateUndoRedoButtons();
  markDirty();
  scheduleAutoSave();
}

/**
 * Undo or redo `steps` changes in a row (the history menus can jump back
 * several at once). Each step restores state before the next, so the
 * opposite stack gets the right snapshots.
 */
function stepHistory(direction, steps) {
  var isUndo = direction === 'undo';
  var done = 0;
  var lastDesc = '';
  for (var i = 0; i < (steps || 1); i++) {
    var descs = isUndo ? PSB.getUndoDescriptions() : PSB.getRedoDescriptions();
    var desc = descs.length > 0 ? descs[0] : '';
    var snap = isUndo ? PSB.undo(state, desc) : PSB.redo(state, desc);
    if (!snap) break;
    applySnapshot(snap);
    lastDesc = snap._desc || 'Change';
    done++;
  }
  if (done > 0) {
    refreshAfterRestore();
    var label = isUndo ? 'Undo: ' : 'Redo: ';
    PSB.showToast(label + (done > 1 ? done + ' changes' : lastDesc), 'info');
  }
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  var u = document.getElementById('btn-undo');
  var r = document.getElementById('btn-redo');
  if (u) u.disabled = !PSB.canUndo();
  if (r) r.disabled = !PSB.canRedo();
  var ua = document.getElementById('btn-undo-arrow');
  var ra = document.getElementById('btn-redo-arrow');
  if (ua) ua.disabled = !PSB.canUndo();
  if (ra) ra.disabled = !PSB.canRedo();
}

function setupUndoRedoDropdowns() {
  var undoArrow = document.getElementById('btn-undo-arrow');
  var redoArrow = document.getElementById('btn-redo-arrow');
  var undoDropdown = document.getElementById('undo-dropdown');
  var redoDropdown = document.getElementById('redo-dropdown');

  function closeAll() {
    undoDropdown.classList.add('hidden');
    redoDropdown.classList.add('hidden');
  }

  undoArrow.addEventListener('click', function(e) {
    e.stopPropagation();
    if (undoArrow.disabled) return;
    redoDropdown.classList.add('hidden');
    var descs = PSB.getUndoDescriptions();
    undoDropdown.innerHTML = '';
    for (var i = 0; i < descs.length; i++) {
      var item = document.createElement('div');
      item.className = 'undo-redo-item';
      item.textContent = descs[i];
      item.dataset.index = i;
      undoDropdown.appendChild(item);
    }
    undoDropdown.classList.toggle('hidden');
  });

  redoArrow.addEventListener('click', function(e) {
    e.stopPropagation();
    if (redoArrow.disabled) return;
    undoDropdown.classList.add('hidden');
    var descs = PSB.getRedoDescriptions();
    redoDropdown.innerHTML = '';
    for (var i = 0; i < descs.length; i++) {
      var item = document.createElement('div');
      item.className = 'undo-redo-item';
      item.textContent = descs[i];
      item.dataset.index = i;
      redoDropdown.appendChild(item);
    }
    redoDropdown.classList.toggle('hidden');
  });

  undoDropdown.addEventListener('click', function(e) {
    var item = e.target.closest('.undo-redo-item');
    if (!item) return;
    closeAll();
    stepHistory('undo', parseInt(item.dataset.index, 10) + 1);
  });

  redoDropdown.addEventListener('click', function(e) {
    var item = e.target.closest('.undo-redo-item');
    if (!item) return;
    closeAll();
    stepHistory('redo', parseInt(item.dataset.index, 10) + 1);
  });

  document.addEventListener('click', function() { closeAll(); });
}

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
        applyLoadedState(saved);
        var meta = readSessionMeta();
        if (meta) importedFileName = meta.fileName || null;
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
      onAddRow: handleAddRow,
      onDeleteRow: handleDeleteRow,
      onFaiRetag: handleFaiRetag,
      getAppState: function() { return state; },
    });
    console.log('[PSB] UI initialized');

    // Bind header controls
    bindGlobalControls();
    bindFileButtons();
    bindNewMenu();
    bindNewButton();
    bindSampleButton();
    bindOpBar();
    bindExportModal();
    bindSettingsModal();
    bindSetupPanel();
    bindFaiControls();
    bindPdfExportButton();
    bindBalloonSizeControl();

    // Wire nav rail tab clicks
    (function() {
      var tabs = document.querySelectorAll('.nav-tab[data-view]');
      for (var ti = 0; ti < tabs.length; ti++) {
        (function(tab) {
          tab.addEventListener('click', function() { switchView(tab.dataset.view); });
        })(tabs[ti]);
      }
    })();

    // Undo / Redo buttons
    document.getElementById('btn-undo').addEventListener('click', function() { stepHistory('undo', 1); });
    document.getElementById('btn-redo').addEventListener('click', function() { stepHistory('redo', 1); });

    // Undo/Redo dropdown arrows
    setupUndoRedoDropdowns();

    // Global History button
    document.getElementById('btn-all-history').addEventListener('click', function() {
      PSB.openHistoryModal();
    });

    // PDF Viewer
    PSB.initPdfViewer();

    // Ballooning (Phase 2 — manual)
    PSB.initBalloonManager({
      getState: function() { return state; },
      onChange: function(evt) {
        // Re-render table and re-fire autosave whenever balloons mutate state.
        recomputeAll();
        PSB.renderTable(state, VIEW_CONFIGS[currentView]);
        PSB.renderBalloonOverlay();
        markDirty();
        scheduleAutoSave();
        updateUndoRedoButtons();
      },
    });

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
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        stepHistory('undo', 1);
      }
      if (mod && (e.key === 'Z' || (e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        stepHistory('redo', 1);
      }
      if (mod && e.key === '1') { e.preventDefault(); switchView('drawing'); }
      if (mod && e.key === '2') { e.preventDefault(); switchView('setup'); }
      if (mod && e.key === '3') { e.preventDefault(); switchView('fai'); }

      // Ballooning shortcuts (skip if user is typing in an input/textarea)
      var inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
      if (!mod && !inField && PSB.hasPdf()) {
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          PSB.setBalloonMode(!PSB.isBalloonMode());
        }
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          PSB.setDatumMode && PSB.setDatumMode(!PSB.isDatumMode());
        }
        if (PSB.getSelectedBalloonRowId && PSB.getSelectedBalloonRowId() != null) {
          // Arrow keys move balloon visually; PDF Y grows up, so ArrowUp → +y, ArrowDown → -y.
          if (e.key === 'ArrowLeft')  { e.preventDefault(); PSB.nudgeSelectedBalloon(-1, 0); }
          if (e.key === 'ArrowRight') { e.preventDefault(); PSB.nudgeSelectedBalloon( 1, 0); }
          if (e.key === 'ArrowUp')    { e.preventDefault(); PSB.nudgeSelectedBalloon( 0, 1); }
          if (e.key === 'ArrowDown')  { e.preventDefault(); PSB.nudgeSelectedBalloon( 0,-1); }
        }
      }

      if (e.key === 'Escape') {
        if (PSB.isBalloonMode && PSB.isBalloonMode()) {
          PSB.setBalloonMode(false);
          PSB.clearPendingBalloonInsert && PSB.clearPendingBalloonInsert();
          return;
        }
        if (PSB.isDatumMode && PSB.isDatumMode()) {
          PSB.setDatumMode(false);
          return;
        }
        var confirmModal = document.getElementById('confirm-modal');
        if (!confirmModal.classList.contains('hidden')) {
          PSB.closeModal('confirm-modal');
          return;
        }
        var historyModal = document.getElementById('history-modal');
        if (!historyModal.classList.contains('hidden')) {
          PSB.closeModal('history-modal');
          return;
        }
        var exportModal = document.getElementById('export-modal');
        var settingsModal = document.getElementById('settings-modal');
        if (!exportModal.classList.contains('hidden')) {
          PSB.closeModal('export-modal');
        } else if (!settingsModal.classList.contains('hidden')) {
          document.getElementById('settings-close').click();
        } else {
          var setupPanel = document.getElementById('setup-panel');
          if (setupPanel && !setupPanel.classList.contains('panel-closed')) {
            PSB.closeSetupPanel();
          } else if (!document.getElementById('sidebar').classList.contains('sidebar-closed')) {
            PSB.closeSidebar();
          }
        }
      }
    });

    // Initial render
    syncGlobalsToUI();
    applyUnitColors(state.globals.importUnits);
    PSB.renderOpBar(state.globals.ops, handleRemoveOp);
    // Start on the step you were on (refresh), else Drawing when empty, Plan when not
    var savedStep = null;
    try { savedStep = sessionStorage.getItem('psb_step'); } catch (e) { /* ignore */ }
    switchView(savedStep || (state.rows.length > 0 ? 'setup' : 'drawing'));
    updateFaiTabBadge();
    updateCmmPartBadge(state.globals.cmmPartName);
    if (state.rows.length > 0) {
      var sessionMeta = readSessionMeta();
      if (sessionMeta && sessionMeta.dirty) markDirty();
      setFilename(importedFileName);
      reconnectFile(false);
    }
    // Set version from single source
    var versionEl = document.querySelector('.app-version');
    if (versionEl) versionEl.textContent = APP_VERSION;

    // Try to restore PDF (no file picker on page load — needs a click)
    PSB.setPdfProjectId(state.globals.projectId);
    if (state.globals.pdfFileName) restoreProjectPdf(false);

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
// PDF EXPORT (BALLOONED PDF)
// ═══════════════════════════════════════════════════════════
//
// Toolbar button → call pdfExport.exportBalloonedPdf with the in-memory
// pdfArrayBuffer. Nothing is sent over the network; pdf-lib runs locally and
// the resulting bytes are downloaded via a transient blob URL.
function bindPdfExportButton() {
  var btn = document.getElementById('pdf-export-balloons');
  if (!btn) return;
  btn.addEventListener('click', function() {
    if (!PSB.hasPdf()) {
      PSB.showToast('Open a PDF first', 'info');
      return;
    }
    var hasBalloons = state.rows.some(function(r) { return r.user && r.user.balloon; });
    if (!hasBalloons) {
      PSB.showToast('No balloons to export — add some with Balloon Mode (B)', 'info');
      return;
    }
    btn.disabled = true;
    var oldTitle = btn.getAttribute('title');
    btn.setAttribute('title', 'Exporting…');
    PSB.exportBalloonedPdf(state, PSB.getPdfArrayBuffer(), PSB.getPdfFileName())
      .then(function(result) {
        PSB.showToast('Exported ' + result.balloonCount + ' balloon' +
                      (result.balloonCount === 1 ? '' : 's') + ' → ' + result.filename, 'success');
      })
      .catch(function(err) {
        console.error('[pdfExport] failed:', err);
        PSB.showToast('PDF export failed: ' + (err && err.message || err), 'error');
      })
      .then(function() {
        btn.disabled = false;
        btn.setAttribute('title', oldTitle);
      });
  });
}

// ═══════════════════════════════════════════════════════════
// BALLOON SIZE CONTROL (global, applies to all balloons)
// ═══════════════════════════════════════════════════════════
function bindBalloonSizeControl() {
  var slider = document.getElementById('pdf-balloon-size');
  if (!slider) return;
  // Reflect the persisted value on load.
  if (state.globals.balloonRadius > 0) slider.value = state.globals.balloonRadius;
  slider.addEventListener('input', function() {
    var r = parseInt(slider.value, 10);
    if (!(r > 0)) return;
    state.globals.balloonRadius = r;
    if (PSB.renderBalloonOverlay) PSB.renderBalloonOverlay();
    markDirty();
    scheduleAutoSave();
  });
}

// ═══════════════════════════════════════════════════════════
// ROW USER CHANGE HANDLER
// ═══════════════════════════════════════════════════════════
function handleRowUserChange(rowId, changes) {
  var row = state.rows.find(function(r) { return r.id === rowId; });
  if (!row) return;

  // Safety net: skip entirely if nothing actually changed
  var hasRealChange = false;
  if (changes.overrides) {
    for (var chk in changes.overrides) {
      if (row.user.overrides[chk] !== changes.overrides[chk]) { hasRealChange = true; break; }
    }
  }
  if (!hasRealChange) {
    for (var chk2 in changes) {
      if (chk2 === 'overrides') continue;
      if (row.user[chk2] !== changes[chk2]) { hasRealChange = true; break; }
    }
  }
  if (!hasRealChange) return;

  // Build audit details from changes (before pushUndo so we have the description)
  var auditDetails = [];
  var descParts = [];
  if (changes.overrides) {
    for (var key in changes.overrides) {
      var oldVal = row.user.overrides[key];
      var newVal = changes.overrides[key];
      if (oldVal !== newVal) {
        auditDetails.push({ field: key, from: oldVal === null ? '' : String(oldVal), to: newVal === null ? '' : String(newVal) });
        descParts.push(key + ': ' + (newVal === null ? 'cleared' : newVal));
      }
    }
  }
  for (var ckey in changes) {
    if (ckey === 'overrides') continue;
    if (row.user[ckey] !== changes[ckey]) {
      auditDetails.push({ field: ckey, from: String(row.user[ckey] || ''), to: String(changes[ckey]) });
      descParts.push(ckey + ': ' + changes[ckey]);
    }
  }
  var dimTag = row.computed.dimTag || row.raw.dimTag || rowId;
  var undoDesc = 'Row ' + dimTag + ' — ' + descParts.join(', ');

  PSB.pushUndo(state, undoDesc);
  PSB.logChange(state.auditLog, { type: 'edit', rowId: rowId, description: undoDesc, details: auditDetails });

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

  // Auto-set equipment to GO / NO-GO when pin/gage is enabled with no equipment
  if (changes.pinGageEnabled && row.user.pinGageEnabled && !row.user.inspectionEquipment) {
    row.user.inspectionEquipment = 'GO / NO-GO';
  }

  // Pin/Gage on → Nom Dim exports the pin/gage value, so clear any typed OUT Nominal
  if (changes.pinGageEnabled && row.user.overrides.outNominal !== null) {
    row.user.overrides = Object.assign({}, row.user.overrides, { outNominal: null });
    PSB.showToast('Pin/Gage on — typed OUT Nominal cleared', 'info');
  }

  // Auto-disable autoNominal when tolerance becomes asymmetric
  if (row.user.autoNominal && changes.overrides) {
    var ov = row.user.overrides;
    var tolChanged = changes.overrides.outTolPlus !== undefined || changes.overrides.outTolMinus !== undefined;
    if (tolChanged) {
      var rawTol = PSB.parseTolerance(row.raw.toleranceText || row.raw.tolerance || '');
      var tp = ov.outTolPlus !== null ? parseFloat(ov.outTolPlus) : rawTol.tolPlus;
      var tm = ov.outTolMinus !== null ? parseFloat(ov.outTolMinus) : rawTol.tolMinus;
      if (!isNaN(tp) && !isNaN(tm) && Math.abs(tp - tm) >= 1e-10) {
        row.user.autoNominal = false;
        PSB.showToast('Asymmetric tolerance — Auto Nominal disabled', 'info');
      }
    }
  }

  // Auto-set status to 'edited' if currently 'none'
  if (row.user.status === 'none') {
    row.user.status = 'edited';
  }

  // Recompute this row
  PSB.recompute(row, state.globals);

  // Re-render table and sidebar
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);

  // Update sidebar if this row is selected
  if (PSB.getSelectedRowId() === rowId) {
    // Re-select the row in the table
    var tr = document.querySelector('#table-body tr[data-row-id="' + rowId + '"]');
    if (tr) tr.classList.add('selected');

    // Full sidebar refresh (uses formatDualDisplay, leading zeros, etc.)
    PSB.populateSidebar(rowId);
  }

  updateUndoRedoButtons();
  markDirty();
  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// ADD / DELETE ROW HANDLERS
// ═══════════════════════════════════════════════════════════
function handleAddRow() {
  PSB.pushUndo(state, 'Add row');
  var maxDimTag = 0;
  for (var i = 0; i < state.rows.length; i++) {
    var dt = parseInt(state.rows[i].raw.dimTag);
    if (!isNaN(dt) && dt > maxDimTag) maxDimTag = dt;
  }
  var newTag = maxDimTag + 1;
  var newRow = PSB.createRow({ dimTag: String(newTag) });
  // Manually added rows are usually dims missing from the print
  newRow.user.notOnPrint = true;
  PSB.recompute(newRow, state.globals);
  state.rows.push(newRow);
  PSB.logChange(state.auditLog, { type: 'add', rowId: newRow.id, description: 'Added row ' + newTag });
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  markDirty();
  scheduleAutoSave();
}

function handleDeleteRow(rowId) {
  var row = state.rows.find(function(r) { return r.id === rowId; });
  var dimTag = row ? (row.computed.dimTag || row.raw.dimTag || rowId) : rowId;
  PSB.pushUndo(state, 'Delete row ' + dimTag);
  // Close sidebar if this row is selected
  if (PSB.getSelectedRowId() === rowId) {
    PSB.closeSidebar();
  }
  state.rows = state.rows.filter(function(r) { return r.id !== rowId; });
  PSB.logChange(state.auditLog, { type: 'delete', rowId: rowId, description: 'Deleted row ' + dimTag });
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  markDirty();
  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// RECOMPUTE ALL ROWS
// ═══════════════════════════════════════════════════════════
function recomputeAll() {
  var printUnits = PSB.getPrintUnits(state.globals);
  for (var i = 0; i < state.rows.length; i++) {
    PSB.recompute(state.rows[i], state.globals);
    PSB.syncFaiUnits(state.rows[i], printUnits);
    PSB.refreshFaiStatus(state.rows[i], state.globals.faiWarnThreshold);
  }
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  updateFaiTabBadge();
  refreshPrintUnitsUI();

  // Refresh sidebar if a row is selected so values stay in sync
  var selId = PSB.getSelectedRowId();
  if (selId !== null) {
    var tr = document.querySelector('#table-body tr[data-row-id="' + selId + '"]');
    if (tr) tr.classList.add('selected');
    PSB.populateSidebar(selId);
  }

  scheduleAutoSave();
}
