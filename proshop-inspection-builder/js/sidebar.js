/**
 * sidebar.js — Row sidebar (moved out of ui.js, no behavior change)
 *
 * - selectRow / closeSidebar: open and close for a row
 * - populateSidebar + its controls (spec, tol, ops, settings, status)
 * - GD&T panel, row history, sidebar resizer
 *
 * Shares ui.js globals (getAppState, onRowUserChange, selectedRowId, ...).
 */

/**
 * Select a row and open the sidebar.
 */
function selectRow(rowId) {
  selectedRowId = rowId;

  // Highlight row
  var allRows = document.querySelectorAll('#table-body tr');
  for (var i = 0; i < allRows.length; i++) {
    var tr = allRows[i];
    if (Number(tr.dataset.rowId) === rowId) {
      tr.classList.add('selected');
    } else {
      tr.classList.remove('selected');
    }
  }

  // Close setup panel so the dimension sidebar can take its place
  closeSetupPanel();

  // Show sidebar
  var sidebar = document.getElementById('sidebar');
  var resizer = document.getElementById('sidebar-resizer');
  sidebar.classList.remove('sidebar-closed');
  resizer.classList.remove('sidebar-closed');

  // Populate sidebar
  populateSidebar(rowId);
}

/**
 * Populate sidebar with selected row's data.
 */
function populateSidebar(rowId) {
  var state = getAppState();
  var row = state.rows.find(function(r) { return r.id === rowId; });
  if (!row) return;

  var c = row.computed;
  var u = row.user;

  // Wire up handlers FIRST — cloneNode wipes select values, so we must
  // clone before setting any values, then set values on the clones in DOM.
  wireUpSidebarHandlers(rowId);

  // Header — split label and number for styling
  document.getElementById('sidebar-dimtag').innerHTML =
    '<span class="dimtag-label">DIM TAG# </span><span class="dimtag-number">' + esc(c.dimTag || '—') + '</span>' + refBadgeHTML(row);
  document.getElementById('sidebar-output-tag').textContent = c.outputTag || '';

  // GD&T info panel — only for GD&T rows. Inserted/removed between the header
  // and the comparison grid; container persists in DOM so we just toggle content.
  renderSidebarGdtPanel(row);

  // OP2000 values (left column — smaller/faded, dual-unit format)
  document.getElementById('sidebar-op2000-spec').innerHTML = formatDualDisplay(c.op2000DualSpec) || '—';
  document.getElementById('sidebar-op2000-nominal').innerHTML = formatDualDisplay(c.op2000DualSpec) || '—';
  document.getElementById('sidebar-op2000-tol').innerHTML = formatDualDisplay(tolDisplay(c.op2000DualTol)) || '—';

  // Output values (right column — bold/bright, dual-unit format)
  document.getElementById('sidebar-out-spec').innerHTML = formatDualDisplay(c.outDrawingSpec) || '—';
  var outNomEl = document.getElementById('sidebar-out-nominal');
  outNomEl.innerHTML = (u.pinGageEnabled ? '🔒 ' : '') + (formatDualDisplay(c.outNominal) || '—');
  outNomEl.classList.toggle('sidebar-locked', !!u.pinGageEnabled);
  outNomEl.title = u.pinGageEnabled ? 'Locked — Pin/Gage is on, so Nom Dim exports the pin/gage value' : '';
  document.getElementById('sidebar-out-tol').innerHTML = formatDualDisplay(tolDisplay(c.outTolerance)) || '—';

  // Override indicators — show arrow icon when value was manually changed
  var oiSpec = document.getElementById('oi-spec');
  var oiTol = document.getElementById('oi-tol');
  var origSpec = document.getElementById('orig-spec');
  var origTol = document.getElementById('orig-tol');

  if (u.overrides.outDrawingSpec !== null) {
    oiSpec.classList.remove('hidden');
    origSpec.textContent = row.raw.drawingSpec || '';
  } else {
    oiSpec.classList.add('hidden');
    origSpec.classList.add('hidden');
    origSpec.textContent = '';
  }

  if (u.overrides.outTolPlus !== null || u.overrides.outTolMinus !== null) {
    oiTol.classList.remove('hidden');
    origTol.textContent = row.raw.tolerance || '';
  } else {
    oiTol.classList.add('hidden');
    origTol.classList.add('hidden');
    origTol.textContent = '';
  }

  // Wire override indicator click — toggle showing original value
  setupOverrideIndicator('oi-spec', 'orig-spec');
  setupOverrideIndicator('oi-tol', 'orig-tol');

  // Pin/Gage override indicator
  var oiPg = document.getElementById('oi-pingage');
  var origPg = document.getElementById('orig-pingage');
  if (u.overrides.pinGageValue !== null) {
    oiPg.classList.remove('hidden');
    origPg.textContent = c.pinGageAuto || '(auto-computed)';
  } else {
    oiPg.classList.add('hidden');
    origPg.classList.add('hidden');
    origPg.textContent = '';
  }
  setupOverrideIndicator('oi-pingage', 'orig-pingage');

  // Pin/Gage display (fixed area — always present, shows value only when enabled)
  var pgEl = document.getElementById('sidebar-pingage-value');
  if (pgEl) {
    if (u.pinGageEnabled && c.pinGage) {
      pgEl.textContent = addLeadingZero(c.pinGage);
      pgEl.classList.add('active');
    } else {
      pgEl.textContent = '—';
      pgEl.classList.remove('active');
    }
  }

  // OP toggles
  var opContainer = document.getElementById('sidebar-op-toggles');
  opContainer.innerHTML = '';
  for (var oi = 0; oi < state.globals.ops.length; oi++) {
    var op = state.globals.ops[oi];
    if (op === 2000) continue; // OP2000 is export-only, not shown in sidebar
    var color = getOpColor(op);
    var btn = document.createElement('button');
    btn.className = 'op-toggle' + (u.includeOps[op] ? ' active' : '');
    btn.style.setProperty('--op-c', color);
    btn.textContent = 'OP ' + op;
    (function(opNum, btnEl) {
      btnEl.addEventListener('click', function() {
        var newInclude = Object.assign({}, u.includeOps);
        newInclude[opNum] = !newInclude[opNum];
        // Immediately toggle visual state
        if (newInclude[opNum]) {
          btnEl.classList.add('active');
        } else {
          btnEl.classList.remove('active');
        }
        onRowUserChange(rowId, { includeOps: newInclude });
      });
    })(op, btn);
    opContainer.appendChild(btn);
  }

  // Checkboxes
  setChecked('sidebar-ipc', u.ipc);
  setChecked('sidebar-is-note', u.isNote);
  setChecked('sidebar-not-on-print', u.notOnPrint);
  setChecked('sidebar-auto-nominal', u.autoNominal);
  setChecked('sidebar-pin-gage-enabled', u.pinGageEnabled);

  // Plating — set AFTER wireUpSidebarHandlers so clone is already in DOM
  document.getElementById('sidebar-plating-mode').value = u.platingMode;

  // Inspection — populate options then set value
  populateEquipmentDropdown(state.globals.equipmentList, u.inspectionEquipment);
  document.getElementById('sidebar-frequency').value = u.inspectionFrequency || '';

  // Complete button — update active state
  var completeBtn = document.getElementById('sidebar-status-complete');
  if (u.status === 'complete') {
    completeBtn.classList.add('active');
  } else {
    completeBtn.classList.remove('active');
  }

  // Row history (bottom of sidebar)
  populateSidebarHistory(rowId);
}

