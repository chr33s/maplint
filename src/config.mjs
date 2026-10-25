import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ts;
export function legacyTS() {
  if (!ts) ts = require('@typescript/typescript6');
  return ts;
}

export const BASE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.svelte-kit', '.astro']);

export function readProject(configPath) {
  const filename = path.resolve(configPath);
  const compiler = legacyTS();
  const read = compiler.readConfigFile(filename, compiler.sys.readFile);
  if (read.error) throw new Error(compiler.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const raw = read.config;
  const parsed = compiler.parseJsonConfigFileContent(raw, compiler.sys, path.dirname(filename), undefined, filename);
  // Legacy TS6 does not know TS7's contentMappers key but retains it in raw config.
  const contentMappers = raw.contentMappers ?? [];
  if (!Array.isArray(contentMappers)) throw new Error('tsconfig contentMappers must be an array');
  for (const mapper of contentMappers) {
    if (!mapper || typeof mapper.package !== 'string' || !Array.isArray(mapper.extensions) ||
        !mapper.extensions.every(e => typeof e === 'string' && e.startsWith('.')))
      throw new Error('Invalid content mapper declaration in tsconfig.json');
  }
  return { filename, root: path.dirname(filename), raw, compilerOptions: parsed.options, contentMappers };
}

export function loadRuleConfig(root) {
  const p = path.join(root, 'maplint.config.json');
  if (!fs.existsSync(p)) return {};
  const config = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (config.rules && (typeof config.rules !== 'object' || Array.isArray(config.rules)))
    throw new Error('maplint.config.json rules must be an object');
  return config.rules ?? {};
}

export function collectFiles(project, inputs) {
  const supported = [...BASE_EXTENSIONS, ...project.contentMappers.flatMap(m => m.extensions)];
  const allowedExt = new Set(supported);
  const files = new Set();
  function addFile(name) {
    const absolute = path.resolve(name);
    if (absolute.endsWith('.d.ts') || absolute.endsWith('.d.mts') || absolute.endsWith('.d.cts')) return;
    if (allowedExt.has(path.extname(absolute).toLowerCase()) && fs.existsSync(absolute) && fs.statSync(absolute).isFile())
      files.add(absolute);
  }
  function walk(name) {
    const absolute = path.resolve(name);
    if (!fs.existsSync(absolute)) throw new Error(`Input path does not exist: ${name}`);
    const stat = fs.statSync(absolute);
    if (stat.isFile()) { addFile(absolute); return; }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) walk(path.join(absolute, entry.name));
      else if (entry.isFile()) addFile(path.join(absolute, entry.name));
    }
  }
  if (inputs.length) {
    for (const input of inputs) {
      const absolute = path.resolve(input);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile() &&
          !allowedExt.has(path.extname(absolute).toLowerCase())) {
        throw new Error(`No parser or content mapper configured for ${input}`);
      }
      walk(input);
    }
  } else {
    // TypeScript's readDirectory handles globs, excludes, and tsconfig files/includes.
    for (const p of project.raw.files ?? []) addFile(path.resolve(project.root, p));
    const includes = project.raw.include ?? (project.raw.files ? [] : ['**/*']);
    const excludes = [
      ...Array.from(IGNORED_DIRS).map(name => `**/${name}/**`),
      ...(project.raw.exclude ?? []),
    ];
    for (const p of legacyTS().sys.readDirectory(project.root, supported, excludes, includes)) addFile(p);
  }
  return [...files].sort();
}

/** Package resolver deliberately scopes mapper resolution to node_modules reachable from tsconfig. */
export function resolveMapperPackage(packageName, projectRoot) {
  if (!/^(?:@[^/]+\/)?[\w.-]+$/.test(packageName)) {
    throw new Error(`Content mapper must be an npm package name: ${packageName}`);
  }
  let directory = path.resolve(projectRoot);
  while (true) {
    const candidate = path.join(directory, 'node_modules', packageName, 'package.json');
    if (fs.existsSync(candidate)) {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const def = manifest.typescript?.contentMapper;
      if (!def || !Array.isArray(def.exec) || !def.exec.length || !def.exec.every(a => typeof a === 'string')) {
        throw new Error(`${packageName} has no valid typescript.contentMapper.exec`);
      }
      return { directory: path.dirname(candidate), manifest, exec: def.exec, compilerOptions: def.compilerOptions ?? [] };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Missing mapper package ${packageName} (run npm install in project root)`);
}
