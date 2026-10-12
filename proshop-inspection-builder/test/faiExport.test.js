/**
 * faiExport.test.js — FAI (CMM results) export
 * Rules: RULES.md §12
 */

window.TEST = window.TEST || {};

TEST.runFaiExportTests = function(log) {
  var passed = 0;
  var failed = 0;

  function assertEq(desc, actual, expected) {
    if (actual === expected) {
      log('<div class="test pass">✓ ' + desc + '</div>');
      passed++;
    } else {
      log('<div class="test fail">✗ ' + desc + ' — got "' + actual + '", expected "' + expected + '"</div>');
      failed++;
    }
  }

  function meas(runId, name, measured, nominal, tol, extra) {
    return Object.assign({
      runId: runId, cmmName: name, measured: measured, nominal: nominal,
      deviation: parseFloat((measured - nominal).toFixed(5)), plusTol: tol, minusTol: tol,
      status: null, equipment: '', notes: '',
    }, extra || {});
  }

  // Inch print. Tags 7 (Ø.142 ±.005), 9 (.248 ±.008), 12 (.500 ±.005, never measured)
  function makeState() {
    var g = Object.assign(PSB.defaultGlobals(), { importUnits: 'inch', printUnitsConfirmed: true, cmmPartName: 'PART-0000' });
    var rows = [
      PSB.createRow({ dimTag: '7', drawingSpec: '.142', nominal: '.142', tolerance: '.005' }),
      PSB.createRow({ dimTag: '9', drawingSpec: '.248', nominal: '.248', tolerance: '.008' }),
      PSB.createRow({ dimTag: '12', drawingSpec: '.500', nominal: '.500', tolerance: '.005' }),
    ];
    rows.forEach(function(r) { PSB.recompute(r, g); });
    rows[0].fai = { measurements: [
      meas('A', '#7 Diameter_Cyl1', 0.1422, 0.142, 0.005),
      meas('A', '#7 Diameter_Cyl2', 0.1460, 0.142, 0.005),   // worst
      meas('A', '#7 Diameter_Cyl3', 0.1418, 0.142, 0.005),
      meas('B', '#7 Diameter_Cyl1', 0.1430, 0.142, 0.005),
    ] };
    // Typed as #19 on the CMM, re-tagged to 9
    rows[1].fai = { measurements: [
      meas('B', '#19 Diameter_Cone', 0.2457, 0.24803, 0.008, { originalTag: 19 }),
    ] };
    rows.forEach(function(r) { if (r.fai) PSB.refreshFaiStatus(r, 0.8); });
    var runs = [
      { id: 'A', label: 'Run A', units: 'inch', unmatchedRows: [
        { dimTag: null, cmmName: 'Z Value_Pocket', measured: -0.06203, nominal: -0.062, plusTol: 0.005, minusTol: 0.005, deviation: -0.00003 },
      ] },
      { id: 'B', label: 'Run B', units: 'mm', unmatchedRows: [] },
    ];
    return { rows: rows, globals: g, faiRuns: runs };
  }

  function settings(extra) {
    var st = makeState();
    return Object.assign(PSB.getFaiExportSettings(st.globals, st.faiRuns), extra || {});
  }
  function col(file, header) {
    return file.records.map(function(r) { return r[header] == null ? '' : r[header]; }).join('|');
  }

  var st, res, f;

  // ── Defaults ────────────────────────────────────────────
  var d = PSB.defaultFaiExportSettings();
  assertEq('Default: tag corrections on', d.applyTagCorrections, true);
  assertEq('Default: unmatched off', d.includeUnmatched, false);
  assertEq('Default: equipment CMM008', d.equipment, 'CMM008');
  assertEq('Default: CSV / ProShop', d.format + '/' + d.template, 'csv/proshop');

  // ── Headers ─────────────────────────────────────────────
  st = makeState();
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }, { id: 'B', on: false }] }));
  f = res.files[0];
  assertEq('Headers: default ProShop columns', f.headers.join(','),
    'Dim Tag #,Measured,Equipment Used,CMM Nominal,CMM Tol Upper,CMM Tol Lower');
  assertEq('Equipment off drops the column',
    PSB.buildFaiExport(st, settings({ includeEquipment: false })).files[0].headers.indexOf('Equipment Used'), -1);

  // ── Dim tag like OP2000, measured number only ───────────
  assertEq('Dim Tag zero-padded like OP2000, no REF', col(f, 'Dim Tag #'), '07');
  assertEq('Worst of many values on one tag (default)', col(f, 'Measured'), '0.1460');
  assertEq('Equipment Used = CMM008', col(f, 'Equipment Used'), 'CMM008');
  assertEq('CMM Tol Lower is negative', col(f, 'CMM Tol Lower'), '-0.0050');
  assertEq('CMM Nominal exported', col(f, 'CMM Nominal'), '0.1420');

  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], duplicates: 'all' }));
  assertEq('Duplicates: all keeps every value', col(res.files[0], 'Measured'), '0.1422|0.1460|0.1418');
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], duplicates: 'first' }));
  assertEq('Duplicates: first', col(res.files[0], 'Measured'), '0.1422');

  // ── Run modes ───────────────────────────────────────────
  res = PSB.buildFaiExport(st, settings({ runMode: 'all', fileMode: 'one' }));
  f = res.files[0];
  assertEq('All runs, one file: Source Run column added', f.headers.indexOf('Source Run') > 0, true);
  assertEq('All runs, one file: each run keeps its values', col(f, 'Dim Tag #') + ' / ' + col(f, 'Source Run'), '07|07|09 / Run A|Run B|Run B');

  res = PSB.buildFaiExport(st, settings({ runMode: 'all', fileMode: 'perRun' }));
  assertEq('All runs, one file per run', res.files.length, 2);
  assertEq('Per-run file name has run label', res.files[0].fileName, 'PART-0000_FAI_Run A.csv');

  // Combine: B primary, A fills gaps (A has no tag 9; B has 7 and 9)
  res = PSB.buildFaiExport(st, settings({ runMode: 'combine', runs: [{ id: 'B', on: true }, { id: 'A', on: true }] }));
  assertEq('Combine: primary run wins', col(res.files[0], 'Measured'), '0.1430|0.2457');
  // Combine: A primary, B fills tag 9
  res = PSB.buildFaiExport(st, settings({ runMode: 'combine', runs: [{ id: 'A', on: true }, { id: 'B', on: true }] }));
  assertEq('Combine: secondary fills the blanks', col(res.files[0], 'Dim Tag #') + ' ' + col(res.files[0], 'Measured'), '07|09 0.1460|0.2457');

  // ── Tag corrections ─────────────────────────────────────
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'B', on: true }], applyTagCorrections: false }));
  assertEq('Corrections off: CMM tag not in plan → dropped (unmatched off)', col(res.files[0], 'Dim Tag #'), '07');
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'B', on: true }], applyTagCorrections: false, includeUnmatched: true }));
  assertEq('Corrections off + unmatched on: original CMM tag', col(res.files[0], 'Dim Tag #'), '07|19');

  // ── Unmatched ───────────────────────────────────────────
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], includeUnmatched: true, includeCmmName: true }));
  f = res.files[0];
  assertEq('Unmatched rows go last, blank tag', col(f, 'Dim Tag #'), '07|');
  assertEq('Unmatched keeps CMM sign', f.records[1]['Measured'], '-0.0620');
  assertEq('CMM Name column', f.records[1]['CMM Name'], 'Z Value_Pocket');

  // ── Units ───────────────────────────────────────────────
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], units: 'mm' }));
  assertEq('Units mm: converted, mm default 3 places', col(res.files[0], 'Measured'), '3.708');
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'B', on: true }], units: 'cmm' }));
  assertEq('Units = CMM run units (mm)', col(res.files[0], 'Measured'), '3.632|6.241');

  // Angles never converted
  st = makeState();
  st.rows[0].fai.measurements = [meas('A', '#7 Cone Angle_CSK', 89.9544, 90, 0.5)];
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], units: 'mm' }));
  assertEq('Angle not converted', col(res.files[0], 'Measured'), '89.954');

  // ── Precision ───────────────────────────────────────────
  st = makeState();
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], precision: 'print' }));
  assertEq('Precision: match print decimals', col(res.files[0], 'Measured'), '0.146');
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], precision: 'fixed', fixedDecimals: 5 }));
  assertEq('Precision: fixed 5', col(res.files[0], 'Measured'), '0.14600');

  // ── Missing dims / extras ───────────────────────────────
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], missingDims: 'blank' }));
  assertEq('Missing dims as blank rows, in tag order', col(res.files[0], 'Dim Tag #') + ' ' + col(res.files[0], 'Measured'), '07|09|12 0.1460||');
  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: true }], includePassFail: true, includeDeviation: true }));
  assertEq('Pass/Fail column', col(res.files[0], 'Pass/Fail'), 'PASS');
  assertEq('Deviation column', col(res.files[0], 'Deviation'), '0.0040');

  // ── Settings sync ───────────────────────────────────────
  st = makeState();
  st.globals.faiExport = { runs: [{ id: 'gone', on: true }, { id: 'B', on: false }], equipment: 'CMM003' };
  var s = PSB.getFaiExportSettings(st.globals, st.faiRuns);
  assertEq('Saved settings: deleted runs dropped, new runs added', s.runs.map(function(r) { return r.id + (r.on ? '+' : '-'); }).join(','), 'B-,A+');
  assertEq('Saved settings: values kept', s.equipment, 'CMM003');

  res = PSB.buildFaiExport(st, settings({ runMode: 'pick', runs: [{ id: 'A', on: false }] }));
  assertEq('No runs selected → no files + warning', res.files.length + ' ' + res.warnings.length, '0 1');

  // CSV text
  res = PSB.buildFaiExport(makeState(), settings({ runMode: 'pick', runs: [{ id: 'A', on: true }] }));
  assertEq('CSV text', res.files[0].csv,
    'Dim Tag #,Measured,Equipment Used,CMM Nominal,CMM Tol Upper,CMM Tol Lower\n07,0.1460,CMM008,0.1420,0.0050,-0.0050');

  return { passed: passed, failed: failed };
};