/**
 * Wire sidebar controls to emit user changes.
 */
function wireUpSidebarHandlers(rowId) {
  // Helper to bind a change handler
  function bind(id, event, handler) {
    var el = document.getElementById(id);
    // Clone to remove old listeners
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    clone.addEventListener(event, handler);
  }

  bind('sidebar-ipc', 'change', function(e) {
    onRowUserChange(rowId, { ipc: e.target.checked });
  });

  bind('sidebar-is-note', 'change', function(e) {
    onRowUserChange(rowId, { isNote: e.target.checked });
  });

  bind('sidebar-not-on-print', 'change', function(e) {
    onRowUserChange(rowId, { notOnPrint: e.target.checked });
  });

  bind('sidebar-auto-nominal', 'change', function(e) {
    onRowUserChange(rowId, { autoNominal: e.target.checked });
  });

  bind('sidebar-pin-gage-enabled', 'change', function(e) {
    onRowUserChange(rowId, { pinGageEnabled: e.target.checked });
  });

  bind('sidebar-plating-mode', 'change', function(e) {
    onRowUserChange(rowId, { platingMode: e.target.value });
  });

  bind('sidebar-equipment', 'change', function(e) {
    onRowUserChange(rowId, { inspectionEquipment: e.target.value });
  });

  bind('sidebar-frequency', 'change', function(e) {
    onRowUserChange(rowId, { inspectionFrequency: e.target.value });
  });

  // Editable sidebar preview values — double-click to edit
  // OP2000 values: set base overrides, clear independent OUT overrides + toast
  setupSidebarValueEdit('sidebar-op2000-spec', 'outDrawingSpec', rowId, 'outputSpec');
  setupSidebarTolEdit('sidebar-op2000-tol', 'outTolPlus', 'outTolMinus', rowId, 'outputTolPlus', 'outputTolMinus');
  // OUT values: set independent overrides only, don't affect OP2000
  setupSidebarValueEdit('sidebar-out-spec', 'outputSpec', rowId);
  setupSidebarValueEdit('sidebar-out-nominal', 'outNominal', rowId);
  setupSidebarTolEdit('sidebar-out-tol', 'outputTolPlus', 'outputTolMinus', rowId);
  setupSidebarValueEdit('sidebar-pingage-value', 'pinGageValue', rowId);

  // Output Tag — double-click to edit (Rule 6: overrideable)
  var otEl = document.getElementById('sidebar-output-tag');
  var otClone = otEl.cloneNode(true);
  otEl.parentNode.replaceChild(otClone, otEl);
  otClone.addEventListener('dblclick', function() {
    if (otClone.querySelector('input')) return;
    var originalValue = otClone.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = originalValue;
    input.className = 'inline-edit-input';
    otClone.textContent = '';
    otClone.appendChild(input);
    input.focus();
    input.select();

    var committed = false;
    var commit = function() {
      if (committed) return;
      committed = true;
      var newValue = input.value.trim();
      // No-op if nothing actually changed
      if (newValue === originalValue.trim()) {
        otClone.textContent = originalValue;
        return;
      }
      otClone.textContent = newValue || originalValue;
      var state = getAppState();
      var row = state.rows.find(function(r) { return r.id === rowId; });
      if (!row) { otClone.textContent = originalValue; return; }
      var ov = Object.assign({}, row.user.overrides);
      ov.outputTag = newValue || null;
      onRowUserChange(rowId, { overrides: ov });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ke) {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') {
        committed = true;
        otClone.textContent = originalValue;
      }
    });
  });

  // Complete button — toggle complete status and auto-advance to next row
  var completeBtn = document.getElementById('sidebar-status-complete');
  var completeClone = completeBtn.cloneNode(true);
  completeBtn.parentNode.replaceChild(completeClone, completeBtn);
  completeClone.addEventListener('click', function() {
    var state = getAppState();
    var currentRow = state.rows.find(function(r) { return r.id === rowId; });
    var newStatus = (currentRow && currentRow.user.status === 'complete') ? 'none' : 'complete';
    onRowUserChange(rowId, { status: newStatus });
    // Auto-advance to next row
    if (newStatus === 'complete') {
      var idx = state.rows.findIndex(function(r) { return r.id === rowId; });
      if (idx >= 0 && idx < state.rows.length - 1) {
        selectRow(state.rows[idx + 1].id);
      }
    }
  });

  // Sidebar close
  var closeBtn = document.getElementById('sidebar-close');
  var closeClone = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(closeClone, closeBtn);
  closeClone.addEventListener('click', closeSidebar);
}

