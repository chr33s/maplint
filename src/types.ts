import type { Severity } from './rules.js';

export type PositionEncoding = 'utf-16' | 'utf-8';

export interface MapperDefinition {
  package: string;
  extensions: string[];
  options?: Record<string, unknown>;
}

export interface ProjectConfig {
  filename: string;
  root: string;
  compilerOptions: Record<string, unknown>;
  /** Lintable files selected by the tsconfig's files/include/exclude, including mapped extensions. */
  fileNames: string[];
  /** The content mappers registered for each declared extension; more than one is a conflict. */
  mappers: Map<string, MapperDefinition[]>;
}

export interface MapperDiagnostic {
  start: number;
  length: number;
  code?: string | number;
  messageText: string;
}

/** `[virtualStart, virtualLength, originalStart, originalLength, kind, features?]` */
export type Mapping = [number, number, number, number, number, ...unknown[]];

export interface MapperOutput {
  text: string;
  extension: string;
  mappings: Mapping[];
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
