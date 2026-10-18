/**
 * inspect.js — Inspect step (moved out of app.js, no behavior change)
 *
 * - CMM import: parse, match to dim tags, unmatched rows, re-tag
 * - CMM runs list (delete runs)
 * - OP2000 / Compensated compare switch
 * - FAI export modal (RULES.md §12)
 */

function setFaiCompareMode(mode) {
  VIEW_CONFIGS.fai.compareMode = mode;
  var op2kBtn = document.getElementById('btn-fai-compare-op2000');
  var compBtn = document.getElementById('btn-fai-compare-comp');
  if (op2kBtn) op2kBtn.classList.toggle('active', mode === 'op2000');
  if (compBtn) compBtn.classList.toggle('active', mode === 'compensated');
  if (currentView === 'fai') PSB.renderTable(state, VIEW_CONFIGS.fai);
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
      PSB.refreshFaiStatus(row, state.globals.faiWarnThreshold);
    }
  }

  state.faiRuns = (state.faiRuns || []).filter(function(r) { return !idSet[r.id]; });
  scheduleAutoSave();
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

/** Find the plan row whose dim tag matches (string compare). */
function findRowByDimTag(dimTag) {
  for (var ri = 0; ri < state.rows.length; ri++) {
    var r = state.rows[ri];
    var tag = r.computed.dimTag || r.raw['Dim Tag #'];
    if (String(tag) === String(dimTag)) return r;
  }
  return null;
}

/**
 * Turn one parsed CMM row into a stored measurement for a plan row:
 * converts units (never angles), makes measured/nominal positive, caps to 5 places.
 */
