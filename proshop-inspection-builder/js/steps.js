/**
 * steps.js — Workflow steps: Drawing → Plan → Inspect (moved out of app.js, no behavior change)
 *
 * - VIEW_CONFIGS: what each step shows
 * - switchView: change step (nav rail, Ctrl+1/2/3)
 * - Step status text + Inspect fail badge
 * - Setup panel open/closed per step
 */

// ── View Configuration ────────────────────────────────────
var VIEW_CONFIGS = {
  // ① Drawing — same table as Plan; PDF in focus, Setup panel closed by default
  drawing: {
    id: 'drawing',
    label: 'Drawing',
    sidebarEnabled: true,
    setupPanelDefault: false,
  },
  // ② Plan — the original Setup view (id kept as 'setup')
  setup: {
    id: 'setup',
    label: 'Plan',
    setupPanelDefault: true,
    sidebarEnabled: true,
  },
  fai: {
    id: 'fai',
    label: 'Inspect',
    setupPanelDefault: false, // CMM table needs the width; ⚙ Setup still opens it
    sidebarEnabled: false,
    compareMode: 'op2000',   // 'op2000' | 'compensated' — which plan values to compare CMM against
  },
};

var currentView = 'setup';

var setupPanelByStep = {}; // step id → was the Setup panel open when you left it

function switchView(viewId) {
  if (!VIEW_CONFIGS[viewId]) viewId = 'setup';
  // Remember the Setup panel state of the step we're leaving
  var panel = document.getElementById('setup-panel');
  if (panel && VIEW_CONFIGS[currentView] && VIEW_CONFIGS[currentView].setupPanelDefault !== undefined) {
    setupPanelByStep[currentView] = !panel.classList.contains('panel-closed');
  }
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

  // Show only the controls tagged for this step (data-steps="drawing setup fai").
  // Untagged controls (Save, Load, New…) show on every step.
  var stepped = document.querySelectorAll('[data-steps]');
  for (var i = 0; i < stepped.length; i++) {
    var steps = stepped[i].getAttribute('data-steps').split(' ');
    stepped[i].classList.toggle('hidden', steps.indexOf(viewId) === -1);
  }

  // Setup panel: Drawing starts closed, Plan open; each step remembers
  // what you last did with it.
  if (config.setupPanelDefault !== undefined) {
    var wantOpen = setupPanelByStep[viewId];
    if (wantOpen === undefined) wantOpen = config.setupPanelDefault;
    if (wantOpen) PSB.openSetupPanel(); else PSB.closeSetupPanel();
  }

  try { sessionStorage.setItem('psb_step', viewId); } catch (e) { /* not critical */ }

  // Activate the matching nav rail tab
  var navTabs = document.querySelectorAll('.nav-tab[data-view]');
  for (var nt = 0; nt < navTabs.length; nt++) {
    navTabs[nt].classList.toggle('active', navTabs[nt].dataset.view === viewId);
  }

  PSB.renderTable(state, config);
}

/** Small status under ① Drawing and ② Plan in the left bar. */
function updateStepStatus() {
  var rows = state.rows || [];
  var n = rows.length;
  var dEl = document.getElementById('nav-drawing-status');
  var pEl = document.getElementById('nav-plan-status');
  var dTab = document.getElementById('nav-tab-drawing');
  var pTab = document.getElementById('nav-tab-setup');
  if (!dEl || !pEl) return;

  var unconfirmed = n > 0 && !state.globals.printUnitsConfirmed;
  dEl.textContent = n > 0 ? String(n) : '';
  dEl.className = 'nav-step-status' + (n === 0 ? ' hidden' : unconfirmed ? ' status-warn' : '');
  if (dTab) dTab.setAttribute('aria-label', 'Step 1, Drawing: ' + n + ' dims' + (unconfirmed ? ', print units not confirmed' : ''));

  var done = 0;
  for (var i = 0; i < n; i++) if (rows[i].user && rows[i].user.status === 'complete') done++;
  pEl.textContent = n > 0 ? done + '/' + n : '';
  pEl.className = 'nav-step-status' + (n === 0 ? ' hidden' : done === n ? ' status-done' : '');
  if (pTab) pTab.setAttribute('aria-label', 'Step 2, Plan: ' + done + ' of ' + n + ' complete');
}

function updateFaiTabBadge() {
  updateStepStatus();
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
// SETUP PANEL — toggle + title block live-save
// ═══════════════════════════════════════════════════════════
function bindSetupPanel() {
  // Toggle button (in the header)
  var toggleBtn = document.getElementById('btn-setup-panel');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      PSB.toggleSetupPanel();
    });
  }

  // Close (X) button inside the panel
  var closeBtn = document.getElementById('setup-panel-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      PSB.closeSetupPanel();
    });
  }

  // Title Block Defaults — live-save on change (no modal open/close needed)
  bindTitleBlockDefaults();
}
