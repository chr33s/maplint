import type * as TS from '@typescript/typescript6';
import { legacyTS } from './ts6.js';
import { normalizeRules, RULES, type Rule, type RuleConfig, type RuleName, type Severity } from './rules.js';
import { indexText, mappingForSpan, type TextIndex } from './spans.js';
import type { Diagnostic, MapperOutput, SourceSpan } from './types.js';

const RULE_ENTRIES = Object.entries(RULES) as Array<[RuleName, Rule]>;
const DIRECTIVE = /^\/\/\s*maplint-disable-(next-line|line)\b\s*(.*)/;

interface Finding extends SourceSpan {
  rule: RuleName | 'syntax';
  message: string;
}

export function lintVirtual({
  originalFile,
  original,
  virtual,
  output,
  rules = normalizeRules(),
}: {
  originalFile: string;
  /** The original file's text, indexed in the mapper's position encoding. */
  original: TextIndex;
  /** Virtual file name; its extension selects the script kind. */
  virtual: string;
  output: MapperOutput;
  rules?: RuleConfig;
}): Diagnostic[] {
  const ts = legacyTS();
  const sf = ts.createSourceFile(virtual, output.text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];

  // parseDiagnostics is internal API, but avoids building a Program just to report syntax errors.
  for (const d of (sf as TS.SourceFile & { parseDiagnostics?: TS.Diagnostic[] }).parseDiagnostics ?? []) {
    const start = d.start ?? 0;
    findings.push({ rule: 'syntax', message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      start, end: start + (d.length ?? 0) });
  }
  const context = { ts, sf };
  function walk(node: TS.Node): void {
    for (const [rule, { message, check }] of RULE_ENTRIES) {
      const span = check(node, context);
      if (span) findings.push({ rule, message, ...span });
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);

  const virtualText = indexText(output.text, original.encoding);
  const mapSpan = (start: number, end: number) => mappingForSpan(output.mappings, virtualText, original, start, end);
  const suppressions: Array<{ line: number; rules: string[] }> = [];
  for (const comment of lineComments(ts, sf)) {
    const match = DIRECTIVE.exec(sf.text.slice(comment.start, comment.end));
    if (!match) continue;
    const mapped = mapSpan(comment.start, comment.end);
    if (!mapped) continue;
    const { line } = original.lineColumn(mapped.start);
    suppressions.push({ line: match[1] === 'line' ? line : line + 1, rules: match[2].split(/[\s,]+/).filter(Boolean) });
  }

  const severities: Record<Finding['rule'], Severity> = { ...rules, syntax: 'error' };
  const diagnostics: Diagnostic[] = [];
  for (const { rule, message, start, end } of findings) {
    const severity = severities[rule];
    if (severity === 'off') continue;
    const mapped = mapSpan(start, end);
    if (!mapped) continue;
    const { line, column } = original.lineColumn(mapped.start);
    // Syntax errors cannot be suppressed.
    if (rule !== 'syntax' && suppressions.some(s => s.line === line && (!s.rules.length || s.rules.includes(rule)))) continue;
    diagnostics.push({ file: originalFile, line, column, ...mapped, severity, rule, message });
  }
  return diagnostics;
}

/**
 * Single-line comments of `sf`, in one pass over its trivia. Only the text outside leaf tokens is scanned: between a
 * node's children there is nothing but trivia, punctuation and keywords, so strings, regexes, templates and JSX text
 * are never mistaken for comments.
 */
function lineComments(ts: typeof TS, sf: TS.SourceFile): SourceSpan[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sf.text);
  const comments: SourceSpan[] = [];
  function scan(pos: number, end: number): void {
    scanner.resetTokenState(pos);
    while (scanner.getTokenEnd() < end) {
      const kind = scanner.scan();
      if (kind === ts.SyntaxKind.EndOfFileToken) return;
      if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
        comments.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
      }
    }
  }
  function visit(node: TS.Node): void {
    if (ts.isJsxText(node)) return; // JSX text has no trivia; `//` in it is text.
    let pos = node.pos;
    let leaf = true;
    ts.forEachChild(node, child => {
      leaf = false;
      scan(pos, child.pos);
      visit(child);
      pos = child.end;
    });
    // A leaf's own text is a single token: scan only the trivia before it.
    scan(pos, leaf ? node.getStart(sf) : node.end);
  }
  visit(sf);
  return comments;
}
