/**
 * history.js — Undo/Redo & Audit Log
 *
 * Provides:
 * - Snapshot-based undo/redo (10 levels)
 * - Persistent audit log with timestamp coalescing
 * - Row-level history for sidebar display
 */

window.PSB = window.PSB || {};

// ── Undo / Redo ──────────────────────────────────────────
var undoStack = [];
var redoStack = [];
var MAX_UNDO = 10;

/**
 * Deep-clone the parts of state needed for undo/redo.
 * Skips computed (recalculated). CSV-imported rows keep raw by reference
 * (frozen); balloon-created rows clone raw because the user can edit it.
 */
function cloneStateForSnapshot(state) {
  return {
    globals: JSON.parse(JSON.stringify(state.globals)),
    rows: state.rows.map(function(row) {
      var rawSnap = (row.raw && row.raw._source === 'balloon')
        ? JSON.parse(JSON.stringify(row.raw))
        : row.raw;
      return {
        id: row.id,
        raw: rawSnap,
        user: JSON.parse(JSON.stringify(row.user)),
      };
    }),
  };
}

/**
 * Push a snapshot of the current state onto the undo stack.
 * Call this BEFORE making any mutation.
 *
 * @param {Object} state — current { rows, globals }
 * @param {string} [description] — human-readable description of the action about to happen
 */
function pushUndo(state, description) {
  var snap = cloneStateForSnapshot(state);
  snap._desc = description || '';
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

/**
 * Undo: pop from undo stack, push current state to redo, return the snapshot to restore.
 * @param {Object} state — current state (to save for redo)
 * @param {string} [desc] — description of the action being undone (for redo label)
 * @returns {Object|null} — snapshot to restore, or null if nothing to undo
 */
function undo(state, desc) {
  if (undoStack.length === 0) return null;
  var snap = cloneStateForSnapshot(state);
  snap._desc = desc || '';
  redoStack.push(snap);
  return undoStack.pop();
}

/**
 * Redo: pop from redo stack, push current state to undo, return the snapshot to restore.
 * @param {Object} state — current state (to save for undo)
 * @param {string} [desc] — description of the action being redone (for undo label)
 * @returns {Object|null} — snapshot to restore, or null if nothing to redo
 */
function redo(state, desc) {
  if (redoStack.length === 0) return null;
  var snap = cloneStateForSnapshot(state);
  snap._desc = desc || '';
  undoStack.push(snap);
  return redoStack.pop();
}

function canUndo() { return undoStack.length > 0; }
function canRedo() { return redoStack.length > 0; }

function getUndoDescriptions() {
  var result = [];
  for (var i = undoStack.length - 1; i >= 0; i--) {
    result.push(undoStack[i]._desc || 'Change');
  }
  return result;
}

function getRedoDescriptions() {
  var result = [];
  for (var i = redoStack.length - 1; i >= 0; i--) {
    result.push(redoStack[i]._desc || 'Change');
  }
  return result;
}

/**
 * Clear undo/redo stacks (e.g. on New File or project load).
 */
function clearUndoRedo() {
  undoStack.length = 0;
  redoStack.length = 0;
}


// ── Audit Log ────────────────────────────────────────────
var COALESCE_MS = 750;

/**
 * Log a change to the audit history.
 * Coalesces rapid changes (same type + row within COALESCE_MS).
 *
 * @param {Object[]} auditLog — the audit log array (state.auditLog)
 * @param {Object} entry
 * @param {string} entry.type — 'edit' | 'add' | 'delete' | 'global' | 'import'
 * @param {number|null} entry.rowId — affected row, or null for global/bulk
 * @param {string} entry.description — human-readable summary
 * @param {Object[]} [entry.details] — array of { field, from, to }
 */
function logChange(auditLog, entry) {
  var now = new Date();
  var timestamp = now.toISOString();

  // Try to coalesce with the last entry
  if (auditLog.length > 0) {
    var last = auditLog[auditLog.length - 1];
    var lastTime = new Date(last.timestamp).getTime();
    var elapsed = now.getTime() - lastTime;

    if (elapsed < COALESCE_MS && last.type === entry.type && last.rowId === entry.rowId) {
      // Merge: update timestamp, append details, update description
      last.timestamp = timestamp;
      if (entry.details && entry.details.length > 0) {
        last.details = last.details || [];
        // Replace existing field entries or add new ones
        for (var i = 0; i < entry.details.length; i++) {
          var newDetail = entry.details[i];
          var replaced = false;
          for (var j = 0; j < last.details.length; j++) {
            if (last.details[j].field === newDetail.field) {
              // Keep original "from", update "to"
              last.details[j].to = newDetail.to;
              replaced = true;
              break;
            }
          }
          if (!replaced) last.details.push(newDetail);
        }
      }
      last.description = entry.description;
      return;
    }
  }

  auditLog.push({
    timestamp: timestamp,
    type: entry.type,
    rowId: entry.rowId,
    description: entry.description,
    details: entry.details || [],
  });
}

/**
 * Get audit entries for a specific row, most recent first.
 * @param {Object[]} auditLog
 * @param {number} rowId
 * @returns {Object[]}
 */
function getRowHistory(auditLog, rowId) {
  var entries = [];
  for (var i = auditLog.length - 1; i >= 0; i--) {
    if (auditLog[i].rowId === rowId) entries.push(auditLog[i]);
  }
  return entries;
}

/**
 * Format a timestamp for display (short form).
 * @param {string} iso — ISO timestamp
 * @returns {string} — e.g. "2:34 PM" or "Mar 15, 2:34 PM"
 */
function formatHistoryTime(iso) {
  var d = new Date(iso);
  var now = new Date();
  var timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() !== now.toDateString()) {
    var monthDay = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return monthDay + ', ' + timeStr;
  }
  return timeStr;
}


// ── Export ────────────────────────────────────────────────
PSB.pushUndo = pushUndo;
PSB.undo = undo;
PSB.redo = redo;
PSB.canUndo = canUndo;
PSB.canRedo = canRedo;
PSB.clearUndoRedo = clearUndoRedo;
PSB.getUndoDescriptions = getUndoDescriptions;
PSB.getRedoDescriptions = getRedoDescriptions;
PSB.logChange = logChange;
PSB.getRowHistory = getRowHistory;
PSB.formatHistoryTime = formatHistoryTime;
