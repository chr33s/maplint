import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbeddedVirtual, extractEmbeddedSections } from '../packages/embedded-mapper/embedded.js';
import { indexText, mappingForSpan as mapSpans } from '../src/spans.js';
import type { MapperOutput, PositionEncoding } from '../src/types.js';

function mappingForSpan(output: MapperOutput, original: string, encoding: PositionEncoding, start: number, end: number) {
  return mapSpans(output.mappings, indexText(output.text, encoding), indexText(original, encoding), start, end);
}

test('Vue scripts and HTML comments map to original locations', () => {
  const src = '<!-- <script>fake()</script> -->\n<p>Hi</p>\n<script lang="ts">\ndebugger;\n</script>';
  const parts = extractEmbeddedSections('App.vue', src);
  assert.equal(parts.length, 1);
  const output = buildEmbeddedVirtual('App.vue', src);
  assert.equal(output.text.trim(), 'debugger;');
  const start = output.text.indexOf('debugger;');
  const mapped = mappingForSpan(output, src, 'utf-16', start, start + 9);
  assert.ok(mapped);
  assert.equal(src.slice(mapped.start, mapped.end), 'debugger;');
  assert.equal(mapped.start, src.indexOf('debugger;'));
});

test('multiple script blocks separate virtual text; no mapped synthetic separator', () => {
  const src = '<script>const x = 1</script><script>debugger;</script>';
  const output = buildEmbeddedVirtual('Comp.svelte', src);
  assert.equal(output.mappings?.length, 2);
  assert.match(output.text, /const x = 1\n;\ndebugger;/);
  const between = output.text.indexOf('\n;\n');
  assert.equal(mappingForSpan(output, src, 'utf-16', between + 1, between + 2), null);
  const end = output.text.indexOf('debugger;');
  const mapped = mappingForSpan(output, src, 'utf-16', end, end + 9);
  assert.ok(mapped);
  assert.equal(mapped.start, src.indexOf('debugger;'));
});

test('Astro frontmatter and inline script extracted', () => {
  const src = '---\nconst name: string = "hey";\n---\n<h1>{name}</h1>\n<script>console.log(name)</script>';
  const output = buildEmbeddedVirtual('Comp.astro', src);
  assert.equal(output.mappings?.length, 2);
  assert.match(output.text, /const name: string/);
  assert.match(output.text, /console.log\(name\)/);
});

test('script-like text inside Astro frontmatter is not extracted twice', () => {
  const src = '---\nconst tag = "<script>";\n---\n<script>debugger;</script>';
  const parts = extractEmbeddedSections('Comp.astro', src);
  assert.deepEqual(parts.map(p => src.slice(p.start, p.end)), ['const tag = "<script>";\n', 'debugger;']);
});

test('non-JS script types and src tags are excluded', () => {
  const src = '<script type="application/json">{"x":1}</script>\n<script src="external.js"></script>';
  const output = buildEmbeddedVirtual('App.vue', src);
  assert.equal(output.text, '');
  assert.deepEqual(output.mappings, []);
});

test('unicode offsets: UTF-16 and UTF-8 maps preserve original spans', () => {
  const src = '🏳️‍🌈<script lang="ts">console.log("😊")</script>';
  for (const encoding of ['utf-16', 'utf-8'] satisfies PositionEncoding[]) {
    const virtual = buildEmbeddedVirtual('App.vue', src, encoding);
    const at = virtual.text.indexOf('console.log');
    const mapped = mappingForSpan(virtual, src, encoding, at, at + 'console.log'.length);
    assert.ok(mapped);
    assert.equal(mapped.start, src.indexOf('console.log'));
    assert.equal(src.slice(mapped.start, mapped.end), 'console.log');
  }
});

test('atoms only map exact spans, synthesized expressions do not map', () => {
  const output: MapperOutput = { text: 'const x;', extension: '.ts', mappings: [[0, 5, 0, 2, 1]] };
  assert.deepEqual(mappingForSpan(output, 'ab', 'utf-16', 0, 5), { start: 0, end: 2 });
  assert.equal(mappingForSpan(output, 'ab', 'utf-16', 2, 4), null);
  assert.equal(mappingForSpan(output, 'ab', 'utf-16', 6, 7), null);
});

test('UTF-8 offset index matches byte counts and rejects split characters', () => {
  const text = 'a😊é\ud800b';
  const index = indexText(text, 'utf-8');
  for (let i = 0; i <= text.length; i++) assert.equal(index.toEncoded(i), Buffer.byteLength(text.slice(0, i)), `index ${i}`);
  assert.deepEqual([0, 1, 5, 7, 10, 11].map(index.fromEncoded), [0, 1, 3, 4, 5, 6]);
  assert.deepEqual([2, 4, 6, 12, -1].map(index.fromEncoded), [-1, -1, -1, -1, -1]);
  assert.deepEqual(index.lineColumn(text.length), { line: 1, column: 7 });
});