/**
 * Close the sidebar.
 */
function closeSidebar() {
  selectedRowId = null;
  document.getElementById('sidebar').classList.add('sidebar-closed');
  document.getElementById('sidebar-resizer').classList.add('sidebar-closed');
  var allRows = document.querySelectorAll('#table-body tr');
  for (var i = 0; i < allRows.length; i++) {
    allRows[i].classList.remove('selected');
  }
}

/**
 * Populate the equipment dropdown.
 */
function populateEquipmentDropdown(equipmentList, currentValue) {
  var select = document.getElementById('sidebar-equipment');
  select.innerHTML = '<option value="">— Select —</option>';
  for (var i = 0; i < equipmentList.length; i++) {
    var item = equipmentList[i];
    var opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    if (item === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
}

// ── Sidebar Resizer ───────────────────────────────────────

function setupSidebarResizer() {
  var resizer = document.getElementById('sidebar-resizer');
  var sidebar = document.getElementById('sidebar');
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
    sidebar.style.width = clamped + 'px';
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

// ── Sidebar Value Editing ──────────────────────────────

function setupSidebarValueEdit(elementId, overrideKey, rowId, clearKey) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  clone.classList.add('sidebar-editable');

  clone.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    if (clone.querySelector('input')) return;
    if (clone.classList.contains('sidebar-locked')) {
      if (PSB.showToast) PSB.showToast('Pin/Gage is on — Nom Dim exports the pin/gage value', 'info');
      return;
    }

    var originalHTML = clone.innerHTML;
    var originalValue = clone.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = originalValue;
    input.className = 'inline-edit-input';
    clone.textContent = '';
    clone.appendChild(input);
    input.focus();
    input.select();

    var committed = false;
    var commit = function() {
      if (committed) return;
      committed = true;
      var newValue = input.value.trim();
      // Strip "[secondary]" bracket notation (same as table inline edit)
      if (newValue && newValue.indexOf(' [') > 0) {
        newValue = newValue.split(' [')[0].trim();
      }
      // Strip leading ± for tolerance values
      if (newValue && newValue.charAt(0) === '\u00b1') {
        newValue = newValue.substring(1);
      }

      // Strip the same notation from originalValue for comparison
      var originalStripped = originalValue;
      if (originalStripped && originalStripped.indexOf(' [') > 0) {
        originalStripped = originalStripped.split(' [')[0].trim();
      }
      if (originalStripped && originalStripped.charAt(0) === '\u00b1') {
        originalStripped = originalStripped.substring(1);
      }

      // No-op if nothing actually changed — restore original HTML formatting
      if (newValue === originalStripped) {
        clone.innerHTML = originalHTML;
        return;
      }

      clone.textContent = newValue || originalValue;
      var state = getAppState();
      var row = state.rows.find(function(r) { return r.id === rowId; });
      if (!row) { clone.innerHTML = originalHTML; return; }
      var ov = Object.assign({}, row.user.overrides);
      ov[overrideKey] = newValue || null;
      // When editing OP2000 base, clear independent OUT override + toast
      if (clearKey && ov[clearKey] !== null) {
        ov[clearKey] = null;
        showToast('OP2000 changed — OUT override cleared', 'info');
      }
      onRowUserChange(rowId, { overrides: ov });
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ke) {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') {
        committed = true;
        clone.innerHTML = originalHTML;
      }
    });
  });
}

