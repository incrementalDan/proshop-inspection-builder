/**
 * inlineEdit.js — Editing table cells in place (moved out of ui.js, no behavior change)
 *
 * - Double-click a cell → single input, or dual +/- inputs for tolerances
 * - Tab / Shift+Tab moves to the next editable cell (resolveNavigateTarget)
 *
 * Shares ui.js globals (onRowUserChange, flashCellKey, navigateTarget, ...).
 */

// ── Inline Editing ────────────────────────────────────

function setupInlineEditing(tr, row) {
  var editableCells = tr.querySelectorAll('td.editable');
  for (var i = 0; i < editableCells.length; i++) {
    (function(td) {
      var isTolCell = td.classList.contains('col-inputtol') || td.classList.contains('col-outtol');

      td.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        if (td.querySelector('input')) return;

        var originalHTML = td.innerHTML;

        if (isTolCell) {
          setupDualTolEdit(td, row, originalHTML);
        } else {
          setupSingleEdit(td, row, originalHTML);
        }
      });
    })(editableCells[i]);
  }
}

function setupDualTolEdit(td, row, originalHTML) {
  var c = row.computed;
  var isInput = td.classList.contains('col-inputtol');
  var plusVal = isInput ? c.op2kTolPlus : c.outTolPlus;
  var minusVal = isInput ? c.op2kTolMinus : c.outTolMinus;

  var state = getAppState();
  var globals = state ? state.globals : {};
  var importUnits = PSB.getPrintUnits(globals);
  var prec = importUnits === 'inch' ? (globals.inchPrecision || 4) : (globals.mmPrecision || 3);

  var plusStr = PSB.formatPrecision(plusVal, prec);
  var minusStr = PSB.formatPrecision(minusVal, prec);

  td.innerHTML = '<div class="tol-edit-container">' +
    '<div class="tol-input-wrap"><span class="tol-sign-label">+</span><input class="tol-input tol-plus" value="' + esc(plusStr) + '"></div>' +
    '<div class="tol-input-wrap"><span class="tol-sign-label">−</span><input class="tol-input tol-minus" value="' + esc(minusStr) + '"></div>' +
    '</div>';

  var plusInput = td.querySelector('.tol-plus');
  var minusInput = td.querySelector('.tol-minus');
  plusInput.focus();
  plusInput.select();

  var committed = false;
  var commit = function() {
    if (committed) return;
    committed = true;

    var pv = plusInput.value.trim();
    var mv = minusInput.value.trim();
    if (pv.charAt(0) === '+') pv = pv.substring(1);
    if (mv.charAt(0) === '-' || mv.charAt(0) === '−') mv = mv.substring(1);

    var pNum = parseFloat(pv);
    var mNum = parseFloat(mv);

    if (isNaN(pNum) && isNaN(mNum)) {
      td.innerHTML = originalHTML;
      return;
    }

    if (isNaN(pNum)) pNum = mNum;
    if (isNaN(mNum)) mNum = pNum;

    var origPlus = td.classList.contains('col-inputtol') ? row.computed.op2kTolPlus : row.computed.outTolPlus;
    var origMinus = td.classList.contains('col-inputtol') ? row.computed.op2kTolMinus : row.computed.outTolMinus;
    if (Math.abs(pNum - origPlus) < 1e-10 && Math.abs(mNum - origMinus) < 1e-10) {
      td.innerHTML = originalHTML;
      return;
    }

    var colClass = '';
    var classes = td.className.split(' ');
    for (var ci = 0; ci < classes.length; ci++) {
      if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
    }
    if (colClass) flashCellKey = row.id + '|' + colClass;

    var ov = Object.assign({}, row.user.overrides);
    if (td.classList.contains('col-inputtol')) {
      if (ov.outputTolPlus !== null || ov.outputTolMinus !== null) {
        ov.outputTolPlus = null;
        ov.outputTolMinus = null;
        showToast('OP2000 Tol changed — OUT Tol override cleared', 'info');
      }
      ov.outTolPlus = String(pNum);
      ov.outTolMinus = String(mNum);
    } else {
      ov.outputTolPlus = String(pNum);
      ov.outputTolMinus = String(mNum);
    }
    onRowUserChange(row.id, { overrides: ov });
  };

  var blurTimeout;
  var onBlur = function() {
    blurTimeout = setTimeout(function() {
      if (!td.contains(document.activeElement) || !td.querySelector('.tol-input')) {
        commit();
      }
    }, 0);
  };

  plusInput.addEventListener('blur', onBlur);
  minusInput.addEventListener('blur', onBlur);

  var handleKey = function(ke, isPlus) {
    if (ke.key === 'Enter') {
      ke.target.blur();
      setTimeout(commit, 0);
    }
    if (ke.key === 'Escape') {
      committed = true;
      td.innerHTML = originalHTML;
    }
    if (ke.key === 'Tab') {
      if (isPlus && !ke.shiftKey) {
        ke.preventDefault();
        minusInput.focus();
        minusInput.select();
      } else if (!isPlus && ke.shiftKey) {
        ke.preventDefault();
        plusInput.focus();
        plusInput.select();
      } else {
        ke.preventDefault();
        var colClass = '';
        var classes = td.className.split(' ');
        for (var ci = 0; ci < classes.length; ci++) {
          if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
        }
        navigateTarget = { rowId: row.id, colClass: colClass, reverse: ke.shiftKey };
        commit();
      }
    }
  };

  plusInput.addEventListener('keydown', function(ke) { handleKey(ke, true); });
  minusInput.addEventListener('keydown', function(ke) { handleKey(ke, false); });
}

