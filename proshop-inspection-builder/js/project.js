/**
 * project.js — The project file (moved out of app.js, no behavior change)
 *
 * - New / sample / open / save / CSV import
 * - Unsaved-changes flag, warning before close
 * - Auto-save (browser + disk file), reconnect after refresh
 *
 * Uses app.js `state`. Every project load goes through openProject().
 */

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
    PSB.cachePdfForProject();
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

// Track imported filename for save suggestion
var importedFileName = null;

// ═══════════════════════════════════════════════════════════
// DIRTY FLAG — tracks unsaved changes to warn before close
// ═══════════════════════════════════════════════════════════
var isDirty = false;

var editCount = 0; // bumps on every edit; a save only marks clean if it saved the latest

function markDirty() {
  isDirty = true;
  editCount++;
  updateUndoRedoButtons(); // every edit can add an undo step
  if (!document.title.startsWith('* ')) {
    document.title = '* ' + document.title;
  }
  var fnEl = document.getElementById('filename-text');
  if (fnEl && !fnEl.textContent.endsWith(' \u2022')) {
    fnEl.textContent = fnEl.textContent + ' \u2022';
  }
  var saveBtn = document.getElementById('btn-save');
  if (saveBtn) saveBtn.classList.add('btn-dirty');
  saveSessionMeta();
}

// Filename + unsaved flag for this tab, so a page refresh shows the same
// header and still warns before closing with unsaved work.
var SESSION_META_KEY = 'psb_session_meta';
function saveSessionMeta() {
  try {
    sessionStorage.setItem(SESSION_META_KEY, JSON.stringify({ fileName: importedFileName, dirty: isDirty }));
  } catch (e) { /* storage blocked — not critical */ }
}
function readSessionMeta() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_META_KEY) || 'null'); } catch (e) { return null; }
}

// ── Link to the project file on disk ──────────────────────
// After a refresh the browser may want a click before we can write to the
// file again. Until then auto-save to disk waits and the header says so.
var needsReconnect = false;

function setNeedsReconnect(on) {
  needsReconnect = on;
  var banner = document.getElementById('filename-banner');
  if (banner) {
    banner.classList.toggle('needs-reconnect', on);
    banner.title = on ? 'Click to reconnect auto-save to this file' : '';
  }
}

/** Forget the disk file (new data that doesn't belong in it). */
function dropFileLink() {
  PSB.clearProjectFileHandle();
  setNeedsReconnect(false);
}

/** Re-attach the remembered file. `fromClick` lets the browser ask permission. */
function reconnectFile(fromClick) {
  return PSB.reconnectProjectHandle(state.globals.projectId, fromClick).then(function(result) {
    if (result === 'connected') {
      setNeedsReconnect(false);
      importedFileName = PSB.getProjectFileName();
      setFilename(importedFileName);
      if (isDirty) scheduleAutoSave(); // write the unsaved work to the file
      if (fromClick) PSB.showToast('Auto-save reconnected to ' + importedFileName, 'success');
    } else if (result === 'needs-click') {
      setNeedsReconnect(true);
      if (!fromClick) PSB.showToast('Click the file name or Save to reconnect auto-save.', 'info');
    }
    return result;
  });
}

function markClean() {
  isDirty = false;
  document.title = document.title.replace(/^\* /, '');
  var fnEl = document.getElementById('filename-text');
  if (fnEl) fnEl.textContent = fnEl.textContent.replace(/ \u2022$/, '');
  var saveBtn = document.getElementById('btn-save');
  if (saveBtn) saveBtn.classList.remove('btn-dirty');
  saveSessionMeta();
}

/**
 * Put a loaded project (file, drag-drop or auto-save) into app state.
 * One place, so every load path restores the same fields.
 */
function applyLoadedState(loaded) {
  state.globals = Object.assign(PSB.defaultGlobals(), loaded.globals);
  state.rows = loaded.rows;
  state.auditLog = loaded.auditLog || [];
  state.faiRuns = loaded.faiRuns || [];
  state.datumRefs = loaded.datumRefs || [];
}

window.addEventListener('pagehide', function() {
  if (state.rows.length > 0) PSB.autoSave(state);
});

