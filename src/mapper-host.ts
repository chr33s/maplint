import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { JsonRpcPeer } from './jsonrpc.js';
import { resolveMapperPackage } from './project.js';
import type { Mapping, MapperDefinition, MapperDiagnostic, MapperOutput, PositionEncoding, ProjectConfig } from './types.js';

const VIRTUAL_EXTENSION = /^\.(?:[cm]?[jt]sx?|json)$/;

let nextHandle = 1;
export class MapperProcess {
  private readonly definition: MapperDefinition;
  private readonly project: ProjectConfig;
  private readonly handle: string;
  private readonly forwardedOptions: string[];
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly peer: JsonRpcPeer;
  positionEncoding: PositionEncoding;
  sourceName = '';

  /** Spawns the mapper process; `start()` performs the protocol handshake. */
  constructor(definition: MapperDefinition, project: ProjectConfig) {
    this.definition = definition;
    this.project = project;
    this.handle = `maplint-${process.pid}-${nextHandle++}`;
    this.positionEncoding = 'utf-16';
    const info = resolveMapperPackage(definition.package, project.root);
    this.forwardedOptions = info.compilerOptions;
    const [command, ...argv] = info.exec;
    // exec from package.json is user-controlled; caller must opt in using --allow-external.
    const child = spawn(command, argv, {
      cwd: info.directory, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-4000); });
    const peer = new JsonRpcPeer(child.stdout, child.stdin);
    this.peer = peer;
    child.once('error', e => peer.close(new Error(`Mapper ${definition.package}: ${e.message}`)));
    child.once('exit', (code, signal) => peer.close(new Error(
      `Mapper ${definition.package} exited (${code ?? signal})${stderr ? ': ' + stderr : ''}`,
    )));
  }

  async start(): Promise<this> {
    try {
      const hello = await this.peer.request('initialize', {
        protocolVersion: 1, locale: 'en', positionEncodings: ['utf-16', 'utf-8'],
      });
      if (!['utf-16', 'utf-8'].includes(hello?.positionEncoding)) throw new Error('Mapper returned invalid position encoding');
      this.positionEncoding = hello.positionEncoding;
      this.sourceName = hello.diagnosticSource || this.definition.package;
      const compilerOptions = Object.fromEntries(this.forwardedOptions
        .filter(key => Object.hasOwn(this.project.compilerOptions, key))
        .map(key => [key, this.project.compilerOptions[key]]));
      const projectResponse = await this.peer.request('openProject', {
        configFileName: this.project.filename,
        projectHandle: this.handle,
        options: this.definition.options ?? {},
        compilerOptions,
      });
      if (projectResponse?.optionDiagnostics?.length) {
        throw new Error(`Mapper reported configuration errors: ${projectResponse.optionDiagnostics
          .map((d: { messageText: string }) => d.messageText).join('; ')}`);
      }
      return this;
    } catch (e) {
      // A mapper that failed its handshake may never answer closeProject: tear it down directly.
      this.peer.close();
      this.child.kill();
      throw e;
    }
  }

  async transform(fileName: string, content: string): Promise<MapperOutput> {
    const result = await this.peer.request('transform', { fileName, content, projectHandle: this.handle });
    return validateOutput(result, this.definition.package);
  }

  async stop() {
    if (!this.peer.closed) {
      try { await this.peer.request('closeProject', { projectHandle: this.handle }); } catch { /* best effort */ }
    }
    this.peer.close();
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Check a transform response once, at the process boundary, so later stages can trust its shape. */
function validateOutput(value: any, source: string, supplemental = false): MapperOutput {
  // Supplemental outputs (e.g. `.d.ts` declarations) may use any extension; only JS/TS ones are linted.
  if (!value || typeof value.text !== 'string' ||
      !(supplemental ? typeof value.extension === 'string' : VIRTUAL_EXTENSION.test(value.extension))) {
    throw new Error(`${source} returned invalid virtual text/extension`);
  }
  for (const key of ['mappings', 'diagnostics', 'supplemental']) {
    if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error(`${source} returned invalid ${key}`);
  }
  return {
    text: value.text,
    extension: value.extension,
    // Malformed entries are dropped: a span without a valid mapping is never reported.
    mappings: (value.mappings ?? []).filter(isMapping),
    diagnostics: (value.diagnostics ?? []).filter(isDiagnostic),
    supplemental: (value.supplemental ?? []).map((item: unknown) => validateOutput(item, source, true)),
  };
}

function isMapping(entry: unknown): entry is Mapping {
  return Array.isArray(entry) && entry.length >= 5 && entry.slice(0, 5).every(Number.isSafeInteger);
}

function isDiagnostic(d: any): d is MapperDiagnostic {
  return Number.isSafeInteger(d?.start) && Number.isSafeInteger(d.length) && d.length >= 0 &&
    Number.isSafeInteger(d.start + d.length) && typeof d.messageText === 'string' &&
    (d.code === undefined || typeof d.code === 'string' || typeof d.code === 'number');
}
