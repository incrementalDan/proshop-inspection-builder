window.PSB = window.PSB || {};

var CMM_SKIP_PATTERNS = [
  /^Name\s+Nominal\s+value\s+Measured\s+value\s+\+Tol\s+-Tol/i,
  /^\+\/-\s*Deviation/i,
  /^ZEISS\s+CALYPSO/i,
  /^\d+(\.\d+)?$/,
  /^Part\s+name/i,
  /^Order\s+number/i,
  /^Part\s+ident/i,
  /^Operator/i,
  /^Time\/Date/i,
  /^Page\s+\d+\s+of\s+\d+/i,
  /^OP\d+\s+Dims/i,
];

// Matches: <Name text> <5 numbers at end of line>
var CMM_ROW_REGEX = /^(.*?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Parse pasted Zeiss CALYPSO text into structured rows.
 * Column order: Name | MeasuredValue | NominalValue | +Tol | -Tol | Deviation
 */
function parseCmmText(rawText) {
  var lines = rawText.split(/\r?\n/).map(function(s) { return (s || '').trim(); }).filter(Boolean);
  var rows = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (shouldSkipCmmLine(line)) continue;

    var m = line.match(CMM_ROW_REGEX);
    if (!m) continue;

    var name = (m[1] || '').trim();
    var dimMatch = name.match(/#\s*(\d{1,3})/);
    var dimTag = dimMatch ? parseInt(dimMatch[1], 10) : null;

    var measured  = parseFloat(m[2]);
    var nominal   = parseFloat(m[3]);
    var plusTol   = parseFloat(m[4]);
    var minusTol  = Math.abs(parseFloat(m[5]));
    var deviation = parseFloat(m[6]);

    rows.push({ dimTag: dimTag, cmmName: name, measured: measured, nominal: nominal, plusTol: plusTol, minusTol: minusTol, deviation: deviation });
  }

  return rows;
}

function shouldSkipCmmLine(line) {
  for (var i = 0; i < CMM_SKIP_PATTERNS.length; i++) {
    if (CMM_SKIP_PATTERNS[i].test(line)) return true;
  }
  return false;
}

PSB.parseCmmText = parseCmmText;

/**
 * Extract header metadata from a Zeiss CALYPSO CMM report.
 * Returns part name and timestamp from the report header section.
 *
 * @param {string} rawText — full CMM report text
 * @returns {{ partName: string, dateStr: string }}
 */
function parseCmmHeader(rawText) {
  var lines = rawText.split(/\r?\n/).map(function(s) { return (s || '').trim(); }).filter(Boolean);
  var partName = '';
  var dateStr = '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (!partName) {
      var pm = line.match(/^Part\s+name\s+(.+)$/i);
      if (pm) partName = pm[1].trim();
    }

    if (!dateStr) {
      var dm = line.match(/^(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)$/i);
      if (dm) dateStr = dm[1].trim();
    }

    if (partName && dateStr) break;
  }

  return { partName: partName, dateStr: dateStr };
}

PSB.parseCmmHeader = parseCmmHeader;
