import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonRpcPeer } from '../src/jsonrpc.js';

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

test('framing handles split, coalesced, and maximum-size messages', async () => {
  const input = new PassThrough();
  const peer = new JsonRpcPeer(input, new PassThrough());
  const frame = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  };
  const first = peer.request('a', {});
  const second = peer.request('b', {});
  const both = Buffer.concat([frame({ id: 1, result: 'one' }), frame({ id: 2, result: 'two' })]);
  for (let i = 0; i < both.length; i += 3) input.write(both.subarray(i, i + 3));
  assert.deepEqual(await Promise.all([first, second]), ['one', 'two']);

  // A body of exactly 32 MiB is accepted, arriving in pipe-sized chunks.
  const big = peer.request('c', {});
  const overhead = JSON.stringify({ jsonrpc: '2.0', id: 3, result: '' }).length;
  const message = frame({ id: 3, result: 'x'.repeat(32 * 1024 * 1024 - overhead) });
  for (let i = 0; i < message.length; i += 65536) input.write(message.subarray(i, i + 65536));
  assert.equal((await big).length, 32 * 1024 * 1024 - overhead);
  peer.close(); input.end();
});
