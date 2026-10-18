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
// GLOBAL CONTROLS
// ═══════════════════════════════════════════════════════════
function bindGlobalControls() {
  // Import units — iOS-style toggle
  var unitToggle = document.getElementById('unit-toggle');
  if (unitToggle) {
    unitToggle.addEventListener('click', function() {
      var isMm = unitToggle.getAttribute('aria-checked') === 'true';
      setPrintUnits(isMm ? 'inch' : 'mm');
    });
    unitToggle.addEventListener('keydown', function(e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); unitToggle.click(); }
    });
  }

  // Fallback: hidden select (for programmatic sync)
  document.getElementById('import-units').addEventListener('change', function(e) {
    setPrintUnits(e.target.value);
  });

  // Print units banner buttons (confirm / switch / keep)
  document.getElementById('units-banner').addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.units) setPrintUnits(btn.dataset.units);
    if (btn.dataset.dismiss) {
      // "Keep" on a mismatch warning — don't nag again for this guess
      state.globals.unitsMismatchDismissed = btn.dataset.dismiss;
      markDirty();
      scheduleAutoSave();
      refreshPrintUnitsUI();
    }
  });

  // Plating thickness
  document.getElementById('plating-thickness').addEventListener('input', function(e) {
    var oldVal = state.globals.platingThickness;
    var newVal = parseFloat(e.target.value) || 0;
    PSB.pushUndo(state, 'Plating thickness → ' + newVal, 'platingThickness');
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
    PSB.pushUndo(state, 'Inch precision → ' + newVal, 'inchPrecision');
    state.globals.inchPrecision = newVal;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Inch precision: ' + oldVal + ' → ' + newVal, details: [{ field: 'inchPrecision', from: String(oldVal), to: String(newVal) }] });
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  document.getElementById('mm-precision').addEventListener('input', function(e) {
    var oldVal = state.globals.mmPrecision;
    var newVal = parseInt(e.target.value) || 3;
    PSB.pushUndo(state, 'MM precision → ' + newVal, 'mmPrecision');
    state.globals.mmPrecision = newVal;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'MM precision: ' + oldVal + ' → ' + newVal, details: [{ field: 'mmPrecision', from: String(oldVal), to: String(newVal) }] });
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });

  document.getElementById('angle-precision').addEventListener('input', function(e) {
    var oldVal = state.globals.angleDecimals;
    var newVal = parseInt(e.target.value, 10);
    if (isNaN(newVal) || newVal < 0) newVal = 3;
    PSB.pushUndo(state, 'Angle decimals → ' + newVal, 'angleDecimals');
    state.globals.angleDecimals = newVal;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Angle decimals: ' + oldVal + ' → ' + newVal, details: [{ field: 'angleDecimals', from: String(oldVal), to: String(newVal) }] });
    recomputeAll();
    markDirty();
    scheduleAutoSave();
  });
}

function syncGlobalsToUI() {
  refreshPrintUnitsUI();
  document.getElementById('import-units').value = state.globals.importUnits;
  syncUnitToggle(state.globals.importUnits);
  applyUnitColors(state.globals.importUnits);
  document.getElementById('plating-thickness').value = state.globals.platingThickness || '';
  document.getElementById('plating-units').value = state.globals.platingUnits;
  document.getElementById('inch-precision').value = state.globals.inchPrecision;
  document.getElementById('mm-precision').value = state.globals.mmPrecision;
  document.getElementById('angle-precision').value = state.globals.angleDecimals;
  var sizeSlider = document.getElementById('pdf-balloon-size');
  if (sizeSlider && state.globals.balloonRadius > 0) {
    sizeSlider.value = state.globals.balloonRadius;
  }
  // Title Block Defaults — now always-visible in setup panel
  var tbu = document.getElementById('settings-tblock-units');
  var tb1 = document.getElementById('settings-tblock-1d');
  var tb2 = document.getElementById('settings-tblock-2d');
  var tb3 = document.getElementById('settings-tblock-3d');
  var tb4 = document.getElementById('settings-tblock-4d');
  var tbg = document.getElementById('settings-tblock-gdt');
  if (tbu) tbu.value = state.globals.titleBlockTolUnits || 'inch';
  if (tb1) tb1.value = state.globals.titleBlockTol1d  || '';
  if (tb2) tb2.value = state.globals.titleBlockTol2d  || '';
  if (tb3) tb3.value = state.globals.titleBlockTol3d  || '';
  if (tb4) tb4.value = state.globals.titleBlockTol4d  || '';
  if (tbg) tbg.value = state.globals.titleBlockTolGdt || '';
}

// ═══════════════════════════════════════════════════════════
// PRINT UNITS (RULES.md §10)
// Values stay in the units they were written in. Changing print units
// RELABELS — nothing is converted, so no work is lost.
// ═══════════════════════════════════════════════════════════
var pdfTitleText = { name: null, text: '' };

