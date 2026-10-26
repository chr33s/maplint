import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lintFile } from '../src/linter.js';
import { normalizeRules } from '../src/rules.js';
import { identityOutput, indexText } from '../src/spans.js';
import type { MapperOutput } from '../src/types.js';
import { buildEmbeddedVirtual } from '../packages/embedded-mapper/embedded.js';

function lint(text: string, file = '/x/src.ts', rules = normalizeRules()) {
  const output = file.endsWith('.vue') ? buildEmbeddedVirtual(file, text) : identityOutput(text, path.extname(file));
  return lintFile({ originalFile: file, original: indexText(text, 'utf-16'), outputs: [output], rules });
}

test('six rules are AST-based and have distinct correct spans', () => {
  const text = 'var a: any = 1; console.log(a); if (a == 1) { debugger; eval("a") }';
  const found = lint(text);
  assert.deepEqual(new Set(found.map(d => d.rule)),
    new Set(['no-var', 'no-explicit-any', 'no-console', 'eqeqeq', 'no-debugger', 'no-eval']));
  for (const p of found) assert.ok(text.slice(p.start, p.end).length > 0);
});

test('Vue generated code maps original line positions', () => {
  const text = '<template></template>\n<script lang="ts">\n  debugger;\n</script>';
  const found = lint(text, '/x/App.vue');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].line, 3);
  assert.equal(found[0].column, 3);
});

test('rule configuration, ignore directives, and syntax errors', () => {
  const rules = normalizeRules({ 'no-console': 'off' });
  assert.deepEqual(lint('// maplint-disable-next-line no-debugger\ndebugger; console.log(1)', '/x/test.ts', rules)
    .filter(d => d.rule !== 'syntax'), []);
  const error = lint('const = 0;');
  assert.equal(error.some(d => d.rule === 'syntax'), true);
  assert.throws(() => normalizeRules({ 'random-rule': 'error' }), /Unknown/);
});

test('directive-like text in strings and regex literals does not suppress diagnostics', () => {
  const text = [
    'const stringDirective = "// maplint-disable-next-line no-debugger";',
    'debugger;',
    'const regexDirective = /\\/\\/ maplint-disable-next-line no-debugger/;',
    'debugger;',
    '// maplint-disable-next-line no-debugger',
    'debugger;',
  ].join('\n');
  const found = lint(text).filter(d => d.rule === 'no-debugger');
  assert.equal(found.length, 2);
  assert.equal(found[0].line, 2);
  assert.equal(found[1].line, 4);
});

test('suppression directives are read from mapped code, not template text', () => {
  const directive = '// maplint-disable-next-line no-debugger';
  // A backtick in template text must not swallow the real directive inside <script>.
  const backtick = `<template><p>use \`npm i</p></template>\n<script lang="ts">\n${directive}\ndebugger;\n</script>`;
  assert.deepEqual(lint(backtick, '/x/App.vue'), []);
  // Directive-like template text is not a comment in the virtual code.
  const template = `<template><p>\n${directive}\n</p></template><script lang="ts">debugger;</script>`;
  assert.deepEqual(lint(template, '/x/App.vue').map(d => `${d.rule}@${d.line}`), ['no-debugger@3']);
});

test('directive-like JSX text does not suppress diagnostics', () => {
  const found = lint('const a = <p>{1} // maplint-disable-line no-debugger</p>; debugger;', '/x/a.tsx');
  assert.deepEqual(found.map(d => d.rule), ['no-debugger']);
  const opening = lint('const b = <p> // maplint-disable-line no-debugger\n</p>; debugger;', '/x/b.tsx');
  assert.deepEqual(opening.map(d => d.rule), ['no-debugger']);
});

test('directives after punctuation tokens suppress diagnostics', () => {
  const cases = [
    'const h = [\n  console.log, // maplint-disable-line no-console\n  1,\n];',
    'const o = {\n  log: console.log, // maplint-disable-line no-console\n};',
    'foo(a, // maplint-disable-next-line no-console\n  console.log);',
    'if (x) { // maplint-disable-next-line\n  console.log(1);\n}',
    'const t = `${console.log, // maplint-disable-line no-console\n  a}`;',
  ];
  for (const text of cases) assert.deepEqual(lint(text), [], text);
});

test('directive-like template text does not suppress diagnostics', () => {
  const found = lint('debugger; const t = `${1} // maplint-disable-line no-debugger\n`;');
  assert.deepEqual(found.map(d => `${d.rule}@${d.line}`), ['no-debugger@1']);
});

test('no-var ignores using declarations', () => {
  assert.deepEqual(lint('using a = f();\nawait using b = g();\nvar c = 1;').map(d => `${d.rule}@${d.line}`), ['no-var@3']);
});

test('syntax errors on synthetic text are reported at the preceding source', () => {
  const text = '<script>const x = (</script>\n<script>let y = 1</script>';
  const found = lint(text, '/x/App.vue').filter(d => d.rule === 'syntax');
  assert.ok(found.length > 0);
  assert.equal(found[0].start, text.indexOf('</script>'));
  assert.equal(found[0].end, found[0].start);
});

test('suppression directives apply to findings in every output of a file', () => {
  const text = '// maplint-disable-next-line no-explicit-any\nlet x: any;';
  const stripped = 'let x: any;';
  const at = text.indexOf(stripped);
  const supplemental: MapperOutput = { text: stripped, extension: '.ts',
    mappings: [[0, stripped.length, at, stripped.length, 0]] };
  assert.deepEqual(lintFile({ originalFile: '/x/a.ts', original: indexText(text, 'utf-16'),
    outputs: [identityOutput(text, '.ts'), supplemental] }), []);
});
