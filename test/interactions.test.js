import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { piCliManifest } from '../backend.js';
import { PiCliSession } from '../session.js';

function fixtureSession() {
    const host = {
        cwd: tmpdir(),
        locale: () => 'en',
        debug() {},
        warn() {},
    };
    const session = new PiCliSession({ kind: 'new', cwd: tmpdir() }, host);
    const sent = [];
    const events = [];
    session.rpc = {
        send(record, callback) {
            sent.push(record);
            callback?.();
        },
        async close() {},
    };
    session.status = 'idle';
    session.subscribe(batch => events.push(...batch));
    return { session, sent, events };
}

test('Pi interaction dialogs use dsh permission and question channels', async t => {
    assert.ok(piCliManifest.capabilities.includes('permissions'));
    assert.ok(piCliManifest.capabilities.includes('questions'));
    const { session, sent, events } = fixtureSession();
    t.after(() => session.dispose());

    session.onRecord({
        type: 'extension_ui_request',
        id: 'select-1',
        method: 'select',
        title: 'Choose an action',
        options: ['Start', 'Review'],
    });
    const select = events.find(event => event.type === 'question.request');
    assert.deepEqual(select?.request.questions[0].options, [{ label: 'Start' }, { label: 'Review' }]);
    assert.equal(select?.request.questions[0].hideCustomInput, true);
    assert.ok(events.some(event => event.type === 'session.status' && event.status === 'requires-action'));
    assert.equal(session.capabilities.questions.respond('select-1', {
        answers: [{ selected: ['Review'] }],
    }), true);
    assert.deepEqual(sent.at(-1), { type: 'extension_ui_response', id: 'select-1', value: 'Review' });
    assert.ok(events.some(event => event.type === 'question.settled' && event.requestId === 'select-1'));
    assert.ok(events.some(event => event.type === 'session.status' && event.status === 'idle'));

    session.onRecord({
        type: 'extension_ui_request',
        id: 'input-1',
        method: 'input',
        title: 'Describe the change',
        placeholder: 'A short description',
    });
    const input = events.find(event => event.type === 'question.request' && event.request.requestId === 'input-1');
    assert.equal(input?.request.questions[0].detail, 'A short description');
    session.capabilities.questions.respond('input-1', {
        answers: [{ selected: [], custom: 'Keep the Pi session native' }],
    });
    assert.deepEqual(sent.at(-1), {
        type: 'extension_ui_response',
        id: 'input-1',
        value: 'Keep the Pi session native',
    });

    session.onRecord({
        type: 'extension_ui_request',
        id: 'editor-1',
        method: 'editor',
        title: 'Edit the goal',
        prefill: 'Finish the backend',
    });
    const editor = events.find(event => event.type === 'question.request' && event.request.requestId === 'editor-1');
    assert.match(editor?.request.questions[0].detail ?? '', /Finish the backend/);
    session.capabilities.questions.respond('editor-1', {
        answers: [{ selected: [], custom: 'Finish the backend\nRun all tests' }],
    });
    assert.deepEqual(sent.at(-1), {
        type: 'extension_ui_response',
        id: 'editor-1',
        value: 'Finish the backend\nRun all tests',
    });
});

test('Pi confirm dialogs round-trip permission decisions', async t => {
    const { session, sent, events } = fixtureSession();
    t.after(() => session.dispose());

    session.onRecord({
        type: 'extension_ui_request',
        id: 'confirm-allow',
        method: 'confirm',
        title: 'Replace goal?',
        message: 'Replace the current goal?',
    });
    const permission = events.find(event => event.type === 'permission.request');
    assert.deepEqual(permission?.request.options.map(option => option.kind), ['allow-once', 'reject']);
    assert.equal(permission?.request.defaultToNo, true);
    assert.equal(session.capabilities.permissions.pending().length, 1);
    session.capabilities.permissions.respond('confirm-allow', { kind: 'allow-once' });
    assert.deepEqual(sent.at(-1), {
        type: 'extension_ui_response',
        id: 'confirm-allow',
        confirmed: true,
    });
    assert.ok(events.some(event => event.type === 'permission.settled'
        && event.requestId === 'confirm-allow' && event.outcome === 'allow-once'));
    assert.equal(session.capabilities.permissions.pending().length, 0);

    session.onRecord({
        type: 'extension_ui_request',
        id: 'confirm-reject',
        method: 'confirm',
        title: 'Apply settings?',
        message: 'Apply the changed settings?',
    });
    session.capabilities.permissions.respond('confirm-reject', { kind: 'reject' });
    assert.deepEqual(sent.at(-1), {
        type: 'extension_ui_response',
        id: 'confirm-reject',
        confirmed: false,
    });
    assert.ok(events.some(event => event.type === 'permission.settled'
        && event.requestId === 'confirm-reject' && event.outcome === 'rejected'));
});

test('Pi interaction cancellation and disposal clear pending requests', async () => {
    const { session, sent, events } = fixtureSession();

    session.onRecord({
        type: 'extension_ui_request',
        id: 'cancel-question',
        method: 'select',
        title: 'Pick one',
        options: ['A', 'B'],
    });
    session.capabilities.questions.cancel('cancel-question');
    assert.deepEqual(sent.at(-1), {
        type: 'extension_ui_response',
        id: 'cancel-question',
        cancelled: true,
    });
    assert.ok(events.some(event => event.type === 'question.settled' && event.requestId === 'cancel-question'));

    session.onRecord({
        type: 'extension_ui_request',
        id: 'dispose-question',
        method: 'input',
        title: 'Pending input',
    });
    session.onRecord({
        type: 'extension_ui_request',
        id: 'dispose-confirm',
        method: 'confirm',
        title: 'Pending approval',
        message: 'Approve this action?',
    });
    assert.equal(session.interactions.hasPending(), true);
    await session.dispose();
    assert.equal(session.interactions.hasPending(), false);
    assert.ok(events.some(event => event.type === 'question.settled' && event.requestId === 'dispose-question'));
    assert.ok(events.some(event => event.type === 'permission.settled'
        && event.requestId === 'dispose-confirm' && event.outcome === 'cancelled'));
});

test('Timed-out Pi dialogs release pending interaction state', async t => {
    const { session, sent, events } = fixtureSession();
    t.after(() => session.dispose());
    const sentBefore = sent.length;

    session.onRecord({
        type: 'extension_ui_request',
        id: 'timeout-question',
        method: 'select',
        title: 'Choose quickly',
        options: ['Now', 'Later'],
        timeout: 10,
    });
    assert.equal(session.interactions.hasPending(), true);
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(session.interactions.hasPending(), false);
    assert.equal(sent.length, sentBefore, 'Pi owns the timeout response');
    assert.ok(events.some(event => event.type === 'question.settled'
        && event.requestId === 'timeout-question'));
    assert.equal(session.status, 'idle');
});

test('Finishing a turn keeps requires-action while an extension dialog is pending', async t => {
    const { session, events } = fixtureSession();
    t.after(() => session.dispose());
    let resolved = false;
    session.activeTurn = {
        assistants: [],
        done: Promise.resolve(),
        resolve: () => { resolved = true; },
    };
    session.onRecord({
        type: 'extension_ui_request',
        id: 'pending-after-turn',
        method: 'select',
        title: 'Continue?',
        options: ['Yes', 'No'],
    });

    session.finishTurn({ kind: 'completed' });
    assert.equal(session.status, 'requires-action');
    assert.equal(resolved, true);

    session.capabilities.questions.cancel('pending-after-turn');
    assert.equal(session.status, 'idle');
    assert.ok(events.some(event => event.type === 'session.status' && event.status === 'requires-action'));
});
