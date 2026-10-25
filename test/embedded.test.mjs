import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbeddedVirtual, extractEmbeddedSections } from '../src/embedded.mjs';
import { mappingForSpan } from '../src/mapper-host.mjs';

test('Vue scripts and HTML comments map to original locations', () => {
  const src = '<!-- <script>fake()</script> -->\n<p>Hi</p>\n<script lang="ts">\ndebugger;\n</script>';
  const parts = extractEmbeddedSections('App.vue', src);
  assert.equal(parts.length, 1);
  const output = buildEmbeddedVirtual('App.vue', src);
  assert.equal(output.text.trim(), 'debugger;');
  const start = output.text.indexOf('debugger;');
  const mapped = mappingForSpan(output, src, 'utf-16', start, start + 9);
  assert.equal(src.slice(mapped.start, mapped.end), 'debugger;');
  assert.equal(mapped.start, src.indexOf('debugger;'));
});

test('multiple script blocks separate virtual text; no mapped synthetic separator', () => {
  const src = '<script>const x = 1</script><script>debugger;</script>';
  const output = buildEmbeddedVirtual('Comp.svelte', src);
  assert.equal(output.mappings.length, 2);
  assert.match(output.text, /const x = 1\n;\ndebugger;/);
  const between = output.text.indexOf('\n;\n');
  assert.equal(mappingForSpan(output, src, 'utf-16', between + 1, between + 2), null);
  const end = output.text.indexOf('debugger;');
  assert.equal(mappingForSpan(output, src, 'utf-16', end, end + 9).start, src.indexOf('debugger;'));
});

test('Astro frontmatter and inline script extracted', () => {
  const src = '---\nconst name: string = "hey";\n---\n<h1>{name}</h1>\n<script>console.log(name)</script>';
  const output = buildEmbeddedVirtual('Comp.astro', src);
  assert.equal(output.mappings.length, 2);
  assert.match(output.text, /const name: string/);
  assert.match(output.text, /console.log\(name\)/);
});

test('non-JS script types and src tags are excluded', () => {
  const src = '<script type="application/json">{"x":1}</script>\n<script src="external.js"></script>';
  const output = buildEmbeddedVirtual('App.vue', src);
  assert.equal(output.text, '');
  assert.deepEqual(output.mappings, []);
});

test('unicode offsets: UTF-16 and UTF-8 maps preserve original spans', () => {
  const src = '🏳️‍🌈<script lang="ts">console.log("😊")</script>';
  for (const encoding of ['utf-16', 'utf-8']) {
    const virtual = buildEmbeddedVirtual('App.vue', src, encoding);
    const at = virtual.text.indexOf('console.log');
    const mapped = mappingForSpan(virtual, src, encoding, at, at + 'console.log'.length);
    assert.equal(mapped.start, src.indexOf('console.log'));
    assert.equal(src.slice(mapped.start, mapped.end), 'console.log');
  }
});

test('atoms only map exact spans, synthesized expressions do not map', () => {
  const output = {text: 'const x;', mappings: [[0, 5, 0, 2, 1]]};
  assert.deepEqual(mappingForSpan(output, 'ab', 'utf-16', 0, 5), { start: 0, end: 2 });
  assert.equal(mappingForSpan(output, 'ab', 'utf-16', 2, 4), null);
  assert.equal(mappingForSpan(output, 'ab', 'utf-16', 6, 7), null);
});
