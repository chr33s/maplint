import { createRequire } from 'node:module';
import type * as TS from '@typescript/typescript6';

const require = createRequire(import.meta.url);
let ts: typeof TS | undefined;

/** Lazily load the TypeScript 6 compatibility API (config parsing and the AST used by rules). */
export function legacyTS(): typeof TS {
  return ts ??= require('@typescript/typescript6');
}
