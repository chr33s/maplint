import test from 'node:test';
import assert from 'node:assert/strict';
import { lintVirtual, normalizeRules } from '../src/linter.mjs';
import { buildEmbeddedVirtual } from '../src/embedded.mjs';

function lint(text, file = '/x/src.ts', rules = normalizeRules()) {
  const embedded = file.endsWith('.vue');
  const output = embedded ? buildEmbeddedVirtual(file, text)
    : { text, extension: '.ts', mappings: [[0, text.length, 0, text.length, 0]] };
  return lintVirtual({ originalFile: file, original: text, virtual: file + output.extension,
    output, rules });
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
