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

// Matches a line of only 5 numbers (no name) — the values for a stacked label block
var CMM_VALUES_ONLY_REGEX = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Dim tag = the FIRST "#N" in the name. Later "#" numbers are part of the
 * feature name (e.g. "#8 Cone Angle_#8 COUNTERSINK") and are ignored.
 */
function cmmDimTagFromName(name) {
  var m = (name || '').match(/#\s*(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Split a stacked label line into one label per "#N".
 * CALYPSO sometimes prints many labels on one line, then their values on
 * the following lines:  "#1 X Value_Cyl1 #16 Y Value_Cyl1 #7 Diameter_Cyl1 ..."
 * Only splits on a "#" that starts a word, so "Angle_#8" stays in its label.
 */
function splitCmmLabels(name) {
  return name.split(/\s+(?=#\s*\d{1,3}\b)/).map(function(s) { return s.trim(); }).filter(Boolean);
}

function buildCmmRow(name, nums) {
  return {
    dimTag: cmmDimTagFromName(name),
    cmmName: name,
    measured: parseFloat(nums[0]),
    nominal: parseFloat(nums[1]),
    plusTol: parseFloat(nums[2]),
    // -Tol column is the signed lower deviation. minusTol = how far BELOW nominal
    // the lower limit sits, so a unilateral "+0.005" lower tol → minusTol -0.005.
    minusTol: -parseFloat(nums[3]) || 0,
    deviation: parseFloat(nums[4]),
  };
}

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

    var labels = splitCmmLabels((m[1] || '').trim());
    if (labels.length === 0) continue;

    // First label owns the numbers on this line
    rows.push(buildCmmRow(labels[0], m.slice(2, 7)));

    // Stacked block: each following values-only line belongs to the next label
    for (var li = 1; li < labels.length; li++) {
      var next = lines[i + 1];
      var vm = next ? next.match(CMM_VALUES_ONLY_REGEX) : null;
      if (!vm) break;
      i++;
      rows.push(buildCmmRow(labels[li], vm.slice(1, 6)));
    }
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
PSB.cmmDimTagFromName = cmmDimTagFromName;

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
      // Labels-then-values layout: "Part name" alone, more labels, then the values.
      // The first line after the label block is the part name.
      else if (/^Part\s+name$/i.test(line)) partName = cmmHeaderValueAfter(lines, i);
    }

    if (!dateStr) {
      var dm = line.match(/^(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)$/i);
      if (dm) dateStr = dm[1].trim();
    }

    if (partName && dateStr) break;
  }

  return { partName: partName, dateStr: dateStr };
}

var CMM_HEADER_LABEL_RE = /^\d*\s*(Part\s+name|Order\s+number|Part\s+ident|Operator|Time\/Date|Drawing\s+(no\.?|number))$/i;

function cmmHeaderValueAfter(lines, i) {
  for (var j = i + 1; j < lines.length; j++) {
    if (CMM_HEADER_LABEL_RE.test(lines[j])) continue;
    // Blank values are skipped in the report, so this line may belong to a
    // later field (operator, date…). Part numbers have digits — trust only those.
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(lines[j])) return '';
    return /\d/.test(lines[j]) ? lines[j] : '';
  }
  return '';
}

PSB.parseCmmHeader = parseCmmHeader;
