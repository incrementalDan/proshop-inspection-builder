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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch (e) {
    console.warn('Auto-save failed:', e);
  }
}

/**
 * Load auto-saved state from localStorage.
 *
 * @returns {Object|null} — { rows, globals } or null if none found
 */
function autoLoad() {
  try {
    var json = localStorage.getItem(STORAGE_KEY);
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
  localStorage.removeItem(STORAGE_KEY);
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

  return {
    globals: data.globals || {},
    rows: data.rows.map(function(r) {
      return {
        id: r.id,
        raw: Object.freeze(Object.assign({}, r.raw)),
        user: r.user,
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
