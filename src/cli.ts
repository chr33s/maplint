import path from 'node:path';
import { parseArgs as parseOptions } from 'node:util';
import { lintProject, runNativeCompiler, type CompilerResult, type LintResult } from './engine.js';
import { RULES } from './rules.js';

interface CliOptions {
  project: string;
  typecheck: boolean;
  allowExternal: boolean;
  json: boolean;
  help: boolean;
  inputs: string[];
}

const HELP = `maplint (experimental) — TypeScript 7.1 content-mapper-aware linter

Usage: maplint [options] [paths...]

  -p, --project FILE    TypeScript project (default: tsconfig.json)
      --allow-external  Permit execution of content mapper processes (required for mapped files)
      --typecheck       Also run native TypeScript 7.1 compiler with --runExternalCode
      --json            Print machine-readable diagnostics
  -h, --help            Show usage

Exit codes: 0 clean or warnings; 1 lint/typecheck errors; 2 configuration/runner failure.
Rules: ${Object.keys(RULES).join(', ')}.
Severities are configured in maplint.config.json beside the tsconfig.json.
`;

export function parseArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseOptions({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p', default: 'tsconfig.json' },
      'allow-external': { type: 'boolean', default: false },
      typecheck: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.typecheck && !values['allow-external']) {
    throw new Error('--typecheck requires --allow-external (content mappers execute external programs)');
  }
  return { project: values.project, typecheck: values.typecheck, allowExternal: values['allow-external'],
    json: values.json, help: values.help, inputs: positionals };
}

function summarize(result: LintResult) {
  const errors = result.diagnostics.filter(d => d.severity === 'error').length;
  return { files: result.files, errors, warnings: result.diagnostics.length - errors };
}

export function formatHuman(result: LintResult, compiler: CompilerResult | null): string {
  const { files, errors, warnings } = summarize(result);
  const records = result.diagnostics.map(d =>
    `${path.relative(process.cwd(), d.file) || d.file}:${d.line}:${d.column} ${d.severity} [${d.rule}] ${d.message}`);
  if (compiler?.output?.trim()) records.push(`\nTypeScript 7.1 diagnostics:\n${compiler.output.trim()}`);
  records.push(`\nmaplint: ${files} file(s), ${errors} lint error(s), ${warnings} warning(s)` +
    (compiler ? `; native compiler exit ${compiler.code}` : ''));
  return records.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return 0; }
  const result = await lintProject(opts);
  const native = opts.typecheck ? await runNativeCompiler(result.project.filename) : null;
  const summary = summarize(result);
  if (opts.json) {
    console.log(JSON.stringify({ ...summary, diagnostics: result.diagnostics,
      ...(native ? { compiler: { exitCode: native.code, output: native.output } } : {}) }, null, 2));
  } else {
    console.log(formatHuman(result, native));
  }
  return (summary.errors || (native && native.code !== 0)) ? 1 : 0;
}
