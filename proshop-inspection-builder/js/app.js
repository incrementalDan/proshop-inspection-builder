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

// ── UUID generator ────────────────────────────────────────
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Ensure the active project has a stable ID; generate one if missing.
function ensureProjectId() {
  if (!state.globals.projectId) {
    state.globals.projectId = generateUUID();
    PSB.setPdfProjectId(state.globals.projectId);
  }
}

// ── View Configuration ────────────────────────────────────
var VIEW_CONFIGS = {
  setup: {
    id: 'setup',
    label: 'Setup View',
    columns: ['status','dimTag','outDrawingSpec','op2000Spec','su2','su3','pinGage','op2000Tol','outTol','plating','ops'],
    sidebarEnabled: true,
    faiControlsVisible: false,
    setupControlsVisible: true,
  },
  fai: {
    id: 'fai',
    label: 'FAI View',
    columns: ['faiStatus','dimTag','drawingSpec','su1','su2','nominal','tolerance','measured','deviation','notes','run'],
    sidebarEnabled: false,
    faiControlsVisible: true,
    setupControlsVisible: false,
    compareMode: 'op2000',   // 'op2000' | 'compensated' — which plan values to compare CMM against
  },
};

var currentView = 'setup';

function setFaiCompareMode(mode) {
  VIEW_CONFIGS.fai.compareMode = mode;
  var op2kBtn = document.getElementById('btn-fai-compare-op2000');
  var compBtn = document.getElementById('btn-fai-compare-comp');
  if (op2kBtn) op2kBtn.classList.toggle('active', mode === 'op2000');
  if (compBtn) compBtn.classList.toggle('active', mode === 'compensated');
  if (currentView === 'fai') PSB.renderTable(state, VIEW_CONFIGS.fai);
}

function switchView(viewId) {
  currentView = viewId;
  var config = VIEW_CONFIGS[viewId];

  // Toggle sidebar visibility
  var sidebar = document.getElementById('sidebar');
  var sidebarResizer = document.getElementById('sidebar-resizer');
  if (sidebar) {
    if (config.sidebarEnabled) {
      // Only re-open sidebar if a row is selected
      // (leave it closed if no row is selected)
    } else {
      sidebar.classList.add('sidebar-closed');
      if (sidebarResizer) sidebarResizer.classList.add('sidebar-closed');
    }
  }

  // Toggle control visibility
  var setupControls = document.querySelectorAll('.setup-only');
  var faiControls = document.querySelectorAll('.fai-only');
  for (var i = 0; i < setupControls.length; i++) {
    if (config.setupControlsVisible) {
      setupControls[i].classList.remove('hidden');
    } else {
      setupControls[i].classList.add('hidden');
    }
  }
  for (var j = 0; j < faiControls.length; j++) {
    if (config.faiControlsVisible) {
      faiControls[j].classList.remove('hidden');
    } else {
      faiControls[j].classList.add('hidden');
    }
  }

  // Activate the matching nav rail tab
  var navTabs = document.querySelectorAll('.nav-tab[data-view]');
  for (var nt = 0; nt < navTabs.length; nt++) {
    navTabs[nt].classList.toggle('active', navTabs[nt].dataset.view === viewId);
  }

  PSB.renderTable(state, config);
}

function updateFaiTabBadge() {
  var badge = document.getElementById('nav-fai-badge');
  if (!badge) return;
  var fails = 0, warns = 0;
  for (var i = 0; i < state.rows.length; i++) {
    var fai = state.rows[i].fai;
    if (!fai) continue;
    if (fai.aggregateStatus === 'fail') fails++;
    else if (fai.aggregateStatus === 'warn') warns++;
  }
  if (fails > 0) {
    badge.textContent = fails > 99 ? '99+' : String(fails);
    badge.className = 'nav-tab-badge';
    badge.classList.remove('hidden');
  } else if (warns > 0) {
    badge.textContent = warns > 99 ? '99+' : String(warns);
    badge.className = 'nav-tab-badge badge-warn';
    badge.classList.remove('hidden');
  } else {
    badge.className = 'nav-tab-badge hidden';
  }
}

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
  auditLog: [],
  faiRuns: [],
  datumRefs: [],
};

// Track imported filename for save suggestion
var importedFileName = null;

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

/**
 * Restore app state from an undo/redo snapshot.
 */
