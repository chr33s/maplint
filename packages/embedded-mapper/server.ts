import { JsonRpcPeer } from '../../src/jsonrpc.js';
import { buildEmbeddedVirtual } from '../../src/embedded.js';
import type { PositionEncoding } from '../../src/types.js';

// The compiler starts this executable as a separate trusted process.
// Never write logs to stdout; stdout is reserved for framed JSON-RPC.
let encoding: PositionEncoding = 'utf-16';
const projects = new Set<string>();
const handlers = {
  initialize(params: { positionEncodings?: string[] }) {
    const offered = params.positionEncodings ?? [];
    const selected = offered.includes('utf-16') ? 'utf-16' : offered.includes('utf-8') ? 'utf-8' : undefined;
    if (!selected) throw new Error('No compatible position encoding');
    encoding = selected;
    return { positionEncoding: encoding, diagnosticSource: 'maplint-embedded' };
  },
  openProject(params: { projectHandle: string }) { projects.add(params.projectHandle); return {}; },
  transform(params: { projectHandle: string; fileName: string; content: string }) {
    if (!projects.has(params.projectHandle)) throw new Error('Unknown project handle');
    return buildEmbeddedVirtual(params.fileName, params.content, encoding);
  },
  closeProject(params: { projectHandle: string }) { projects.delete(params.projectHandle); return null; },
};
new JsonRpcPeer(process.stdin, process.stdout, { handlers });
