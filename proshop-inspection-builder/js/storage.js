/**
 * storage.js — Save / Load Project State
 *
 * Saves full app state (rows + globals) as JSON.
 * Uses localStorage for auto-save, JSON file download for manual save.
 */

const STORAGE_KEY = 'proshop_inspection_builder';

/**
 * Auto-save current state to localStorage.
 *
 * @param {Object} state — { rows, globals }
 */
export function autoSave(state) {
  try {
    const serialized = serializeState(state);
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
export function autoLoad() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
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
 * @param {string} [filename]
 */
export function saveProject(state) {
  const serialized = serializeState(state);
  const json = JSON.stringify(serialized, null, 2);

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `ProShop_Project_${stamp}.json`;

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
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
export function loadProject(jsonString) {
  const parsed = JSON.parse(jsonString);
  return deserializeState(parsed);
}

/**
 * Clear auto-saved state.
 */
export function clearAutoSave() {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Serialization helpers ─────────────────────────────────

function serializeState(state) {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    globals: state.globals,
    rows: state.rows.map(row => ({
      id: row.id,
      raw: row.raw,
      user: row.user,
      // computed is NOT saved — it's recalculated on load
    })),
  };
}

function deserializeState(data) {
  if (!data || !data.rows) {
    throw new Error('Invalid project file');
  }

  return {
    globals: data.globals || {},
    rows: data.rows.map(r => ({
      id: r.id,
      raw: Object.freeze({ ...r.raw }),
      user: r.user,
      computed: {}, // Will be recalculated by app.js on load
    })),
  };
}
