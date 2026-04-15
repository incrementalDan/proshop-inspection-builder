/**
 * storage.js — Save / Load Project State
 *
 * Saves full app state (rows + globals) as JSON.
 * Uses sessionStorage for quick auto-save, File System Access API for
 * persistent file saves (with automatic silent overwrites after first save).
 */

window.PSB = window.PSB || {};

var STORAGE_KEY = 'proshop_inspection_builder';

/**
 * Auto-save current state to sessionStorage (fast, in-memory).
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
 * - First save: prompts user to pick a location and filename
 * - Subsequent saves: silently overwrites the same file (no prompt)
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
  // If we have a handle, write directly (no prompt)
  if (projectFileHandle) {
    return writeToHandle(projectFileHandle, json).then(function() {
      console.log('[PSB] Project saved to ' + projectFileHandle.name);
      return true;
    }).catch(function(err) {
      console.warn('[PSB] Save to handle failed:', err);
      // Silent saves should not re-prompt — just fail quietly
      if (silent) {
        projectFileHandle = null;
        return false;
      }
      // Manual save: re-prompt so the user can pick a new location
      projectFileHandle = null;
      return promptAndSave(json);
    });
  }

  // No handle yet
  if (silent) {
    // Silent save with no handle — skip entirely (sessionStorage has data)
    return Promise.resolve(false);
  }

  // First time manual save: ask user where to save
  return promptAndSave(json);
}

function promptAndSave(json) {
  return window.showSaveFilePicker({
    suggestedName: 'ProShop_Project.json',
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
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'ProShop_Project.json';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Auto-save to disk (silent). Only writes if a file handle exists.
 * Never prompts the user. Safe to call frequently (caller should debounce).
 *
 * @param {Object} state — { rows, globals }
 * @returns {Promise<boolean>}
 */
function autoSaveToDisk(state) {
  if (!projectFileHandle) return Promise.resolve(false);
  var serialized = serializeState(state);
  var json = JSON.stringify(serialized, null, 2);
  return writeToHandle(projectFileHandle, json).then(function() {
    console.log('[PSB] Auto-saved to disk: ' + projectFileHandle.name);
    return true;
  }).catch(function(err) {
    console.warn('[PSB] Disk auto-save failed:', err);
    return false;
  });
}

/**
 * Check if a persistent file handle exists (project has been saved at least once).
 * @returns {boolean}
 */
function hasFileHandle() {
  return projectFileHandle !== null;
}

/**
 * Get the current project filename from the file handle.
 * @returns {string|null}
 */
function getProjectFileName() {
  return projectFileHandle ? projectFileHandle.name : null;
}

/**
 * Clear the stored file handle (e.g. on New File).
 */
function clearProjectFileHandle() {
  projectFileHandle = null;
}

/**
 * Open a project file using the File System Access API.
 * Stores the file handle so subsequent saves overwrite the same file.
 *
 * Falls back to returning null if API not available (caller uses <input> fallback).
 *
 * @returns {Promise<{jsonString: string, fileName: string}|null>}
 */
function openProjectWithHandle() {
  if (!window.showOpenFilePicker) return Promise.resolve(null);

  return window.showOpenFilePicker({
    types: [{
      description: 'ProShop Project',
      accept: { 'application/json': ['.json'] },
    }],
    multiple: false,
  }).then(function(handles) {
    var handle = handles[0];
    projectFileHandle = handle;
    return handle.getFile();
  }).then(function(file) {
    return file.text().then(function(text) {
      return { jsonString: text, fileName: file.name };
    });
  }).catch(function(err) {
    if (err.name === 'AbortError') {
      console.log('[PSB] Open cancelled by user');
      return null;
    }
    console.error('[PSB] Open failed:', err);
    return null;
  });
}

/**
 * Load project state from a JSON string.
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
    auditLog: state.auditLog || [],
  };
}

function deserializeState(data) {
  if (!data || !data.rows) {
    throw new Error('Invalid project file');
  }

  var defaults = PSB.defaultUserState();
  return {
    globals: data.globals || {},
    auditLog: data.auditLog || [],
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
PSB.autoSaveToDisk = autoSaveToDisk;
PSB.hasFileHandle = hasFileHandle;
PSB.getProjectFileName = getProjectFileName;
PSB.openProjectWithHandle = openProjectWithHandle;
