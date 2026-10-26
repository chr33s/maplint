import { legacyTS } from './config.js';
import { mappingForSpan } from './mapper-host.js';
import type { Diagnostic, LineColumn, MapperOutput, RuleName, Severity } from './types.js';

export const DEFAULT_RULES: Record<RuleName, Severity> = {
  'no-debugger': 'error',
  'no-console': 'warn',
  eqeqeq: 'warn',
  'no-var': 'warn',
  'no-eval': 'error',
  'no-explicit-any': 'warn',
};
const RULES = new Set(Object.keys(DEFAULT_RULES));
const SEVERITIES = new Set(['off', 'warn', 'error']);

export function normalizeRules(config: Record<string, Severity> = {}): Record<RuleName, Severity> {
  for (const [rule, severity] of Object.entries(config)) {
    if (!RULES.has(rule)) throw new Error(`Unknown maplint rule: ${rule}`);
    if (!SEVERITIES.has(severity)) throw new Error(`Invalid severity for ${rule}: ${severity}`);
  }
  return { ...DEFAULT_RULES, ...config };
}

export function lintVirtual({
  originalFile,
  original,
  virtual,
  output,
  encoding = 'utf-16',
  rules = DEFAULT_RULES,
}: {
  originalFile: string;
  original: string;
  virtual: string;
  output: MapperOutput;
  encoding?: 'utf-16' | 'utf-8';
  rules?: Record<RuleName, Severity>;
}): Diagnostic[] {
  const ts = legacyTS();
  const extension = output.extension.toLowerCase();
  const kind = ['.tsx', '.jsx'].includes(extension) ? ts.ScriptKind.TSX
    : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(virtual, output.text, ts.ScriptTarget.Latest, true, kind);
  const suppressionDirectives = getSuppressionDirectives(ts, original);
  const problems: Diagnostic[] = [];
  function emit(rule: RuleName | 'syntax', message: string, start: number, end: number, forceError = false): void {
    if (!forceError && rules[rule as RuleName] === 'off') return;
    const mapped = mappingForSpan(output, original, encoding, start, end);
    if (!mapped || mapped.start < 0 || mapped.end < mapped.start || mapped.end > original.length) return;
    const line = lineCol(original, mapped.start);
    if (!forceError && disabled(suppressionDirectives, line.line, rule)) return;
    problems.push({ file: originalFile, line: line.line, column: line.column,
      start: mapped.start, end: mapped.end, severity: forceError ? 'error' : rules[rule as RuleName] as Exclude<Severity, 'off'>, rule, message });
  }

  for (const d of sf.parseDiagnostics ?? []) {
    const start = d.start ?? 0;
    emit('syntax', ts.flattenDiagnosticMessageText(d.messageText, '\n'), start, start + (d.length ?? 0), true);
  }
  function walk(node: any): void {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      emit('no-debugger', 'Unexpected debugger statement', node.getStart(sf), node.end);
    }
    if (node.kind === ts.SyntaxKind.PropertyAccessExpression &&
        node.expression?.kind === ts.SyntaxKind.Identifier && node.expression.text === 'console') {
      emit('no-console', 'Unexpected console access', node.getStart(sf), node.end);
    }
    if (node.kind === ts.SyntaxKind.CallExpression &&
        node.expression?.kind === ts.SyntaxKind.Identifier && node.expression.text === 'eval') {
      emit('no-eval', 'Avoid eval()', node.expression.getStart(sf), node.expression.end);
    }
    if (node.kind === ts.SyntaxKind.BinaryExpression &&
        [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      emit('eqeqeq', 'Use strict equality (=== or !==)', node.operatorToken.getStart(sf), node.operatorToken.end);
    }
    if (node.kind === ts.SyntaxKind.VariableDeclarationList &&
        (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      emit('no-var', 'Use let or const instead of var', node.getStart(sf), node.getStart(sf) + 3);
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      emit('no-explicit-any', 'Avoid explicit any type', node.getStart(sf), node.end);
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return problems;
}

export function lineCol(text: string, index: number): LineColumn {
  const prefix = text.slice(0, index);
  const line = prefix.split('\n').length;
  const last = prefix.lastIndexOf('\n');
  return { line, column: index - last };
}

function getSuppressionDirectives(ts: any, text: string): Map<number, { mode: string; rules: string[] }> {
  const directives = new Map();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    const match = /^\/\/\s*maplint-disable(-next-line|-line)?\b\s*(.*)/.exec(comment);
    if (!match) continue;
    const line = lineCol(text, scanner.getTokenPos()).line;
    directives.set(line, {
      mode: match[1] ?? '',
      rules: match[2].split(/[\s,]+/).filter(Boolean),
    });
  }
  return directives;
}

function disabled(directives: Map<number, { mode: string; rules: string[] }>, line: number, rule: string): boolean {
  function applies(directive: { mode: string; rules: string[] } | undefined): boolean {
    return Boolean(directive && (!directive.rules.length || directive.rules.includes(rule)));
  }
  const sameLine = directives.get(line);
  const previousLine = directives.get(line - 1);
  return Boolean((sameLine?.mode === '-line' && applies(sameLine)) ||
    (previousLine?.mode === '-next-line' && applies(previousLine)));
}