// Always-visible GD&T panel in the sidebar for GD&T rows.
function renderSidebarGdtPanel(row) {
  var panel = document.getElementById('sidebar-gdt-panel');
  if (!panel) return;
  if (!row.user.gdt) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  var gdt = row.user.gdt;
  panel.style.display = '';
  // The reference tooltip HTML is reused inline; it already includes the
  // category badge, controls/requires/common text, and the Learn-more link.
  panel.innerHTML =
    '<div class="sidebar-gdt-header">' +
      '<span class="gdt-symbol">' + esc(PSB.GDT_SYMBOLS[gdt.characteristic] || '') + '</span>' +
      '<span class="gdt-name">' + esc(gdt.characteristicName || '') + '</span>' +
    '</div>' +
    '<div class="sidebar-gdt-frame gdt-frame">' + esc(gdt.nominalFrame || '') + '</div>' +
    PSB.getGdtTooltipHtml(gdt.characteristic);
}

// ── Sidebar Tolerance Editing (dual +/- inputs) ──────

function setupSidebarTolEdit(elementId, plusKey, minusKey, rowId, clearPlusKey, clearMinusKey) {
  var el = document.getElementById(elementId);
  if (!el) return;
  var clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  clone.classList.add('sidebar-editable');

  clone.addEventListener('dblclick', function(e) {
    e.stopPropagation();
    if (clone.querySelector('input')) return;

    var originalHTML = clone.innerHTML;
    var state = getAppState();
    var row = state.rows.find(function(r) { return r.id === rowId; });
    if (!row) return;

    var c = row.computed;
    var globals = state.globals || {};
    var importUnits = PSB.getPrintUnits(globals);
    var prec = importUnits === 'inch' ? (globals.inchPrecision || 4) : (globals.mmPrecision || 3);

    var isOp2k = plusKey === 'outTolPlus';
    var plusVal = isOp2k ? c.op2kTolPlus : c.outTolPlus;
    var minusVal = isOp2k ? c.op2kTolMinus : c.outTolMinus;
    var curMode = (row.user.overrides && row.user.overrides.tolMode) || 'sym';

    // Min/max bounds are derived from the print-spec nominal (OP2000) — plating/conversion
    // are applied downstream, not at the override layer.
    var nominalForBounds = parseFloat(c.op2000Nominal);
    if (isNaN(nominalForBounds)) nominalForBounds = parseFloat(c.nominal);

    clone.innerHTML = '<div class="tol-edit-container"></div>';
    var mount = clone.querySelector('.tol-edit-container');
    mount.style.flexDirection = 'column';
    mount.style.alignItems = 'stretch';

    var ctrl = PSB.renderTolModeInputs(mount, {
      mode: curMode, plus: plusVal, minus: minusVal,
      nominal: isNaN(nominalForBounds) ? null : nominalForBounds,
      precision: prec,
    });
    ctrl.focus();

    var committed = false;
    function revert() { committed = true; clone.innerHTML = originalHTML; }
    function commit() {
      if (committed) return;
      var r = ctrl.commit();
      if (!r.ok) return; // error shown inline; keep editor open
      committed = true;

      var pNum = r.tolPlus;
      var mNum = r.tolMinus;
      var newMode = r.tolMode;

      var freshState = getAppState();
      var freshRow = freshState.rows.find(function(rr) { return rr.id === rowId; });
      if (!freshRow) { clone.innerHTML = originalHTML; return; }

      var prevMode = (freshRow.user.overrides && freshRow.user.overrides.tolMode) || 'sym';
      var nothingChanged =
        Math.abs(pNum - plusVal) < 1e-10 &&
        Math.abs(mNum - minusVal) < 1e-10 &&
        newMode === prevMode;
      if (nothingChanged) { clone.innerHTML = originalHTML; return; }

      var ov = Object.assign({}, freshRow.user.overrides);
      ov[plusKey] = String(pNum);
      ov[minusKey] = String(mNum);
      ov.tolMode = newMode;

      if (clearPlusKey && (ov[clearPlusKey] !== null || ov[clearMinusKey] !== null)) {
        ov[clearPlusKey] = null;
        ov[clearMinusKey] = null;
        showToast('OP2000 Tol changed — OUT Tol override cleared', 'info');
      }
      onRowUserChange(rowId, { overrides: ov });
    }

    // Blur-commit, but only when focus leaves the entire control (not when
    // switching between mode chip and input).
    function onBlur() {
      setTimeout(function() {
        if (!clone.contains(document.activeElement)) commit();
      }, 0);
    }
    var inputs = ctrl.getInputs();
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('blur', onBlur);
      inputs[i].addEventListener('keydown', function(ke) {
        if (ke.key === 'Enter')  { ke.preventDefault(); commit(); }
        if (ke.key === 'Escape') { ke.preventDefault(); revert(); }
      });
    }

    // When the mode chip is clicked, fields re-render — re-bind blur/keydown to the new inputs.
    var chips = clone.querySelectorAll('.tol-mode-chip');
    for (var ci = 0; ci < chips.length; ci++) {
      chips[ci].addEventListener('click', function() {
        setTimeout(function() {
          var fresh = ctrl.getInputs();
          for (var k = 0; k < fresh.length; k++) {
            fresh[k].addEventListener('blur', onBlur);
            fresh[k].addEventListener('keydown', function(ke) {
              if (ke.key === 'Enter')  { ke.preventDefault(); commit(); }
              if (ke.key === 'Escape') { ke.preventDefault(); revert(); }
            });
          }
        }, 0);
      });
    }
  });
}

