// The splitter decides what the binary receives, so it gets its own checks:
// every case below is a shape a model actually produces.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitCommand } from '../lib/index.js';

test('quotes group and are removed', () => {
  assert.deepEqual(splitCommand('set "C:\\a b\\x.pptx" /slide[1]'), [
    'set',
    'C:\\a b\\x.pptx',
    '/slide[1]',
  ]);
});

test('single quotes behave the same', () => {
  assert.deepEqual(splitCommand("view 'D:\\my file.docx' text"), ['view', 'D:\\my file.docx', 'text']);
});

test('an escaped quote reaches the binary intact', () => {
  // A model writing a COUNTIF condition must be able to keep the quotes, or the
  // formula silently loses its condition.
  assert.deepEqual(splitCommand('set f.xlsx /Sheet1!A3 --prop formula=COUNTIF(A1:A2,\\">1\\")'), [
    'set',
    'f.xlsx',
    '/Sheet1!A3',
    '--prop',
    'formula=COUNTIF(A1:A2,">1")',
  ]);
});

test('a bare quote is shell-like and disappears', () => {
  assert.deepEqual(splitCommand('set f.xlsx /Sheet1!A3 --prop formula=COUNTIF(A1:A2,">1")'), [
    'set',
    'f.xlsx',
    '/Sheet1!A3',
    '--prop',
    'formula=COUNTIF(A1:A2,>1)',
  ]);
});

test('windows paths keep their backslashes', () => {
  assert.deepEqual(splitCommand('create C:\\Users\\me\\Desktop\\deck.pptx'), [
    'create',
    'C:\\Users\\me\\Desktop\\deck.pptx',
  ]);
});

test('an escaped space stays inside the argument', () => {
  assert.deepEqual(splitCommand('open C:\\my\\ dir\\a.pptx'), ['open', 'C:\\my dir\\a.pptx']);
});

test('repeated whitespace produces no empty arguments', () => {
  assert.deepEqual(splitCommand('  view   a.pptx    text  '), ['view', 'a.pptx', 'text']);
});
