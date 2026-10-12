/**
 * faiExport.js — FAI (CMM results) export
 *
 * Turns stored CMM measurements (row.fai.measurements + faiRuns) into
 * export files. Pure logic — no DOM. Rules: RULES.md §12.
 *
 * Settings live in state.globals.faiExport so they save with the project.
 */

window.PSB = window.PSB || {};

// Column order for the ProShop FAI CSV. Optional columns are dropped when off.
var FAI_PROSHOP_COLUMNS = [
  'Dim Tag #',
  'Measured',
  'Equipment Used',
  'CMM Nominal',
  'CMM Tol Upper',
  'CMM Tol Lower',
  'Deviation',
  'Pass/Fail',
  'Source Run',
  'CMM Name',
];

var FAI_ANGLE_RE = /angle|°/i;

/**
 * Default FAI export settings.
 */
function defaultFaiExportSettings() {
  return {
    format: 'csv',              // only CSV for now
    template: 'proshop',        // only ProShop for now
    runMode: 'all',             // 'all' | 'pick' | 'combine'
    runs: [],                   // ordered [{ id, on }] — order = rank for 'combine'
    fileMode: 'one',            // 'one' | 'perRun' (all / pick only)
    units: 'print',             // 'print' | 'inch' | 'mm' | 'cmm'
    precision: 'unitDefault',   // 'unitDefault' | 'print' | 'fixed'
    fixedDecimals: 4,
    applyTagCorrections: true,  // use re-tagged / assigned dim tags
    includeUnmatched: false,    // CMM rows with no plan dim tag
    duplicates: 'worst',        // 'all' | 'worst' | 'first' | 'last' — many values on one tag
    missingDims: 'skip',        // 'skip' | 'blank' — plan dims with no measurement
    includeEquipment: true,
    equipment: 'CMM008',
    includeCmmNominal: true,
    includeCmmTol: true,
    includeDeviation: false,
    includePassFail: false,
    includeSourceRun: false,
    includeCmmName: false,
    fileNamePattern: '{part}_FAI',
    partNumber: '',             // typed Part # for {part}; blank = auto
  };
}

/**
 * Saved settings merged over defaults, with the run list synced to the
 * runs that exist now (deleted runs dropped, new runs added on).
 */
function getFaiExportSettings(globals, faiRuns) {
  var s = Object.assign(defaultFaiExportSettings(), (globals && globals.faiExport) || {});
  var existing = {};
  (faiRuns || []).forEach(function(r) { existing[r.id] = true; });
  var seen = {};
  var runs = [];
  (s.runs || []).forEach(function(r) {
    if (existing[r.id] && !seen[r.id]) { runs.push({ id: r.id, on: r.on !== false }); seen[r.id] = true; }
  });
  (faiRuns || []).forEach(function(r) {
    if (!seen[r.id]) runs.push({ id: r.id, on: true });
  });
  s.runs = runs;
  return s;
}

// ── Helpers ───────────────────────────────────────────────

function faiRunById(faiRuns, id) {
  for (var i = 0; i < (faiRuns || []).length; i++) {
    if (faiRuns[i].id === id) return faiRuns[i];
  }
  return null;
}

/** Runs the settings select, in rank order. */
function faiSelectedRuns(s, faiRuns) {
  if (s.runMode === 'all') return (faiRuns || []).slice();
  var out = [];
  s.runs.forEach(function(r) {
    var run = r.on ? faiRunById(faiRuns, r.id) : null;
    if (run) out.push(run);
  });
  return out;
}

/**
 * Dim tag a measurement exports under.
 * Corrections on → the plan row it sits on now.
 * Corrections off → the tag the CMM gave it (null = unmatched).
 */
function faiMeasurementTag(row, m, applyCorrections) {
  if (applyCorrections || !Object.prototype.hasOwnProperty.call(m, 'originalTag')) {
    return String(row.computed.dimTag);
  }
  return m.originalTag == null ? null : String(m.originalTag);
}

