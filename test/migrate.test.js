import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const packageRoot = process.env.DSH_TUI_PACKAGE
    ?? join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
const adapterPath = join(packageRoot, 'lib', 'types', 'dsh-adapter', 'migrate', 'adapters', 'pi.js');

const session = (id, cwd) => [
    { type: 'session', version: 3, id, timestamp: '2026-11-01T10:00:00.000Z', cwd },
    { type: 'message', id: 'a1', parentId: null, timestamp: '2026-11-01T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } },
    { type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-11-01T10:00:02.000Z',
        message: { role: 'assistant', model: 'demo', content: [
            { type: 'thinking', thinking: 'thought' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'x' } },
        ] } },
    { type: 'message', id: 'a3', parentId: 'a2', timestamp: '2026-11-01T10:00:03.000Z',
        message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'body' }], isError: false } },
    // An abandoned rewind branch: appended before the leaf, not on its path.
    { type: 'message', id: 'b1', parentId: 'a1', timestamp: '2026-11-01T10:00:06.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'ABANDONED branch' }] } },
    { type: 'message', id: 'a4', parentId: 'a3', timestamp: '2026-11-01T10:00:04.000Z',
        message: { role: 'assistant', model: 'demo', content: [{ type: 'text', text: 'answer' }] } },
    { type: 'session_info', id: 'a5', parentId: 'a4', timestamp: '2026-11-01T10:00:05.000Z', name: 'Fixture title' },
];

test('Pi migration adapter browses and loads native sessions', { skip: !existsSync(adapterPath) && 'Pi adapter is not applied to this dsh-tui' }, async t => {
    const adapter = (await import(adapterPath)).piAdapter;
    const temp = await mkdtemp(join(tmpdir(), 'pi-migrate-'));
    const agentDir = join(temp, 'agent');
    const project = join(temp, 'project');
    const bucket = join(agentDir, 'sessions', '--tmp-project--');
    t.after(() => rm(temp, { recursive: true, force: true }));
    await mkdir(bucket, { recursive: true });
    await mkdir(project);
    const file = join(bucket, '2026-11-01T10-00-00-000Z_0192aaaa-bbbb-7ccc-8ddd-eeeeffff0101.jsonl');
    await writeFile(file, `${session('0192aaaa-bbbb-7ccc-8ddd-eeeeffff0101', project).map(line => JSON.stringify(line)).join('\n')}\n`);

    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
        assert.equal(adapter.id, 'pi');
        assert.deepEqual(adapter.roots(), [join(agentDir, 'sessions')]);
        assert.equal(adapter.count(), 1);

        const scanned = await adapter.scan();
        assert.equal(scanned.length, 1);
        assert.equal(scanned[0].summary.sessionKey, '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0101');
        assert.equal(scanned[0].summary.title, 'Fixture title');
        assert.equal(scanned[0].summary.cwd, project);

        const loaded = await adapter.load(file);
        assert.equal(loaded.sourceId, '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0101');
        assert.equal(loaded.titleExplicit, true);
        assert.equal(loaded.turns.length, 1);
        assert.deepEqual(loaded.turns[0].steps.map(step => step.blocks.map(block => block.type)), [['reasoning', 'tool-call'], ['text']]);
        assert.deepEqual(loaded.turns[0].steps[0].results, [{ callId: 'c1', text: 'body', isError: false }]);
        assert.ok(!JSON.stringify(loaded).includes('ABANDONED'));

        const discovered = adapter.discover();
        assert.equal(discovered.sessions.length, 1);
    }
    finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});
