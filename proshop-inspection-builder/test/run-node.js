/**
 * run-node.js — Run the test suite from the command line (no browser).
 *
 *   node test/run-node.js
 *
 * Loads the same files as test/index.html into a fake `window`,
 * runs every suite, prints failures, exits 1 if anything failed.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var FILES = [
  'js/mathEngine.js',
  'js/parser.js',
  'js/units.js',
  'js/dataModel.js',
  'js/gdtParser.js',
  'js/ocrEngine.js',
  'js/exportEngine.js',
  'js/cmmParser.js',
  'js/faiExport.js',
  'js/storage.js',
  'js/history.js',
  'test/testData.js',
  'test/parser.test.js',
  'test/mathEngine.test.js',
  'test/ocrEngine.test.js',
  'test/export.test.js',
  'test/fixtures/gcInchSample.js',
  'test/fixture.test.js',
  'test/units.test.js',
  'test/fixtures/cmmCalypsoSample.js',
  'test/cmm.test.js',
  'test/faiExport.test.js',
  'test/history.test.js',
];

var ctx = { console: console };
ctx.window = ctx;
vm.createContext(ctx);
FILES.forEach(function(f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
});

var SUITES = [
  ['Parser', 'runParserTests'],
  ['Math Engine', 'runMathTests'],
  ['OCR Engine', 'runOcrTests'],
  ['Export', 'runExportTests'],
  ['Fixtures', 'runFixtureTests'],
  ['Units', 'runUnitsTests'],
  ['CMM', 'runCmmTests'],
  ['FAI Export', 'runFaiExportTests'],
  ['History', 'runHistoryTests'],
];

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

var totalPass = 0;
var totalFail = 0;
SUITES.forEach(function(s) {
  var fn = ctx.TEST[s[1]];
  if (!fn) return;
  var res = fn(function(html) {
    if (html.indexOf('fail') >= 0) console.log('  ' + stripHtml(html));
  });
  console.log(s[0] + ': ' + res.passed + ' passed, ' + res.failed + ' failed');
  totalPass += res.passed;
  totalFail += res.failed;
});
// ── Version: label and every ?v= in index.html must be the same ──
(function checkVersion() {
  var appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var m = appJs.match(/var APP_VERSION = 'v(\d+\.\d+\.\d+)';/);
  var tags = html.match(/\?v=[^"']+/g) || [];
  var bad = tags.filter(function(t) { return !m || t !== '?v=' + m[1]; });
  var ok = m && tags.length > 0 && bad.length === 0;
  if (ok) {
    totalPass++;
    console.log('Version: v' + m[1] + ' on label + ' + tags.length + ' files');
  } else {
    totalFail++;
    console.log('Version: FAIL — APP_VERSION in js/app.js must look like v1.2.3 and match every ?v= in index.html' +
      (bad.length ? ' (found ' + bad.slice(0, 3).join(', ') + ')' : ''));
  }
})();

console.log('\nTOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed');
process.exit(totalFail ? 1 : 0);