function buildCmmMeasurement(cmmRow, planRow, runId, cmmUnits, planUnits) {
  // Angles are never converted between units — degrees are degrees regardless of unit system.
  // An angle CMM row is one where the CMM name contains "angle" or "°",
  // or the matched plan row is flagged as an angle dimension.
  var ANGLE_RE_CMM = /angle|°/i;
  var isCmmAngle = ANGLE_RE_CMM.test(cmmRow.cmmName) || (planRow.computed && planRow.computed.isAngle);
  var doConvert = cmmUnits !== planUnits && !isCmmAngle;
  // Angles round to the Angle Decimals setting; everything else caps at 5 places
  var ad = state.globals.angleDecimals != null ? state.globals.angleDecimals : 3;
  var places = isCmmAngle ? Math.min(5, ad) : 5;

  // Convert CMM values to plan units if needed
  var measured  = doConvert ? PSB.convertUnits(cmmRow.measured,  cmmUnits, planUnits) : cmmRow.measured;
  var nominal   = doConvert ? PSB.convertUnits(cmmRow.nominal,   cmmUnits, planUnits) : cmmRow.nominal;
  var deviation = doConvert ? PSB.convertUnits(cmmRow.deviation, cmmUnits, planUnits) : cmmRow.deviation;
  var plusTol   = doConvert ? PSB.convertUnits(cmmRow.plusTol,   cmmUnits, planUnits) : cmmRow.plusTol;
  var minusTol  = doConvert ? PSB.convertUnits(cmmRow.minusTol,  cmmUnits, planUnits) : cmmRow.minusTol;

  // Measured and nominal are always positive; tolerance is never touched
  measured = Math.abs(measured);
  nominal  = Math.abs(nominal);

  return {
    runId: runId,
    cmmName: cmmRow.cmmName,
    // Cap stored values (5 places, or angle decimals for angles)
    measured:  parseFloat(measured.toFixed(places)),
    nominal:   parseFloat(nominal.toFixed(places)),
    deviation: parseFloat(deviation.toFixed(places)),
    plusTol:   parseFloat(plusTol.toFixed(places)),
    minusTol:  parseFloat(minusTol.toFixed(places)),
    units: planUnits,             // units these values are in (kept = print units)
    status: null,
    equipment: '',
    notes: '',
    attachments: [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Move one CMM measurement to a different dim tag (fixes a wrong tag typed on the CMM).
 * Keeps the CMM name as-is; remembers the original tag on the measurement.
 */
function handleFaiRetag(fromRowId, measurementIndex, newTag) {
  newTag = String(newTag).replace(/^#/, '').trim();
  var fromRow = null;
  for (var i = 0; i < state.rows.length; i++) {
    if (String(state.rows[i].id) === String(fromRowId)) { fromRow = state.rows[i]; break; }
  }
  if (!fromRow || !fromRow.fai || !fromRow.fai.measurements[measurementIndex]) return;
  if (String(fromRow.computed.dimTag) === newTag) return;

  var toRow = findRowByDimTag(newTag);
  if (!toRow) {
    PSB.showToast('No dim tag ' + newTag + ' in this plan', 'warn');
    return;
  }

  PSB.pushUndo(state, 'Re-tag CMM ' + fromRow.computed.dimTag + ' → ' + newTag);
  var m = fromRow.fai.measurements.splice(measurementIndex, 1)[0];
  if (m.originalTag == null) m.originalTag = PSB.cmmDimTagFromName(m.cmmName);
  if (String(m.originalTag) === newTag) delete m.originalTag;

  if (fromRow.fai.measurements.length === 0) fromRow.fai = null;
  else PSB.refreshFaiStatus(fromRow, state.globals.faiWarnThreshold);

  if (!toRow.fai) toRow.fai = { measurements: [], aggregateStatus: null, isExpanded: false };
  toRow.fai.measurements.push(m);
  PSB.refreshFaiStatus(toRow, state.globals.faiWarnThreshold);

  PSB.logChange(state.auditLog, { type: 'edit', rowId: toRow.id, description: 'CMM "' + m.cmmName + '" re-tagged ' + fromRow.computed.dimTag + ' → ' + newTag });
  afterFaiChange();
  PSB.showToast('Moved to dim tag ' + newTag, 'info');
}

/**
 * Assign an unmatched CMM row (no "#" or unknown tag) to a dim tag.
 * @returns {boolean} true if assigned
 */
function assignUnmatchedCmmRow(runId, unmatchedIndex, newTag) {
  newTag = String(newTag).replace(/^#/, '').trim();
  var run = findFaiRun(runId);
  if (!run || !run.unmatchedRows || !run.unmatchedRows[unmatchedIndex]) return false;
  var toRow = findRowByDimTag(newTag);
  if (!toRow) {
    PSB.showToast('No dim tag ' + newTag + ' in this plan', 'warn');
    return false;
  }

  PSB.pushUndo(state, 'Assign CMM row to ' + newTag);
  var cmmRow = run.unmatchedRows.splice(unmatchedIndex, 1)[0];
  var m = buildCmmMeasurement(cmmRow, toRow, run.id, run.units || 'mm', PSB.getPrintUnits(state.globals));
  m.originalTag = cmmRow.dimTag;
  if (m.originalTag != null && String(m.originalTag) === newTag) delete m.originalTag;
  if (!toRow.fai) toRow.fai = { measurements: [], aggregateStatus: null, isExpanded: false };
  toRow.fai.measurements.push(m);
  PSB.refreshFaiStatus(toRow, state.globals.faiWarnThreshold);
  run.matchedCount = (run.matchedCount || 0) + 1;

  PSB.logChange(state.auditLog, { type: 'edit', rowId: toRow.id, description: 'CMM "' + cmmRow.cmmName + '" assigned to ' + newTag });
  afterFaiChange();
  return true;
}

function afterFaiChange() {
  scheduleAutoSave();
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  updateFaiTabBadge();
  updateUndoRedoButtons();
  markDirty();
}

function handleCmmImport(rawText, fileName, cmmUnits, clearFirst) {
  var parsed = PSB.parseCmmText(rawText);
  if (!parsed || parsed.length === 0) {
    PSB.showToast('No CMM data found in input', 'warn');
    return;
  }

  // Undo point BEFORE anything changes (part name, clearing old runs),
  // so one undo puts it all back.
  PSB.pushUndo(state, 'Import CMM run: ' + fileName);

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

  var planUnits = PSB.getPrintUnits(state.globals);

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
    var planRow = findRowByDimTag(dimTag);

    if (!planRow) {
      for (var gi = 0; gi < group.length; gi++) unmatchedRows.push(group[gi]);
      continue;
    }

    matchedCount += group.length;
    if (!planRow.fai) planRow.fai = { measurements: [], aggregateStatus: null, isExpanded: false };

    for (var gi = 0; gi < group.length; gi++) {
      planRow.fai.measurements.push(buildCmmMeasurement(group[gi], planRow, runId, cmmUnits, planUnits));
    }
    PSB.refreshFaiStatus(planRow, warnThreshold);
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
  scheduleAutoSave();
  PSB.renderTable(state, VIEW_CONFIGS[currentView]);
  updateCmmPartBadge(state.globals.cmmPartName);
  updateFaiTabBadge();

  // Show import summary
  showCmmImportSummary(runId, parsed.length, matchedCount, unmatchedRows);
  updateUndoRedoButtons();
  markDirty();
}

function showCmmImportSummary(runId, totalParsed, matchedCount, unmatchedRows) {
  var modal = document.getElementById('modal-cmm-summary');
  if (!modal) return;
  document.getElementById('cmm-summary-total').textContent = totalParsed;
  document.getElementById('cmm-summary-matched').textContent = matchedCount;
  document.getElementById('cmm-summary-unmatched').textContent = unmatchedRows.length;
  renderCmmUnmatchedList(runId);
  PSB.openModal('modal-cmm-summary');
}

function findFaiRun(runId) {
  for (var i = 0; i < (state.faiRuns || []).length; i++) {
    if (state.faiRuns[i].id === runId) return state.faiRuns[i];
  }
  return null;
}

/**
 * HTML list of a run's unmatched CMM rows, each with a dim tag box.
 * Pair with bindCmmAssignInputs() after inserting it.
 */
function buildCmmUnmatchedHtml(run) {
  var rows = (run && run.unmatchedRows) || [];
  var items = '';
  for (var u = 0; u < rows.length; u++) {
    var row = rows[u];
    items += '<li class="cmm-unmatched-item">' +
      '<input type="text" class="cmm-assign-tag" data-run-id="' + PSB.esc(run.id) + '" data-index="' + u + '" placeholder="#" title="Type a dim tag and press Enter" size="4"' +
        (row.dimTag != null ? ' value="' + PSB.esc(String(row.dimTag)) + '"' : '') + '> ' +
      PSB.esc(row.cmmName || '(no name)') + ' — ' + (row.measured != null ? row.measured : '?') + '</li>';
  }
  return '<ul class="cmm-unmatched-ul">' + items + '</ul>';
}

/** Enter in a tag box assigns that unmatched row, then calls onAssigned(). */
function bindCmmAssignInputs(container, onAssigned) {
  var inputs = container.querySelectorAll('input.cmm-assign-tag');
  for (var k = 0; k < inputs.length; k++) {
    inputs[k].addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var tag = e.target.value.trim();
      if (!tag) return;
      var runId = e.target.getAttribute('data-run-id');
      if (assignUnmatchedCmmRow(runId, parseInt(e.target.getAttribute('data-index'), 10), tag)) {
        onAssigned();
      }
    });
  }
}

/**
 * Import summary: unmatched CMM rows with tag boxes.
 * Re-renders after each assign (indexes shift as rows leave the list).
 */
function renderCmmUnmatchedList(runId) {
  var listEl = document.getElementById('cmm-summary-unmatched-list');
  var run = findFaiRun(runId);
  var rows = (run && run.unmatchedRows) || [];
  document.getElementById('cmm-summary-matched').textContent = run ? run.matchedCount : 0;
  document.getElementById('cmm-summary-unmatched').textContent = rows.length;
  if (rows.length === 0) { listEl.innerHTML = ''; return; }

  listEl.innerHTML = '<p><strong>Unmatched rows</strong> — type the dim tag and press Enter to assign:</p>' +
    buildCmmUnmatchedHtml(run);
  bindCmmAssignInputs(listEl, function() { renderCmmUnmatchedList(runId); });
}

function bindFaiControls() {
  // FAI compare mode toggle
  var cmpOp2kBtn = document.getElementById('btn-fai-compare-op2000');
  var cmpCompBtn = document.getElementById('btn-fai-compare-comp');
  if (cmpOp2kBtn) cmpOp2kBtn.addEventListener('click', function() { setFaiCompareMode('op2000'); });
  if (cmpCompBtn) cmpCompBtn.addEventListener('click', function() { setFaiCompareMode('compensated'); });

  bindFaiExportModal();

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

// ═══════════════════════════════════════════════════════════
// FAI EXPORT — options live in globals.faiExport (saved with the project)
// ═══════════════════════════════════════════════════════════

var faiExportSettings = null;

function bindFaiExportModal() {
  var modal = document.getElementById('modal-fai-export');
  if (!modal) return;

  document.getElementById('btn-export-fai').addEventListener('click', openFaiExportModal);
  document.getElementById('btn-fai-export-close').addEventListener('click', function() { PSB.closeModal('modal-fai-export'); });
  document.getElementById('btn-fai-export-cancel').addEventListener('click', function() { PSB.closeModal('modal-fai-export'); });
  document.getElementById('btn-fai-export-download').addEventListener('click', downloadFaiExport);

  // Any option change → save + refresh preview
  modal.addEventListener('change', onFaiExportInput);
  modal.addEventListener('input', function(e) {
    if (e.target.type === 'text' || e.target.type === 'number') onFaiExportInput(e);
  });

  // Run list: tick boxes and rank arrows
  document.getElementById('fai-exp-runs').addEventListener('click', function(e) {
    var btn = e.target.closest('button[data-move]');
    if (!btn) return;
    var i = parseInt(btn.getAttribute('data-index'), 10);
    var j = i + parseInt(btn.getAttribute('data-move'), 10);
    var runs = faiExportSettings.runs;
    if (j < 0 || j >= runs.length) return;
    var tmp = runs[i]; runs[i] = runs[j]; runs[j] = tmp;
    saveFaiExportSettings();
    renderFaiExportRuns();
    renderFaiExportPreview();
  });
}

function openFaiExportModal() {
  if (!state.faiRuns || state.faiRuns.length === 0) {
    PSB.showToast('Import CMM data first.', 'warn');
    return;
  }
  faiExportSettings = PSB.getFaiExportSettings(state.globals, state.faiRuns);
  fillFaiExportForm();
  PSB.openModal('modal-fai-export');
}

function fillFaiExportForm() {
  var s = faiExportSettings;
  var modal = document.getElementById('modal-fai-export');
  var fields = modal.querySelectorAll('[data-key]');
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i].getAttribute('data-key');
    if (fields[i].type === 'checkbox') fields[i].checked = !!s[key];
    else fields[i].value = s[key] == null ? '' : s[key];
  }
  setRadio('fai-exp-runmode', s.runMode);
  setRadio('fai-exp-filemode', s.fileMode);
  renderFaiExportRuns();
  renderFaiExportPreview();
}

function setRadio(name, value) {
  var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
  if (el) el.checked = true;
}

function onFaiExportInput(e) {
  var s = faiExportSettings;
  if (!s) return;
  var t = e.target;
  var key = t.getAttribute('data-key');
  if (key) {
    if (t.type === 'checkbox') s[key] = t.checked;
    else if (t.type === 'number') s[key] = parseInt(t.value, 10);
    else s[key] = t.value;
  } else if (t.name === 'fai-exp-runmode') {
    s.runMode = t.value;
    renderFaiExportRuns();
  } else if (t.name === 'fai-exp-filemode') {
    s.fileMode = t.value;
  } else if (t.hasAttribute('data-run-id')) {
    var id = t.getAttribute('data-run-id');
    for (var i = 0; i < s.runs.length; i++) {
      if (s.runs[i].id === id) s.runs[i].on = t.checked;
    }
    renderFaiExportRuns();
  } else {
    return;
  }
  saveFaiExportSettings();
  renderFaiExportPreview();
}

function saveFaiExportSettings() {
  state.globals.faiExport = JSON.parse(JSON.stringify(faiExportSettings));
  markDirty();
  scheduleAutoSave();
}

function renderFaiExportRuns() {
  var s = faiExportSettings;
  var list = document.getElementById('fai-exp-runs');
  var mode = s.runMode;
  var html = '';
  var rank = 0;
  for (var i = 0; i < s.runs.length; i++) {
    var r = s.runs[i];
    var run = findFaiRun(r.id);
    if (!run) continue;
    var on = mode === 'all' ? true : r.on;
    if (on) rank++;
    var meta = run.matchedCount + ' dims' + (run.units ? ' · ' + run.units : '') +
      (run.importedAt ? ' · ' + run.importedAt.slice(0, 10) : '');
    html += '<div class="cmm-run-row">' +
      '<input type="checkbox" data-run-id="' + PSB.esc(r.id) + '"' + (on ? ' checked' : '') + (mode === 'all' ? ' disabled' : '') + '>' +
      (mode === 'combine' ? '<span class="fai-exp-rank">' + (on ? rank : '') + '</span>' : '') +
      '<span class="cmm-run-label">' + PSB.esc(run.label || run.fileName) + '</span>' +
      '<span class="cmm-run-meta">' + PSB.esc(meta) + '</span>' +
      (mode === 'combine'
        ? '<button class="btn btn-small fai-exp-move" data-move="-1" data-index="' + i + '" title="Rank higher">▲</button>' +
          '<button class="btn btn-small fai-exp-move" data-move="1" data-index="' + i + '" title="Rank lower">▼</button>'
        : '') +
      '</div>';
  }
  list.innerHTML = html;
  document.getElementById('fai-exp-filemode-row').classList.toggle('hidden', mode === 'combine');
}

function renderFaiExportPreview() {
  var s = faiExportSettings;
  document.getElementById('fai-exp-fixed').classList.toggle('hidden', s.precision !== 'fixed');
  document.getElementById('fai-exp-equipment').disabled = !s.includeEquipment;

  var gate = document.getElementById('fai-exp-gate');
  var btn = document.getElementById('btn-fai-export-download');
  var confirmed = !!state.globals.printUnitsConfirmed;
  gate.classList.toggle('hidden', confirmed);

  var auto = PSB.faiAutoPartName(state);
  document.getElementById('fai-exp-part').placeholder = auto ? auto + ' (from CMM report)' : 'Type the part #';

  var res = PSB.buildFaiExport(state, s);
  document.getElementById('fai-exp-filenames').textContent = res.files.map(function(f) { return f.fileName; }).join(', ');
  var summary = res.files.map(function(f) {
    return PSB.esc(f.fileName) + ' — ' + f.records.length + ' rows';
  }).join('<br>');
  res.warnings.forEach(function(w) { summary += '<br><span class="fai-exp-warn">' + PSB.esc(w) + '</span>'; });
  document.getElementById('fai-exp-summary').innerHTML = summary;

  var f = res.files[0];
  var preview = '';
  if (f) {
    var MAX = 25;
    preview = '<table><thead><tr>' + f.headers.map(function(h) { return '<th>' + PSB.esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
    f.records.slice(0, MAX).forEach(function(rec) {
      preview += '<tr>' + f.headers.map(function(h) { return '<td>' + PSB.esc(rec[h] == null ? '' : String(rec[h])) + '</td>'; }).join('') + '</tr>';
    });
    preview += '</tbody></table>';
    if (f.records.length > MAX) preview += '<div class="hint">…' + (f.records.length - MAX) + ' more rows</div>';
  }
  document.getElementById('fai-exp-preview').innerHTML = preview;

  // Options changed → start the save list over
  faiPendingFiles = null;
  var count = res.files.length;
  btn.disabled = !confirmed || count === 0;
  updateFaiDownloadButton(count);
}

// Files still to save. Browsers only open a save dialog right after a click,
// so with many files each click saves the next one.
var faiPendingFiles = null;

function updateFaiDownloadButton(fileCount) {
  var btn = document.getElementById('btn-fai-export-download');
  if (faiPendingFiles) {
    var total = faiPendingFiles.total;
    btn.textContent = 'Save file ' + (total - faiPendingFiles.files.length + 1) + ' of ' + total;
  } else {
    btn.textContent = fileCount > 1 ? 'Download ' + fileCount + ' CSVs' : 'Download CSV';
  }
}

function downloadFaiExport() {
  if (!state.globals.printUnitsConfirmed) return;
  if (!faiPendingFiles) {
    var res = PSB.buildFaiExport(state, faiExportSettings);
    if (res.files.length === 0) return;
    faiPendingFiles = { files: res.files.slice(), total: res.files.length };
  }
  var f = faiPendingFiles.files[0];
  PSB.downloadCSV(f.csv, f.fileName, PSB.getProjectFileHandle()).then(function(saved) {
    if (!saved) return; // cancelled — same file stays next
    faiPendingFiles.files.shift();
    if (faiPendingFiles.files.length > 0) {
      updateFaiDownloadButton();
      PSB.showToast('Saved ' + f.fileName + '. Click to save the next file.', 'info');
      return;
    }
    var total = faiPendingFiles.total;
    faiPendingFiles = null;
    PSB.showToast('FAI exported (' + total + ' file' + (total > 1 ? 's' : '') + ').', 'success');
    PSB.closeModal('modal-fai-export');
  }).catch(function() {
    PSB.showToast('FAI export failed.', 'error');
  });
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
    var unmatchedCount = (run.unmatchedRows || []).length;
    if (unmatchedCount > 0) {
      html += '<details class="cmm-run-unmatched">' +
        '<summary>' + unmatchedCount + ' unmatched — assign a dim tag</summary>' +
        buildCmmUnmatchedHtml(run) +
        '</details>';
    }
  }
  list.innerHTML = html;
  bindCmmAssignInputs(list, function() {
    // Keep the run that was just edited open after re-render
    var open = {};
    var det = list.querySelectorAll('details.cmm-run-unmatched[open] input.cmm-assign-tag');
    for (var d = 0; d < det.length; d++) open[det[d].getAttribute('data-run-id')] = true;
    refreshCmmRunsList();
    var inputs = list.querySelectorAll('input.cmm-assign-tag');
    for (var j = 0; j < inputs.length; j++) {
      if (open[inputs[j].getAttribute('data-run-id')]) inputs[j].closest('details').open = true;
    }
  });
  updateDeleteSelectedBtn();
}

function updateDeleteSelectedBtn() {
  var btn = document.getElementById('btn-cmm-delete-selected');
  if (!btn) return;
  var checked = document.querySelectorAll('#cmm-runs-list input[type=checkbox]:checked').length;
  btn.disabled = checked === 0;
  btn.textContent = checked > 0 ? 'Delete Selected (' + checked + ')' : 'Delete Selected';
}
