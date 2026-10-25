import { spawn } from 'node:child_process';
import { JsonRpcPeer } from './jsonrpc.mjs';
import { resolveMapperPackage } from './config.mjs';

let nextHandle = 1;
export class MapperProcess {
  constructor(definition, project) {
    this.definition = definition;
    this.project = project;
    this.handle = `maplint-${process.pid}-${nextHandle++}`;
    this.child = null;
    this.peer = null;
    this.positionEncoding = 'utf-16';
  }

  async start() {
    const info = resolveMapperPackage(this.definition.package, this.project.root);
    const [command, ...argv] = info.exec;
    // exec from package.json is user-controlled; caller must opt in using --allow-external.
    const child = spawn(command, argv, {
      cwd: info.directory, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-4000); });
    this.peer = new JsonRpcPeer(child.stdout, child.stdin, { timeoutMs: 15_000 });
    child.once('error', e => this.peer.close(new Error(`Mapper ${this.definition.package}: ${e.message}`)));
    child.once('exit', (code, signal) => this.peer.close(new Error(
      `Mapper ${this.definition.package} exited (${code ?? signal})${stderr ? ': ' + stderr : ''}`,
    )));
    try {
      const hello = await this.peer.request('initialize', {
        protocolVersion: 1, locale: 'en', positionEncodings: ['utf-16', 'utf-8'],
      });
      if (!['utf-16', 'utf-8'].includes(hello?.positionEncoding)) throw new Error('Mapper returned invalid position encoding');
      this.positionEncoding = hello.positionEncoding;
      this.sourceName = hello.diagnosticSource || this.definition.package;
      const compilerOptions = {};
      for (const key of info.compilerOptions) {
        if (Object.hasOwn(this.project.compilerOptions, key))
          compilerOptions[key] = this.project.compilerOptions[key];
      }
      const projectResponse = await this.peer.request('openProject', {
        configFileName: this.project.filename,
        projectHandle: this.handle,
        options: this.definition.options ?? {},
        compilerOptions,
      });
      if (projectResponse?.optionDiagnostics?.length) {
        throw new Error(`Mapper reported configuration errors: ${projectResponse.optionDiagnostics.map(d => d.messageText).join('; ')}`);
      }
      return this;
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  async transform(fileName, content) {
    const result = await this.peer.request('transform', { fileName, content, projectHandle: this.handle });
    if (!result || typeof result.text !== 'string' || !/^\.(?:[cm]?[jt]sx?|json)$/.test(result.extension)) {
      throw new Error(`${this.definition.package} returned invalid virtual text/extension`);
    }
    if (result.mappings !== undefined && !Array.isArray(result.mappings)) throw new Error('Invalid mapping table');
    return result;
  }

  async stop() {
    if (!this.child) return;
    if (!this.peer.closed) {
      try { await this.peer.request('closeProject', { projectHandle: this.handle }); } catch { /* best effort */ }
    }
    this.peer.close();
    this.child.stdin.end();
    this.child.kill();
    this.child = null;
  }
}

export function mappingForSpan(output, original, encoding, start, end) {
  // All linter offsets are JS string indices. Protocol offsets may be UTF-8 bytes.
  const spanStart = encoding === 'utf-8' ? byteOffset(output.text, start) : start;
  const spanEnd = encoding === 'utf-8' ? byteOffset(output.text, end) : end;
  const mappings = output.mappings ?? [];
  for (const entry of mappings) {
    if (!Array.isArray(entry) || entry.length < 5 || entry.some((v, i) => i < 5 && !Number.isSafeInteger(v))) continue;
    const [vStart, vLength, oStart, oLength, kind] = entry;
    if (spanStart < vStart || spanEnd > vStart + vLength) continue;
    if (kind === 0 && vLength === oLength) { // 1:1 verbatim mapping
      const mappedStart = oStart + spanStart - vStart;
      const mappedEnd = oStart + spanEnd - vStart;
      return { start: encoding === 'utf-8' ? jsOffset(original, mappedStart) : mappedStart,
               end: encoding === 'utf-8' ? jsOffset(original, mappedEnd) : mappedEnd };
    }
    // Atoms/aliases have no meaningful partial positions. Map only whole atoms.
    if ((kind === 1 || kind === 2) && spanStart === vStart && spanEnd === vStart + vLength) {
      return { start: encoding === 'utf-8' ? jsOffset(original, oStart) : oStart,
               end: encoding === 'utf-8' ? jsOffset(original, oStart + oLength) : oStart + oLength };
    }
  }
  // Synthetic text has no original location: never invent a diagnostic span.
  return null;
}

function byteOffset(text, index) { return Buffer.byteLength(text.slice(0, index), 'utf8'); }
function jsOffset(text, bytes) {
  if (bytes === 0) return 0;
  let i = 0;
  let b = 0;
  while (i < text.length && b < bytes) {
    const codePoint = text.codePointAt(i);
    const char = String.fromCodePoint(codePoint);
    b += Buffer.byteLength(char, 'utf8');
    i += char.length;
  }
  if (b !== bytes) return -1; // invalid boundary; caller skips it
  return i;
}
