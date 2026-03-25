# Save Workflow Polish Plan

## Goal
Save once, pick location once, then auto-save silently on every edit. Never re-prompt.

## Changes

### 1. storage.js — Auto-save to disk (debounced)
- Add `autoSaveToDisk(state)` function: if `projectFileHandle` exists, silently write to it
- No prompt, no toast — just quiet persistence
- Exposed as `PSB.autoSaveToDisk`

### 2. storage.js — Stable default filename
- Change `promptAndSave()` suggested name from `ProShop_Project_<timestamp>.json` to `ProShop_Project.json`
- Same for `downloadBlob()` fallback

### 3. storage.js — Load with file handle
- Add `loadProjectWithHandle()` that uses `showOpenFilePicker()` (with fallback)
- Stores the handle so subsequent saves overwrite the same file
- Returns `{ handle, jsonString }` so app.js can set the handle and parse

### 4. app.js — Wire auto-save to disk
- In `scheduleAutoSave()`, also schedule a disk save (~3s debounce)
- Only writes if handle exists (no prompt)
- Add a separate `diskSaveTimer` with longer debounce than sessionStorage

### 5. app.js — Export stops prompting
- Remove the `setTimeout` + `saveProject(silent)` from export confirm handler
- Replace with: if handle exists, `autoSaveToDisk()`. If no handle, skip (sessionStorage has it).

### 6. app.js — Load uses file handle
- Change load button to use `PSB.loadProjectWithHandle()` when available
- Falls back to current `<input type="file">` on unsupported browsers
- After load, file handle is stored → saves go to same file

## Files Modified
- `js/storage.js` — new functions, stable filename, load with handle
- `js/app.js` — wire disk auto-save, fix export, fix load
