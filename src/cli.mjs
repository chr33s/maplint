import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BASE_EXTENSIONS, collectFiles, loadRuleConfig, readProject } from './config.mjs';
import { MapperProcess } from './mapper-host.mjs';
import { lintVirtual, lineCol, normalizeRules } from './linter.mjs';

const HELP = `maplint (experimental) — TypeScript 7.1 content-mapper-aware linter

Usage: maplint [options] [paths...]

  -p, --project FILE    TypeScript project (default: tsconfig.json)
      --allow-external  Permit execution of content mapper processes (required for mapped files)
      --typecheck       Also run native TypeScript 7.1 compiler with --runExternalCode
      --json            Print machine-readable diagnostics
      --help            Show usage

Exit codes: 0 clean or warnings; 1 lint/typecheck errors; 2 configuration/runner failure.
Rules: no-debugger, no-console, eqeqeq, no-var, no-eval, no-explicit-any.
Severities are configured in maplint.config.json beside the tsconfig.json.
`;

export function parseArgs(argv) {
  const args = { project: 'tsconfig.json', typecheck: false, allowExternal: false, json: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' || arg === '-p') {
      if (!argv[i + 1]) throw new Error('Missing project path');
      args.project = argv[++i];
    } else if (arg === '--typecheck') args.typecheck = true;
    else if (arg === '--allow-external') args.allowExternal = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else args.inputs.push(arg);
  }
  if (args.typecheck && !args.allowExternal) {
    throw new Error('--typecheck requires --allow-external (content mappers execute external programs)');
  }
  return args;
}

export async function lintProject(options) {
  const project = readProject(options.project);
  const files = collectFiles(project, options.inputs ?? []);
  const rules = normalizeRules(loadRuleConfig(project.root));
  const sessions = new Map();
  const diagnostics = [];
  try {
    for (const file of files) {
      const original = fs.readFileSync(file, 'utf8');
      const ext = path.extname(file).toLowerCase();
      const defs = project.contentMappers.filter(mapper => mapper.extensions.includes(ext));
      if (defs.length > 1) throw new Error(`More than one mapper registered for ${ext} in ${project.filename}`);
      let output;
      let encoding = 'utf-16';
      if (defs.length) {
        if (!options.allowExternal) {
          throw new Error(`File ${file} requires mapper ${defs[0].package}. Pass --allow-external to run it.`);
        }
        const def = defs[0];
        if (!sessions.has(def)) {
          const proc = await new MapperProcess(def, project).start();
          sessions.set(def, proc);
        }
        const session = sessions.get(def);
        output = await session.transform(file, original);
        encoding = session.positionEncoding;
        for (const d of output.diagnostics ?? []) {
          if (!Number.isSafeInteger(d.start) || !Number.isSafeInteger(d.length) || d.length < 0) continue;
          const endOffset = d.start + d.length;
          if (!Number.isSafeInteger(endOffset)) continue;
          const start = encoding === 'utf-8' ? utf8ToIndex(original, d.start) : d.start;
          const end = encoding === 'utf-8' ? utf8ToIndex(original, endOffset) : endOffset;
          if (start < 0 || end < start || end > original.length) continue;
          const lc = lineCol(original, start);
          diagnostics.push({ file, line: lc.line, column: lc.column, start, end,
            rule: `mapper/${session.sourceName}/${d.code}`, severity: 'error', message: d.messageText });
        }
        // Supplemental source files are a TypeScript concept. MVP lints canonical output only.
      } else if (BASE_EXTENSIONS.includes(ext)) {
        output = { text: original, extension: ext, mappings: [[0, original.length, 0, original.length, 0]] };
      } else {
        continue;
      }
      const virtualFiles = [output, ...(output.supplemental ?? [])];
      for (const [index, virtualFile] of virtualFiles.entries()) {
        if (virtualFile.extension === '.json') continue; // JSON is not lintable JS/TS.
        if (typeof virtualFile.text !== 'string' || !Array.isArray(virtualFile.mappings ?? [])) {
          throw new Error(`Mapper returned invalid supplemental file for ${file}`);
        }
        diagnostics.push(...lintVirtual({ originalFile: file, original,
          virtual: `${file}.virtual${index}${virtualFile.extension}`,
          output: virtualFile, encoding, rules }));
      }
    }
  } finally {
    await Promise.all([...sessions.values()].map(s => s.stop()));
  }
  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.rule.localeCompare(b.rule));
  // The same user code can appear in canonical and supplemental virtual sources.
  const deduped = diagnostics.filter((d, index) => index === 0 ||
    !(diagnostics[index - 1].file === d.file && diagnostics[index - 1].start === d.start &&
      diagnostics[index - 1].end === d.end && diagnostics[index - 1].rule === d.rule));
  return { files: files.length, diagnostics: deduped, project };
}

function utf8ToIndex(text, byteOffset) {
  if (byteOffset < 0) return -1;
  let b = 0;
  for (let i = 0; i < text.length;) {
    if (b === byteOffset) return i;
    const cp = text.codePointAt(i);
    b += Buffer.byteLength(String.fromCodePoint(cp));
    i += cp > 65535 ? 2 : 1;
  }
  return b === byteOffset ? text.length : -1;
}

export async function runNativeCompiler(projectFile) {
  const cwd = path.dirname(path.resolve(projectFile));
  let dir = cwd;
  let command = null;
  while (true) {
    const candidate = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(candidate)) { command = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!command) throw new Error('TypeScript 7.1 local tsc is missing. Install dependencies first: npm install');
  return new Promise((resolve, reject) => {
    const args = ['--project', path.resolve(projectFile), '--noEmit', '--pretty', 'false', '--runExternalCode'];
    const proc = spawn(process.execPath, [command, ...args], { cwd, windowsHide: true });
    let output = '';
    let error = '';
    const limit = 8 * 1024 * 1024;
    proc.stdout.on('data', chunk => { output = (output + chunk).slice(-limit); });
    proc.stderr.on('data', chunk => { error = (error + chunk).slice(-limit); });
    proc.once('error', reject);
    proc.once('close', code => resolve({ code, output: `${output}${error}` }));
  });
}

export function formatHuman(result, compiler) {
  const records = result.diagnostics.map(d =>
    `${path.relative(process.cwd(), d.file) || d.file}:${d.line}:${d.column} ${d.severity} [${d.rule}] ${d.message}`);
  if (compiler?.output?.trim()) records.push(`\nTypeScript 7.1 diagnostics:\n${compiler.output.trim()}`);
  const errors = result.diagnostics.filter(d => d.severity === 'error').length;
  const warnings = result.diagnostics.filter(d => d.severity === 'warn').length;
  records.push(`\nmaplint: ${result.files} file(s), ${errors} lint error(s), ${warnings} warning(s)` +
    (compiler ? `; native compiler exit ${compiler.code}` : ''));
  return records.join('\n');
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return 0; }
  const result = await lintProject(opts);
  const native = opts.typecheck ? await runNativeCompiler(result.project.filename) : null;
  const errors = result.diagnostics.filter(d => d.severity === 'error').length;
  if (opts.json) {
    console.log(JSON.stringify({ files: result.files, errors, warnings: result.diagnostics.length - errors,
      diagnostics: result.diagnostics,
      ...(native ? { compiler: { exitCode: native.code, output: native.output } } : {}) }, null, 2));
  } else {
    console.log(formatHuman(result, native));
  }
  return (errors || (native && native.code !== 0)) ? 1 : 0;
}
