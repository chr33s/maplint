import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonRpcPeer } from '../src/jsonrpc.mjs';

test('framed JSON-RPC handles two directions and unicode', async () => {
  const fromA = new PassThrough();
  const fromB = new PassThrough();
  const a = new JsonRpcPeer(fromB, fromA, { handlers: { echo: p => ({ answer: p.text }) } });
  const b = new JsonRpcPeer(fromA, fromB, { handlers: { uppercase: p => p.text.toUpperCase() } });
  assert.deepEqual(await b.request('echo', { text: 'こんにちは😊' }), { answer: 'こんにちは😊' });
  assert.equal(await a.request('uppercase', { text: 'hello' }), 'HELLO');
  a.close(); b.close();
  fromA.end(); fromB.end();
});

test('errors propagate across JSON-RPC', async () => {
  const fromA = new PassThrough();
  const fromB = new PassThrough();
  const a = new JsonRpcPeer(fromB, fromA, { handlers: {} });
  const b = new JsonRpcPeer(fromA, fromB);
  await assert.rejects(b.request('doesNotExist', {}), /No method/);
  a.close(); b.close(); fromA.end(); fromB.end();
});
