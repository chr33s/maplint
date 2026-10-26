import fs from 'node:fs';
import path from 'node:path';
import type * as TS from '@typescript/typescript6';
import { legacyTS } from './ts6.js';
import type { MapperDefinition, ProjectConfig } from './types.js';

export const BASE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORED_DIR_GLOBS = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.svelte-kit', '.astro']
  .map(name => `**/${name}/**`);

export function readProject(configPath: string): ProjectConfig {
  const filename = path.resolve(configPath);
  const ts = legacyTS();
  const read = ts.readConfigFile(filename, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  // Legacy TS6 does not know TS7's contentMappers key but retains it in raw config.
  const contentMappers: unknown = read.config.contentMappers ?? [];
  if (!Array.isArray(contentMappers)) throw new Error('tsconfig contentMappers must be an array');
  const mappers = new Map<string, MapperDefinition[]>();
  for (const mapper of contentMappers) {
    if (!mapper || typeof mapper.package !== 'string' || !Array.isArray(mapper.extensions) ||
        !mapper.extensions.every((e: unknown) => typeof e === 'string' && e.startsWith('.')))
      throw new Error('Invalid content mapper declaration in tsconfig.json');
    for (const extension of new Set<string>(mapper.extensions)) {
      mappers.set(extension, [...mappers.get(extension) ?? [], mapper]);
    }
  }
  // TypeScript resolves files/include/exclude (and extends) and hands the wildcard specs to readDirectory. Maplint
  // matches them itself: TypeScript would keep only program files, dropping JavaScript without allowJs and files
  // that share a name with a higher-priority extension.
  const lintable = [...BASE_EXTENSIONS, ...mappers.keys()];
  let matched: string[] = [];
  const host: TS.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory(root, _extensions, excludes, includes, depth) {
      matched = ts.sys.readDirectory(root, lintable, [...excludes ?? [], ...IGNORED_DIR_GLOBS], includes, depth);
      return [];
    },
  };
  // With wildcard matches withheld, TypeScript's file list holds only the literal `files` entries.
  const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(filename), undefined, filename);
  return { filename, root: path.dirname(filename), compilerOptions: parsed.options,
    fileNames: [...parsed.fileNames, ...matched], mappers };
}

/** The content mapper for `file`'s extension. Conflicting registrations are an error only for files that use them. */
export function mapperFor(project: ProjectConfig, file: string): MapperDefinition | undefined {
  const extension = path.extname(file).toLowerCase();
  const [mapper, ...others] = project.mappers.get(extension) ?? [];
  if (others.length) throw new Error(`More than one mapper registered for ${extension} in ${project.filename}`);
  return mapper;
}

export function loadRuleConfig(root: string): Record<string, unknown> {
  const p = path.join(root, 'maplint.config.json');
  if (!fs.existsSync(p)) return {};
  const config = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (config.rules && (typeof config.rules !== 'object' || Array.isArray(config.rules)))
    throw new Error('maplint.config.json rules must be an object');
  return config.rules ?? {};
}

/** Lintable files: the tsconfig's file list, or the given paths when there are any. */
export function collectFiles(project: ProjectConfig, inputs: string[]): string[] {
  const extensions = [...BASE_EXTENSIONS, ...project.mappers.keys()];
  const supported = (file: string) => extensions.includes(path.extname(file).toLowerCase());
  const candidates = !inputs.length ? project.fileNames : inputs.flatMap(input => {
    const absolute = path.resolve(input);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (!stat) throw new Error(`Input path does not exist: ${input}`);
    if (stat.isDirectory()) {
      return legacyTS().sys.readDirectory(absolute, extensions, IGNORED_DIR_GLOBS, ['**/*']);
    }
    if (!supported(absolute)) throw new Error(`No parser or content mapper configured for ${input}`);
    return [absolute];
  });
  const files = new Set<string>();
  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (supported(file) && !/\.d\.[cm]?ts$/.test(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      files.add(file);
    }
  }
  return [...files].sort();
}

/** Walk up from `start` and return the first existing `<dir>/<relative>`. */
export function findUp(start: string, relative: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Package resolver deliberately scopes mapper resolution to node_modules reachable from tsconfig. */
export function resolveMapperPackage(packageName: string, projectRoot: string): {
  directory: string;
  exec: string[];
  compilerOptions: string[];
} {
  if (!/^(?:@[^/]+\/)?[\w.-]+$/.test(packageName)) {
    throw new Error(`Content mapper must be an npm package name: ${packageName}`);
  }
  const manifest = findUp(projectRoot, path.join('node_modules', packageName, 'package.json'));
  if (!manifest) throw new Error(`Missing mapper package ${packageName} (run npm install in project root)`);
  const def = JSON.parse(fs.readFileSync(manifest, 'utf8')).typescript?.contentMapper;
  if (!def || !Array.isArray(def.exec) || !def.exec.length || !def.exec.every((a: unknown) => typeof a === 'string')) {
    throw new Error(`${packageName} has no valid typescript.contentMapper.exec`);
  }
  return { directory: path.dirname(manifest), exec: def.exec, compilerOptions: def.compilerOptions ?? [] };
}