/** Fraction of the tolerance band used (bigger = worse). */
function faiBandUsed(entry) {
  var m = entry.m;
  var lim = entry.row
    ? PSB.getFaiLimits(entry.row.computed, m, 'op2000')
    : { nominal: m.nominal, plusTol: m.plusTol, minusTol: m.minusTol };
  var dev = m.measured - lim.nominal;
  var tol = dev >= 0 ? lim.plusTol : lim.minusTol;
  if (!tol) return dev === 0 ? 0 : Infinity;
  return Math.abs(dev) / tol;
}

function faiPickDuplicates(list, rule) {
  if (list.length <= 1 || rule === 'all') return list;
  if (rule === 'first') return [list[0]];
  if (rule === 'last') return [list[list.length - 1]];
  var worst = list[0];
  var worstScore = faiBandUsed(worst);
  for (var i = 1; i < list.length; i++) {
    var sc = faiBandUsed(list[i]);
    if (sc > worstScore) { worst = list[i]; worstScore = sc; }
  }
  return [worst];
}

function faiTagSortKey(tag) {
  var n = parseFloat(tag);
  return isFinite(n) ? n : Number.MAX_VALUE;
}

function faiCsvCell(v) {
  var str = v == null ? '' : String(v);
  if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0 || str.indexOf('\n') >= 0) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function faiSafeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'FAI';
}

// ── Gather ────────────────────────────────────────────────

/**
 * Every measurement from the given runs, tagged for export.
 * Matched values are stored in print units; unmatched rows are raw CMM units.
 */
function faiGatherEntries(state, runs, s) {
  var printUnits = PSB.getPrintUnits(state.globals);
  var rank = {};
  runs.forEach(function(r, i) { rank[r.id] = i; });
  var entries = [];
  var planTags = {};
  state.rows.forEach(function(row) { planTags[String(row.computed.dimTag)] = true; });

  state.rows.forEach(function(row) {
    if (!row.fai || !row.fai.measurements) return;
    row.fai.measurements.forEach(function(m) {
      if (!(m.runId in rank)) return;
      var tag = faiMeasurementTag(row, m, s.applyTagCorrections);
      entries.push({
        tag: tag,
        matched: tag !== null && planTags[tag] === true,
        row: row,
        m: m,
        runId: m.runId,
        fromUnits: printUnits,
        isAngle: FAI_ANGLE_RE.test(m.cmmName || '') || !!row.computed.isAngle,
      });
    });
  });

  if (s.includeUnmatched) {
    runs.forEach(function(run) {
      (run.unmatchedRows || []).forEach(function(u) {
        entries.push({
          tag: u.dimTag == null ? null : String(u.dimTag),
          matched: false,
          row: null,
          m: u,
          runId: run.id,
          fromUnits: run.units || 'mm',
          isAngle: FAI_ANGLE_RE.test(u.cmmName || ''),
        });
      });
    });
  }
  // Uncorrected tags that point nowhere are unmatched, not dropped silently
  return entries.filter(function(e) { return e.matched || s.includeUnmatched; });
}

/**
 * Pick the entries for one file.
 * Combine: each dim tag comes from the highest-ranked run that has it.
 * Otherwise: every run keeps its own values.
 */
function faiSelectEntries(entries, runs, s, combine) {
  var rank = {};
  runs.forEach(function(r, i) { rank[r.id] = i; });

  var matched = entries.filter(function(e) { return e.matched; });
  var unmatched = entries.filter(function(e) { return !e.matched; });

  var groups = {}; // key → entries
  var order = [];
  matched.forEach(function(e) {
    var key = combine ? e.tag : e.runId + '|' + e.tag;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(e);
  });

  var picked = [];
  order.forEach(function(key) {
    var list = groups[key];
    if (combine) {
      var best = Math.min.apply(null, list.map(function(e) { return rank[e.runId]; }));
      list = list.filter(function(e) { return rank[e.runId] === best; });
    }
    picked = picked.concat(faiPickDuplicates(list, s.duplicates));
  });

  picked.sort(function(a, b) {
    var d = faiTagSortKey(a.tag) - faiTagSortKey(b.tag);
    if (d) return d;
    if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
    return rank[a.runId] - rank[b.runId];
  });

  return picked.concat(unmatched);
}

