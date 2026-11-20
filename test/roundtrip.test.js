import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const provider = 'roundtrip';
const model = 'roundtrip-model';
const turns = [
    ['roundtrip: seed from Pi CLI', 'seed reply from Pi'],
    ['roundtrip: append from backend', 'backend reply from Pi'],
    ['roundtrip: second turn from backend', 'second backend reply from Pi'],
    ['roundtrip: reopen from Pi CLI', 'reopened reply from Pi'],
];
const transcript = turns.flatMap(([prompt, reply]) => [['user', prompt], ['assistant', reply]]);

function text(content) {
    if (typeof content === 'string') return content;
    return content?.filter(block => block.type === 'text').map(block => block.text).join('');
}

function mockProvider(requests, summaries) {
    return createServer(async (req, res) => {
        try {
            assert.equal(req.method, 'POST');
            assert.equal(req.url, '/v1/chat/completions');
            let body = '';
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            assert.equal(input.model, model);
            assert.equal(input.stream, true);
            const messages = input.messages
                .filter(({ role }) => role === 'user' || role === 'assistant')
                .map(({ role, content }) => [role, text(content)]);
            const reply = turns.find(([prompt]) => prompt === messages.at(-1)?.[1])?.[1];
            if (!reply) {
                // Pi's compaction asks for a summary instead of a normal prompt.
                summaries.push(messages);
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ id: 'chatcmpl-summary', object: 'chat.completion.chunk', created: 1, model,
                    choices: [{ index: 0, delta: { role: 'assistant', content: 'compacted summary text' }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: 'chatcmpl-summary', object: 'chat.completion.chunk', created: 1, model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                res.end('data: [DONE]\n\n');
                return;
            }
            requests.push({ messages, effort: input.reasoning_effort });

            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = choice => res.write(`data: ${JSON.stringify({
                id: 'chatcmpl-roundtrip', object: 'chat.completion.chunk', created: 1, model,
                choices: [{ index: 0, ...choice }],
            })}\n\n`);
            send({ delta: { role: 'assistant', content: reply }, finish_reason: null });
            send({ delta: {}, finish_reason: 'stop' });
            res.end('data: [DONE]\n\n');
        } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
        }
    });
}

async function nativeSessionFiles(agentDir) {
    const root = join(agentDir, 'sessions');
    const paths = await readdir(root, { recursive: true });
    return paths.filter(path => path.endsWith('.jsonl')).map(path => join(root, path));
}

function entries(contents) {
    return contents.trim().split('\n').map(line => JSON.parse(line));
}

function messages(contents) {
    return entries(contents)
        .filter(({ type, message }) => type === 'message' && ['user', 'assistant'].includes(message?.role))
        .map(({ message }) => [message.role, text(message.content)]);
}

test('real Pi CLI and the backend append to the same native session', { timeout: 45_000 }, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-pi-roundtrip-'));
    const agentDir = join(temp, 'agent');
    const cwd = join(temp, 'project');
    const dataDir = join(temp, 'backend-data');
    const env = {
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: undefined,
        PI_MODEL: `${provider}/${model}`,
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
    };
    const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const setEnv = values => {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    t.after(async () => {
        setEnv(originalEnv);
        assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
        assert.ok(basename(temp).startsWith('dsh-pi-roundtrip-'));
        await rm(temp, { recursive: true, force: true });
    });
    setEnv(env);
    await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(dataDir)]);

    const runPi = (...args) => {
        const pending = execFile('pi', args, { cwd, timeout: 12_000, signal: t.signal });
        pending.child.stdin.end(); // Pi reads non-TTY stdin before handling the prompt.
        return pending;
    };
    try {
        await runPi('--version');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        t.skip('pi executable is unavailable on PATH');
        return;
    }

    const requests = [];
    const summaries = [];
    const server = mockProvider(requests, summaries);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    });
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({
        providers: {
            [provider]: {
                baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
                api: 'openai-completions', apiKey: 'local-fixture',
                models: [{ id: model, name: 'Round-trip model', reasoning: true, input: ['text'],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
            },
        },
    }));
    // A tiny recent window so the short fixture still has history to summarize.
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
        defaultProvider: provider, defaultModel: model, compaction: { keepRecentTokens: 0, reserveTokens: 100 },
    }));

    const cliArgs = ['--print', '--no-extensions', '--no-skills', '--no-context-files', '--model', `${provider}/${model}`];
    const seed = await runPi(...cliArgs, '--', turns[0][0]);
    assert.equal(seed.stdout.trim(), turns[0][1]);
    const files = await nativeSessionFiles(agentDir);
    assert.equal(files.length, 1);
    const [file] = files;
    const seeded = await readFile(file, 'utf8');
    const header = entries(seeded)[0];
    assert.equal(header.type, 'session');
    assert.ok(header.id);
    assert.deepEqual(messages(seeded), transcript.slice(0, 2));

    const { backend } = await import('../register.js');
    const host = { cwd, dataDir, locale: () => 'en', debug() {}, warn() {}, appVersion: 'roundtrip-test' };
    assert.deepEqual((await backend.catalog.list({ cwd })).map(row => row.id), [header.id]);
    assert.deepEqual((await backend.catalog.list({ allProjects: true })).map(row => row.id), [header.id]);
    assert.deepEqual(await backend.catalog.list({ cwd: temp }), []);
    assert.deepEqual((await backend.catalog.preview(header.id, { cwd })).map(({ text }) => text), [turns[0][0], turns[0][1]]);
    await assert.rejects(backend.open({ kind: 'resume', sessionId: 'missing-session', cwd }, host), /Pi session not found/);
    assert.equal(await readFile(file, 'utf8'), seeded);
    const profile = process.env.PI_TUI_TEST_DSH_HOME;
    if (profile) {
        const socket = `pi-roundtrip-${process.pid}`;
        const tmux = (...args) => execFile('tmux', ['-L', socket, ...args], { timeout: 5000 });
        t.after(() => tmux('kill-server').catch(() => {}));
        const waitForPane = async (expected) => {
            const deadline = Date.now() + 12_000;
            let screen = '';
            while (Date.now() < deadline) {
                screen = (await tmux('capture-pane', '-p', '-S', '-100')).stdout;
                if (screen.includes(expected)) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.fail(`TUI did not display ${expected}:\n${screen}`);
        };
        await tmux('new-session', '-d', '-x', '120', '-y', '40', '-c', cwd, 'env',
            `DSH_HOME=${profile}`, ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
            'dsh-tui', '--backend', 'pi-cli');
        await waitForPane('Pi CLI · pi v');
        await tmux('send-keys', '-l', '/resume');
        await waitForPane('│ ⌘ /resume');
        await tmux('send-keys', 'Enter');
        await waitForPane(turns[0][0]);
        await tmux('send-keys', 'Enter');
        await waitForPane(turns[0][1]);
        for (const [index, [prompt, reply]] of turns.slice(1, 3).entries()) {
            const command = `/effort ${['high', 'low'][index]}`;
            await tmux('send-keys', '-l', command);
            await waitForPane(command);
            await tmux('send-keys', 'Enter');
            await waitForPane(`roundtrip/roundtrip-model · ${['high', 'low'][index]}`);
            await tmux('send-keys', '-l', prompt);
            await tmux('send-keys', 'Enter');
            await waitForPane(reply);
        }
        await tmux('send-keys', 'C-d');
        await tmux('send-keys', 'C-d').catch(() => {});
        const deadline = Date.now() + 8000;
        while (await tmux('has-session').then(() => true, () => false)) {
            assert.ok(Date.now() < deadline, 'dsh-tui did not exit');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } else {
        const session = await backend.open({ kind: 'resume', sessionId: header.id, cwd }, host);
        try {
            assert.equal(session.sessionId, header.id);
            const replayed = await session.history();
            assert.deepEqual(replayed.filter(event => event.type === 'user.message').map(event => event.text), [turns[0][0]]);
            const live = [];
            const unsubscribe = session.subscribe(batch => live.push(...batch));
            try {
                const child = session.rpc.child;
                assert.ok(child.pid, 'resume starts Pi before the first prompt');
                for (const [index, [prompt, reply]] of turns.slice(1, 3).entries()) {
                    live.length = 0;
                    const effort = session.capabilities.effort;
                    const level = ['high', 'low'][index];
                    assert.ok(effort.levels().some(option => option.id === level));
                    await effort.set(level);
                    assert.equal(effort.current(), level);
                    assert.ok(live.some(event => event.type === 'effort.changed' && event.effort === level));
                    const result = await session.submit({ text: prompt, clientMessageId: `roundtrip-backend-${index}` }, 'turn');
                    assert.equal(result.accepted, true);
                    const end = live.find(event => event.type === 'turn.end');
                    assert.equal(end?.reason?.kind, 'completed', JSON.stringify(end));
                    assert.equal(live.filter(event => event.type === 'assistant.delta' && event.delta.kind === 'text')
                        .map(event => event.delta.text).join(''), reply);
                    assert.equal(session.rpc.child, child);
                    assert.equal(child.exitCode, null);
                    assert.equal(child.signalCode, null);
                }
                const compaction = [];
                session.subscribe(batch => compaction.push(...batch));
                await session.capabilities.compact.run();
                const start = compaction.find(event => event.type === 'compaction.start');
                const end = compaction.find(event => event.type === 'compaction.end');
                assert.equal(start?.trigger, 'manual');
                assert.equal(end?.ok, true, JSON.stringify(end));
                assert.match(end?.summary ?? '', /compacted summary text/);
                assert.ok(compaction.some(event => event.type === 'compaction.end' && event.contextReplaced === true));
                assert.ok(compaction.some(event => event.type === 'user.message' && event.source === 'compaction'
                    && /compacted summary text/.test(event.text)), 'the summary renders as a compact row');
                let secondError;
                try {
                    await session.capabilities.compact.run();
                } catch (error) {
                    secondError = error;
                }
                assert.match(secondError?.message ?? '', /Already|Nothing|compact/i);
            } finally {
                unsubscribe();
            }
        } finally {
            await session.dispose();
        }
        assert.equal(session.rpc.child.exitCode, 0, 'closing the session shuts Pi down cleanly');
    }

    const appended = await readFile(file, 'utf8');
    assert.ok(appended.startsWith(seeded), 'the backend must preserve Pi’s original entries');
    assert.deepEqual(messages(appended), transcript.slice(0, -2));

    const [lastPrompt, lastReply] = turns.at(-1);
    const reopened = await runPi(...cliArgs, '--session', header.id, '--', lastPrompt);
    assert.equal(reopened.stdout.trim(), lastReply);
    const completed = await readFile(file, 'utf8');
    assert.ok(completed.startsWith(appended), 'Pi must preserve the backend’s appended entries');
    assert.deepEqual(messages(completed), transcript);
    assert.deepEqual(await nativeSessionFiles(agentDir), [file]);
    assert.deepEqual(requests.slice(0, 3).map(request => request.messages), turns.slice(0, 3).map((_, index) => transcript.slice(0, index * 2 + 1)));
    assert.ok(summaries.length >= 1, 'Pi asked its model for a compaction summary');
    assert.deepEqual(requests.slice(1).map(request => request.effort), ['high', 'low', 'low']);
    assert.deepEqual(entries(appended).filter(entry => entry.type === 'thinking_level_change').slice(-2)
        .map(entry => entry.thinkingLevel), ['high', 'low']);
    assert.equal(entries(appended).filter(entry => entry.type === 'compaction').length, 1);
});
