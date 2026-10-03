/**
 * export.test.js — Export / override consistency tests
 *
 * Guards against the screen showing one value while the export sends another.
 */

window.TEST = window.TEST || {};

TEST.runExportTests = function(log) {
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

  function globals(extra) {
    return Object.assign(PSB.defaultGlobals(), { importUnits: 'mm', exportUnits: 'inch' }, extra || {});
  }
  function row(spec, tol, extraRaw) {
    return PSB.createRow(Object.assign({ dimTag: '1', drawingSpec: spec, nominal: spec, tolerance: tol }, extraRaw || {}));
  }
  function exp(r, g, op) {
    PSB.recompute(r, g);
    return PSB.getExportData(r, op || 50, g);
  }

  var g, r, e;

  // Typed OUT spec with no OP2000 value
  g = globals(); r = row('', '');
  r.user.overrides.outputSpec = '12.7';
  r.user.overrides.outputTolPlus = '0.05'; r.user.overrides.outputTolMinus = '0.05';
  e = exp(r, g);
  assertEq('Typed OUT spec exports (no OP2000 value)', e['Drawing Spec'], '.5000');
  assertEq('Typed OUT tol exports (no OP2000 value)', e['Tol ±'], '.0020');

  // Typed OUT Nominal
  g = globals(); r = row('10', '0.1');
  r.user.overrides.outNominal = '9.95';
  e = exp(r, g);
  assertEq('Typed OUT Nominal exports', e['Nom Dim'], '.3917');
  assertEq('Typed OUT Nominal leaves Drawing Spec alone', e['Drawing Spec'], '.3937');

  // Angles never unit-converted
  g = globals(); r = row('45', '0.5', { specUnit2: '°' });
  e = exp(r, g);
  assertEq('Angle spec not converted', e['Drawing Spec'], '45.000');
  assertEq('Angle tol not converted', e['Tol ±'], '.500');

  // Pin/Gage follows typed OUT spec
  g = globals(); r = row('5', '0.01');
  r.user.pinGageEnabled = true; r.user.overrides.outputSpec = '6';
  PSB.recompute(r, g);
  assertEq('Pin/Gage uses typed OUT spec', r.computed.pinGage, 'P(Ø5.990+ | Ø6.010-)');
  assertEq('OUT Nominal display follows typed OUT spec', r.computed.outNominal, '6.000 [.2362]');

  // Plating on typed OUT spec: math not applied, shown as "=value+2xI"
  g = globals({ platingThickness: 0.01 }); r = row('10', '0.1');
  r.user.platingMode = '+2xI'; r.user.overrides.outputSpec = '10.5';
  e = exp(r, g);
  assertEq('Typed OUT spec + plating: spec unchanged', e['Drawing Spec'], '.4134');
  assertEq('Typed OUT spec + plating: Nom Dim "=value+2xI"', e['Nom Dim'], '=.4134+2xI');

  // Plating on calculated value keeps "(+2xI)" annotation (0.01" plating → 10 + 2×0.254 mm)
  g = globals({ platingThickness: 0.01 }); r = row('10', '0.1');
  r.user.platingMode = '+2xI';
  e = exp(r, g);
  assertEq('Calculated plating keeps annotation', e['Nom Dim'], '.4137 (+2xI)');

  // Notes: typed tolerance exports, title-block default never does
  g = globals(); r = row('BREAK EDGES', '');
  r.user.isNote = true;
  r.user.overrides.outputTolPlus = '0.2'; r.user.overrides.outputTolMinus = '0.2';
  e = exp(r, g);
  assertEq('Note: typed tolerance exports', e['Tol ±'], '0.2');

  r = PSB.createBalloonRow(2, { drawingSpec: 'BREAK EDGES .01', tolerance: '0.005' }, {});
  r.user.isNote = true; r.user.balloon.tolType = 'default';
  e = exp(r, g);
  assertEq('Note: title-block default tolerance not exported', e['Tol ±'], '');

  // Not-on-print rows skipped in OP2000 only
  g = globals({ ops: [2000, 50] }); r = row('10', '0.1');
  r.user.notOnPrint = true; r.user.includeOps[50] = true;
  PSB.recompute(r, g);
  var csv = PSB.generateCSV([r], [2000, 50], g).split('\n');
  assertEq('Not-on-print: skipped in OP2000, kept in OP50', csv.length, 2);
  assertEq('Not-on-print: OP50 line present', csv[1].split(',')[1], '50');

  return { passed: passed, failed: failed };
};