// Read page-1 text of the loaded PDF once (local only) for title block clues
function loadPdfTitleText() {
  var name = (PSB.hasPdf && PSB.hasPdf()) ? PSB.getPdfFileName() : null;
  if (!name || pdfTitleText.name === name) return;
  var doc = PSB.getPdfDoc && PSB.getPdfDoc();
  if (!doc) return;
  pdfTitleText = { name: name, text: '' };
  doc.getPage(1).then(function(page) { return page.getTextContent(); }).then(function(content) {
    if (pdfTitleText.name !== name) return;
    pdfTitleText.text = content.items.map(function(i) { return i.str; }).join(' ');
    refreshPrintUnitsUI();
  }).catch(function() {});
}

function detectUnitsNow() {
  return PSB.detectPrintUnits(PSB.unitSamplesFromRows(state.rows), pdfTitleText.text);
}

function unitName(u) { return u === 'inch' ? 'INCH' : 'MM'; }

function unitButtonsHtml(primary, detected) {
  var other = primary === 'inch' ? 'mm' : 'inch';
  function b(u, cls, label) {
    return '<button class="btn btn-small ' + cls + '" data-units="' + u + '">' + label +
      (u === detected ? ' (detected)' : '') + '</button>';
  }
  return '<div class="units-banner-actions">' +
    b(primary, 'btn-primary', 'Confirm ' + unitName(primary)) +
    b(other, 'btn-secondary', 'Use ' + unitName(other)) + '</div>';
}

function refreshPrintUnitsUI() {
  loadPdfTitleText();
  updateStepStatus(); // ① shows a warning until units are confirmed
  var g = state.globals;
  var cur = PSB.getPrintUnits(g);
  var status = document.getElementById('print-units-status');
  if (status) {
    status.textContent = g.printUnitsConfirmed ? '✓ Confirmed' : '⚠ Not confirmed';
    status.className = 'print-units-status' + (g.printUnitsConfirmed ? '' : ' unconfirmed');
  }
  var banner = document.getElementById('units-banner');
  if (!banner) return;
  if (!state.rows.length) { banner.classList.add('hidden'); return; }

  var d = detectUnitsNow();
  var why = d.reasons.length ? '<div class="units-banner-why">' + PSB.esc(d.reasons.slice(0, 3).join(' · ')) + '</div>' : '';
  var html = '';
  banner.classList.remove('mismatch');
  if (!g.printUnitsConfirmed) {
    var guess = d.units || cur;
    html = '<div class="units-banner-msg">' +
      (d.units
        ? '⚠ Print units not confirmed. Looks like <strong>' + unitName(d.units) + '</strong>' + (d.confidence === 'low' ? ' (low confidence)' : '') + '.'
        : '⚠ Print units not confirmed — could not tell from the values.') +
      why + '</div>' + unitButtonsHtml(guess, d.units);
  } else if (d.confidence === 'high' && d.units !== cur && g.unitsMismatchDismissed !== d.units) {
    banner.classList.add('mismatch');
    html = '<div class="units-banner-msg">⚠ Values look like <strong>' + unitName(d.units) +
      '</strong>, but print units are <strong>' + unitName(cur) + '</strong>.' + why + '</div>' +
      '<div class="units-banner-actions">' +
      '<button class="btn btn-small btn-primary" data-units="' + d.units + '">Switch to ' + unitName(d.units) + '</button>' +
      '<button class="btn btn-small btn-secondary" data-dismiss="' + d.units + '">Keep ' + unitName(cur) + '</button></div>';
  }
  banner.innerHTML = html;
  banner.classList.toggle('hidden', !html);
}

var TYPED_KEY_LABELS = {
  outDrawingSpec: 'OP2000 spec', outTolPlus: 'OP2000 tol +', outTolMinus: 'OP2000 tol −',
  outputSpec: 'OUT spec', outputTolPlus: 'OUT tol +', outputTolMinus: 'OUT tol −',
};

/**
 * Set (and confirm) the print units. Same units → just confirms.
 * Different → relabel; if the user typed values, ask keep vs convert.
 */
