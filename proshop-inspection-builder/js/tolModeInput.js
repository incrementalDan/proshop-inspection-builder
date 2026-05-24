/**
 * tolModeInput.js — Shared tolerance-input renderer with mode toggle.
 *
 * Three input modes for the same underlying (tolPlus, tolMinus) numbers:
 *   - 'sym'    Single input  → tolPlus = tolMinus = value
 *   - 'asym'   Two inputs    → tolPlus, tolMinus entered independently
 *   - 'minmax' Two inputs    → min/max bounds around nominal
 *                              tolPlus  = max − nominal
 *                              tolMinus = nominal − min
 *                              (validates min ≤ nominal ≤ max)
 *
 * Used by:
 *   - ui.js setupSidebarTolEdit (OP2000 + OUT sidebar editors)
 *   - balloonManager.js showPopover/confirmPopover (new-balloon popover)
 *
 * Math downstream (recompute → mathEngine → exportEngine) is unchanged.
 * Only the input layer differs by mode.
 *
 * Usage:
 *   var ctrl = PSB.renderTolModeInputs(containerEl, {
 *     mode: 'sym',          // initial mode
 *     plus: 0.005,          // current tolPlus
 *     minus: 0.005,         // current tolMinus
 *     nominal: 0.250,       // for minmax mode validation + min/max derivation
 *     precision: 4,         // display precision for prefilled values
 *   });
 *   // later:
 *   var result = ctrl.commit();
 *   // result = { ok, tolPlus, tolMinus, tolMode, error? }
 */

window.PSB = window.PSB || {};

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function _fmt(v, prec) {
  if (v == null || isNaN(v)) return '';
  if (PSB.formatPrecision) return PSB.formatPrecision(v, prec);
  return String(Number(v).toFixed(prec));
}

function _parseNum(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return NaN;
  // Strip leading + or unicode minus sign
  if (s.charAt(0) === '+') s = s.substring(1);
  if (s.charAt(0) === '−') s = '-' + s.substring(1);
  return parseFloat(s);
}

var MODES = ['sym', 'asym', 'minmax'];
var MODE_LABELS = { sym: '±', asym: '+/−', minmax: 'min/max' };

