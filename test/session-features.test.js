import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { PiCliSession } from '../session.js';

function fixtureSession() {
    const warnings = [];
    const debug = [];
    const session = new PiCliSession({ kind: 'new', cwd: tmpdir() }, {
        cwd: tmpdir(),
        locale: () => 'en',
        debug(message) { debug.push(message); },
        warn(message) { warnings.push(message); },
    });
    session.status = 'idle';
    const events = [];
    session.subscribe(batch => events.push(...batch));
    return { session, events, warnings, debug };
}

test('Pi extension prefill and titles project into the host session', async t => {
    const { session, events } = fixtureSession();
    t.after(() => session.dispose());
    const drafts = [];
    session.promptInjector = async text => {
        drafts.push(text);
        return true;
    };

    session.onRecord({ type: 'extension_ui_request', id: 'prefill-1', method: 'set_editor_text', text: 'Use this plan' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(drafts, ['Use this plan']);

    session.onRecord({ type: 'extension_ui_request', id: 'title-1', method: 'setTitle', title: '  Extension title  ' });
    assert.equal(session.title, 'Extension title');
    assert.ok(events.some(event => event.type === 'session.title'
        && event.title === 'Extension title' && event.source === 'auto'));
});

test('TUI-only Pi extension commands stay out of the host command menu', async t => {
    const { session } = fixtureSession();
    t.after(() => session.dispose());
    session.rpc = {
        async request(type) {
            assert.equal(type, 'get_commands');
            return {
                commands: [
                    { name: 'plan', description: 'Plan mode', source: 'extension', sourceInfo: { source: 'npm:plan' } },
                    { name: 'sidebar', description: 'Toggle sidebar', source: 'extension', sourceInfo: { source: 'git:github.com/suemi994/pi-sidebar' } },
                    { name: 'open-tui', description: 'Open settings', source: 'extension', sourceInfo: { source: 'npm:pi-open-tui' } },
                    { name: 'tool-display', description: 'Tool rendering', source: 'extension', sourceInfo: { source: 'npm:pi-ui-enhancement' } },
                    { name: 'lens-widget-toggle', description: 'Toggle widget', source: 'extension', sourceInfo: { source: 'npm:pi-lens' } },
                    { name: 'council', description: 'Prompt template', source: 'prompt', sourceInfo: { source: 'npm:pi-subagents' } },
                    { name: 'skill:pi-subagents', description: 'Skill', source: 'skill', sourceInfo: { source: 'npm:pi-subagents' } },
                ],
            };
        },
        async close() {},
    };

    const commands = await session.capabilities.commands.list();
    assert.deepEqual(commands.map(command => command.name), [
        'steer', 'pi-tree', 'pi-fork', 'pi-suggest', 'plan', 'council', 'skill:pi-subagents',
    ]);
});

test('Hidden Pi commands can be added by name', async t => {
    const { session } = fixtureSession();
    t.after(() => session.dispose());
    const previous = process.env.PI_HIDDEN_COMMANDS;
    process.env.PI_HIDDEN_COMMANDS = 'telegram-status, lens-map';
    t.after(() => {
        if (previous === undefined) delete process.env.PI_HIDDEN_COMMANDS;
        else process.env.PI_HIDDEN_COMMANDS = previous;
    });
    session.rpc = {
        async request() {
            return {
                commands: [
                    { name: 'telegram-status', description: 'Telegram', source: 'extension', sourceInfo: {} },
                    { name: 'lens-map', description: 'Lens map', source: 'extension', sourceInfo: {} },
                    { name: 'plan', description: 'Plan mode', source: 'extension', sourceInfo: {} },
                ],
            };
        },
        async close() {},
    };

    const commands = await session.capabilities.commands.list();
    assert.deepEqual(commands.map(command => command.name), ['steer', 'pi-tree', 'pi-fork', 'pi-suggest', 'plan']);
});

test('Typing a TUI-only command explains why it cannot run', async t => {
    const { session } = fixtureSession();
    t.after(() => session.dispose());
    const result = await session.submit({ text: '/sidebar', clientMessageId: 'tui-only' }, 'turn');
    assert.deepEqual(result, { accepted: false, reason: "/sidebar is only available in Pi's own TUI" });
});

test('Pi emits step boundaries so dsh-tui can measure generation speed', async t => {
    const { session, events } = fixtureSession();
    t.after(() => session.dispose());
    session.turnNo = 1;

    session.openIfNeeded();
    session.closeAttempt();

    assert.deepEqual(events.filter(event => event.type === 'step.start' || event.type === 'step.end')
        .map(event => [event.type, event.turn, event.step]), [
        ['step.start', 1, 1],
        ['step.end', 1, 1],
    ]);
    assert.ok(events.some(event => event.type === 'assistant.attempt.start' && event.step === 1));
    assert.ok(events.some(event => event.type === 'assistant.attempt.end' && event.step === 1));
});

test('Pi interrupt clears queued work before aborting', async t => {
    const { session, events } = fixtureSession();
    t.after(() => session.dispose());
    const calls = [];
    let resolveTurn;
    session.activeTurn = {
        assistants: [],
        userAnchors: [],
        done: new Promise(resolve => { resolveTurn = resolve; }),
        resolve: () => resolveTurn(),
    };
    session.status = 'running';
    session.queued = [
        { id: 'follow-1', text: 'Follow up', placement: 'followup' },
        { id: 'steer-1', text: 'Steer', placement: 'steer' },
    ];
    session.rpc = {
        async request(type) {
            calls.push(type);
            if (type === 'abort') session.finishTurn({ kind: 'aborted' });
            return {};
        },
        async close() {},
    };

    const receipt = await session.cancel('interrupt');
    assert.deepEqual(calls, ['clear_queue', 'abort']);
    assert.deepEqual(receipt, { stillQueued: [], outcome: 'confirmed' });
    assert.deepEqual(events.findLast(event => event.type === 'pending.changed').discarded, ['follow-1', 'steer-1']);
});

test('Failed Pi abort reports the queue state after clearing it', async t => {
    const { session } = fixtureSession();
    t.after(() => session.dispose());
    session.activeTurn = {
        assistants: [],
        userAnchors: [],
        done: Promise.resolve(),
        resolve() {},
    };
    session.status = 'running';
    session.queued = [
        { id: 'follow-1', text: 'Follow up', placement: 'followup' },
        { id: 'steer-1', text: 'Steer', placement: 'steer' },
    ];
    session.rpc = {
        async request(type) {
            if (type === 'clear_queue') return {};
            if (type === 'abort') throw new Error('abort failed');
            throw new Error(`unexpected request: ${type}`);
        },
        async close() {},
    };

    assert.deepEqual(await session.cancel('interrupt'), { stillQueued: [], outcome: 'unknown' });
    assert.deepEqual(session.queued, []);
    assert.equal(session.activeTurn.cancelling, false);
});

test('Pi user cancel leaves queued work with Pi', async t => {
    const { session } = fixtureSession();
    t.after(() => session.dispose());
    const calls = [];
    session.activeTurn = {
        assistants: [],
        userAnchors: [],
        done: Promise.resolve(),
        resolve() {},
    };
    session.status = 'running';
    session.rpc = {
        async request(type) {
            calls.push(type);
            if (type === 'abort') session.finishTurn({ kind: 'aborted' });
            return {};
        },
        async close() {},
    };

    assert.deepEqual(await session.cancel('user'), { stillQueued: [], outcome: 'confirmed' });
    assert.deepEqual(calls, ['abort']);
});

test('Pi runtime refresh updates image support with the selected model', async t => {
    const { session, events } = fixtureSession();
    t.after(() => session.dispose());
    session.contextWindow = 8192;
    session.rpc = {
        async request(type) {
            assert.equal(type, 'get_state');
            return {
                sessionId: session.sessionId,
                sessionFile: '/tmp/fixture.jsonl',
                model: { provider: 'fixture', id: 'vision', contextWindow: 16384, input: ['text', 'image'] },
            };
        },
        async close() {},
    };

    await session.refreshRuntimeState();
    assert.equal(session.providerId, 'fixture');
    assert.equal(session.modelId, 'vision');
    assert.equal(session.contextWindow, 16384);
    assert.equal(session.acceptsImages, true);
    assert.ok(events.some(event => event.type === 'context.capacity' && event.contextWindow === 16384));
});

test('Pi process exit discards queued work and closes pending interaction state', async () => {
    const { session, events, warnings } = fixtureSession();
    let resolved = false;
    let resolveTurn;
    const done = new Promise(resolve => {
        resolveTurn = () => {
            resolved = true;
            resolve();
        };
    });
    session.activeTurn = {
        assistants: [],
        userAnchors: [],
        done,
        resolve: () => resolveTurn(),
    };
    session.status = 'running';
    session.queued = [
        { id: 'follow-1', text: 'Follow up', placement: 'followup' },
        { id: 'steer-1', text: 'Steer', placement: 'steer' },
    ];
    session.onRecord({
        type: 'extension_ui_request',
        id: 'pending-confirm',
        method: 'confirm',
        title: 'Approve?',
        message: 'Approve before the process exits?',
    });

    session.handleRpcExit(new Error('Pi RPC exited (1): test failure'));

    assert.equal(session.status, 'disposed');
    assert.equal(session.activeTurn, undefined);
    assert.deepEqual(session.queued, []);
    assert.equal(session.sideQueries.signal.aborted, true);
    assert.equal(session.interactions.hasPending(), false);
    assert.equal(resolved, true);
    assert.deepEqual(warnings, ['Pi RPC exited (1): test failure']);
    assert.deepEqual(events.findLast(event => event.type === 'pending.changed').discarded, ['follow-1', 'steer-1']);
    assert.ok(events.some(event => event.type === 'turn.end'
        && event.reason.kind === 'error' && event.reason.message === 'Pi RPC exited (1): test failure'));
    assert.ok(events.some(event => event.type === 'session.status' && event.status === 'disposed'));
});

test('Runtime refresh failure does not block turn completion', async () => {
    const { session, events, debug } = fixtureSession();
    let resolved = false;
    session.activeTurn = {
        assistants: [],
        userAnchors: [],
        done: Promise.resolve(),
        resolve: () => { resolved = true; },
    };
    session.status = 'running';
    session.rpc = {
        async request(type) {
            throw new Error(`${type} failed`);
        },
        async close() {},
    };

    await session.settleTurn(session.activeTurn, { kind: 'completed' });

    assert.equal(session.activeTurn, undefined);
    assert.equal(session.status, 'idle');
    assert.equal(resolved, true);
    assert.ok(events.some(event => event.type === 'turn.end' && event.reason.kind === 'completed'));
    assert.ok(debug.includes('get_state failed'));
});