function setPrintUnits(newUnits, onDone) {
  var g = state.globals;
  var oldUnits = PSB.getPrintUnits(g);

  if (newUnits === oldUnits) {
    if (!g.printUnitsConfirmed) {
      PSB.pushUndo(state, 'Confirm print units: ' + newUnits);
      g.printUnitsConfirmed = true;
      PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Confirmed print units: ' + newUnits, details: [{ field: 'printUnitsConfirmed', from: 'false', to: 'true' }] });
    }
    g.unitsMismatchDismissed = null;
    finishUnitsChange();
    if (onDone) onDone();
    return;
  }

  var apply = function(convert) {
    PSB.pushUndo(state, 'Print units: ' + oldUnits + ' → ' + newUnits);
    g.importUnits = newUnits;
    g.printUnitsConfirmed = true;
    g.unitsMismatchDismissed = null;
    var n = convert ? PSB.convertTypedValues(state.rows, oldUnits, newUnits, g) : 0;
    PSB.logChange(state.auditLog, { type: 'global', rowId: null,
      description: 'Print units: ' + oldUnits + ' → ' + newUnits + ' (relabeled' + (n ? ', converted ' + n + ' typed values' : '') + ')',
      details: [{ field: 'importUnits', from: oldUnits, to: newUnits }] });
    finishUnitsChange();
    PSB.showToast('Print units: ' + unitName(newUnits) + ' — relabeled, nothing lost' + (n ? ', ' + n + ' typed values converted' : '') + '.', 'success');
    if (onDone) onDone();
  };

  var typed = PSB.listTypedValues(state.rows);
  if (!typed.length) { apply(false); return; }

  document.getElementById('units-change-title').textContent = 'Change print units: ' + unitName(oldUnits) + ' → ' + unitName(newUnits);
  document.getElementById('units-change-list').innerHTML = typed.map(function(t) {
    return '<li>#' + PSB.esc(t.dimTag) + ' ' + (TYPED_KEY_LABELS[t.key] || t.key) + ': ' + PSB.esc(t.value) + '</li>';
  }).join('');
  var close = function() { PSB.closeModal('units-change-modal'); };
  document.getElementById('units-change-keep').onclick = function() { close(); apply(false); };
  document.getElementById('units-change-convert').onclick = function() { close(); apply(true); };
  document.getElementById('units-change-cancel').onclick = function() { close(); syncUnitToggle(oldUnits); };
  PSB.openModal('units-change-modal');
}

function finishUnitsChange() {
  var u = PSB.getPrintUnits(state.globals);
  document.getElementById('import-units').value = u;
  syncUnitToggle(u);
  applyUnitColors(u);
  recomputeAll();
  markDirty();
  scheduleAutoSave();
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
    if (!state.globals.printUnitsConfirmed) { renderExportGate(); return; }
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

  renderExportGate();
  PSB.openModal('export-modal');
}

// Export is blocked until print units are confirmed — confirm right here.
function renderExportGate() {
  var gate = document.getElementById('export-units-gate');
  var btn = document.getElementById('btn-export-confirm');
  if (state.globals.printUnitsConfirmed) {
    gate.classList.add('hidden');
    btn.disabled = false;
    return;
  }
  var d = detectUnitsNow();
  var guess = d.units || PSB.getPrintUnits(state.globals);
  gate.innerHTML = '<p><strong>Confirm print units to export.</strong> ' +
    (d.units ? 'Looks like <strong>' + unitName(d.units) + '</strong>.' : 'Could not tell from the values.') +
    ' What units is the print drawn in?</p>' + unitButtonsHtml(guess, d.units);
  gate.classList.remove('hidden');
  btn.disabled = true;
  gate.querySelectorAll('button[data-units]').forEach(function(b) {
    b.addEventListener('click', function() { setPrintUnits(b.dataset.units, renderExportGate); });
  });
}

// ═══════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════
function bindSettingsModal() {
  document.getElementById('btn-settings').addEventListener('click', function() {
    // Populate equipment list
    document.getElementById('settings-equipment-list').value =
      state.globals.equipmentList.join('\n');
    // Populate balloon OCR mode (treat legacy 'tesseract' value as 'pdfjs')
    var savedOcrMode = state.globals.ocrMode || 'pdfjs';
    document.getElementById('settings-ocr-mode').value =
      (savedOcrMode === 'claude') ? 'claude' : 'pdfjs';

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
    state.globals.ocrMode = (ocrMode === 'claude') ? 'claude' : 'pdfjs';
    PSB.logChange(state.auditLog, { type: 'global', rowId: null, description: 'Updated settings' });

    PSB.closeModal('settings-modal');
    markDirty();
    scheduleAutoSave();
  });
}

function bindTitleBlockDefaults() {
  function saveTitleBlock() {
    var units = document.getElementById('settings-tblock-units');
    var t1d   = document.getElementById('settings-tblock-1d');
    var t2d   = document.getElementById('settings-tblock-2d');
    var t3d   = document.getElementById('settings-tblock-3d');
    var t4d   = document.getElementById('settings-tblock-4d');
    var tgdt  = document.getElementById('settings-tblock-gdt');
    if (units) state.globals.titleBlockTolUnits = units.value || 'inch';
    if (t1d)  state.globals.titleBlockTol1d  = t1d.value.trim();
    if (t2d)  state.globals.titleBlockTol2d  = t2d.value.trim();
    if (t3d)  state.globals.titleBlockTol3d  = t3d.value.trim();
    if (t4d)  state.globals.titleBlockTol4d  = t4d.value.trim();
    if (tgdt) state.globals.titleBlockTolGdt = tgdt.value.trim();
    markDirty();
    scheduleAutoSave();
  }

  var ids = [
    'settings-tblock-units',
    'settings-tblock-1d',
    'settings-tblock-2d',
    'settings-tblock-3d',
    'settings-tblock-4d',
    'settings-tblock-gdt',
  ];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) el.addEventListener('change', saveTitleBlock);
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
var platingToastTimer = null;
