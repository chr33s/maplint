/** JSON-RPC 2.0 over Content-Length framed byte streams (the TypeScript mapper transport). */
import type { Readable, Writable } from 'node:stream';

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcOptions {
  handlers?: Record<string, (params: any) => unknown | Promise<unknown>>;
  timeoutMs?: number;
}

export class JsonRpcPeer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly handlers: NonNullable<JsonRpcOptions['handlers']>;
  private readonly timeoutMs: number;
  /** An incomplete header. */
  private header: Buffer;
  /** Chunks of the current body, once its header is read; joined only when complete. */
  private body: Buffer[];
  private bodyBytes: number;
  private contentLength: number | null;
  private nextId: number;
  private readonly pending: Map<number, PendingRequest>;
  closed: boolean;

  constructor(input: Readable, output: Writable, options: JsonRpcOptions = {}) {
    this.input = input;
    this.output = output;
    this.handlers = options.handlers ?? {};
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.header = Buffer.alloc(0);
    this.body = [];
    this.bodyBytes = 0;
    this.contentLength = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    input.on('data', (chunk) => this.#onData(chunk));
    input.on('end', () => this.close(new Error('Mapper stream ended')));
    input.on('error', (error) => this.close(error));
    output.on('error', (error) => this.close(error));
  }

  send(message: Record<string, any>): void {
    if (this.closed) throw new Error('JSON-RPC connection is closed');
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.output.write(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    this.output.write(payload);
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Content mapper timed out (${method})`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  close(reason: Error = new Error('JSON-RPC connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(reason);
    }
    this.pending.clear();
  }

  #onData(chunk: Buffer | string) {
    let data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    // Bytes are copied only to complete a header or a body, so a large message costs linear time. Both are bounded:
    // untrusted data, including never-terminated headers, cannot grow without limit.
    while (!this.closed) {
      if (this.contentLength === null) {
        const pending = this.header.length ? Buffer.concat([this.header, data]) : data;
        const headerEnd = pending.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (pending.length > MAX_HEADER_BYTES) this.close(new Error('Content mapper header too long'));
          this.header = pending;
          return;
        }
        const header = pending.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i);
        if (!match || Number(match[1]) > MAX_MESSAGE_BYTES) {
          this.close(new Error('Invalid content-mapper Content-Length header'));
          return;
        }
        this.contentLength = Number(match[1]);
        this.header = Buffer.alloc(0);
        data = pending.subarray(headerEnd + 4);
      }
      const needed = this.contentLength - this.bodyBytes;
      if (data.length < needed) {
        this.body.push(data);
        this.bodyBytes += data.length;
        return;
      }
      this.body.push(data.subarray(0, needed));
      const body = Buffer.concat(this.body, this.contentLength);
      data = data.subarray(needed);
      this.body = [];
      this.bodyBytes = 0;
      this.contentLength = null;
      try {
        const message = JSON.parse(body.toString('utf8'));
        void this.#dispatch(message);
      } catch (error) {
        this.close(new Error(`Invalid JSON-RPC response: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  async #dispatch(message: any): Promise<void> {
    if (message && Object.hasOwn(message, 'method')) {
      const { id, method, params } = message;
      const handler = this.handlers[method];
      if (!handler) {
        if (id !== undefined) this.send({ id, error: { code: -32601, message: `No method: ${method}` } });
        return;
      }
      try {
        const result = await handler(params ?? {});
        if (id !== undefined) this.send({ id, result: result ?? null });
      } catch (error) {
        if (id !== undefined) {
          this.send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        }
      }
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`Mapper RPC: ${message.error.message}`));
    else pending.resolve(message.result);
  }
}
