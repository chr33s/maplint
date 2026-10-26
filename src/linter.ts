import type * as TS from '@typescript/typescript6';
import { legacyTS } from './ts6.js';
import { BASE_EXTENSIONS } from './project.js';
import { normalizeRules, RULES, type Rule, type RuleConfig, type RuleName, type Severity } from './rules.js';
import { createSpanMapper, indexText, type TextIndex } from './spans.js';
import type { Diagnostic, MapperOutput, SourceSpan } from './types.js';

const RULE_ENTRIES = Object.entries(RULES) as Array<[RuleName, Rule]>;
const DIRECTIVE = /^\/\/\s*maplint-disable-(next-line|line)\b\s*(.*)/;

/** Lint every JS/TS virtual output of one original file; suppression directives in any output apply to all. */
export function lintFile({
  originalFile,
  original,
  outputs,
  rules = normalizeRules(),
}: {
  originalFile: string;
  /** The original file's text, indexed in the mapper's position encoding. */
  original: TextIndex;
  /** The canonical output first, then supplemental outputs. Non-JS/TS outputs (e.g. JSON) are skipped. */
  outputs: MapperOutput[];
  rules?: RuleConfig;
}): Diagnostic[] {
  const ts = legacyTS();
  const severities: Record<RuleName | 'syntax', Severity> = { ...rules, syntax: 'error' };
  const findings: Diagnostic[] = [];
  const suppressions: Array<{ line: number; rules: string[] }> = [];
  for (const [index, output] of outputs.entries()) {
    // Declarations such as `.d.ts` are JS/TS too.
    if (!BASE_EXTENSIONS.some(extension => output.extension.toLowerCase().endsWith(extension))) continue;
    // The virtual file name's extension selects the script kind.
    const sf = ts.createSourceFile(`${originalFile}.virtual${index}${output.extension}`, output.text,
      ts.ScriptTarget.Latest, true);
    const spans = createSpanMapper(output.mappings, indexText(output.text, original.encoding), original);
    const report = (rule: RuleName | 'syntax', message: string, mapped: SourceSpan | null) => {
      const severity = severities[rule];
      if (severity === 'off' || !mapped) return;
      findings.push({ file: originalFile, ...original.lineColumn(mapped.start), ...mapped, severity, rule, message });
    };

    // parseDiagnostics is internal API, but avoids building a Program just to report syntax errors.
    for (const d of (sf as TS.SourceFile & { parseDiagnostics?: TS.Diagnostic[] }).parseDiagnostics ?? []) {
      const start = d.start ?? 0;
      // An error on synthetic text (such as a separator after an unclosed script) is usually caused by the user
      // code before it, so it is reported there.
      report('syntax', ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        spans.map(start, start + (d.length ?? 0)) ?? spans.nearestBefore(start));
    }
    const context = { ts, sf };
    const walk = (node: TS.Node): void => {
      for (const [rule, { message, check }] of RULE_ENTRIES) {
        const span = check(node, context);
        if (span) report(rule, message, spans.map(span.start, span.end));
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);

    for (const comment of lineComments(ts, sf)) {
      const match = DIRECTIVE.exec(sf.text.slice(comment.start, comment.end));
      const mapped = match && spans.map(comment.start, comment.end);
      if (!mapped) continue;
      const { line } = original.lineColumn(mapped.start);
      suppressions.push({ line: match[1] === 'line' ? line : line + 1, rules: match[2].split(/[\s,]+/).filter(Boolean) });
    }
  }
  // Syntax errors cannot be suppressed.
  return findings.filter(({ rule, line }) => rule === 'syntax' ||
    !suppressions.some(s => s.line === line && (!s.rules.length || s.rules.includes(rule))));
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
