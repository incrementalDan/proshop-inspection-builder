/**
 * planSettings.js — Plan settings (moved out of app.js, no behavior change)
 *
 * - OP list (add / remove)
 * - Print units (detect, confirm, change), plating, precision
 * - Title-block defaults, settings modal
 * - ProShop CSV export modal
 */

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
var platingToastTimer = null;