// ── Override Indicator ─────────────────────────────────────

function setupOverrideIndicator(btnId, origId) {
  var btn = document.getElementById(btnId);
  var orig = document.getElementById(origId);
  // Clone to remove old listeners
  var clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);
  clone.addEventListener('click', function(e) {
    e.stopPropagation();
    orig.classList.toggle('hidden');
  });
}

function setChecked(id, value) {
  document.getElementById(id).checked = !!value;
}

// ── Sidebar Row History ──────────────────────────────────

function populateSidebarHistory(rowId) {
  var listEl = document.getElementById('sidebar-history-list');
  if (!listEl) return;
  var state = getAppState();
  var entries = PSB.getRowHistory(state.auditLog || [], rowId);

  if (entries.length === 0) {
    listEl.innerHTML = '<span class="text-muted">No changes yet</span>';
  } else {
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      html += '<div class="history-entry">' +
        '<span class="history-time">' + PSB.formatHistoryTime(e.timestamp) + '</span>' +
        '<span class="history-desc">' + esc(e.description) + '</span>' +
        '</div>';
    }
    listEl.innerHTML = html;
  }

  // Wire "View All" — shows only this row's history
  var viewAllBtn = document.getElementById('btn-row-history');
  if (viewAllBtn) {
    var clone = viewAllBtn.cloneNode(true);
    viewAllBtn.parentNode.replaceChild(clone, viewAllBtn);
    clone.addEventListener('click', function() { openHistoryModal(rowId); });
  }
}
PSB.closeSidebar = closeSidebar;
PSB.populateSidebar = populateSidebar;
