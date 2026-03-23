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

// Persistent file handle for project saves (File System Access API)
var projectFileHandle = null;

/**
 * Save full project state as a JSON file.
 *
 * Uses File System Access API when available:
 * - First save: prompts user to pick a location
 * - Subsequent saves: silently overwrites the same file
 *
 * Falls back to classic blob download if the API isn't supported.
 *
 * @param {Object} state — { rows, globals }
 * @param {Object} [opts] — { silent: true } to skip picker if handle exists
 * @returns {Promise<boolean>} — true if saved successfully
 */
function saveProject(state, opts) {
  var serialized = serializeState(state);
  var json = JSON.stringify(serialized, null, 2);
  opts = opts || {};

  // File System Access API path (Chrome/Edge)
  if (window.showSaveFilePicker) {
    return saveWithFileHandle(json, opts.silent);
  }

  // Fallback: classic blob download
  downloadBlob(json);
  return Promise.resolve(true);
}

function saveWithFileHandle(json, silent) {
  // If we already have a handle, write directly (no prompt)
  if (projectFileHandle && silent) {
    return writeToHandle(projectFileHandle, json).then(function() {
      console.log('[PSB] Project silently saved to ' + projectFileHandle.name);
      return true;
    }).catch(function(err) {
      console.warn('[PSB] Silent save failed, will re-prompt:', err);
      projectFileHandle = null;
      return promptAndSave(json);
    });
  }

  // If we have a handle from a previous save, reuse it (manual save)
  if (projectFileHandle) {
    return writeToHandle(projectFileHandle, json).then(function() {
      console.log('[PSB] Project saved to ' + projectFileHandle.name);
      return true;
    }).catch(function(err) {
      console.warn('[PSB] Save to existing handle failed, re-prompting:', err);
      projectFileHandle = null;
      return promptAndSave(json);
    });
  }

  // First time: ask user where to save
  return promptAndSave(json);
}

function promptAndSave(json) {
  var now = new Date();
  var stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  return window.showSaveFilePicker({
    suggestedName: 'ProShop_Project_' + stamp + '.json',
    types: [{
      description: 'ProShop Project',
      accept: { 'application/json': ['.json'] },
    }],
  }).then(function(handle) {
    projectFileHandle = handle;
    return writeToHandle(handle, json);
  }).then(function() {
    console.log('[PSB] Project saved to ' + projectFileHandle.name);
    return true;
  }).catch(function(err) {
    if (err.name === 'AbortError') {
      console.log('[PSB] Save cancelled by user');
      return false;
    }
    console.error('[PSB] Save failed:', err);
    return false;
  });
}

function writeToHandle(handle, content) {
  return handle.createWritable().then(function(writable) {
    return writable.write(content).then(function() {
      return writable.close();
    });
  });
}

function downloadBlob(json) {
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
 * Clear the stored file handle (e.g. on New File).
 */
function clearProjectFileHandle() {
  projectFileHandle = null;
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
PSB.clearProjectFileHandle = clearProjectFileHandle;