// ── Format ────────────────────────────────────────────────

function faiTargetUnits(s, entry, run, printUnits) {
  if (s.units === 'cmm') return (run && run.units) || 'mm';
  if (s.units === 'inch' || s.units === 'mm') return s.units;
  return printUnits;
}

function faiDecimals(s, entry, target, globals) {
  if (s.precision === 'fixed') {
    var n = parseInt(s.fixedDecimals, 10);
    return isFinite(n) && n >= 0 ? Math.min(n, 8) : 4;
  }
  var converted = !entry.isAngle && entry.fromUnits !== target;
  if (s.precision === 'print' && entry.row && !converted) {
    var d = PSB.countDecimals(entry.row.computed.op2000DrawingSpec);
    if (d !== null) return d;
  }
  return target === 'mm' ? (globals.mmPrecision != null ? globals.mmPrecision : 3)
                         : (globals.inchPrecision != null ? globals.inchPrecision : 4);
}

function faiPassFail(entry) {
  var status = entry.m.status;
  if (!status) {
    var m = entry.m;
    status = PSB.computeFaiStatus(m.measured, m.nominal, m.plusTol, m.minusTol);
  }
  return status === 'fail' ? 'FAIL' : 'PASS';
}

/** Which columns this file gets. */
function faiColumns(s, multiRunFile) {
  return FAI_PROSHOP_COLUMNS.filter(function(c) {
    if (c === 'Equipment Used') return s.includeEquipment;
    if (c === 'CMM Nominal') return s.includeCmmNominal;
    if (c === 'CMM Tol Upper' || c === 'CMM Tol Lower') return s.includeCmmTol;
    if (c === 'Deviation') return s.includeDeviation;
    if (c === 'Pass/Fail') return s.includePassFail;
    // Many runs in one file without Source Run = duplicate tags you can't tell apart
    if (c === 'Source Run') return s.includeSourceRun || multiRunFile;
    if (c === 'CMM Name') return s.includeCmmName;
    return true;
  });
}

function faiEntryRecord(entry, s, state, runsById) {
  var g = state.globals;
  var run = runsById[entry.runId];
  var target = faiTargetUnits(s, entry, run, PSB.getPrintUnits(g));
  var dec = faiDecimals(s, entry, target, g);
  var m = entry.m;
  function val(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    var out = entry.isAngle ? v : PSB.convertUnits(v, entry.fromUnits, target);
    var str = PSB.formatPrecision(out, dec);
    return /^-0(\.0*)?$/.test(str) ? str.slice(1) : str;
  }
  return {
    'Dim Tag #': entry.tag == null ? '' : PSB.generateOutputTag(entry.tag, '', true),
    'Measured': val(m.measured),
    'Equipment Used': (m.equipment || '').trim() || s.equipment || '',
    'CMM Nominal': val(m.nominal),
    'CMM Tol Upper': val(m.plusTol),
    'CMM Tol Lower': typeof m.minusTol === 'number' ? val(-Math.abs(m.minusTol)) : '',
    'Deviation': val(m.deviation),
    'Pass/Fail': faiPassFail(entry),
    'Source Run': run ? (run.label || run.fileName || run.id) : '',
    'CMM Name': m.cmmName || '',
  };
}

/** Blank rows for plan dims that got no value in this file. */
function faiMissingRecords(state, picked, runLabel) {
  var have = {};
  picked.forEach(function(e) { if (e.matched) have[e.tag] = true; });
  var out = [];
  state.rows.forEach(function(row) {
    var tag = String(row.computed.dimTag);
    if (row.user.notOnPrint || have[tag] || tag === '') return;
    have[tag] = true;
    out.push({ sortKey: faiTagSortKey(tag), tag: tag, rec: {
      'Dim Tag #': PSB.generateOutputTag(tag, '', true),
      'Source Run': runLabel || '',
    } });
  });
  return out;
}

/** {part} when none is typed: CMM report header, then project file name. */
function faiAutoPartName(state) {
  var part = (state.globals.cmmPartName || '').trim();
  if (!part && PSB.getProjectFileName) {
    part = (PSB.getProjectFileName() || '').replace(/\.[^.]+$/, '');
  }
  return part;
}

