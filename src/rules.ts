import type * as TS from '@typescript/typescript6';
import type { SourceSpan } from './types.js';

export const SEVERITIES = ['off', 'warn', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface RuleContext {
  ts: typeof TS;
  sf: TS.SourceFile;
}

export interface Rule {
  severity: Severity;
  message: string;
  /** The virtual-text span to report for `node`, if the rule applies to it. */
  check(node: TS.Node, context: RuleContext): SourceSpan | undefined;
}

function span(node: TS.Node, sf: TS.SourceFile): SourceSpan {
  return { start: node.getStart(sf), end: node.end };
}

/** Single source of truth for rule names, default severities, messages, and detection. */
export const RULES = {
  'no-debugger': {
    severity: 'error',
    message: 'Unexpected debugger statement',
    check: (node, { ts, sf }) => ts.isDebuggerStatement(node) ? span(node, sf) : undefined,
  },
  'no-console': {
    severity: 'warn',
    message: 'Unexpected console access',
    check: (node, { ts, sf }) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'console' ? span(node, sf) : undefined,
  },
  eqeqeq: {
    severity: 'warn',
    message: 'Use strict equality (=== or !==)',
    check: (node, { ts, sf }) => ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) ? span(node.operatorToken, sf) : undefined,
  },
  'no-var': {
    severity: 'warn',
    message: 'Use let or const instead of var',
    check: (node, { ts, sf }) => ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)
      ? { start: node.getStart(sf), end: node.getStart(sf) + 3 } : undefined,
  },
  'no-eval': {
    severity: 'error',
    message: 'Avoid eval()',
    check: (node, { ts, sf }) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'eval' ? span(node.expression, sf) : undefined,
  },
  'no-explicit-any': {
    severity: 'warn',
    message: 'Avoid explicit any type',
    check: (node, { ts, sf }) => node.kind === ts.SyntaxKind.AnyKeyword ? span(node, sf) : undefined,
  },
} satisfies Record<string, Rule>;

export type RuleName = keyof typeof RULES;
export type RuleConfig = Record<RuleName, Severity>;

export function normalizeRules(config: Record<string, unknown> = {}): RuleConfig {
  const rules = Object.fromEntries(Object.entries(RULES).map(([name, rule]) => [name, rule.severity])) as RuleConfig;
  for (const [rule, severity] of Object.entries(config)) {
    if (!Object.hasOwn(RULES, rule)) throw new Error(`Unknown maplint rule: ${rule}`);
    if (!SEVERITIES.includes(severity as Severity)) throw new Error(`Invalid severity for ${rule}: ${severity}`);
    rules[rule as RuleName] = severity as Severity;
  }
  return rules;
}
