/**
 * fixture.test.js — Real-file tests + one test per rule in RULES.md
 *
 * Golden test: a real Ground Control CSV run end-to-end through import →
 * recompute → export, compared line by line to a hand-checked expected CSV.
 */

window.TEST = window.TEST || {};

TEST.runFixtureTests = function(log) {
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

  function runFile(csv, globals, ops) {
    var rows = PSB.parseCSV(csv).map(function(raw) {
      var r = PSB.createRow(raw);
      for (var i = 0; i < ops.length; i++) r.user.includeOps[ops[i]] = true;
      PSB.recompute(r, globals);
      return r;
    });
    return PSB.generateCSV(rows, ops, globals);
  }

  function compareLines(desc, actual, expected) {
    var a = actual.split('\n');
    var e = expected.split('\n');
    var bad = 0;
    for (var i = 0; i < Math.max(a.length, e.length); i++) {
      if (a[i] !== e[i]) {
        bad++;
        assertEq(desc + ' line ' + (i + 1), a[i], e[i]);
      }
    }
    if (!bad) assertEq(desc + ' (' + e.length + ' lines)', true, true);
  }

  // ── Golden file: inch print ─────────────────────────────
  compareLines('GC inch print → inch export',
    runFile(TEST.GC_INCH_SAMPLE_CSV, Object.assign(PSB.defaultGlobals(), { importUnits: 'inch', exportUnits: 'inch' }), [2000, 50]),
    TEST.GC_INCH_SAMPLE_EXPECTED_INCH);
  compareLines('GC inch print → mm export',
    runFile(TEST.GC_INCH_SAMPLE_CSV, Object.assign(PSB.defaultGlobals(), { importUnits: 'inch', exportUnits: 'mm' }), [2000, 50]),
    TEST.GC_INCH_SAMPLE_EXPECTED_MM);

  // ── One-row rule tests ──────────────────────────────────
  function inchGlobals(extra) {
    return Object.assign(PSB.defaultGlobals(), { importUnits: 'inch', exportUnits: 'inch' }, extra || {});
  }
  function exp(spec, tol, g, setup, op) {
    var r = PSB.createRow({ dimTag: '3', drawingSpec: spec, nominal: spec, tolerance: tol });
    r.user.includeOps[50] = true;
    if (setup) setup(r);
    PSB.recompute(r, g);
    return PSB.getExportData(r, op || 50, g);
  }
  var e;

  // Precision — same units, no math → print decimals
  e = exp('.390', '0.005', inchGlobals());
  assertEq('Precision: same units keeps print decimals (spec)', e['Drawing Spec'], '0.390');
  assertEq('Precision: same units keeps print decimals (tol)', e['Tol ±'], '0.005');

  // Precision — same units, plating changed it → at least unit default
  e = exp('.081', '0.005', inchGlobals({ platingThickness: 0.0002 }), function(r) { r.user.platingMode = '+2xI'; });
  assertEq('Precision: plating not rounded away', e['Drawing Spec'], '0.0814');
  assertEq('Precision: plating label on Nom Dim', e['Nom Dim'], '0.0814 (+2xI)');
  assertEq('Precision: plating never touches tol', e['Tol ±'], '0.005');

  // Precision — same units, centering changed it
  e = exp('.100', '+.005 -.002', inchGlobals());
  assertEq('Precision: centered spec', e['Drawing Spec'], '0.1015');
  assertEq('Precision: centered tol', e['Tol ±'], '0.0035');

  // Precision — converted → unit default
  e = exp('.390', '0.005', inchGlobals({ exportUnits: 'mm' }));
  assertEq('Precision: inch → mm uses mm default', e['Drawing Spec'], '9.906');
  e = exp('10.0', '0.1', Object.assign(PSB.defaultGlobals(), { importUnits: 'mm', exportUnits: 'inch' }));
  assertEq('Precision: mm → inch uses inch default', e['Drawing Spec'], '0.3937');

  // Angles — as printed, never converted
  e = exp('90', '0.5', inchGlobals({ exportUnits: 'mm' }), function(r) { r.raw = Object.freeze(Object.assign({}, r.raw, { specUnit2: '°' })); });
  assertEq('Angle: spec as printed', e['Drawing Spec'], '90');
  assertEq('Angle: tol as printed', e['Tol ±'], '0.5');
  e = exp('90', '+1 -0', inchGlobals(), function(r) { r.raw = Object.freeze(Object.assign({}, r.raw, { specUnit2: '°' })); });
  assertEq('Angle: centering keeps needed decimals', e['Drawing Spec'], '90.5');

  // No tolerance → blank, not ".0000"
  e = exp('.248', '', inchGlobals());
  assertEq('No tolerance: Tol blank', e['Tol ±'], '');
  assertEq('No tolerance: spec still exported', e['Drawing Spec'], '0.248');

  // Threads → note, tolerance blank everywhere
  e = exp('M2.5 - 6H ALL', '2.5 - 6', inchGlobals());
  assertEq('Thread: OUT tol blank', e['Tol ±'], '');
  assertEq('Thread: spec text kept', e['Drawing Spec'], 'M2.5 - 6H ALL');
  e = exp('M2.5 - 6H ALL', '2.5 - 6', inchGlobals(), null, 2000);
  assertEq('Thread: OP2000 tol blank', e['Tol ±'], '');

  // Countersink symbol removed at import
  var parsed = PSB.parseCSV('Dim Tag #,Drawing Spec,Nom Dim,Tol ±\n9,⌄ .248,,');
  assertEq('Countersink symbol stripped', parsed[0].drawingSpec, '.248');

  // Counterbore ⌴ / depth ↧ move from Drawing Spec to SU1
  parsed = PSB.parseCSV('Dim Tag #,Spec Unit 1,Drawing Spec,Nom Dim,Tol ±\n5,Ø,⌴ .250,⌴ .250,0.005\n6,,↧ .120,,0.010');
  assertEq('Counterbore: removed from spec', parsed[0].drawingSpec, '.250');
  assertEq('Counterbore: added to SU1 before Ø', parsed[0].specUnit1, '⌴ Ø');
  assertEq('Counterbore: removed from Nom Dim', parsed[0].nominal, '.250');
  assertEq('Depth: removed from spec', parsed[1].drawingSpec, '.120');
  assertEq('Depth: added to SU1', parsed[1].specUnit1, '↧');
  assertEq('Balloon/OCR path: depth to SU1', PSB.parseSpecUnits('↧ .120').su1, '↧');
  e = exp('.120', '0.010', inchGlobals(), function(r) { r.raw = Object.freeze(Object.assign({}, r.raw, { specUnit1: '↧' })); });
  assertEq('Depth: exported in SU1', e['Spec Unit 1'], '↧');
  assertEq('Depth: value still exported', e['Drawing Spec'], '0.120');

  // Leading zero: screen and export match, decimals untouched
  e = exp('.390', '0.005', inchGlobals(), null, 2000);
  assertEq('Leading zero: OP2000 spec', e['Drawing Spec'], '0.390');
  assertEq('Leading zero: OP2000 Nom Dim', e['Nom Dim'], '0.390');

  // Notes: typed OUT spec drives other OPs; OP2000 keeps print text
  var setNoteOut = function(r) { r.user.overrides.outputSpec = 'MATERIAL: 6061-T6 ALUMINUM'; };
  e = exp('MATERIAL: 6061 ALUMINUM', '', inchGlobals(), setNoteOut);
  assertEq('Note: typed OUT spec on OP50', e['Drawing Spec'], 'MATERIAL: 6061-T6 ALUMINUM');
  e = exp('MATERIAL: 6061 ALUMINUM', '', inchGlobals(), setNoteOut, 2000);
  assertEq('Note: OP2000 keeps print text', e['Drawing Spec'], 'MATERIAL: 6061 ALUMINUM');
  var gcNote = PSB.createRow({ dimTag: '21', drawingSpec: 'MATERIAL: 6061 ALUMINUM', nominal: '', tolerance: '' });
  PSB.recompute(gcNote, inchGlobals());
  assertEq('Note: OP50 Nom Dim blank unless typed', PSB.getExportData(gcNote, 50, inchGlobals())['Nom Dim'], '');
  assertEq('Note: no leading zero added to note text', exp('MATERIAL .5 THK PLATE', '', inchGlobals(), null, 2000)['Drawing Spec'], 'MATERIAL .5 THK PLATE');

  // Words with no digits → note
  assertEq('No-digit text is a note', PSB.detectFeatureType('REMOVE SHARP EDGES'), 'note');

  // OP2000: Nom Dim = Drawing Spec (notes too); dim tag zero-padded
  e = exp('MATERIAL: 6061 ALUMINUM', '', inchGlobals(), null, 2000);
  assertEq('OP2000 note: Nom Dim = Drawing Spec', e['Nom Dim'], 'MATERIAL: 6061 ALUMINUM');
  assertEq('OP2000: dim tag padded', e['Dim Tag #'], '03');

  return { passed: passed, failed: failed };
};
