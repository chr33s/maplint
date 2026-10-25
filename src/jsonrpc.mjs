/** JSON-RPC 2.0 over Content-Length framed byte streams (the TypeScript mapper transport). */
export class JsonRpcPeer {
  constructor(input, output, options = {}) {
    this.input = input;
    this.output = output;
    this.handlers = options.handlers ?? {};
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.buffer = Buffer.alloc(0);
    this.contentLength = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    input.on('data', (chunk) => this.#onData(chunk));
    input.on('end', () => this.close(new Error('Mapper stream ended')));
    input.on('error', (error) => this.close(error));
    output.on('error', (error) => this.close(error));
  }

  send(message) {
    if (this.closed) throw new Error('JSON-RPC connection is closed');
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.output.write(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    this.output.write(payload);
  }

  request(method, params) {
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

  close(reason = new Error('JSON-RPC connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(reason);
    }
    this.pending.clear();
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    // Bound untrusted data, including never-terminated headers.
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.close(new Error('Content mapper response exceeds 32 MiB'));
      return;
    }
    while (true) {
      if (this.contentLength === null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (this.buffer.length > 8192) this.close(new Error('Content mapper header too long'));
          return;
        }
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i);
        if (!match || Number(match[1]) > 32 * 1024 * 1024) {
          this.close(new Error('Invalid content-mapper Content-Length header'));
          return;
        }
        this.contentLength = Number(match[1]);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }
      if (this.buffer.length < this.contentLength) return;
      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = null;
      try {
        const message = JSON.parse(body.toString('utf8'));
        void this.#dispatch(message);
      } catch (error) {
        this.close(new Error(`Invalid JSON-RPC response: ${error.message}`));
        return;
      }
    }
  }

  async #dispatch(message) {
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
          this.send({ id, error: { code: -32603, message: String(error.message ?? error) } });
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