function renderTolModeInputs(container, opts) {
  opts = opts || {};
  var precision = opts.precision != null ? opts.precision : 3;
  var nominal = (opts.nominal != null && !isNaN(parseFloat(opts.nominal))) ? parseFloat(opts.nominal) : null;
  var mode = MODES.indexOf(opts.mode) >= 0 ? opts.mode : 'sym';
  var plus = (opts.plus != null && !isNaN(parseFloat(opts.plus))) ? parseFloat(opts.plus) : 0;
  var minus = (opts.minus != null && !isNaN(parseFloat(opts.minus))) ? parseFloat(opts.minus) : 0;

  // Build toggle + input slots.
  container.innerHTML =
    '<div class="tol-mode-toggle" role="tablist">' +
      MODES.map(function(m) {
        return '<button type="button" class="tol-mode-chip' + (m === mode ? ' active' : '') +
               '" data-mode="' + m + '" tabindex="-1">' + _esc(MODE_LABELS[m]) + '</button>';
      }).join('') +
    '</div>' +
    '<div class="tol-mode-fields"></div>' +
    '<div class="tol-mode-error" style="display:none"></div>';

  var fieldsEl = container.querySelector('.tol-mode-fields');
  var errorEl = container.querySelector('.tol-mode-error');
  var chips = container.querySelectorAll('.tol-mode-chip');
  var firstInput = null;

  function renderFields() {
    // Render inputs for the current mode, prefilled from current plus/minus/nominal.
    if (mode === 'sym') {
      // Symmetric: one ± input. If plus and minus differ, prefer plus.
      var symVal = _fmt(plus || minus || 0, precision);
      fieldsEl.innerHTML =
        '<div class="tol-input-wrap"><span class="tol-sign-label">±</span>' +
          '<input class="tol-input tol-sym" value="' + _esc(symVal) + '" inputmode="decimal" /></div>';
    } else if (mode === 'asym') {
      fieldsEl.innerHTML =
        '<div class="tol-input-wrap"><span class="tol-sign-label">+</span>' +
          '<input class="tol-input tol-plus" value="' + _esc(_fmt(plus, precision)) + '" inputmode="decimal" /></div>' +
        '<div class="tol-input-wrap"><span class="tol-sign-label">−</span>' +
          '<input class="tol-input tol-minus" value="' + _esc(_fmt(minus, precision)) + '" inputmode="decimal" /></div>';
    } else {
      // min/max: derive bounds from current nominal+plus/minus.
      var minVal = nominal != null ? _fmt(nominal - minus, precision) : '';
      var maxVal = nominal != null ? _fmt(nominal + plus, precision) : '';
      fieldsEl.innerHTML =
        '<div class="tol-input-wrap"><span class="tol-sign-label">min</span>' +
          '<input class="tol-input tol-min" value="' + _esc(minVal) + '" inputmode="decimal" /></div>' +
        '<div class="tol-input-wrap"><span class="tol-sign-label">max</span>' +
          '<input class="tol-input tol-max" value="' + _esc(maxVal) + '" inputmode="decimal" /></div>';
    }
    firstInput = fieldsEl.querySelector('input');
    if (firstInput) {
      // Tab-cycle support: clicking should select; expose focusable elements.
      fieldsEl.querySelectorAll('input').forEach(function(inp) {
        inp.addEventListener('focus', function() { inp.select(); });
      });
    }
    hideError();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = '';
  }
  function hideError() {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  function setMode(newMode) {
    if (newMode === mode) return;
    // Pull current values forward so a switch preserves what's been typed.
    var cur = readCurrent();
    if (cur.ok) { plus = cur.tolPlus; minus = cur.tolMinus; }
    mode = newMode;
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-mode') === mode);
    }
    renderFields();
    if (firstInput) firstInput.focus();
  }

  // Hook chip clicks
  for (var i = 0; i < chips.length; i++) {
    (function(chip) {
      chip.addEventListener('mousedown', function(e) { e.preventDefault(); });
      chip.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        setMode(chip.getAttribute('data-mode'));
      });
    })(chips[i]);
  }

  // Read the current input values without applying validation. Returns shape
  // { ok, tolPlus, tolMinus, tolMode, error? }. ok=false means the user has
  // not yet entered enough to derive numbers.
  function readCurrent() {
    if (mode === 'sym') {
      var sv = fieldsEl.querySelector('.tol-sym');
      var n = _parseNum(sv && sv.value);
      if (isNaN(n)) return { ok: false, error: 'Enter a tolerance value' };
      if (n < 0)   return { ok: false, error: 'Symmetric tolerance must be non-negative' };
      return { ok: true, tolPlus: n, tolMinus: n, tolMode: 'sym' };
    }
    if (mode === 'asym') {
      var pv = fieldsEl.querySelector('.tol-plus');
      var mv = fieldsEl.querySelector('.tol-minus');
      var p = _parseNum(pv && pv.value);
      var m = _parseNum(mv && mv.value);
      // Allow blanks to default to 0 on the missing side, like the legacy editor did.
      if (isNaN(p) && isNaN(m)) return { ok: false, error: 'Enter a +/− tolerance' };
      if (isNaN(p)) p = 0;
      if (isNaN(m)) m = 0;
      if (p < 0 || m < 0) return { ok: false, error: '+/− values must be non-negative magnitudes' };
      return { ok: true, tolPlus: p, tolMinus: m, tolMode: 'asym' };
    }
    // minmax
    var minIn = fieldsEl.querySelector('.tol-min');
    var maxIn = fieldsEl.querySelector('.tol-max');
    var minN = _parseNum(minIn && minIn.value);
    var maxN = _parseNum(maxIn && maxIn.value);
    if (isNaN(minN) || isNaN(maxN)) return { ok: false, error: 'Enter both min and max' };
    if (maxN < minN) return { ok: false, error: 'max must be ≥ min' };
    if (nominal == null) return { ok: false, error: 'No nominal — switch to ± or +/− mode' };
    if (minN > nominal + 1e-12) return { ok: false, error: 'min must be ≤ nominal (' + _fmt(nominal, precision) + ')' };
    if (maxN < nominal - 1e-12) return { ok: false, error: 'max must be ≥ nominal (' + _fmt(nominal, precision) + ')' };
    var tp = maxN - nominal;
    var tm = nominal - minN;
    if (tp < 0) tp = 0;
    if (tm < 0) tm = 0;
    return { ok: true, tolPlus: tp, tolMinus: tm, tolMode: 'minmax' };
  }

  function commit() {
    var r = readCurrent();
    if (!r.ok) {
      showError(r.error || 'Invalid input');
      var bad = fieldsEl.querySelector('input');
      if (bad) bad.focus();
      return r;
    }
    hideError();
    return r;
  }

  renderFields();

  return {
    commit: commit,
    readCurrent: readCurrent,
    getMode: function() { return mode; },
    setMode: setMode,
    focus: function() { if (firstInput) { firstInput.focus(); firstInput.select(); } },
    getInputs: function() { return fieldsEl.querySelectorAll('input'); },
    setNominal: function(v) {
      var n = parseFloat(v);
      nominal = isNaN(n) ? null : n;
    },
  };
}

PSB.renderTolModeInputs = renderTolModeInputs;