function faiFileName(s, state, runLabel) {
  var part = (s.partNumber || '').trim() || faiAutoPartName(state);
  var d = new Date();
  var date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  var pattern = s.fileNamePattern || '{part}_FAI';
  if (runLabel && pattern.indexOf('{run}') < 0) pattern += '_{run}';
  var name = pattern
    .replace(/\{part\}/g, part || 'Part')
    .replace(/\{date\}/g, date)
    .replace(/\{run\}/g, runLabel || '');
  return faiSafeFileName(name.replace(/_+$/, '')) + '.csv';
}

// ── Build ─────────────────────────────────────────────────

/**
 * Build the FAI export.
 *
 * @param {Object} state — { rows, globals, faiRuns }
 * @param {Object} [settings] — defaults to the saved settings
 * @returns {{ files: Array<{fileName, headers, records, csv}>, warnings: string[] }}
 */
function buildFaiExport(state, settings) {
  var s = settings || getFaiExportSettings(state.globals, state.faiRuns);
  var runs = faiSelectedRuns(s, state.faiRuns);
  var warnings = [];
  if (runs.length === 0) {
    return { files: [], warnings: ['No CMM runs selected.'] };
  }

  var runsById = {};
  runs.forEach(function(r) { runsById[r.id] = r; });

  var combine = s.runMode === 'combine';
  var groups;
  if (combine) groups = [{ runs: runs, label: runs.length > 1 ? 'Combined' : (runs[0].label || '') }];
  else if (s.fileMode === 'perRun') groups = runs.map(function(r) { return { runs: [r], label: r.label || r.fileName || r.id }; });
  else groups = [{ runs: runs, label: runs.length > 1 ? '' : (runs[0].label || '') }];

  var files = [];
  var usedNames = {};
  groups.forEach(function(gr) {
    var entries = faiGatherEntries(state, gr.runs, s);
    var picked = faiSelectEntries(entries, gr.runs, s, combine);
    var multiRunFile = !combine && gr.runs.length > 1;
    var headers = faiColumns(s, multiRunFile);

    var records = picked.map(function(e) {
      return { sortKey: e.matched ? faiTagSortKey(e.tag) : Infinity, rec: faiEntryRecord(e, s, state, runsById) };
    });

    if (s.missingDims === 'blank') {
      if (multiRunFile) {
        gr.runs.forEach(function(run) {
          var mine = picked.filter(function(e) { return e.runId === run.id; });
          records = records.concat(faiMissingRecords(state, mine, run.label || run.fileName || run.id));
        });
      } else {
        records = records.concat(faiMissingRecords(state, picked, ''));
      }
      // Stable sort keeps run order inside a tag
      records = records.map(function(r, i) { r.i = i; return r; }).sort(function(a, b) {
        return (a.sortKey - b.sortKey) || (a.i - b.i);
      });
    }

    var recs = records.map(function(r) { return r.rec; });
    var lines = [headers.map(faiCsvCell).join(',')];
    recs.forEach(function(rec) {
      lines.push(headers.map(function(h) { return faiCsvCell(rec[h]); }).join(','));
    });

    var label = (s.fileMode === 'perRun' || combine) ? gr.label : '';
    var name = faiFileName(s, state, label);
    var base = name.replace(/\.csv$/, '');
    for (var n = 2; usedNames[name]; n++) name = base + '_' + n + '.csv';
    usedNames[name] = true;

    if (recs.length === 0) warnings.push(name + ': no measured values to export.');
    files.push({ fileName: name, headers: headers, records: recs, csv: lines.join('\n') });
  });

  return { files: files, warnings: warnings };
}

// ── Export to namespace ───────────────────────────────────
PSB.FAI_PROSHOP_COLUMNS = FAI_PROSHOP_COLUMNS;
PSB.defaultFaiExportSettings = defaultFaiExportSettings;
PSB.getFaiExportSettings = getFaiExportSettings;
PSB.buildFaiExport = buildFaiExport;
PSB.faiAutoPartName = faiAutoPartName;
