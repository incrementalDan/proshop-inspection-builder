/**
 * testData.js — Sample data for testing
 *
 * Contains real data from Ground Control and expected ProShop output.
 */

window.TEST = window.TEST || {};

// Raw CSV string from Ground Control export
TEST.SAMPLE_INPUT_CSV = 'Internal Part #,Op #,Dim Tag #,Ref Loc,Char Dsg,Spec Unit 1,Drawing Spec,Spec Unit 2,Spec Unit 3,Inspec Equip,Nom Dim,Tol ±,IPC?,Inspection Frequency,Show Dim When?\n' +
',,1,S1,,,33.0,,,,33.0,0.5,,,\n' +
',,2,S1,,,25.0,,,,25.0,0.1,,,\n' +
',,3,S1,,,12.5,,,,12.5,0.1,,,\n' +
',,4,S1,,,8.00,,,,8.00,0.05,,,\n' +
',,5,S1,,,4.0,,,,4.0,0.1,,,\n' +
',,6,S1,,,16.5,,,,16.5,0.3,,,\n' +
',,7,S1,,Ø,3.5,,,,3.5,0.1,,,\n' +
',,8,S1,,Ø,9.0,,,,9.0,0.3,,,\n' +
',,9,S1,,Ø,3.3,,2x,,3.3,0.1,,,\n' +
',,10,S1,,,5.0,,,,5.0,0.1,,,\n' +
',,11,S1,,,2.0,,4x,,2.0,0.1,,,\n' +
',,12,S1,,,3.0,,,,3.0,0.5,,,\n' +
',,13,S1,,,15.0,,,,15.0,0.3,,,\n' +
',,14,S1,,,BREAK AND DEBURR ALL SHARP EDGES.,,,,,,,,\n' +
',,15,S1,,,BAG AND TAG PART WITH PART NO. AND REV LABELLED.,,,,,,,,\n' +
',,16,S1,,,INVAR 36,,,,,,,,';

// Individual test cases for math engine
TEST.MATH_TEST_CASES = {
  // Nominal centering tests
  centering: [
    {
      desc: 'Symmetric tolerance — no change',
      input: { nominal: 0.100, tolPlus: 0.005, tolMinus: 0.005 },
      expected: { nominal: 0.100, tolSymmetric: 0.005 },
    },
    {
      desc: 'Asymmetric tolerance — shift center',
      input: { nominal: 0.100, tolPlus: 0.010, tolMinus: 0.002 },
      expected: { nominal: 0.104, tolSymmetric: 0.006 },
    },
    {
      desc: 'Asymmetric with larger minus — shift negative',
      input: { nominal: 1.000, tolPlus: 0.001, tolMinus: 0.005 },
      expected: { nominal: 0.998, tolSymmetric: 0.003 },
    },
  ],

  // Plating tests
  plating: [
    {
      desc: '+1x Internal — subtract plating',
      input: { nominal: 1.000, plating: 0.001, mode: '+1xI' },
      expected: 0.999,
    },
    {
      desc: '+2x Internal — subtract 2x plating',
      input: { nominal: 1.000, plating: 0.001, mode: '+2xI' },
      expected: 0.998,
    },
    {
      desc: '-1x External — add plating',
      input: { nominal: 1.000, plating: 0.001, mode: '-1xE' },
      expected: 1.001,
    },
    {
      desc: '-2x External — add 2x plating',
      input: { nominal: 1.000, plating: 0.001, mode: '-2xE' },
      expected: 1.002,
    },
  ],

  // Unit conversion tests
  conversion: [
    {
      desc: 'mm to inch',
      input: { value: 25.4, from: 'mm', to: 'inch' },
      expected: 1.0,
    },
    {
      desc: 'inch to mm',
      input: { value: 1.0, from: 'inch', to: 'mm' },
      expected: 25.4,
    },
    {
      desc: 'same units — no change',
      input: { value: 5.0, from: 'mm', to: 'mm' },
      expected: 5.0,
    },
  ],

  // Pin gage tests
  pinGage: [
    {
      desc: 'Standard pin gage',
      input: { nominal: 0.500, tolerance: 0.005 },
      expected: { go: 0.495, noGo: 0.505 },
    },
  ],
};

// Parser test cases
TEST.PARSER_TEST_CASES = {
  featureDetection: [
    { input: '33.0', expected: 'dimension' },
    { input: 'BREAK AND DEBURR ALL SHARP EDGES.', expected: 'note' },
    { input: 'BAG AND TAG PART WITH PART NO. AND REV LABELLED.', expected: 'note' },
    { input: 'INVAR 36', expected: 'note' },
    { input: '1/4-20 UNC', expected: 'thread' },
    { input: 'M6x1.0', expected: 'thread' },
  ],

  toleranceParsing: [
    { input: '0.5', expected: { tolPlus: 0.5, tolMinus: 0.5, isSymmetric: true } },
    { input: '±0.005', expected: { tolPlus: 0.005, tolMinus: 0.005, isSymmetric: true } },
    { input: '+0.010 -0.002', expected: { tolPlus: 0.010, tolMinus: 0.002, isSymmetric: false } },
    { input: '+.005-.002', expected: { tolPlus: 0.005, tolMinus: 0.002, isSymmetric: false } },
    { input: '', expected: { tolPlus: 0, tolMinus: 0, isSymmetric: true } },
  ],

  specUnits: [
    { input: 'Ø3.5', expected: { su1: 'Ø', su2: '', su3: '' } },
    { input: '3.3 2x', expected: { su1: '', su2: '', su3: '2x' } },
    { input: '2.0 4x', expected: { su1: '', su2: '', su3: '4x' } },
    { input: 'Ø0.651 THRU', expected: { su1: 'Ø', su2: 'THRU', su3: '' } },
  ],
};
