/**
 * cmm.test.js — CMM report parsing + FAI pass/fail limits
 * Rules: RULES.md §11
 */

window.TEST = window.TEST || {};

TEST.runCmmTests = function(log) {
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

  // ── Header ──────────────────────────────────────────────
  assertEq('Header: part name from labels-then-values layout',
    PSB.parseCmmHeader(TEST.CMM_CALYPSO_SAMPLE).partName, 'PART-0000 - Sample Part');
  assertEq('Header: part name on the same line',
    PSB.parseCmmHeader('Part name ABC-123 Rev B\n').partName, 'ABC-123 Rev B');
  assertEq('Header: blank part name stays blank',
    PSB.parseCmmHeader('Part name\nOrder number\nTime/Date\n10/1/2026 9:07 AM\n').partName, '');

  assertEq('Header: blank part name not filled by the operator',
    PSB.parseCmmHeader('Part name\nOrder number\nOperator\nTime/Date\nMaster\n10/1/2026 9:07 AM\n').partName, '');
  assertEq('Header: unknown label not taken as part name',
    PSB.parseCmmHeader('Part name\nCustomer\nPART-1\n').partName, '');

  // ── Unilateral tolerance ────────────────────────────────
  var uni = PSB.parseCmmText('#4 Diameter_Bore 10.00700 10.00000 0.01000 0.00500 0.00700\n')[0];
  assertEq('Unilateral: +Tol kept', uni.plusTol, 0.01);
  assertEq('Unilateral: positive -Tol → lower limit above nominal', uni.minusTol, -0.005);
  assertEq('Unilateral: inside zone passes', PSB.computeFaiStatus(10.007, 10, 0.01, -0.005), 'pass');
  assertEq('Unilateral: at nominal fails (below lower limit)', PSB.computeFaiStatus(10.0, 10, 0.01, -0.005), 'fail');
  assertEq('Symmetric -Tol still a positive magnitude',
    PSB.parseCmmText('#4 X 1.00000 1.00000 0.00500 -0.00500 0.00000\n')[0].minusTol, 0.005);

  // ── Print units change after import ─────────────────────
  var urow = { computed: { isAngle: false }, fai: { measurements: [
    { cmmName: '#1 Diameter', measured: 1, nominal: 1, deviation: 0, plusTol: 0.01, minusTol: 0.01, units: 'inch' },
    { cmmName: '#1 Cone Angle', measured: 90, nominal: 90, deviation: 0, plusTol: 0.5, minusTol: 0.5, units: 'inch' },
    { cmmName: '#1 Old', measured: 2, nominal: 2, deviation: 0, plusTol: 0.1, minusTol: 0.1 },
  ] } };
  PSB.syncFaiUnits(urow, 'mm');
  var um = urow.fai.measurements;
  assertEq('Units change: measurement converted inch → mm', um[0].measured.toFixed(3) + '/' + um[0].plusTol.toFixed(3), '25.400/0.254');
  assertEq('Units change: angle not converted', um[1].measured, 90);
  assertEq('Units change: old measurement assumed print units', um[2].measured + ' ' + um[2].units, '2 mm');
  PSB.syncFaiUnits(urow, 'inch');
  assertEq('Units change: back again', um[0].measured.toFixed(5), '1.00000');

  // ── Parsing ─────────────────────────────────────────────
  var rows = PSB.parseCmmText(TEST.CMM_CALYPSO_SAMPLE);
  assertEq('Parse: every measured value becomes a row', rows.length, 27);

  function tagsOf(name) {
    return rows.filter(function(r) { return r.cmmName === name; }).map(function(r) { return r.dimTag; }).join(',');
  }
  function find(name) {
    for (var i = 0; i < rows.length; i++) if (rows[i].cmmName === name) return rows[i];
    return null;
  }

  // Stacked block: one label line, values on the following lines
  assertEq('Stacked: first label keeps its own tag (#1)', tagsOf('#1 X Value_Cylinder1'), '1');
  assertEq('Stacked: 2nd label → 2nd value line', find('#16 Y Value_Cylinder1').measured, -1.18472);
  assertEq('Stacked: 3rd label → 3rd value line', find('#7 Diameter_Cylinder1').measured, 0.14222);
  assertEq('Stacked: last label → last value line', find('#7 Diameter_Cylinder6').measured, 0.14217);
  assertEq('Stacked: all 6 hole diameters tagged #7',
    rows.filter(function(r) { return r.dimTag === 7; }).length, 6);

  // First "#" wins
  assertEq('First #: "#8 Cone Angle_#8 COUNTERSINK" → 8', tagsOf('#8 Cone Angle_#8 COUNTERSINK'), '8');
  assertEq('First #: "#23 Dia #5 hole" → 23', PSB.cmmDimTagFromName('#23 Dia #5 hole'), 23);
  assertEq('First #: name with no # → null', tagsOf('Z Value_SM slot pocket Depth'), '');
  assertEq('First #: no # → dimTag null', find('Z Value_SM slot pocket Depth').dimTag, null);

  // Column order: measured, nominal, +tol, -tol (stored positive), deviation
  var d9 = find('#9 Diameter_Cone addition1');
  assertEq('Columns: measured', d9.measured, 0.24571);
  assertEq('Columns: nominal', d9.nominal, 0.24803);
  assertEq('Columns: -tol stored positive', d9.minusTol, 0.008);

  // Header-only line (one number) is not a row
  assertEq('Header "#7 .142 holes and locations" skipped', find('#7 .142 holes and locations'), null);

  // ── Pass/fail limits ────────────────────────────────────
  var m = { measured: 0.24613, nominal: 0.24803, plusTol: 0.008, minusTol: 0.008 };

  // Plan has no tolerance (e.g. "⌄ .248") → grade with the CMM's own limits
  var noTol = { op2000Nominal: 0.248, op2kTolPlus: 0, op2kTolMinus: 0 };
  assertEq('No plan tol → uses CMM limits', PSB.getFaiLimits(noTol, m, 'op2000').source, 'cmm');
  assertEq('No plan tol → in-tol CMM value PASSes', PSB.computeFaiMeasurementStatus(noTol, m, 'op2000', 0.8), 'pass');

  // Plan has a tolerance → plan wins
  var tight = { op2000Nominal: 0.248, op2kTolPlus: 0.001, op2kTolMinus: 0.001 };
  assertEq('Plan tol → uses plan limits', PSB.getFaiLimits(tight, m, 'op2000').source, 'plan');
  assertEq('Plan tol → graded against plan (FAIL at ±.001)', PSB.computeFaiMeasurementStatus(tight, m, 'op2000', 0.8), 'fail');

  // No numeric nominal (note) → CMM limits
  var note = { op2000Nominal: 'MATERIAL', op2kTolPlus: 0.005, op2kTolMinus: 0.005 };
  assertEq('Non-numeric plan nominal → uses CMM limits', PSB.getFaiLimits(note, m, 'op2000').source, 'cmm');

  // Stored statuses match the table
  var row = { computed: noTol, fai: { measurements: [
    { measured: 0.24571, nominal: 0.24803, plusTol: 0.008, minusTol: 0.008 },
    { measured: 0.25514, nominal: 0.24803, plusTol: 0.008, minusTol: 0.008 },
  ] } };
  PSB.refreshFaiStatus(row, 0.8);
  assertEq('refreshFaiStatus: child 1 pass', row.fai.measurements[0].status, 'pass');
  assertEq('refreshFaiStatus: child 2 warn (89% of band)', row.fai.measurements[1].status, 'warn');
  assertEq('refreshFaiStatus: parent = worst child', row.fai.aggregateStatus, 'warn');

  return { passed: passed, failed: failed };
};
