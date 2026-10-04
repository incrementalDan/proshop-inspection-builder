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
  assertEq('Typed OUT Nominal exports exactly as typed', e['Nom Dim'], '9.95');
  assertEq('Typed OUT Nominal leaves Drawing Spec alone', e['Drawing Spec'], '.3937');

  // Angles never unit-converted
  g = globals(); r = row('45', '0.5', { specUnit2: '°' });
  e = exp(r, g);
  assertEq('Angle spec not converted, as printed', e['Drawing Spec'], '45');
  assertEq('Angle tol not converted, as printed', e['Tol ±'], '.5');

  // Pin/Gage follows typed OUT spec
  g = globals(); r = row('5', '0.01');
  r.user.pinGageEnabled = true; r.user.overrides.outputSpec = '6';
  PSB.recompute(r, g);
  assertEq('Pin/Gage uses typed OUT spec', r.computed.pinGage, 'P(Ø5.99+ | Ø6.01-)');
  assertEq('Pin/Gage on: OUT Nominal display = pin/gage from typed OUT spec', r.computed.outNominal, 'P(Ø5.99+ | Ø6.01-)');
  r.user.pinGageEnabled = false; PSB.recompute(r, g);
  assertEq('OUT Nominal display follows typed OUT spec', r.computed.outNominal, '6 [.2362]');

  // Pin/Gage never uses OUT Nominal (free field)
  g = globals(); r = row('5', '0.01');
  r.user.pinGageEnabled = true; r.user.overrides.outNominal = '7';
  PSB.recompute(r, g);
  assertEq('Pin/Gage ignores typed OUT Nominal', r.computed.pinGage, 'P(Ø4.99+ | Ø5.01-)');

  // Pin/Gage on → Nom Dim = pin/gage even if an old typed OUT Nominal exists
  g = globals(); r = row('5', '0.01');
  r.user.pinGageEnabled = true; r.user.overrides.outNominal = 'OLD';
  e = exp(r, g);
  assertEq('Pin/Gage on: OUT Nominal display = pin/gage', r.computed.outNominal, 'P(Ø4.99+ | Ø5.01-)');
  assertEq('Pin/Gage on: Nom Dim export = pin/gage', e['Nom Dim'], 'P(Ø.1965+ | Ø.1972-)');

  // Plating on typed OUT spec: math applied same as calculated rows (10.5 + 2×0.254 mm)
  g = globals({ platingThickness: 0.01 }); r = row('10', '0.1');
  r.user.platingMode = '+2xI'; r.user.overrides.outputSpec = '10.5';
  e = exp(r, g);
  assertEq('Typed OUT spec + plating: spec plated', e['Drawing Spec'], '.4334');
  assertEq('Typed OUT spec + plating: Nom Dim plated + annotation', e['Nom Dim'], '.4334 (+2xI)');
  assertEq('Typed OUT spec + plating: OUT Nominal display plated', r.computed.outNominal, '11.008 (+2xI) [.4334]');

  // Pin/Gage exported in export units (screen stays in import units)
  g = globals(); r = row('5', '0.01');
  r.user.pinGageEnabled = true;
  e = exp(r, g);
  assertEq('Pin/Gage screen in import units', r.computed.pinGage, 'P(Ø4.99+ | Ø5.01-)');
  assertEq('Pin/Gage export in export units', e['Nom Dim'], 'P(Ø.1965+ | Ø.1972-)');
  r.user.overrides.pinGageValue = 'P(Ø.19+ | Ø.20-)';
  e = exp(r, g);
  assertEq('Typed Pin/Gage exported as typed', e['Nom Dim'], 'P(Ø.19+ | Ø.20-)');

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
