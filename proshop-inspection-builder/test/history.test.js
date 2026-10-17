/**
 * history.test.js — Undo snapshots and project save/load round trip.
 * Guards: datum markers survive save → load and undo.
 */

window.TEST = window.TEST || {};

TEST.runHistoryTests = function(log) {
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

  function makeState() {
    return {
      rows: PSB.parseCSV(TEST.GC_INCH_SAMPLE_CSV).map(function(raw) { return PSB.createRow(raw); }),
      globals: PSB.defaultGlobals(),
      auditLog: [],
      faiRuns: [],
      datumRefs: [],
    };
  }

  // ── Save → load keeps datum markers ─────────────────────
  var st = makeState();
  st.datumRefs.push({ id: 'datum_A_1', letter: 'A', page: 1, center: { x: 10, y: 20 }, radius: 8 });
  var loaded = PSB.loadProject(JSON.stringify({
    version: 2, globals: st.globals, auditLog: [], faiRuns: [],
    datumRefs: st.datumRefs,
    rows: st.rows.map(function(r) { return { id: r.id, raw: r.raw, user: r.user, fai: null }; }),
  }));
  assertEq('Load: datum markers restored', loaded.datumRefs.length, 1);
  assertEq('Load: datum letter kept', loaded.datumRefs[0].letter, 'A');

  // ── Undo snapshot includes datum markers ────────────────
  PSB.clearUndoRedo();
  st = makeState();
  PSB.pushUndo(st, 'Add datum A');
  st.datumRefs.push({ id: 'datum_A_1', letter: 'A', page: 1 });
  var snap = PSB.undo(st, 'Add datum A');
  assertEq('Undo: snapshot has datum list', Array.isArray(snap.datumRefs), true);
  assertEq('Undo: datum add is undone', snap.datumRefs.length, 0);
  st.datumRefs = snap.datumRefs;
  var redoSnap = PSB.redo(st, 'Add datum A');
  assertEq('Redo: datum comes back', redoSnap.datumRefs.length, 1);

  // ── Multi-step undo (history menu jump) ─────────────────
  PSB.clearUndoRedo();
  st = makeState();
  PSB.pushUndo(st, 'step 1'); st.globals.platingThickness = 1;
  PSB.pushUndo(st, 'step 2'); st.globals.platingThickness = 2;
  PSB.pushUndo(st, 'step 3'); st.globals.platingThickness = 3;
  // Jump back 2 steps, restoring between steps like the app does
  for (var i = 0; i < 2; i++) {
    var s = PSB.undo(st, PSB.getUndoDescriptions()[0]);
    st.globals = s.globals;
  }
  assertEq('Jump undo 2 steps: value', st.globals.platingThickness, 1);
  assertEq('Jump undo 2 steps: 2 redo steps', PSB.getRedoDescriptions().length, 2);
  var r1 = PSB.redo(st, ''); st.globals = r1.globals;
  assertEq('Redo after jump: step forward', st.globals.platingThickness, 2);
  PSB.clearUndoRedo();

  // ── Typing in one box = one undo step ───────────────────
  st = makeState();
  st.globals.platingThickness = 0;
  ['0', '0.', '0.0', '0.00', '0.0005'].forEach(function(v) {
    PSB.pushUndo(st, 'Plating thickness → ' + v, 'platingThickness');
    st.globals.platingThickness = parseFloat(v) || 0;
  });
  assertEq('Grouped typing: one undo step', PSB.getUndoDescriptions().length, 1);
  assertEq('Grouped typing: label shows last value', PSB.getUndoDescriptions()[0], 'Plating thickness → 0.0005');
  assertEq('Grouped typing: undo goes back to before typing', PSB.undo(st, '').globals.platingThickness, 0);

  // A different field breaks the group
  PSB.clearUndoRedo();
  PSB.pushUndo(st, 'a', 'platingThickness');
  PSB.pushUndo(st, 'b', 'inchPrecision');
  PSB.pushUndo(st, 'c', 'platingThickness');
  assertEq('Different fields: separate steps', PSB.getUndoDescriptions().length, 3);

  // Ungrouped pushes are never merged
  PSB.clearUndoRedo();
  PSB.pushUndo(st, 'x'); PSB.pushUndo(st, 'y');
  assertEq('Ungrouped: separate steps', PSB.getUndoDescriptions().length, 2);

  // After an undo, typing again starts a new step
  PSB.clearUndoRedo();
  PSB.pushUndo(st, 'p1', 'platingThickness');
  PSB.undo(st, '');
  PSB.pushUndo(st, 'p2', 'platingThickness');
  assertEq('After undo: new step, not merged', PSB.getUndoDescriptions().length, 1);
  assertEq('After undo: redo cleared', PSB.canRedo(), false);
  PSB.clearUndoRedo();

  return { passed: passed, failed: failed };
};