function setupSingleEdit(td, row, originalHTML) {
  var originalValue = td.textContent;
  var input = document.createElement('input');
  input.type = 'text';
  input.value = originalValue;
  td.textContent = '';
  // SU1 holds ProShop notes — give the editor room instead of the narrow cell
  if (td.classList.contains('col-su1')) {
    input.className = 'su1-wide-input';
    td.classList.add('su1-editing');
  }
  td.appendChild(input);
  input.focus();
  input.select();

  var committed = false;
  var commit = function() {
    if (committed) return;
    committed = true;
    var newValue = input.value.trim();
    if (newValue && newValue.indexOf(' [') > 0) {
      newValue = newValue.split(' [')[0].trim();
    }

    var originalStripped = originalValue;
    if (originalStripped && originalStripped.indexOf(' [') > 0) {
      originalStripped = originalStripped.split(' [')[0].trim();
    }

    if (newValue === originalStripped) {
      td.innerHTML = originalHTML;
      return;
    }

    td.textContent = newValue || originalValue;

    var colClass = '';
    var classes = td.className.split(' ');
    for (var ci = 0; ci < classes.length; ci++) {
      if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
    }
    if (colClass) flashCellKey = row.id + '|' + colClass;

    var ov = Object.assign({}, row.user.overrides);
    if (td.classList.contains('col-inputspec')) {
      if (ov.outputSpec !== null) {
        ov.outputSpec = null;
        showToast('OP2000 Spec changed — OUT Spec override cleared', 'info');
      }
      ov.outDrawingSpec = newValue || null;
    } else if (td.classList.contains('col-drawspec')) {
      ov.outputSpec = newValue || null;
    } else if (td.classList.contains('col-pingage')) {
      ov.pinGageValue = newValue || null;
    } else if (td.classList.contains('col-su1')) {
      ov.specUnit1 = newValue || null;
    } else if (td.classList.contains('col-su2')) {
      ov.specUnit2 = newValue || null;
    } else if (td.classList.contains('col-su3')) {
      ov.specUnit3 = newValue || null;
    }
    onRowUserChange(row.id, { overrides: ov });
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', function(ke) {
    if (ke.key === 'Enter') input.blur();
    if (ke.key === 'Escape') {
      committed = true;
      td.innerHTML = originalHTML;
    }
    if (ke.key === 'Tab') {
      ke.preventDefault();
      var colClass = '';
      var classes = td.className.split(' ');
      for (var ci = 0; ci < classes.length; ci++) {
        if (classes[ci].indexOf('col-') === 0) { colClass = classes[ci]; break; }
      }
      navigateTarget = {
        rowId: row.id,
        colClass: colClass,
        reverse: ke.shiftKey
      };
      input.blur();
    }
  });
}

// ── Tab Navigation Helper ─────────────────────────────────

function resolveNavigateTarget(tbody, displayRows) {
  var nav = navigateTarget;
  var editableCols = ['col-su1', 'col-drawspec', 'col-inputspec', 'col-su2', 'col-su3',
                      'col-pingage', 'col-inputtol', 'col-outtol'];

  var rowIdx = -1;
  for (var ri = 0; ri < displayRows.length; ri++) {
    if (displayRows[ri].id === nav.rowId) { rowIdx = ri; break; }
  }
  if (rowIdx < 0) return;

  var colIdx = editableCols.indexOf(nav.colClass);
  if (colIdx < 0) return;

  if (nav.reverse) {
    colIdx--;
    if (colIdx < 0) { colIdx = editableCols.length - 1; rowIdx--; }
  } else {
    colIdx++;
    if (colIdx >= editableCols.length) { colIdx = 0; rowIdx++; }
  }

  if (rowIdx < 0 || rowIdx >= displayRows.length) return;

  var targetRowId = displayRows[rowIdx].id;
  var targetColClass = editableCols[colIdx];

  var targetTr = tbody.querySelector('tr[data-row-id="' + targetRowId + '"]');
  if (!targetTr) return;
  var targetTd = targetTr.querySelector('.' + targetColClass);
  if (!targetTd) return;

  setTimeout(function() {
    targetTd.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, 0);
}