function restoreSnapshot(snapshot) {
  state.globals = snapshot.globals;
  state.rows = snapshot.rows.map(function(r) {
    // Balloon-created rows keep mutable raw; CSV rows stay frozen.
    var rawCopy = Object.assign({}, r.raw);
    var raw = (rawCopy._source === 'balloon') ? rawCopy : Object.freeze(rawCopy);
    return {
      id: r.id,
      raw: raw,
      user: r.user,
      computed: {},
    };
  });
  recomputeAll();
  syncGlobalsToUI();
  PSB.renderOpBar(state.globals.ops, handleRemoveOp);
  updateUndoRedoButtons();
  markDirty();
  scheduleAutoSave();
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
    var descs = PSB.getUndoDescriptions();
    var desc = descs.length > 0 ? descs[0] : '';
    var snap = PSB.undo(state, desc);
    if (snap) { restoreSnapshot(snap); PSB.showToast('Undo: ' + (snap._desc || 'Change'), 'info'); }
    updateUndoRedoButtons();
  });

  redoDropdown.addEventListener('click', function(e) {
    var item = e.target.closest('.undo-redo-item');
    if (!item) return;
    closeAll();
    var descs = PSB.getRedoDescriptions();
    var desc = descs.length > 0 ? descs[0] : '';
    var snap = PSB.redo(state, desc);
    if (snap) { restoreSnapshot(snap); PSB.showToast('Redo: ' + (snap._desc || 'Change'), 'info'); }
    updateUndoRedoButtons();
  });

  document.addEventListener('click', function() { closeAll(); });
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
        state.auditLog = saved.auditLog || [];
        state.faiRuns = saved.faiRuns || [];
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
    document.getElementById('btn-undo').addEventListener('click', function() {
      var descs = PSB.getUndoDescriptions();
      var desc = descs.length > 0 ? descs[0] : '';
      var snap = PSB.undo(state, desc);
      if (snap) { restoreSnapshot(snap); PSB.showToast('Undo: ' + (snap._desc || 'Change'), 'info'); }
      updateUndoRedoButtons();
    });
    document.getElementById('btn-redo').addEventListener('click', function() {
      var descs = PSB.getRedoDescriptions();
      var desc = descs.length > 0 ? descs[0] : '';
      var snap = PSB.redo(state, desc);
      if (snap) { restoreSnapshot(snap); PSB.showToast('Redo: ' + (snap._desc || 'Change'), 'info'); }
      updateUndoRedoButtons();
    });

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
        var uDescs = PSB.getUndoDescriptions();
        var uDesc = uDescs.length > 0 ? uDescs[0] : '';
        var snap = PSB.undo(state, uDesc);
        if (snap) { restoreSnapshot(snap); PSB.showToast('Undo: ' + (snap._desc || 'Change'), 'info'); }
        updateUndoRedoButtons();
      }
      if (mod && (e.key === 'Z' || (e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        var rDescs = PSB.getRedoDescriptions();
        var rDesc = rDescs.length > 0 ? rDescs[0] : '';
        var snapR = PSB.redo(state, rDesc);
        if (snapR) { restoreSnapshot(snapR); PSB.showToast('Redo: ' + (snapR._desc || 'Change'), 'info'); }
        updateUndoRedoButtons();
      }
      if (mod && e.key === '1') { e.preventDefault(); switchView('setup'); }
      if (mod && e.key === '2') { e.preventDefault(); switchView('fai'); }

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
        } else if (!document.getElementById('sidebar').classList.contains('sidebar-closed')) {
          PSB.closeSidebar();
        }
      }
    });

    // Initial render
    syncGlobalsToUI();
    applyUnitColors(state.globals.importUnits);
    PSB.renderOpBar(state.globals.ops, handleRemoveOp);
    PSB.renderTable(state, VIEW_CONFIGS[currentView]);
    updateCmmPartBadge(state.globals.cmmPartName);
    // Set version from single source
    var versionEl = document.querySelector('.app-version');
    if (versionEl) versionEl.textContent = APP_VERSION;

    // Try to restore PDF — set project ID first so IDB byte cache is keyed correctly
    if (state.globals.pdfFileName) {
      PSB.setPdfProjectId(state.globals.projectId);
      PSB.tryRestorePdf(state.globals.pdfFileName).then(function(ok) {
        if (!ok) PSB.showToast('PDF not found. Click "PDF" to re-select.', 'info');
      });
    }

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
// NEW FILE BUTTON
// ═══════════════════════════════════════════════════════════
function bindNewButton() {
  document.getElementById('btn-new').addEventListener('click', function() {
    var doNew = function() {
      PSB.clearAutoSave();
      PSB.clearProjectFileHandle();
      PSB.clearUndoRedo();
      // closePdf() clears in-memory state; IDB byte cache is intentionally preserved
      // so re-loading this project later still finds the PDF automatically.
      PSB.closePdf();
      state.rows = [];
      state.globals = PSB.defaultGlobals();
      state.auditLog = [];
      state.faiRuns = [];
      importedFileName = null;
      PSB.setPdfProjectId(null);
      syncGlobalsToUI();
      PSB.renderOpBar(state.globals.ops, handleRemoveOp);
      PSB.renderTable(state, VIEW_CONFIGS[currentView]);
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
      var oldUnit = state.globals.importUnits;
      PSB.pushUndo(state, 'Units: ' + oldUnit + ' → ' + newUnit);
      unitToggle.setAttribute('aria-checked', newUnit === 'mm' ? 'true' : 'false');
      document.getElementById('import-units').value = newUnit;
      state.globals.importUnits = newUnit;
      PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Units: ' + oldUnit + ' → ' + newUnit, details: [{ field: 'importUnits', from: oldUnit, to: newUnit }] });
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
    var oldVal = state.globals.platingThickness;
    var newVal = parseFloat(e.target.value) || 0;
    PSB.pushUndo(state, 'Plating thickness: ' + oldVal + ' → ' + newVal);
    state.globals.platingThickness = newVal;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Plating thickness: ' + oldVal + ' → ' + newVal, details: [{ field: 'platingThickness', from: String(oldVal), to: String(newVal) }] });
    recomputeAll();
    markDirty();
    scheduleAutoSave();
    // Toast fires after user stops typing (debounced)
    if (platingToastTimer) clearTimeout(platingToastTimer);
    platingToastTimer = setTimeout(function() {
      var units = state.globals.platingUnits || 'inch';
      if (newVal > 0) {
        PSB.showToast('Plating: ' + newVal + ' ' + units, 'info');
      } else {
        PSB.showToast('Plating thickness cleared', 'info');
      }
    }, 700);
  });

  // Plating units
  document.getElementById('plating-units').addEventListener('change', function(e) {
    var oldVal = state.globals.platingUnits;
    PSB.pushUndo(state, 'Plating units: ' + oldVal + ' → ' + e.target.value);
    state.globals.platingUnits = e.target.value;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Plating units: ' + oldVal + ' → ' + e.target.value, details: [{ field: 'platingUnits', from: oldVal, to: e.target.value }] });
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  // Precision
  document.getElementById('inch-precision').addEventListener('input', function(e) {
    var oldVal = state.globals.inchPrecision;
    var newVal = parseInt(e.target.value) || 4;
    PSB.pushUndo(state, 'Inch precision: ' + oldVal + ' → ' + newVal);
    state.globals.inchPrecision = newVal;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Inch precision: ' + oldVal + ' → ' + newVal, details: [{ field: 'inchPrecision', from: String(oldVal), to: String(newVal) }] });
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  document.getElementById('mm-precision').addEventListener('input', function(e) {
    var oldVal = state.globals.mmPrecision;
    var newVal = parseInt(e.target.value) || 3;
    PSB.pushUndo(state, 'MM precision: ' + oldVal + ' → ' + newVal);
    state.globals.mmPrecision = newVal;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'MM precision: ' + oldVal + ' → ' + newVal, details: [{ field: 'mmPrecision', from: String(oldVal), to: String(newVal) }] });
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
  var sizeSlider = document.getElementById('pdf-balloon-size');
  if (sizeSlider && state.globals.balloonRadius > 0) {
    sizeSlider.value = state.globals.balloonRadius;
  }
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

function setPdfFileName(name) {
  state.globals.pdfFileName = name || null;
  if (name) markDirty();
}
PSB.setPdfFileName = setPdfFileName;

function getSuggestedSaveName() {
  if (!importedFileName) return 'ProShop_Project - InspecProject.json';
  // Strip extension, append " - InspecProject.json"
  var base = importedFileName.replace(/\.(csv|json)$/i, '');
  return base + ' - InspecProject.json';
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

function applyLoadedProject(jsonString, fileName) {
  try {
    var loaded = PSB.loadProject(jsonString);
    state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
    state.rows = loaded.rows;
    state.auditLog = loaded.auditLog || [];
    state.faiRuns = loaded.faiRuns || [];
    importedFileName = fileName;
    PSB.clearUndoRedo();
    recomputeAll();
    syncGlobalsToUI();
    PSB.renderOpBar(state.globals.ops, handleRemoveOp);
    PSB.closeSidebar();
    setFilename(fileName);
    markClean();

    // Restore PDF — inject project ID so IDB byte cache is keyed correctly
    PSB.setPdfProjectId(state.globals.projectId);
    if (state.globals.pdfFileName) {
      var pdfName = state.globals.pdfFileName;
      PSB.tryRestorePdf(pdfName).then(function(ok) {
        if (ok) return;
        // All IDB layers missed — prompt user to locate the PDF once.
        // startIn opens in the project's folder (if project was opened via FSA).
        PSB.showToast('Select ' + pdfName + ' (one-time — remembered after this)', 'info');
        return PSB.promptForPdf(pdfName);
      });
    } else {
      PSB.closePdf();
    }

    updateCmmPartBadge(state.globals.cmmPartName);
    console.log('[PSB] Loaded project with ' + state.rows.length + ' rows');
  } catch (err) {
    PSB.showToast('Failed to load project file: ' + err.message, 'error');
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
    ensureProjectId(); // generate UUID if this project doesn't have one yet
    var result = PSB.saveProject(state, { suggestedName: getSuggestedSaveName() });
    if (result && result.then) {
      result.then(function(ok) {
        if (ok) {
          markClean();
          var fname = PSB.getProjectFileName();
          if (fname) setFilename(fname);
          PSB.showToast('Project saved.', 'success');
        }
      });
    } else {
      markClean();
      PSB.showToast('Project saved.', 'success');
    }
  });

  // Load project button — uses File System Access API to get a handle
  // so subsequent saves overwrite the same file without prompting.
  document.getElementById('btn-load').addEventListener('click', function() {
    PSB.openProjectWithHandle().then(function(result) {
      if (result) {
        applyLoadedProject(result.jsonString, result.fileName);
      } else if (!window.showOpenFilePicker) {
        // Fallback for browsers without File System Access API
        document.getElementById('file-load-project').click();
      }
      // null with API = user cancelled, do nothing
    });
  });

  document.getElementById('file-load-project').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    var loadFileName = file.name;
    reader.onload = function(ev) {
      applyLoadedProject(ev.target.result, loadFileName);
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

    PSB.pushUndo(state, 'Add OP ' + val);
    state.globals.ops.push(val);
    state.globals.ops.sort(function(a, b) { return a - b; });
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Added OP ' + val });

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
  PSB.pushUndo(state, 'Remove OP ' + opNum);
  state.globals.ops = state.globals.ops.filter(function(o) { return o !== opNum; });
  PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Removed OP ' + opNum });
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
    PSB.closeModal('export-modal');
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

    PSB.showLoading('Exporting...');
    setTimeout(function() {
      state.globals.exportUnits = exportUnits;
      recomputeAll();
      var csv = PSB.generateCSV(state.rows, selectedOps, state.globals);
      PSB.downloadCSV(csv, null, PSB.getProjectFileHandle()).then(function(saved) {
        PSB.hideLoading();
        if (saved) {
          PSB.showToast('CSV exported.', 'success');
          PSB.closeModal('export-modal');
          if (PSB.hasFileHandle()) {
            PSB.autoSaveToDisk(state).then(function(ok) { if (ok) markClean(); });
          }
        }
        // If !saved (user cancelled picker), keep modal open
      }).catch(function() {
        PSB.hideLoading();
        PSB.showToast('Export failed.', 'error');
      });
    }, 50);
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

  PSB.openModal('export-modal');
}

// ═══════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════
function bindSettingsModal() {
  document.getElementById('btn-settings').addEventListener('click', function() {
    // Populate equipment list
    document.getElementById('settings-equipment-list').value =
      state.globals.equipmentList.join('\n');
    // Populate balloon OCR mode
    document.getElementById('settings-ocr-mode').value =
      state.globals.ocrMode || 'tesseract';
    // Populate title block defaults
    document.getElementById('settings-tblock-units').value =
      state.globals.titleBlockTolUnits || 'inch';
    document.getElementById('settings-tblock-1d').value =
      state.globals.titleBlockTol1d || '';
    document.getElementById('settings-tblock-2d').value =
      state.globals.titleBlockTol2d || '';
    document.getElementById('settings-tblock-3d').value =
      state.globals.titleBlockTol3d || '';
    document.getElementById('settings-tblock-4d').value =
      state.globals.titleBlockTol4d || '';
    document.getElementById('settings-tblock-gdt').value =
      state.globals.titleBlockTolGdt || '';

    PSB.openModal('settings-modal');
  });

  document.getElementById('settings-close').addEventListener('click', function() {
    PSB.pushUndo(state, 'Update settings');
    // Save equipment list
    var eqText = document.getElementById('settings-equipment-list').value;
    state.globals.equipmentList = eqText.split('\n')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s !== ''; })
      .sort();
    // Save balloon OCR mode
    var ocrMode = document.getElementById('settings-ocr-mode').value;
    state.globals.ocrMode = (ocrMode === 'claude') ? 'claude' : 'tesseract';
    // Save title block defaults
    state.globals.titleBlockTolUnits = document.getElementById('settings-tblock-units').value || 'inch';
    state.globals.titleBlockTol1d  = document.getElementById('settings-tblock-1d').value.trim();
    state.globals.titleBlockTol2d  = document.getElementById('settings-tblock-2d').value.trim();
    state.globals.titleBlockTol3d  = document.getElementById('settings-tblock-3d').value.trim();
    state.globals.titleBlockTol4d  = document.getElementById('settings-tblock-4d').value.trim();
    state.globals.titleBlockTolGdt = document.getElementById('settings-tblock-gdt').value.trim();
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Updated settings' });

    PSB.closeModal('settings-modal');
    markDirty();
    scheduleAutoSave();
  });
}

// ═══════════════════════════════════════════════════════════
// FILE IMPORT HANDLER
// ═══════════════════════════════════════════════════════════
function handleFileImport(content, fileName) {
  var doImport = function() {
    PSB.showLoading('Importing...');
    setTimeout(function() {
      if (fileName.endsWith('.json')) {
        try {
          var loaded = PSB.loadProject(content);
          state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
          state.rows = loaded.rows;
          state.auditLog = loaded.auditLog || [];
          state.faiRuns = loaded.faiRuns || [];
          importedFileName = fileName;
          PSB.clearUndoRedo();
          recomputeAll();
          syncGlobalsToUI();
          PSB.renderOpBar(state.globals.ops, handleRemoveOp);
          PSB.closeSidebar();
          setFilename(fileName);
          markClean();

          // Restore PDF — inject project ID so IDB byte cache is keyed correctly
          PSB.setPdfProjectId(state.globals.projectId);
          if (state.globals.pdfFileName) {
            PSB.restoreOrPromptPdf(state.globals.pdfFileName, true);
          } else {
            PSB.closePdf();
          }
        } catch (err) {
          PSB.showToast('Failed to load project: ' + err.message, 'error');
        }
        PSB.hideLoading();
        return;
      }

      var rawRows = PSB.parseCSV(content);
      if (rawRows.length === 0) {
        PSB.showToast('No valid data found in CSV.', 'error');
        PSB.hideLoading();
        return;
      }

      PSB.clearUndoRedo();
      PSB.resetIdCounter();
      state.rows = rawRows.map(function(raw) { return PSB.createRow(raw); });
      state.auditLog = [];
      importedFileName = fileName;
      PSB.logChange(state.auditLog, { type: 'import', rowId: null, description: 'Imported ' + state.rows.length + ' rows from ' + fileName });
      recomputeAll();
      PSB.closeSidebar();
      setFilename(fileName);
      markDirty();
      console.log('[PSB] Imported ' + state.rows.length + ' rows from ' + fileName);
      PSB.showToast('Imported ' + state.rows.length + ' rows from ' + fileName, 'success');
      PSB.hideLoading();
    }, 50);
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
  for (var i = 0; i < state.rows.length; i++) {
    PSB.recompute(state.rows[i], state.globals);
  }
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  updateFaiTabBadge();

  // Refresh sidebar if a row is selected so values stay in sync
  var selId = PSB.getSelectedRowId();
  if (selId !== null) {
    var tr = document.querySelector('#table-body tr[data-row-id="' + selId + '"]');
    if (tr) tr.classList.add('selected');
    PSB.populateSidebar(selId);
  }

  scheduleAutoSave();
}

// ═══════════════════════════════════════════════════════════
// FAI IMPORT FLOW
// ═══════════════════════════════════════════════════════════

/**
 * Delete one or more CMM runs by ID. Removes all matching measurements from
 * every row, recalculates aggregateStatus, and removes the run from faiRuns.
 *
 * @param {string[]} runIds — array of run IDs to remove
 */
function deleteFaiRuns(runIds) {
  if (!runIds || runIds.length === 0) return;
  var idSet = {};
  for (var i = 0; i < runIds.length; i++) idSet[runIds[i]] = true;

  for (var ri = 0; ri < state.rows.length; ri++) {
    var row = state.rows[ri];
    if (!row.fai || !row.fai.measurements) continue;
    row.fai.measurements = row.fai.measurements.filter(function(m) {
      return !idSet[m.runId];
    });
    if (row.fai.measurements.length === 0) {
      row.fai = null;
    } else {
      row.fai.aggregateStatus = PSB.computeAggregateStatus(row.fai.measurements);
    }
  }

  state.faiRuns = (state.faiRuns || []).filter(function(r) { return !idSet[r.id]; });
  PSB.autoSave({ rows: state.rows, globals: state.globals, auditLog: state.auditLog, faiRuns: state.faiRuns });
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  markDirty();
}

function updateCmmPartBadge(partName) {
  var badge = document.getElementById('cmm-part-badge');
  var text  = document.getElementById('cmm-part-name-text');
  if (!badge || !text) return;
  if (partName) {
    text.textContent = partName;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function handleCmmImport(rawText, fileName, cmmUnits, clearFirst) {
  var parsed = PSB.parseCmmText(rawText);
  if (!parsed || parsed.length === 0) {
    PSB.showToast('No CMM data found in input', 'warn');
    return;
  }

  var cmmHeader  = PSB.parseCmmHeader(rawText);
  var runLabel   = cmmHeader.dateStr || fileName.replace(/\.[^.]+$/, '');
  var runPartName = cmmHeader.partName || '';
  if (runPartName) state.globals.cmmPartName = runPartName;

  // Save chosen units to globals for next time
  cmmUnits = cmmUnits || state.globals.cmmImportUnits || 'mm';
  state.globals.cmmImportUnits = cmmUnits;

  // Clear existing runs if requested
  if (clearFirst && state.faiRuns && state.faiRuns.length > 0) {
    var allIds = state.faiRuns.map(function(r) { return r.id; });
    deleteFaiRuns(allIds);
  }

  PSB.pushUndo(state, 'Import CMM run: ' + fileName);

  var planUnits = state.globals.importUnits || 'mm';
  var needConvert = cmmUnits !== planUnits;

  var runId = 'run_' + Date.now();
  var matchedCount = 0;
  var unmatchedRows = [];
  var warnThreshold = state.globals.faiWarnThreshold || 0.80;

  // Group parsed rows by dimTag
  var byDimTag = {};
  for (var i = 0; i < parsed.length; i++) {
    var p = parsed[i];
    if (p.dimTag !== null) {
      if (!byDimTag[p.dimTag]) byDimTag[p.dimTag] = [];
      byDimTag[p.dimTag].push(p);
    } else {
      unmatchedRows.push(p);
    }
  }

  // Match to plan rows and attach measurements
  for (var dimTag in byDimTag) {
    var group = byDimTag[dimTag];
    var planRow = null;
    for (var ri = 0; ri < state.rows.length; ri++) {
      var r = state.rows[ri];
      var tag = r.computed.dimTag || r.raw['Dim Tag #'];
      if (String(tag) === String(dimTag)) { planRow = r; break; }
    }

    if (!planRow) {
      for (var gi = 0; gi < group.length; gi++) unmatchedRows.push(group[gi]);
      continue;
    }

    matchedCount += group.length;
    if (!planRow.fai) planRow.fai = { measurements: [], aggregateStatus: null, isExpanded: false };

    var now = new Date().toISOString();
    for (var gi = 0; gi < group.length; gi++) {
      var cmmRow = group[gi];

      // Angles are never converted between units — degrees are degrees regardless of unit system.
      // An angle CMM row is one where the CMM name contains "angle" or "°",
      // or the matched plan row is flagged as an angle dimension.
      var ANGLE_RE_CMM = /angle|°/i;
      var isCmmAngle = ANGLE_RE_CMM.test(cmmRow.cmmName) || (planRow.computed && planRow.computed.isAngle);
      var doConvert = needConvert && !isCmmAngle;

      // Convert CMM values to plan units if needed
      var measured  = doConvert ? PSB.convertUnits(cmmRow.measured,  cmmUnits, planUnits) : cmmRow.measured;
      var nominal   = doConvert ? PSB.convertUnits(cmmRow.nominal,   cmmUnits, planUnits) : cmmRow.nominal;
      var deviation = doConvert ? PSB.convertUnits(cmmRow.deviation, cmmUnits, planUnits) : cmmRow.deviation;
      var plusTol   = doConvert ? PSB.convertUnits(cmmRow.plusTol,   cmmUnits, planUnits) : cmmRow.plusTol;
      var minusTol  = doConvert ? PSB.convertUnits(cmmRow.minusTol,  cmmUnits, planUnits) : cmmRow.minusTol;

      // Measured and nominal are always positive; tolerance is never touched
      measured = Math.abs(measured);
      nominal  = Math.abs(nominal);

      // Cap all stored values to 5 decimal places
      measured  = parseFloat(measured.toFixed(5));
      nominal   = parseFloat(nominal.toFixed(5));
      deviation = parseFloat(deviation.toFixed(5));
      plusTol   = parseFloat(plusTol.toFixed(5));
      minusTol  = parseFloat(minusTol.toFixed(5));

      var status = PSB.computeFaiStatus(measured, nominal, plusTol, minusTol, warnThreshold);
      planRow.fai.measurements.push({
        runId: runId,
        cmmName: cmmRow.cmmName,
        measured: measured,
        nominal: nominal,
        deviation: deviation,
        plusTol: plusTol,
        minusTol: minusTol,
        status: status,
        isChild: gi > 0,
        childIndex: gi > 0 ? gi : null,
        equipment: '',
        notes: '',
        attachments: [],
        timestamp: now,
      });
    }
    planRow.fai.aggregateStatus = PSB.computeAggregateStatus(planRow.fai.measurements);
  }

  // Append run metadata
  if (!state.faiRuns) state.faiRuns = [];
  state.faiRuns.push({
    id: runId,
    label: runLabel,
    partName: runPartName,
    fileName: fileName,
    importedAt: new Date().toISOString(),
    units: cmmUnits,
    rowCount: parsed.length,
    matchedCount: matchedCount,
    unmatchedRows: unmatchedRows,
  });

  PSB.logChange(state.auditLog, { type: 'import', rowId: null, description: 'CMM import: ' + fileName });
  PSB.autoSave({ rows: state.rows, globals: state.globals, auditLog: state.auditLog, faiRuns: state.faiRuns });
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  updateCmmPartBadge(state.globals.cmmPartName);
  updateFaiTabBadge();

  // Show import summary
  showCmmImportSummary(parsed.length, matchedCount, unmatchedRows);
  markDirty();
}

function showCmmImportSummary(totalParsed, matchedCount, unmatchedRows) {
  var unmatchedHtml = '';
  if (unmatchedRows.length > 0) {
    var items = '';
    var limit = unmatchedRows.length < 20 ? unmatchedRows.length : 20;
    for (var i = 0; i < limit; i++) {
      var row = unmatchedRows[i];
      items += '<li>' + PSB.esc(row.cmmName || '(no name)') + ' — ' + (row.measured != null ? row.measured : '?') + '</li>';
    }
    if (unmatchedRows.length > 20) items += '<li>…and ' + (unmatchedRows.length - 20) + ' more</li>';
    unmatchedHtml = '<p><strong>Unmatched rows:</strong></p><ul>' + items + '</ul>';
  }

  var modal = document.getElementById('modal-cmm-summary');
  if (modal) {
    document.getElementById('cmm-summary-total').textContent = totalParsed;
    document.getElementById('cmm-summary-matched').textContent = matchedCount;
    document.getElementById('cmm-summary-unmatched').textContent = unmatchedRows.length;
    document.getElementById('cmm-summary-unmatched-list').innerHTML = unmatchedHtml;
    PSB.openModal('modal-cmm-summary');
  }
}

function bindFaiControls() {
  // FAI compare mode toggle
  var cmpOp2kBtn = document.getElementById('btn-fai-compare-op2000');
  var cmpCompBtn = document.getElementById('btn-fai-compare-comp');
  if (cmpOp2kBtn) cmpOp2kBtn.addEventListener('click', function() { setFaiCompareMode('op2000'); });
  if (cmpCompBtn) cmpCompBtn.addEventListener('click', function() { setFaiCompareMode('compensated'); });

  // FAI Export button
  var exportFaiBtn = document.getElementById('btn-export-fai');
  if (exportFaiBtn) {
    exportFaiBtn.addEventListener('click', function() {
      PSB.openModal('modal-fai-export');
    });
  }

  // FAI Export modal close
  var faiExportClose = document.getElementById('btn-fai-export-close');
  if (faiExportClose) {
    faiExportClose.addEventListener('click', function() {
      PSB.closeModal('modal-fai-export');
    });
  }

  // CMM Import button — populate existing runs list when modal opens
  var importCmmBtn = document.getElementById('btn-import-cmm');
  if (importCmmBtn) {
    importCmmBtn.addEventListener('click', function() {
      var pasteArea = document.getElementById('cmm-paste-area');
      if (pasteArea) pasteArea.value = '';
      var filenameSpan = document.getElementById('cmm-loaded-filename');
      if (filenameSpan) filenameSpan.textContent = '';
      cmmLastLoadedFileName = 'CMM_Import.txt';

      // Sync units toggle to current global
      var curUnits = state.globals.cmmImportUnits || 'mm';
      var mmBtn   = document.getElementById('btn-cmm-units-mm');
      var inchBtn = document.getElementById('btn-cmm-units-inch');
      if (mmBtn)   mmBtn.classList.toggle('active',  curUnits === 'mm');
      if (inchBtn) inchBtn.classList.toggle('active', curUnits === 'inch');

      // Populate existing runs list
      refreshCmmRunsList();
      PSB.openModal('modal-cmm-import');
    });
  }

  // CMM units toggle
  var cmmUnitsMm   = document.getElementById('btn-cmm-units-mm');
  var cmmUnitsInch = document.getElementById('btn-cmm-units-inch');
  if (cmmUnitsMm) {
    cmmUnitsMm.addEventListener('click', function() {
      cmmUnitsMm.classList.add('active');
      if (cmmUnitsInch) cmmUnitsInch.classList.remove('active');
    });
  }
  if (cmmUnitsInch) {
    cmmUnitsInch.addEventListener('click', function() {
      cmmUnitsInch.classList.add('active');
      if (cmmUnitsMm) cmmUnitsMm.classList.remove('active');
    });
  }

  // CMM Import cancel
  var cmmCancelBtn = document.getElementById('btn-cmm-import-cancel');
  if (cmmCancelBtn) {
    cmmCancelBtn.addEventListener('click', function() {
      PSB.closeModal('modal-cmm-import');
    });
  }

  // CMM file input — read as text, track filename
  var cmmFileInput = document.getElementById('cmm-file-input');
  if (cmmFileInput) {
    cmmFileInput.addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (!file) return;
      cmmLastLoadedFileName = file.name;
      var filenameSpan = document.getElementById('cmm-loaded-filename');
      if (filenameSpan) filenameSpan.textContent = file.name;
      var reader = new FileReader();
      reader.onload = function(ev) {
        var pasteArea = document.getElementById('cmm-paste-area');
        if (pasteArea) pasteArea.value = ev.target.result;
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  // Delete selected runs
  var deleteSelectedBtn = document.getElementById('btn-cmm-delete-selected');
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener('click', function() {
      var checkboxes = document.querySelectorAll('#cmm-runs-list input[type=checkbox]:checked');
      var ids = [];
      for (var i = 0; i < checkboxes.length; i++) {
        ids.push(checkboxes[i].value);
      }
      if (ids.length === 0) return;
      PSB.pushUndo(state, 'Delete CMM run' + (ids.length > 1 ? 's' : ''));
      deleteFaiRuns(ids);
      PSB.showToast('Deleted ' + ids.length + ' run' + (ids.length > 1 ? 's' : ''), 'success');
      refreshCmmRunsList();
    });
  }

  // Select-all checkbox
  var selectAllChk = document.getElementById('cmm-select-all');
  if (selectAllChk) {
    selectAllChk.addEventListener('change', function() {
      var checkboxes = document.querySelectorAll('#cmm-runs-list input[type=checkbox]');
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = selectAllChk.checked;
      }
      updateDeleteSelectedBtn();
    });
  }

  // CMM Import confirm
  var cmmConfirmBtn = document.getElementById('btn-cmm-import-confirm');
  if (cmmConfirmBtn) {
    cmmConfirmBtn.addEventListener('click', function() {
      var pasteArea = document.getElementById('cmm-paste-area');
      var rawText = pasteArea ? pasteArea.value : '';
      if (!rawText.trim()) {
        PSB.showToast('Please paste CMM data or load a file', 'warn');
        return;
      }
      var mmBtn = document.getElementById('btn-cmm-units-mm');
      var chosenUnits = (mmBtn && mmBtn.classList.contains('active')) ? 'mm' : 'inch';
      var modeRadio = document.querySelector('input[name="cmm-import-mode"]:checked');
      var clearFirst = modeRadio && modeRadio.value === 'clear';
      PSB.closeModal('modal-cmm-import');
      handleCmmImport(rawText, cmmLastLoadedFileName, chosenUnits, clearFirst);
    });
  }

  // CMM Summary done
  var cmmSummaryDone = document.getElementById('btn-cmm-summary-done');
  if (cmmSummaryDone) {
    cmmSummaryDone.addEventListener('click', function() {
      PSB.closeModal('modal-cmm-summary');
    });
  }
}

var cmmLastLoadedFileName = 'CMM_Import.txt';

function refreshCmmRunsList() {
  var runs = state.faiRuns || [];
  var section = document.getElementById('cmm-runs-section');
  var list = document.getElementById('cmm-runs-list');
  var selectAllChk = document.getElementById('cmm-select-all');
  if (!section || !list) return;

  if (runs.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  if (selectAllChk) selectAllChk.checked = false;

  var html = '';
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    var date = run.importedAt ? run.importedAt.slice(0, 10) : '';
    var unitsLabel = run.units ? ' · ' + run.units : '';
    html += '<label class="cmm-run-row">' +
      '<input type="checkbox" value="' + PSB.esc(run.id) + '" onchange="updateDeleteSelectedBtn()"> ' +
      '<span class="cmm-run-label">' + PSB.esc(run.label || run.fileName) + '</span>' +
      '<span class="cmm-run-meta">' + PSB.esc(run.matchedCount + ' dims' + unitsLabel + (date ? ' · ' + date : '')) + '</span>' +
      '</label>';
  }
  list.innerHTML = html;
  updateDeleteSelectedBtn();
}

function updateDeleteSelectedBtn() {
  var btn = document.getElementById('btn-cmm-delete-selected');
  if (!btn) return;
  var checked = document.querySelectorAll('#cmm-runs-list input[type=checkbox]:checked').length;
  btn.disabled = checked === 0;
  btn.textContent = checked > 0 ? 'Delete Selected (' + checked + ')' : 'Delete Selected';
}

// ═══════════════════════════════════════════════════════════
// AUTO-SAVE (debounced)
// ═══════════════════════════════════════════════════════════
var autoSaveTimer = null;
var diskSaveTimer = null;
var platingToastTimer = null;

function scheduleAutoSave() {
  // Quick save to sessionStorage (1s debounce)
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(function() {
    PSB.autoSave(state);
  }, 1000);

  // Persist to disk if file handle exists (3s debounce)
  if (diskSaveTimer) clearTimeout(diskSaveTimer);
  diskSaveTimer = setTimeout(function() {
    if (PSB.hasFileHandle()) {
      ensureProjectId(); // make sure projectId is set before writing to disk
      PSB.autoSaveToDisk(state).then(function(ok) {
        if (ok) markClean();
      });
    }
  }, 3000);
}
