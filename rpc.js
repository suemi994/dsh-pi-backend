import { spawn } from 'node:child_process';

export function formatPiRpcExit(code, signal, stderr) {
    const status = signal ?? code ?? 'unknown';
    const lines = String(stderr ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const errorAt = lines.findIndex(line => /^[A-Za-z]*Error:/.test(line));
    const detail = lines.slice(errorAt < 0 ? 0 : errorAt).join(' | ').replace(/\s+/g, ' ');
    return `Pi RPC exited (${status})${detail ? `: ${detail.slice(0, 2000)}` : ''}`;
}

export class PiRpc {
    #pending = new Map();
    #nextId = 0;
    #closed;
    #failure;
    #closing = false;

    constructor(args, cwd, onEvent, onExit, { spawnProcess = spawn } = {}) {
        const child = spawnProcess('pi', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        let buffer = '';
        let stderr = '';
        let spawnError;
        child.stdout.setEncoding('utf8').on('data', chunk => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                let record;
                try { record = JSON.parse(line); } catch { continue; }
                if (record?.type === 'response') {
                    const request = this.#pending.get(record.id);
                    if (!request) continue;
                    if (record.success) request.resolve(record.data);
                    else request.reject(new Error(record.error || `Pi rejected ${record.command}`));
                } else if (record) onEvent(record);
            }
        });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
        child.stdin.on('error', () => {}); // A pending write or child close reports stream failure.
        child.once('error', error => { spawnError = error; });
        this.#closed = new Promise(resolve => child.once('close', (code, signal) => {
            this.#failure = spawnError ?? new Error(formatPiRpcExit(code, signal, stderr));
            this.#failure.exitCode = code;
            this.#failure.signal = signal;
            for (const request of this.#pending.values()) request.reject(this.#failure);
            try { onExit(this.#failure, this.#closing); }
            finally { resolve(); }
        }));
    }

    send(record, callback) {
        this.child.stdin.write(`${JSON.stringify(record)}\n`, callback);
    }

    request(type, fields = {}, timeout = 20_000) {
        if (this.#failure || this.#closing) return Promise.reject(this.#failure ?? new Error('Pi RPC is closing'));
        const id = String(++this.#nextId);
        return new Promise((resolve, reject) => {
            const finish = (settle, value) => {
                clearTimeout(timer);
                this.#pending.delete(id);
                settle(value);
            };
            const timer = setTimeout(() => {
                const error = new Error(`Pi RPC ${type} timed out`);
                error.code = 'PI_RPC_TIMEOUT';
                finish(reject, error);
            }, timeout);
            const request = { resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
            this.#pending.set(id, request);
            this.send({ ...fields, type, id }, error => { if (error) request.reject(error); });
        });
    }

    async close() {
        if (this.#closing || this.#failure) return this.#closed;
        this.#closing = true;
        this.child.stdin.end();
        const terminate = setTimeout(() => this.child.kill('SIGTERM'), 3000);
        const kill = setTimeout(() => this.child.kill('SIGKILL'), 6000);
        try { await this.#closed; }
        finally { clearTimeout(terminate); clearTimeout(kill); }
    }
}
