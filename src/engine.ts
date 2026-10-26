import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { collectFiles, findUp, loadRuleConfig, mapperFor, readProject } from './project.js';
import { MapperProcess } from './mapper-host.js';
import { lintFile } from './linter.js';
import { normalizeRules } from './rules.js';
import { decodeSpan, identityOutput, indexText, type TextIndex } from './spans.js';
import type { Diagnostic, MapperDefinition, MapperOutput, ProjectConfig } from './types.js';

export interface LintResult {
  files: number;
  diagnostics: Diagnostic[];
  project: ProjectConfig;
}

export interface CompilerResult {
  code: number | null;
  output: string;
}

export async function lintProject(options: { project: string; allowExternal: boolean; inputs: string[] }): Promise<LintResult> {
  const project = readProject(options.project);
  const files = collectFiles(project, options.inputs);
  const rules = normalizeRules(loadRuleConfig(project.root));
  const mapped = files.find(file => mapperFor(project, file));
  if (mapped && !options.allowExternal) {
    throw new Error(`File ${mapped} requires mapper ${mapperFor(project, mapped)!.package}. Pass --allow-external to run it.`);
  }
  const sessions = new Map<MapperDefinition, MapperProcess>();
  const diagnostics: Diagnostic[] = [];
  try {
    for (const file of files) {
      const original = fs.readFileSync(file, 'utf8');
      const mapper = mapperFor(project, file);
      let output: MapperOutput;
      let source: TextIndex;
      if (mapper) {
        let session = sessions.get(mapper);
        if (!session) {
          session = await new MapperProcess(mapper, project).start();
          sessions.set(mapper, session);
        }
        try {
          output = await session.transform(file, original);
        } catch (error) {
          // A failed transform is an error in that file; the rest of the project is still linted. A mapper that
          // exited is restarted for the next file.
          if (session.closed) {
            sessions.delete(mapper);
            await session.stop();
          }
          diagnostics.push({ file, line: 1, column: 1, start: 0, end: 0, severity: 'error',
            rule: `mapper/${session.sourceName}`,
            message: `Transform failed: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        source = indexText(original, session.positionEncoding);
        diagnostics.push(...mapperDiagnostics(file, source, output, session.sourceName));
      } else {
        output = identityOutput(original, path.extname(file).toLowerCase());
        source = indexText(original, 'utf-16');
      }
      diagnostics.push(...lintFile({ originalFile: file, original: source,
        outputs: [output, ...output.supplemental ?? []], rules }));
    }
  } finally {
    await Promise.all([...sessions.values()].map(s => s.stop()));
  }
  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end ||
    a.rule.localeCompare(b.rule));
  // The same user code can appear in canonical and supplemental virtual sources.
  const seen = new Set<string>();
  const deduped = diagnostics.filter(d => {
    const key = JSON.stringify([d.file, d.start, d.end, d.rule, d.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { files: files.length, diagnostics: deduped, project };
}

/** Mapper diagnostics are positioned in the original file, in the negotiated encoding. */
function mapperDiagnostics(file: string, original: TextIndex, output: MapperOutput, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const d of output.diagnostics ?? []) {
    const span = decodeSpan(original, d.start, d.start + d.length);
    if (!span) continue;
    diagnostics.push({ file, ...original.lineColumn(span.start), ...span, severity: 'error',
      rule: d.code === undefined ? `mapper/${source}` : `mapper/${source}/${d.code}`, message: d.messageText });
  }
  return diagnostics;
}

export async function runNativeCompiler(projectFile: string): Promise<CompilerResult> {
  const cwd = path.dirname(path.resolve(projectFile));
  const command = findUp(cwd, path.join('node_modules', 'typescript', 'bin', 'tsc'));
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
