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
  'js/dataModel.js',
  'js/gdtParser.js',
  'js/ocrEngine.js',
  'js/exportEngine.js',
  'test/testData.js',
  'test/parser.test.js',
  'test/mathEngine.test.js',
  'test/ocrEngine.test.js',
  'test/export.test.js',
  'test/fixtures/gcInchSample.js',
  'test/fixture.test.js',
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
console.log('\nTOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed');
process.exit(totalFail ? 1 : 0);
