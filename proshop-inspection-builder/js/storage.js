/**
 * storage.js — Save / Load Project State
 *
 * Saves full app state (rows + globals) as JSON.
 * Uses localStorage for auto-save, JSON file download for manual save.
 */

window.PSB = window.PSB || {};

var STORAGE_KEY = 'proshop_inspection_builder';

/**
 * Auto-save current state to localStorage.
 *
 * @param {Object} state — { rows, globals }
 */
function autoSave(state) {
  try {
    var serialized = serializeState(state);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch (e) {
    console.warn('Auto-save failed:', e);
  }
}

/**
 * Load auto-saved state from sessionStorage.
 * Data is cleared when the tab/window is closed.
 *
 * @returns {Object|null} — { rows, globals } or null if none found
 */
function autoLoad() {
  try {
    var json = sessionStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return deserializeState(JSON.parse(json));
  } catch (e) {
    console.warn('Auto-load failed:', e);
    return null;
  }
}

/**
 * Save full project state as a downloadable JSON file.
 *
 * @param {Object} state — { rows, globals }
 */
function saveProject(state) {
  var serialized = serializeState(state);
  var json = JSON.stringify(serialized, null, 2);

  var now = new Date();
  var stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var filename = 'ProShop_Project_' + stamp + '.json';

  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Load project state from a JSON string (from file upload).
 *
 * @param {string} jsonString
 * @returns {Object} — { rows, globals }
 */
function loadProject(jsonString) {
  var parsed = JSON.parse(jsonString);
  return deserializeState(parsed);
}

/**
 * Clear auto-saved state.
 */
function clearAutoSave() {
  sessionStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_KEY); // also clear legacy localStorage
}

// ── Serialization helpers ─────────────────────────────────

function serializeState(state) {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    globals: state.globals,
    rows: state.rows.map(function(row) {
      return {
        id: row.id,
        raw: row.raw,
        user: row.user,
        // computed is NOT saved — it's recalculated on load
      };
    }),
  };
}

function deserializeState(data) {
  if (!data || !data.rows) {
    throw new Error('Invalid project file');
  }

  var defaults = PSB.defaultUserState();
  return {
    globals: data.globals || {},
    rows: data.rows.map(function(r) {
      // Ensure all user fields exist (handles saves from older versions)
      var user = Object.assign({}, defaults, r.user);
      user.overrides = Object.assign({}, defaults.overrides, (r.user && r.user.overrides) || {});
      user.includeOps = Object.assign({}, (r.user && r.user.includeOps) || {});
      return {
        id: r.id,
        raw: Object.freeze(Object.assign({}, r.raw)),
        user: user,
        computed: {}, // Will be recalculated by app.js on load
      };
    }),
  };
}

// ── Export to namespace ───────────────────────────────────
PSB.autoSave = autoSave;
PSB.autoLoad = autoLoad;
PSB.saveProject = saveProject;
PSB.loadProject = loadProject;
PSB.clearAutoSave = clearAutoSave;
