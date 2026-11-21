import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPiPromptInjector, dshInjectSocketPath } from '../prompt-injection.js';

test('Pi editor prefill writes to the dsh-tui input channel', async () => {
    const fake = new FakeSocket();
    const inject = createPiPromptInjector({
        sessionId: 'fixture-session',
        dataDir: '/tmp/fixture-inject',
        connectSocket: path => {
            fake.connectedTo = path;
            return fake;
        },
    });

    assert.equal(await inject('Draft from Pi '), true);
    assert.equal(fake.connectedTo, dshInjectSocketPath('fixture-session', '/tmp/fixture-inject'));
    assert.deepEqual(JSON.parse(fake.written), { type: 'prompt.append', text: 'Draft from Pi ' });
    assert.equal(fake.destroyed, true);
});

test('Missing dsh-tui input channel reports without throwing', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-pi-inject-'));
    const errors = [];
    try {
        const inject = createPiPromptInjector({
            sessionId: 'missing-session',
            dataDir: temp,
            timeoutMs: 100,
            onError: message => errors.push(message),
        });
        assert.equal(await inject('Draft from Pi'), false);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Pi editor prefill failed/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('Timed-out dsh-tui input channel reports a warning', async () => {
    const errors = [];
    const fake = new FakeSocket({ timeout: true });
    const inject = createPiPromptInjector({
        sessionId: 'timeout-session',
        dataDir: '/tmp/fixture-inject',
        timeoutMs: 50,
        connectSocket: () => fake,
        onError: message => errors.push(message),
    });

    assert.equal(await inject('Draft from Pi'), false);
    assert.equal(fake.timeoutMs, 50);
    assert.match(errors[0], /input channel timed out/);
});

test('Closed dsh-tui input channel settles the prefill request', async () => {
    const errors = [];
    const fake = new FakeSocket({ close: true });
    const inject = createPiPromptInjector({
        sessionId: 'closed-session',
        dataDir: '/tmp/fixture-inject',
        timeoutMs: 1000,
        connectSocket: () => fake,
        onError: message => errors.push(message),
    });

    assert.equal(await inject('Draft from Pi'), false);
    assert.match(errors[0], /closed before prefill completed/);
});

test('Synchronous input channel failure reports without rejecting', async () => {
    const errors = [];
    const inject = createPiPromptInjector({
        sessionId: 'broken-session',
        dataDir: '/tmp/fixture-inject',
        connectSocket() {
            throw new Error('invalid socket path');
        },
        onError: message => errors.push(message),
    });

    assert.equal(await inject('Draft from Pi'), false);
    assert.match(errors[0], /invalid socket path/);
});

class FakeSocket extends EventEmitter {
    written = '';
    destroyed = false;

    constructor({ timeout = false, close = false } = {}) {
        super();
        this.timeout = timeout;
        this.close = close;
        queueMicrotask(() => {
            if (this.timeout) this.emit('timeout');
            else {
                this.emit('connect');
                if (close) this.emit('close');
            }
        });
    }

    setTimeout(timeoutMs) {
        this.timeoutMs = timeoutMs;
    }

    end(data, callback) {
        this.written = data;
        if (!this.close) callback();
    }

    destroy() {
        this.destroyed = true;
    }
}
