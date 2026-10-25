import { JsonRpcPeer } from '../../src/jsonrpc.mjs';
import { buildEmbeddedVirtual } from '../../src/embedded.mjs';

// The compiler starts this executable as a separate trusted process.
// Never write logs to stdout; stdout is reserved for framed JSON-RPC.
let encoding = 'utf-16';
const projects = new Set();
const handlers = {
  initialize(params) {
    const offered = params.positionEncodings ?? [];
    encoding = offered.includes('utf-16') ? 'utf-16' : offered.includes('utf-8') ? 'utf-8' : '';
    if (!encoding) throw new Error('No compatible position encoding');
    return { positionEncoding: encoding, diagnosticSource: 'maplint-embedded' };
  },
  openProject(params) { projects.add(params.projectHandle); return {}; },
  transform(params) {
    if (!projects.has(params.projectHandle)) throw new Error('Unknown project handle');
    return buildEmbeddedVirtual(params.fileName, params.content, encoding);
  },
  closeProject(params) { projects.delete(params.projectHandle); return null; },
};
new JsonRpcPeer(process.stdin, process.stdout, { handlers });
