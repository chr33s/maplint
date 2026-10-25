import { legacyTS } from './config.mjs';
import { mappingForSpan } from './mapper-host.mjs';

export const DEFAULT_RULES = {
  'no-debugger': 'error',
  'no-console': 'warn',
  eqeqeq: 'warn',
  'no-var': 'warn',
  'no-eval': 'error',
  'no-explicit-any': 'warn',
};
const RULES = new Set(Object.keys(DEFAULT_RULES));
const SEVERITIES = new Set(['off', 'warn', 'error']);

export function normalizeRules(config = {}) {
  for (const [rule, severity] of Object.entries(config)) {
    if (!RULES.has(rule)) throw new Error(`Unknown maplint rule: ${rule}`);
    if (!SEVERITIES.has(severity)) throw new Error(`Invalid severity for ${rule}: ${severity}`);
  }
  return { ...DEFAULT_RULES, ...config };
}

export function lintVirtual({ originalFile, original, virtual, output, encoding = 'utf-16', rules = DEFAULT_RULES }) {
  const ts = legacyTS();
  const extension = output.extension.toLowerCase();
  const kind = ['.tsx', '.jsx'].includes(extension) ? ts.ScriptKind.TSX
    : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(virtual, output.text, ts.ScriptTarget.Latest, true, kind);
  const problems = [];
  function emit(rule, message, start, end, forceError = false) {
    if (!forceError && rules[rule] === 'off') return;
    const mapped = mappingForSpan(output, original, encoding, start, end);
    if (!mapped || mapped.start < 0 || mapped.end < mapped.start || mapped.end > original.length) return;
    const line = lineCol(original, mapped.start);
    if (!forceError && disabled(original, line.line, rule)) return;
    problems.push({ file: originalFile, line: line.line, column: line.column,
      start: mapped.start, end: mapped.end, severity: forceError ? 'error' : rules[rule], rule, message });
  }

  for (const d of sf.parseDiagnostics ?? []) {
    const start = d.start ?? 0;
    emit('syntax', ts.flattenDiagnosticMessageText(d.messageText, '\n'), start, start + (d.length ?? 0), true);
  }
  function walk(node) {
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

export function lineCol(text, index) {
  const prefix = text.slice(0, index);
  const line = prefix.split('\n').length;
  const last = prefix.lastIndexOf('\n');
  return { line, column: index - last };
}

function disabled(text, line, rule) {
  const lines = text.split(/\r?\n/);
  const same = lines[line - 1] ?? '';
  const previous = lines[line - 2] ?? '';
  function contains(disable) {
    // This intentionally handles line comments, not block directives.
    const match = /\/\/\s*maplint-disable(?:-next-line|-line)?\b\s*(.*)/.exec(disable);
    if (!match) return false;
    const named = match[1].split(/[\s,]+/).filter(Boolean);
    return named.length === 0 || named.includes(rule);
  }
  return (/maplint-disable-line\b/.test(same) && contains(same)) ||
    (/maplint-disable-next-line\b/.test(previous) && contains(previous));
}
