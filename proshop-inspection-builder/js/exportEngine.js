/**
 * exportEngine.js — ProShop CSV Export
 *
 * Generates CSV matching ProShop import format.
 * Reads exclusively from row.computed (via getExportData).
 *
 * OP2000 rows: raw values only, no math
 * Other OPs: computed values with unit conversion
 */

window.PSB = window.PSB || {};

// ── CSV Column Headers (exact ProShop format) ─────────────
var CSV_HEADERS = [
  'Internal Part #',
  'Op #',
  'Dim Tag #',
  'Ref Loc',
  'Char Dsg',
  'Spec Unit 1',
  'Drawing Spec',
  'Spec Unit 2',
  'Spec Unit 3',
  'Inspec Equip',
  'Nom Dim',
  'Tol ±',
  'IPC?',
  'Inspection Frequency',
  'Show Dim When?',
];

/**
 * Generate a full ProShop-compatible CSV string.
 *
 * @param {Object[]} rows — array of row objects
 * @param {number[]} selectedOps — which OPs to export (e.g., [2000, 50])
 * @param {Object} globals — global settings
 * @returns {string} CSV content
 */
function generateCSV(rows, selectedOps, globals) {
  var lines = [];

  // Header row
  lines.push(CSV_HEADERS.join(','));

  // Data rows: for each selected OP, export all included rows
  for (var oi = 0; oi < selectedOps.length; oi++) {
    var opNum = selectedOps[oi];
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      // OP2000 exports all rows; other OPs require per-row enablement
      if (opNum !== 2000 && row.user.includeOps[opNum] !== true) {
        continue;
      }

      var exportData = PSB.getExportData(row, opNum, globals);
      lines.push(formatExportRow(exportData));
    }
  }

  return lines.join('\n');
}

/**
 * Format a single export data object as a CSV line.
 *
 * @param {Object} data — flat object with CSV column keys
 * @returns {string} CSV line
 */
function formatExportRow(data) {
  return CSV_HEADERS.map(function(header) {
    var value = data[header];
    if (value === undefined || value === null) value = '';
    // Normalize diameter symbol for ProShop: Ø → ⌀
    if (header === 'Spec Unit 1') {
      value = String(value).replace(/Ø/g, '⌀');
    }
    var str = String(value);

    // Quote fields that contain commas, quotes, or newlines
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }).join(',');
}

/**
 * Trigger a CSV file download.
 *
 * When a projectHandle is supplied and the browser supports the File System
 * Access API, opens a save picker starting in the same folder as the project
 * file so the CSV lands next to it.  Falls back to a classic blob download.
 *
 * @param {string} csvContent — the CSV string
 * @param {string} [filename] — download filename
 * @param {FileSystemFileHandle} [projectHandle] — optional project file handle
 * @returns {Promise<boolean>} resolves true if saved, false if cancelled
 */
function downloadCSV(csvContent, filename, projectHandle) {
  if (!filename) {
    var now = new Date();
    var stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    filename = 'ProShop_Export_' + stamp + '.csv';
  }

  if (window.showSaveFilePicker) {
    var opts = {
      suggestedName: filename,
      types: [{ description: 'CSV File', accept: { 'text/csv': ['.csv'] } }],
    };
    if (projectHandle) {
      opts.startIn = projectHandle;
    }
    return window.showSaveFilePicker(opts).then(function(handle) {
      return handle.createWritable();
    }).then(function(writable) {
      var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      return writable.write(blob).then(function() { return writable.close(); });
    }).then(function() {
      return true;
    }).catch(function(err) {
      if (err.name === 'AbortError') return false;
      // Unexpected error — fall back to blob download
      blobDownloadCSV(csvContent, filename);
      return true;
    });
  }

  blobDownloadCSV(csvContent, filename);
  return Promise.resolve(true);
}

function blobDownloadCSV(csvContent, filename) {
  var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
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

// ── Export to namespace ───────────────────────────────────
PSB.generateCSV = generateCSV;
PSB.formatExportRow = formatExportRow;
PSB.downloadCSV = downloadCSV;
