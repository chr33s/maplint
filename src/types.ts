export type PositionEncoding = 'utf-16' | 'utf-8';
export type RuleName = 'no-debugger' | 'no-console' | 'eqeqeq' | 'no-var' | 'no-eval' | 'no-explicit-any';
export type Severity = 'off' | 'warn' | 'error';

export interface MapperDefinition {
  package: string;
  extensions: string[];
  options?: Record<string, unknown>;
}

export interface ProjectConfig {
  filename: string;
  root: string;
  raw: Record<string, any>;
  compilerOptions: Record<string, unknown>;
  contentMappers: MapperDefinition[];
}

export interface MapperDiagnostic {
  start: number;
  length: number;
  code?: string | number;
  messageText: string;
}

export interface MapperOutput {
  text: string;
  extension: string;
  mappings?: number[][];
  diagnostics?: MapperDiagnostic[];
  supplemental?: MapperOutput[];
}

export interface SourceSpan {
  start: number;
  end: number;
}

export interface Diagnostic extends SourceSpan {
  file: string;
  line: number;
  column: number;
  severity: Exclude<Severity, 'off'>;
  rule: string;
  message: string;
}

export interface LineColumn {
  line: number;
  column: number;
}
