import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { lintProject, parseArgs, runNativeCompiler } from '../src/cli.js';

const root = path.resolve(import.meta.dirname, '../..');
const project = path.join(root, 'examples/demo/tsconfig.json');

test('cannot execute mappers or TypeScript without opt-in', async () => {
  assert.throws(() => parseArgs(['--typecheck']), /allow-external/);
  await assert.rejects(lintProject({ project, inputs: [], allowExternal: false }), /allow-external/);
});

test('whole demo uses external mapper process and maps original locations', async () => {
  const result = await lintProject({ project, inputs: [], allowExternal: true });
  assert.equal(result.files, 4);
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 1);
  assert.equal(result.diagnostics.filter(d => d.severity === 'warn').length, 6);
  const vue = result.diagnostics.filter(d => d.file.endsWith('App.vue'));
  assert.equal(vue.find(d => d.rule === 'no-debugger')?.line, 6);
  assert.equal(vue.find(d => d.rule === 'no-explicit-any')?.line, 3);
});

test('CLI returns JSON and non-zero exit code on errors', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/bin/maplint.js'), '--project', project,
    '--allow-external', '--json'], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 1, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.errors, 1);
  assert.equal(data.diagnostics.length, 7);
});

test('native TypeScript invocation passes --runExternalCode and reports compiler exit status', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maplint-tsc-'));
  try {
    const bin = path.join(scratch, 'node_modules/typescript/bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, 'tsc');
    fs.writeFileSync(script, 'console.log(process.argv.slice(2).join(" ")); process.exit(1);\n');
    fs.writeFileSync(path.join(scratch, 'tsconfig.json'), '{}');
    const out = await runNativeCompiler(path.join(scratch, 'tsconfig.json'));
    assert.equal(out.code, 1);
    assert.match(out.output, /--runExternalCode/);
    assert.match(out.output, /--noEmit/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('third-party mapper with a different extension and UTF-8 positions', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maplint-3rdparty-'));
  try {
    const mapper = path.join(scratch, 'node_modules', 'third-party-mapper');
    const src = path.join(scratch, 'src');
    fs.mkdirSync(mapper, { recursive: true });
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(mapper, 'package.json'), JSON.stringify({
      name: 'third-party-mapper',
      type: 'module',
      typescript: { contentMapper: { exec: ['node', 'server.js'] } },
    }));
    const rpcUrl = new URL('../src/jsonrpc.js', import.meta.url).href;
    fs.writeFileSync(path.join(mapper, 'server.js'), `
import { JsonRpcPeer } from ${JSON.stringify(rpcUrl)};
new JsonRpcPeer(process.stdin, process.stdout, { handlers: {
  initialize() { return {positionEncoding:'utf-8',diagnosticSource:'third-party'}; },
  openProject() { return {}; },
  transform({content}) {
    const start = content.indexOf(':') + 2;
    const text = content.slice(start);
    return {text, extension:'.ts',
      diagnostics:[{start:0,length:Buffer.byteLength('header😊'),code:'fixture',messageText:'fixture diagnostic'}],
      mappings:[[0,Buffer.byteLength(text),Buffer.byteLength(content.slice(0,start)),Buffer.byteLength(text),0]]};
  },
  closeProject() { return null; },
}});
`);
    fs.writeFileSync(path.join(src, 'Thing.cmp'), 'header😊: debugger;');
    const config = path.join(scratch, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({ files: ['src/Thing.cmp'],
      contentMappers: [{ package: 'third-party-mapper', extensions: ['.cmp'] }] }));
    const result = await lintProject({ project: config, inputs: [], allowExternal: true });
    assert.equal(result.files, 1);
    assert.equal(result.diagnostics.length, 2);
    const mapperDiagnostic = result.diagnostics.find(d => d.rule === 'mapper/third-party/fixture');
    assert.ok(mapperDiagnostic);
    assert.equal(mapperDiagnostic.start, 0);
    assert.equal(mapperDiagnostic.end, 'header😊'.length);
    const lintDiagnostic = result.diagnostics.find(d => d.rule === 'no-debugger');
    assert.ok(lintDiagnostic);
    assert.equal(lintDiagnostic.column, 'header😊: '.length + 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
