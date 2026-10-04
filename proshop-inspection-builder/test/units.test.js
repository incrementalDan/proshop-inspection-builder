/**
 * units.test.js — Print units: detection, live title block, safe unit change
 * Rules: RULES.md §10
 */

window.TEST = window.TEST || {};

TEST.runUnitsTests = function(log) {
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

  function rowsFrom(csv) {
    return PSB.parseCSV(csv).map(function(raw) { return PSB.createRow(raw); });
  }
  var d;

  // ── Detection ───────────────────────────────────────────
  d = PSB.detectPrintUnits(PSB.unitSamplesFromRows(rowsFrom(TEST.GC_INCH_SAMPLE_CSV)));
  assertEq('Detect: real inch GC file → inch', d.units, 'inch');
  assertEq('Detect: real inch GC file → high confidence', d.confidence, 'high');

  d = PSB.detectPrintUnits(PSB.unitSamplesFromRows(rowsFrom(TEST.SAMPLE_INPUT_CSV)));
  assertEq('Detect: mm sample file → mm', d.units, 'mm');
  assertEq('Detect: mm sample file → high confidence', d.confidence, 'high');

  d = PSB.detectPrintUnits([], 'UNLESS OTHERWISE SPECIFIED DIMENSIONS ARE IN INCHES');
  assertEq('Detect: title block text → inch', d.units, 'inch');
  d = PSB.detectPrintUnits([{ spec: '.390', tol: '0.005' }], 'DIMENSIONS ARE IN MILLIMETERS');
  assertEq('Detect: title block beats values', d.units, 'mm');

  var angleRow = PSB.createRow({ dimTag: '8', drawingSpec: '90', specUnit2: '°', tolerance: '0.5' });
  assertEq('Detect: angles ignored', PSB.unitSamplesFromRows([angleRow]).length, 0);

  d = PSB.detectPrintUnits([]);
  assertEq('Detect: nothing to go on → none', d.confidence, 'none');
  assertEq('Detect: nothing to go on → no guess', d.units, null);

  d = PSB.detectPrintUnits([{ spec: '5', tol: '' }]);
  assertEq('Detect: whole numbers alone → no guess', d.units, null);

  // ── Title block default follows units live ─────────────
  var g = Object.assign(PSB.defaultGlobals(), { importUnits: 'inch', titleBlockTolUnits: 'inch', titleBlockTol3d: '0.005' });
  var r = PSB.createBalloonRow(1, { drawingSpec: '.390', tolerance: '0.005' }, {});
  r.user.balloon.tolType = 'default';
  PSB.recompute(r, g);
  assertEq('Title block: inch print, inch title block', r.computed.op2000Tolerance, '0.005');
  g.importUnits = 'mm';
  PSB.recompute(r, g);
  assertEq('Title block: relabel to mm → converted live, not stale', r.computed.op2000Tolerance, '0.127');
  g.titleBlockTol3d = '0.010';
  g.importUnits = 'inch';
  PSB.recompute(r, g);
  assertEq('Title block: edit title block → row follows', r.computed.op2000Tolerance, '0.010');

  // ── Changing print units keeps all work ────────────────
  var gi = Object.assign(PSB.defaultGlobals(), { importUnits: 'mm', exportUnits: 'inch' });
  var rows = rowsFrom(TEST.GC_INCH_SAMPLE_CSV);
  rows[0].user.platingMode = '+2xI';
  rows[0].user.inspectionFrequency = '1 in 50';
  rows[0].user.overrides.outputSpec = '.395';
  rows.forEach(function(x) { PSB.recompute(x, gi); });
  gi.importUnits = 'inch';   // relabel: user had it wrong
  rows.forEach(function(x) { PSB.recompute(x, gi); });
  assertEq('Relabel: raw value untouched', rows[0].raw.drawingSpec, '.390');
  assertEq('Relabel: plating kept', rows[0].user.platingMode, '+2xI');
  assertEq('Relabel: frequency kept', rows[0].computed.outputTag, 'HREF-01');
  assertEq('Relabel: typed value kept as typed', rows[0].user.overrides.outputSpec, '.395');
  assertEq('Relabel: export now correct', PSB.getExportData(rows[1], 50, gi)['Drawing Spec'], '3.846');

  var typed = PSB.listTypedValues(rows);
  assertEq('Typed values listed for review', typed.length, 1);
  assertEq('Typed value key', typed[0].key, 'outputSpec');

  var n = PSB.convertTypedValues(rows, 'inch', 'mm', gi);
  assertEq('Convert typed: count', n, 1);
  assertEq('Convert typed: value', rows[0].user.overrides.outputSpec, '10.033');

  return { passed: passed, failed: failed };
};
