/**
 * exportEngine.js — ProShop CSV Export
 *
 * Generates CSV matching ProShop import format.
 * Reads exclusively from row.computed (via getExportData).
 *
 * OP2000 rows: raw values only, no math
 * Other OPs: computed values with unit conversion
 */

import { getExportData } from './dataModel.js';

// ── CSV Column Headers (exact ProShop format) ─────────────
const CSV_HEADERS = [
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
export function generateCSV(rows, selectedOps, globals) {
  const lines = [];

  // Header row
  lines.push(CSV_HEADERS.join(','));

  // Data rows: for each selected OP, export all included rows
  for (const opNum of selectedOps) {
    for (const row of rows) {
      // Skip notes if they shouldn't be exported (optional: you may want to include them)
      // Skip rows not included in this OP
      if (row.computed.includeOps && row.computed.includeOps[opNum] === false) {
        continue;
      }

      // Only export rows that have this OP enabled
      if (row.user.includeOps[opNum] !== true) {
        continue;
      }

      const exportData = getExportData(row, opNum, globals);
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
export function formatExportRow(data) {
  return CSV_HEADERS.map(header => {
    const value = data[header] ?? '';
    const str = String(value);

    // Quote fields that contain commas, quotes, or newlines
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }).join(',');
}

/**
 * Trigger a CSV file download in the browser.
 *
 * @param {string} csvContent — the CSV string
 * @param {string} [filename] — download filename
 */
export function downloadCSV(csvContent, filename) {
  if (!filename) {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    filename = `ProShop_Export_${stamp}.csv`;
  }

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
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
