import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../src/cli.js';
import { lintProject, runNativeCompiler } from '../src/engine.js';
import { mapperFor, readProject } from '../src/project.js';

const root = path.resolve(import.meta.dirname, '../..');
const project = path.join(root, 'examples/demo/tsconfig.json');
const rpcUrl = new URL('../src/jsonrpc.js', import.meta.url).href;

test('cannot execute mappers or TypeScript without opt-in', async () => {
  assert.throws(() => parseArgs(['--typecheck']), /allow-external/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
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
    fs.writeFileSync(path.join(mapper, 'server.js'), `
import { JsonRpcPeer } from ${JSON.stringify(rpcUrl)};
new JsonRpcPeer(process.stdin, process.stdout, { handlers: {
  initialize() { return {positionEncoding:'utf-8',diagnosticSource:'third-party'}; },
  openProject() { return {}; },
  transform({content}) {
    const start = content.indexOf(':') + 2;
    const text = content.slice(start);
    return {text, extension:'.ts',
      diagnostics:[{start:0,length:Buffer.byteLength('header😊'),code:'fixture',messageText:'fixture diagnostic'},
        {start:0,length:1,messageText:'no code'}],
      mappings:[[0,Buffer.byteLength(text),Buffer.byteLength(content.slice(0,start)),Buffer.byteLength(text),0]]};
  },
  closeProject() { return null; },
}});
`);
    fs.writeFileSync(path.join(src, 'Thing.cmp'), 'header😊: debugger;');
    const config = path.join(scratch, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({ include: ['src'],
      contentMappers: [{ package: 'third-party-mapper', extensions: ['.cmp'] }] }));
    const result = await lintProject({ project: config, inputs: [], allowExternal: true });
    assert.equal(result.files, 1);
    assert.equal(result.diagnostics.length, 3);
    assert.ok(result.diagnostics.find(d => d.rule === 'mapper/third-party'));
    const mapperDiagnostic = result.diagnostics.find(d => d.rule === 'mapper/third-party/fixture');
    assert.ok(mapperDiagnostic);
    assert.equal(mapperDiagnostic.start, 0);
    assert.equal(mapperDiagnostic.end, 'header😊'.length);
    const lintDiagnostic = result.diagnostics.find(d => d.rule === 'no-debugger');
    assert.ok(lintDiagnostic);
    assert.equal(lintDiagnostic.column, 'header😊: '.length + 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('mapper that fails its handshake is killed without waiting for closeProject', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maplint-hung-'));
  try {
    const mapper = path.join(scratch, 'node_modules', 'hung-mapper');
    fs.mkdirSync(mapper, { recursive: true });
    fs.mkdirSync(path.join(scratch, 'src'));
    fs.writeFileSync(path.join(mapper, 'package.json'), JSON.stringify({
      name: 'hung-mapper',
      type: 'module',
      typescript: { contentMapper: { exec: ['node', 'server.js'] } },
    }));
    fs.writeFileSync(path.join(mapper, 'server.js'), `
import fs from 'node:fs';
import { JsonRpcPeer } from ${JSON.stringify(rpcUrl)};
fs.writeFileSync('pid', String(process.pid));
new JsonRpcPeer(process.stdin, process.stdout, { handlers: {
  initialize() { return {positionEncoding:'utf-32'}; },
  closeProject() { return new Promise(() => {}); },
}});
`);
    fs.writeFileSync(path.join(scratch, 'src', 'a.cmp'), 'x');
    const config = path.join(scratch, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({ include: ['src'],
      contentMappers: [{ package: 'hung-mapper', extensions: ['.cmp'] }] }));
    await assert.rejects(lintProject({ project: config, inputs: [], allowExternal: true }), /invalid position encoding/);
    const pid = Number(fs.readFileSync(path.join(mapper, 'pid'), 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(), false, 'mapper process still running');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

test('project mode lints every lintable file the tsconfig selects, skipping build output', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maplint-select-'));
  try {
    writeFiles(scratch, {
      'base.json': JSON.stringify({ include: ['src'], exclude: ['src/skip'] }),
      'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: {} }),
      'src/a.js': 'debugger;', 'src/b.ts': 'debugger;', 'src/b.js': 'debugger;', 'src/b.d.ts': '',
      'src/skip/s.ts': 'debugger;', 'src/dist/c.ts': 'debugger;', 'lib/x.ts': 'debugger;',
    });
    const result = await lintProject({ project: path.join(scratch, 'tsconfig.json'), inputs: [], allowExternal: false });
    assert.deepEqual([...new Set(result.diagnostics.map(d => path.relative(scratch, d.file)))].sort(),
      ['src/a.js', 'src/b.js', 'src/b.ts']);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('conflicting mapper registrations fail only for files that use them', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maplint-conflict-'));
  try {
    writeFiles(scratch, {
      'tsconfig.json': JSON.stringify({ include: ['src'], contentMappers: [
        { package: 'x', extensions: ['.cmp', '.cmp'] }, { package: 'y', extensions: ['.html'] },
        { package: 'z', extensions: ['.html'] }] }),
      'src/a.ts': 'debugger;',
    });
    const config = path.join(scratch, 'tsconfig.json');
    const result = await lintProject({ project: config, inputs: [], allowExternal: false });
    assert.equal(result.files, 1);
    const project = readProject(config);
    assert.equal(mapperFor(project, 'a.cmp')?.package, 'x');
    assert.throws(() => mapperFor(project, 'a.html'), /More than one mapper registered for \.html/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('supplemental outputs: declarations are linted, other extensions skipped, duplicates collapse', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maplint-supplemental-'));
  try {
    writeFiles(scratch, {
      'node_modules/m/package.json': JSON.stringify({ name: 'm', type: 'module',
        typescript: { contentMapper: { exec: ['node', 'server.js'] } } }),
      'node_modules/m/server.js': `
import { JsonRpcPeer } from ${JSON.stringify(rpcUrl)};
new JsonRpcPeer(process.stdin, process.stdout, { handlers: {
  initialize() { return {positionEncoding:'utf-16',diagnosticSource:'m'}; },
  openProject() { return {}; },
  transform({content}) {
    const map = [[0, content.length, 0, content.length, 0]];
    return {text: content, extension: '.ts', mappings: map,
      diagnostics: [{start:0,length:1,messageText:{messageText:'chain'}}, {start:0,length:1,code:{},messageText:'bad'},
        {start:0,length:1,messageText:'kept'}],
      supplemental: [{text: content, extension: '.ts', mappings: map},
        {text: 'declare const x: any;', extension: '.d.ts', mappings: [[17,3,0,3,0]]},
        {text: 'var x;', extension: '.css', mappings: [[0,6,0,6,0]]}]};
  },
  closeProject() { return null; },
}});
`,
      'src/a.cmp': 'debugger; console.log(1);',
      'tsconfig.json': JSON.stringify({ include: ['src'], contentMappers: [{ package: 'm', extensions: ['.cmp'] }] }),
    });
    const result = await lintProject({ project: path.join(scratch, 'tsconfig.json'), inputs: [], allowExternal: true });
    assert.deepEqual(result.diagnostics.map(d => `${d.rule}:${d.message}`).sort(), [
      'mapper/m:kept', 'no-console:Unexpected console access', 'no-debugger:Unexpected debugger statement',
      'no-explicit-any:Avoid explicit any type']);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