window.addEventListener('beforeunload', function(e) {
  if (isDirty && state.rows.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ═══════════════════════════════════════════════════════════
// NEW FILE BUTTON
// ═══════════════════════════════════════════════════════════
// "New ▾" menu: Blank project / Sample data
function bindNewMenu() {
  var btn = document.getElementById('btn-new-menu');
  var menu = document.getElementById('new-menu');
  if (!btn || !menu) return;
  function setOpen(open) {
    menu.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    setOpen(menu.classList.contains('hidden'));
  });
  menu.addEventListener('click', function() { setOpen(false); }); // item picked
  document.addEventListener('click', function() { setOpen(false); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') setOpen(false); });
}

function bindNewButton() {
  document.getElementById('btn-new').addEventListener('click', function() {
    var doNew = function() {
      PSB.clearAutoSave();
      dropFileLink();
      PSB.clearUndoRedo();
      // closePdf() clears in-memory state; IDB byte cache is intentionally preserved
      // so re-loading this project later still finds the PDF automatically.
      PSB.closePdf();
      state.rows = [];
      state.globals = PSB.defaultGlobals();
      state.auditLog = [];
      state.faiRuns = [];
      state.datumRefs = [];
      importedFileName = null;
      PSB.setPdfProjectId(null);
      syncGlobalsToUI();
      PSB.renderOpBar(state.globals.ops, handleRemoveOp);
      PSB.renderTable(state, VIEW_CONFIGS[currentView]);
      PSB.closeSidebar();
      setFilename(null);
      updateCmmPartBadge(null);
      updateFaiTabBadge();
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

function setPdfFileName(name) {
  state.globals.pdfFileName = name || null;
  if (name) { markDirty(); scheduleAutoSave(); }
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
  if (isDirty) el.textContent += ' \u2022';
  saveSessionMeta();
}

/**
 * The one way a project file gets into the app (Load button, file input,
 * drag-drop). `fileHandle` is passed only by the Load button (the picked file);
 * it is attached only after the file parses. Otherwise disk auto-save is switched
 * off until the user picks Save, so a dropped file can never overwrite the
 * project that was open before it.
 */
function openProject(jsonString, fileName, fileHandle) {
  var loaded;
  try {
    loaded = PSB.loadProject(jsonString);
  } catch (err) {
    // Nothing changes — the open project and its file link stay as they were
    PSB.showToast('Failed to load project file: ' + err.message, 'error');
    return false;
  }
  dropFileLink();
  if (fileHandle) PSB.useProjectFileHandle(fileHandle);
  applyLoadedState(loaded);
  if (fileHandle) {
    // Remembered link is keyed by project id. Not ensureProjectId(): that
    // caches the PDF on screen, which still belongs to the previous project.
    if (!state.globals.projectId) state.globals.projectId = generateUUID();
    PSB.rememberProjectHandle(state.globals.projectId);
  }
  importedFileName = fileName;
  PSB.clearUndoRedo();
  recomputeAll();
  syncGlobalsToUI();
  PSB.renderOpBar(state.globals.ops, handleRemoveOp);
  PSB.closeSidebar();
  setFilename(fileName);
  updateCmmPartBadge(state.globals.cmmPartName);
  updateUndoRedoButtons();
  markClean();
  restoreProjectPdf(true);
  console.log('[PSB] Loaded project with ' + state.rows.length + ' rows');
  return true;
}

/**
 * Re-open the project's PDF. Order: browser cache → saved file handle →
 * (if allowed) ask the user to pick it once.
 */
function restoreProjectPdf(promptIfMissing) {
  PSB.setPdfProjectId(state.globals.projectId); // IDB cache is keyed by project
  var pdfName = state.globals.pdfFileName;
  if (!pdfName) {
    PSB.closePdf();
    return;
  }
  PSB.tryRestorePdf(pdfName).then(function(ok) {
    if (ok) return;
    if (!promptIfMissing) {
      PSB.showToast('PDF not found. Click "PDF" to re-select.', 'info');
      return;
    }
    PSB.showToast('Select ' + pdfName + ' (one-time — remembered after this)', 'info');
    return PSB.promptForPdf(pdfName).then(function(picked) {
      if (!picked) PSB.showToast('PDF not loaded. Click "PDF" to select ' + pdfName + '.', 'info');
    });
  });
}

/** Ask before throwing away unsaved work; runs `fn` straight away if nothing is unsaved. */
function confirmDiscardChanges(fn) {
  if (!isDirty || state.rows.length === 0) { fn(); return; }
  PSB.showConfirmModal({
    title: 'Discard Unsaved Changes?',
    message: 'This project has unsaved changes. Opening another file will lose them.',
    confirmLabel: 'Discard & Open',
    confirmClass: 'btn-danger',
    onConfirm: fn,
  });
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
    // After a refresh: reconnect to the same file first instead of "Save As"
    var ready = needsReconnect ? reconnectFile(true) : Promise.resolve();
    var savedAt;
    ready.then(function() {
      savedAt = editCount; // what this save writes
      return PSB.saveProject(state, { suggestedName: getSuggestedSaveName() });
    }).then(function(ok) {
      if (!ok) return;
      setNeedsReconnect(false);
      PSB.rememberProjectHandle(state.globals.projectId);
      var fname = PSB.getProjectFileName();
      if (fname) importedFileName = fname;
      diskSaveWarned = false;
      if (editCount === savedAt) markClean();
      if (fname) setFilename(fname);
      PSB.showToast('Project saved.', 'success');
    });
  });

  // Click the file name to reconnect auto-save after a refresh
  document.getElementById('filename-banner').addEventListener('click', function() {
    if (needsReconnect) reconnectFile(true);
  });

  // Load project button — uses File System Access API to get a handle
  // so subsequent saves overwrite the same file without prompting.
  document.getElementById('btn-load').addEventListener('click', function() {
    confirmDiscardChanges(function() {
      if (!window.showOpenFilePicker) {
        // Fallback for browsers without File System Access API
        document.getElementById('file-load-project').click();
        return;
      }
      PSB.openProjectWithHandle().then(function(result) {
        // null = user cancelled, do nothing
        if (result) openProject(result.jsonString, result.fileName, result.handle);
      });
    });
  });

  document.getElementById('file-load-project').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    var loadFileName = file.name;
    reader.onload = function(ev) {
      openProject(ev.target.result, loadFileName, false);
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
// FILE IMPORT HANDLER
// ═══════════════════════════════════════════════════════════
function handleFileImport(content, fileName) {
  if (fileName.toLowerCase().endsWith('.json')) {
    confirmDiscardChanges(function() { openProject(content, fileName, false); });
    return;
  }

  var doImport = function() {
    PSB.showLoading('Importing...');
    setTimeout(function() {
      var rawRows = PSB.parseCSV(content);
      if (rawRows.length === 0) {
        PSB.showToast('No valid data found in CSV.', 'error');
        PSB.hideLoading();
        return;
      }

      PSB.clearUndoRedo();
      PSB.resetIdCounter();
      // New data = new project: don't auto-save over the previously opened
      // file, and get a fresh id so it never shares links/caches with it.
      dropFileLink();
      state.globals.projectId = null;
      ensureProjectId();
      state.rows = rawRows.map(function(raw) { return PSB.createRow(raw); });
      state.auditLog = [];
      // CMM results belonged to the old rows — drop them so no orphan runs remain
      state.faiRuns = [];
      state.globals.cmmPartName = null;
      updateCmmPartBadge(null);
      // Guess print units from the values; user must confirm before export
      var unitGuess = PSB.detectPrintUnits(PSB.unitSamplesFromRows(state.rows));
      if (unitGuess.units) state.globals.importUnits = unitGuess.units;
      state.globals.printUnitsConfirmed = false;
      state.globals.unitsMismatchDismissed = null;
      syncGlobalsToUI();
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
      message: 'You have <strong>' + state.rows.length + '</strong> rows with edits. Importing will replace all data' +
        ((state.faiRuns && state.faiRuns.length) ? ', including <strong>' + state.faiRuns.length + '</strong> CMM run' + (state.faiRuns.length > 1 ? 's' : '') : '') + '.',
      confirmLabel: 'Replace',
      confirmClass: 'btn-danger',
      onConfirm: doImport
    });
  } else {
    doImport();
  }
}

// ═══════════════════════════════════════════════════════════
// AUTO-SAVE (debounced)
// ═══════════════════════════════════════════════════════════
var autoSaveTimer = null;
var diskSaveTimer = null;
var diskSaveWarned = false;
var sessionSaveWarned = false;

// Called by ui.js after an edit it makes directly (e.g. FAI notes)
PSB.onProjectEdited = function() {
  markDirty();
  scheduleAutoSave();
};

function scheduleAutoSave() {
  // Quick save to sessionStorage (1s debounce)
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(function() {
    // H: browser storage full → refresh would lose work, so say so once
    if (!PSB.autoSave(state) && !sessionSaveWarned) {
      sessionSaveWarned = true;
      PSB.showToast('Browser backup is full. Save the project to a file.', 'error');
    }
  }, 1000);

  // Persist to disk if file handle exists (3s debounce)
  if (diskSaveTimer) clearTimeout(diskSaveTimer);
  diskSaveTimer = setTimeout(function() {
    if (PSB.hasFileHandle()) {
      ensureProjectId(); // make sure projectId is set before writing to disk
      var savedAt = editCount;
      PSB.autoSaveToDisk(state).then(function(ok) {
        if (ok) {
          diskSaveWarned = false;
          if (editCount === savedAt) markClean();
        } else if (!diskSaveWarned) {
          // File moved, locked or permission lost — don't fail silently
          diskSaveWarned = true;
          PSB.showToast('Auto-save to file failed. Click Save to save your work.', 'error');
        }
      });
    }
  }, 3000);
}
