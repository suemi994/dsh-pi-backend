import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { PiRpc, formatPiRpcExit } from '../rpc.js';

test('Pi RPC parses responses and surfaces a one-line process failure', async () => {
    const child = new FakeChild();
    const exits = [];
    const rpc = new PiRpc([], '/tmp', () => {}, (error, closing) => {
        exits.push({ error, closing });
    }, { spawnProcess: () => child });

    const state = rpc.request('get_state');
    await new Promise(resolve => setImmediate(resolve));
    const request = JSON.parse(child.input.trim());
    child.stdout.write(`${JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: { sessionId: 'fixture' },
    })}\n`);
    assert.deepEqual(await state, { sessionId: 'fixture' });

    const pending = rpc.request('get_entries');
    child.stderr.write([
        'node:fs:1350',
        '  const result = binding.mkdir(',
        '',
        "Error: ENOENT: no such file or directory, mkdir '/tmp/sessions/project'",
        "    at mkdirSync (node:fs:1350:26) { code: 'ENOENT' }",
        'Node.js v24.18.0',
    ].join('\n'));
    child.finish(7, null);

    await assert.rejects(pending, error => {
        assert.match(error.message, /^Pi RPC exited \(7\): Error: ENOENT/);
        assert.match(error.message, /mkdirSync/);
        assert.equal(error.message.includes('\n'), false);
        assert.equal(error.exitCode, 7);
        return true;
    });
    assert.equal(exits.length, 1);
    assert.equal(exits[0].closing, false);
});

test('Pi RPC exit formatting keeps the stderr cause', () => {
    const message = formatPiRpcExit(null, 'SIGTERM', 'warning\nError: provider failed\nat run (pi.js:1:2)\n');
    assert.equal(message, 'Pi RPC exited (SIGTERM): Error: provider failed | at run (pi.js:1:2)');
});

class FakeChild extends EventEmitter {
    input = '';
    exitCode = null;
    signalCode = null;

    constructor() {
        super();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdin = new Writable({
            write: (chunk, _encoding, callback) => {
                this.input += chunk.toString();
                callback();
            },
        });
    }

    kill(signal) {
        this.finish(null, signal);
    }

    finish(code, signal) {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.stdout.end();
        this.stderr.end();
        this.emit('close', code, signal);
    }
}
