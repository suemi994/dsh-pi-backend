import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

function mockProvider(requests, summaries, sideRequests, extra) {
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
            const prompt = messages.at(-1)?.[1];
            const side = prompt?.startsWith('Conversation excerpts (JSON):');
            if (side) {
                assert.equal(input.tools?.length ?? 0, 0);
                sideRequests.push(prompt);
            }
            const extraReply = await extra?.(prompt, input);
            const reply = extraReply ?? (side
                ? prompt.includes('Predict one short follow-up message')
                    ? prompt.includes(turns[2][0]) ? 'NONE' : 'Show me the next step.'
                : prompt.includes('Create a compact session recap')
                    ? JSON.stringify({ title: 'Pi round-trip recap', summary: 'Side recap from Pi' })
                    : prompt.includes('Which branch is active?') ? 'Side branch answer from Pi' : 'Side answer from Pi'
                : turns.find(([text]) => text === prompt)?.[1]);
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
            if (!side) requests.push({ messages, effort: input.reasoning_effort });

            res.writeHead(200, { 'content-type': 'text/event-stream' });
            // Simulate a provider whose prompt grows with the conversation. Pi
            // anchors its current-context estimate to this sample.
            const promptTokens = 1400 + input.messages.length * 100;
            const send = (choice, usage) => res.write(`data: ${JSON.stringify({
                id: 'chatcmpl-roundtrip', object: 'chat.completion.chunk', created: 1, model,
                choices: [{ index: 0, ...choice }], usage,
            })}\n\n`);
            if (process.env.PI_TUI_TEST_DSH_HOME && prompt === turns[1][0]) {
                send({ delta: { role: 'assistant', reasoning_content: 'Pi reasoning fixture' }, finish_reason: null });
                await new Promise(resolve => setTimeout(resolve, 1800));
            }
            send({ delta: { role: 'assistant', content: reply }, finish_reason: null });
            send({ delta: {}, finish_reason: 'stop' }, { prompt_tokens: promptTokens, completion_tokens: 7,
                total_tokens: promptTokens + 7, prompt_tokens_details: { cached_tokens: 12 } });
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
    const isolatedHome = join(temp, 'home');
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
    await Promise.all([
        mkdir(agentDir),
        mkdir(cwd),
        mkdir(dataDir),
        mkdir(join(isolatedHome, '.dsh-tui'), { recursive: true }),
    ]);

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
    const sideRequests = [];
    const forkPaths = [];
    let releaseImageTurn;
    let sawImageTurn;
    const imageTurn = new Promise(resolve => { sawImageTurn = resolve; });
    const imageTurnRelease = new Promise(resolve => { releaseImageTurn = resolve; });
    const imageInputs = [];
    const server = mockProvider(requests, summaries, sideRequests, async (prompt, input) => {
        if (!['Fixture image prompt', 'Fixture steer', 'Fixture follow-up'].includes(prompt)) return;
        imageInputs.push(input.messages.at(-1).content);
        if (prompt === 'Fixture image prompt') {
            sawImageTurn();
            await imageTurnRelease;
        }
        return 'Fixture reply';
    });
    server.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
    } catch (error) {
        if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
        t.skip(`loopback listeners are unavailable: ${error.code}`);
        return;
    }
    t.after(() => {
        server.closeAllConnections();
        return new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    });
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({
        providers: {
            [provider]: {
                baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
                api: 'openai-completions', apiKey: 'local-fixture',
                models: [{ id: model, name: 'Round-trip model', reasoning: true, input: ['text', 'image'],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
            },
        },
    }));
    // A tiny recent window so the short fixture still has history to summarize.
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
        defaultProvider: provider, defaultModel: model, compaction: { keepRecentTokens: 0, reserveTokens: 100 },
    }));

    await mkdir(join(agentDir, 'extensions'));
    await writeFile(join(agentDir, 'extensions', 'test-status.js'), `
        export default function (pi) {
            pi.on('session_start', (_event, ctx) => {
                ctx.ui.setStatus('fixture', '\u001b[38;5;114mPi fixture extension ready\u001b[0m');
                ctx.ui.setWidget('fixture-list', ['Pi widget fixture line']);
            });
            pi.registerCommand('plan', {
                description: 'Fixture Plan extension command',
                handler: async (args, ctx) => {
                    if (args.trim() === 'dialog') {
                        const choice = await ctx.ui.select('Fixture plan action', ['Start', 'Review']);
                        const note = await ctx.ui.input('Fixture plan note', 'Enter a note');
                        const approved = await ctx.ui.confirm('Fixture plan approval', 'Apply the fixture plan?');
                        const edited = await ctx.ui.editor('Fixture plan editor', 'draft plan');
                        ctx.ui.notify('PLAN_DIALOG_RESULT:' + choice + '|' + note + '|' + approved + '|' + edited, 'info');
                        return;
                    }
                    ctx.ui.notify('PLAN_COMMAND:' + args.trim(), 'info');
                },
            });
            pi.registerCommand('goal', {
                description: 'Fixture Goal extension command',
                handler: async (args, ctx) => {
                    ctx.ui.notify('GOAL_COMMAND:' + args.trim(), 'info');
                },
            });
            pi.registerCommand('prefill', {
                description: 'Fixture editor prefill command',
                handler: async (args, ctx) => {
                    ctx.ui.setEditorText('PREFILL:' + args.trim());
                },
            });
            pi.registerCommand('rewind', {
                description: 'Fixture checkpoint restore',
                handler: async (_args, ctx) => {
                    if (ctx.ui.custom) return await ctx.ui.custom(() => {});
                    const selection = await ctx.ui.select('Fixture checkpoint', ['Keep current', 'Restore first reply']);
                    if (selection !== 'Restore first reply') return;
                    const first = ctx.sessionManager.getEntries().find(entry => entry.message?.role === 'assistant');
                    await ctx.navigateTree(first.id, { summarize: false });
                },
            });
        }
    `);

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
        let parentId = entries(seeded).at(-1).id;
        const sidebarEntries = [
            { type: 'custom', customType: 'rpiv-todo-state',
                data: { tasks: [{ id: 1, subject: 'Review Pi todo fixture', status: 'in_progress' }], nextId: 2 } },
            { type: 'message', message: { role: 'toolResult', toolCallId: 'fixture-child', toolName: 'subagent',
                content: [], isError: false, timestamp: Date.now(),
                details: { results: [{ index: 0, agent: 'reviewer', task: 'Pi child fixture', exitCode: 0 }] } } },
        ];
        for (const [index, entry] of sidebarEntries.entries()) {
            const id = `f17e000${index + 1}`;
            await appendFile(file, JSON.stringify({ ...entry, id, parentId, timestamp: new Date().toISOString() }) + '\n');
            parentId = id;
        }
        const socket = `pi-roundtrip-${process.pid}`;
        const tmux = (...args) => execFile('tmux', ['-L', socket, ...args], { timeout: 5000 });
        t.after(() => tmux('kill-server').catch(() => {}));
        const waitForPane = async (expected, present = true) => {
            const deadline = Date.now() + 12_000;
            let screen = '';
            while (Date.now() < deadline) {
                screen = (await tmux('capture-pane', '-p', '-S', '-100')).stdout;
                const found = typeof expected === 'string' ? screen.includes(expected) : expected.test(screen);
                if (found === present) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.fail(`TUI did not display ${expected}:\n${screen}`);
        };
        const contextReadout = async () => {
            const screen = (await tmux('capture-pane', '-p', '-S', '-100')).stdout;
            const matches = [...screen.matchAll(/\d+(?:\.\d+)?% \(([^)]+)\)/g)];
            assert.ok(matches.length > 0, `TUI did not display a context readout:\n${screen}`);
            return matches.at(-1)[1];
        };
        const waitForContextChange = async previous => {
            const deadline = Date.now() + 5000;
            let screen = '';
            while (Date.now() < deadline) {
                screen = (await tmux('capture-pane', '-p', '-S', '-100')).stdout;
                const match = [...screen.matchAll(/\d+(?:\.\d+)?% \(([^)]+)\)/g)].at(-1);
                if (match !== undefined && match[1] !== previous) return match[1];
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.fail(`TUI context readout stayed at ${previous}:\n${screen}`);
        };
        await tmux('new-session', '-d', '-x', '120', '-y', '40', '-c', cwd, 'env',
            `HOME=${isolatedHome}`,
            `DSH_HOME=${profile}`, 'DSH_TUI_LANG=en', ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
            'dsh-tui', '--backend', 'pi');
        await waitForPane('pi · pi v');
        await tmux('send-keys', '-l', '/resume');
        await waitForPane('/resume');
        await tmux('send-keys', 'Enter');
        await waitForPane(turns[0][0]);
        await tmux('send-keys', 'Enter');
        await waitForPane(turns[0][1]);
        const initialContext = await contextReadout();
        await tmux('send-keys', '-l', '/panel info');
        await tmux('send-keys', 'Enter');
        await waitForPane('Cache hit');
        await waitForPane('Pi fixture extension ready');
        await waitForPane('38;5;114m', false);
        await waitForPane('Pi widget fixture line');
        await tmux('send-keys', 'C-b');
        await waitForPane('Esc chat', false);
        await tmux('send-keys', '-l', '/panel todo');
        await tmux('send-keys', 'Enter');
        await waitForPane(/│.*Review Pi todo fixture/);
        await tmux('send-keys', 'C-b');
        await waitForPane('Esc chat', false);
        await tmux('send-keys', '-l', '/panel agents');
        await waitForPane('/panel agents');
        await tmux('send-keys', 'Enter');
        await waitForPane(/│.*Pi child fixture/);
        await tmux('send-keys', 'C-b');
        await waitForPane('Esc chat', false);
        for (const [index, [prompt, reply]] of turns.slice(1, 3).entries()) {
            const command = `/effort ${['high', 'low'][index]}`;
            await tmux('send-keys', '-l', command);
            await waitForPane(command);
            await tmux('send-keys', 'Enter');
            await waitForPane(`roundtrip-model · ${['high', 'low'][index]}`);
            await tmux('send-keys', '-l', prompt);
            await tmux('send-keys', 'Enter');
            if (index === 0) await waitForPane(/· total \d+s · .*tokens/);
            await waitForPane(reply);
            if (index === 0) await waitForPane(/· total \d+s · .*tokens/, false);
            if (index === 0) {
                await waitForPane('Tab to accept · Show me the next step.');
                const beforeTab = requests.length;
                await tmux('send-keys', 'Tab');
                await waitForPane(/❯.*Show me the next step\./);
                await waitForPane('Tab to accept', false);
                assert.equal(requests.length, beforeTab, 'Tab accepts the suggestion into the draft');
                await tmux('send-keys', 'C-u');
                await waitForPane('Show me the next step.', false);
            }
        }
        const continuedContext = await contextReadout();
        assert.notEqual(continuedContext, initialContext, 'continued conversation must move the context readout');
        await tmux('send-keys', '-l', '/panel info');
        await tmux('send-keys', 'Enter');
        await waitForPane('Cache hit');
        await waitForPane('Tokens');
        await waitForPane('Pi native');
        await tmux('send-keys', 'C-b');
        await waitForPane('Esc chat', false);
        await tmux('send-keys', '-l', '/tree');
        await tmux('send-keys', 'Enter');
        await waitForPane('Pi session tree');
        await tmux('send-keys', 'Down', 'Up', 'Enter');
        await waitForPane('Pi branch action');
        await tmux('send-keys', 'Down', 'Enter');
        await waitForPane('Created a Pi branch.');
        const seedAnchor = entries(seeded).find(entry => entry.message?.role === 'user').id;
        await tmux('send-keys', '-l', `/tree ${seedAnchor}`);
        await tmux('send-keys', 'Enter');
        const deadlineForTree = Date.now() + 5000;
        while (true) {
            const screen = (await tmux('capture-pane', '-p', '-S', '-100')).stdout;
            if (screen.includes('Pi session tree')) break;
            assert.ok(Date.now() < deadlineForTree, `TUI did not display the requested Pi branch:\n${screen}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const newFiles = (await nativeSessionFiles(agentDir)).filter(path => path !== file);
        assert.equal(newFiles.length, 1);
        const forkContents = await readFile(newFiles[0], 'utf8');
        assert.equal(entries(forkContents)[0].parentSession, file);
        assert.deepEqual(messages(forkContents), transcript.slice(0, 1));
        forkPaths.push(...newFiles);
        await tmux('send-keys', '-l', '/suggest');
        await tmux('send-keys', 'Enter');
        await waitForPane('Side answer from Pi');
        await tmux('send-keys', '-l', '/recap');
        await tmux('send-keys', 'Enter');
        await waitForPane('Side recap from Pi');
        await waitForPane('Pi round-trip recap');
        await tmux('send-keys', 'Escape');
        await waitForPane('Side recap from Pi', false);
        await tmux('send-keys', '-l', '/btw Which branch is active?');
        await waitForPane('Which branch is active?');
        await tmux('send-keys', 'Enter');
        await waitForPane('Side branch answer from Pi');
        await tmux('send-keys', 'C-b');
        await waitForPane('Side branch answer from Pi', false);
        await tmux('send-keys', '-l', '/prefill from Pi');
        await tmux('send-keys', 'Enter');
        await waitForPane('PREFILL:from Pi');
        await tmux('send-keys', 'C-u');
        await tmux('send-keys', '-l', '/compact');
        await waitForPane('/compact');
        await tmux('send-keys', 'Enter');
        await waitForPane('compacted summary text');
        await waitForContextChange(continuedContext);
        await tmux('send-keys', '-l', '/restore');
        await tmux('send-keys', 'Enter');
        await waitForPane(/❯● Keep current/);
        await tmux('send-keys', 'Down');
        await waitForPane(/❯● Restore first reply/);
        await tmux('send-keys', 'Enter');
        await waitForPane('Fixture checkpoint', false);
        await waitForPane(turns[0][1]);
        await waitForPane(turns[2][1], false);
        assert.deepEqual(messages(await readFile(file, 'utf8')).slice(0, 6), transcript.slice(0, 6));
        await tmux('send-keys', '-l', '/tree');
        await tmux('send-keys', 'Enter');
        await waitForPane('Pi session tree');
        await tmux('send-keys', 'Down', 'Down', 'Enter');
        await waitForPane('Pi branch action');
        await tmux('send-keys', 'Enter');
        await waitForPane(new RegExp('❯.*' + turns[2][0]));
        await tmux('send-keys', 'C-u');
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
            assert.ok(replayed.some(event => event.type === 'usage' && event.usage.output === 7));
            assert.ok(replayed.some(event => event.type === 'session.ready' && event.contextWindow === 8192));
            const live = [];
            const contextUsage = [];
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
                    await session.activeTurn?.done;
                    const end = live.find(event => event.type === 'turn.end');
                    assert.equal(end?.reason?.kind, 'completed', JSON.stringify(end));
                    assert.equal(live.filter(event => event.type === 'assistant.delta' && event.delta.kind === 'text')
                        .map(event => event.delta.text).join(''), reply);
                    assert.ok(live.some(event => event.type === 'usage' && event.usage.output === 7));
                    assert.ok(live.some(event => event.type === 'context.usage' && event.max === 8192));
                    contextUsage.push(live.filter(event => event.type === 'context.usage').at(-1)?.used);
                    assert.equal(session.rpc.child, child);
                    assert.equal(child.exitCode, null);
                    assert.equal(child.signalCode, null);
                }
                assert.ok(contextUsage.every(used => Number.isFinite(used)), JSON.stringify(contextUsage));
                assert.notEqual(contextUsage[1], contextUsage[0], 'continued turns must refresh measured context usage');
                const commands = await session.capabilities.commands.list();
                assert.ok(commands.some(command => command.name === 'tree'));
                assert.ok(commands.some(command => command.name === 'plan'));
                assert.ok(commands.some(command => command.name === 'goal'));
                const currentUser = live.find(event => event.type === 'user.message' && event.source === 'user');
                const waitForLive = async predicate => {
                    const deadline = Date.now() + 5000;
                    while (Date.now() < deadline) {
                        const found = live.find(predicate);
                        if (found) return found;
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                    assert.fail(`Timed out waiting for live event: ${JSON.stringify(live.slice(-8))}`);
                };
                live.length = 0;
                const planCommand = session.submit({ text: '/plan dialog', clientMessageId: 'plan-dialog' }, 'turn');
                const planChoice = await waitForLive(event => event.type === 'question.request');
                assert.equal(planChoice.request.questions[0].question, 'Fixture plan action');
                session.capabilities.questions.respond(planChoice.request.requestId, {
                    answers: [{ selected: ['Review'] }],
                });
                const planNote = await waitForLive(event => event.type === 'question.request'
                    && event.request.requestId !== planChoice.request.requestId);
                assert.equal(planNote.request.questions[0].detail, 'Enter a note');
                session.capabilities.questions.respond(planNote.request.requestId, {
                    answers: [{ selected: [], custom: 'Keep the extension flow' }],
                });
                const planApproval = await waitForLive(event => event.type === 'permission.request');
                assert.equal(planApproval.request.title, 'Fixture plan approval');
                session.capabilities.permissions.respond(planApproval.request.requestId, { kind: 'allow-once' });
                const planEditor = await waitForLive(event => event.type === 'question.request'
                    && event.request.requestId !== planChoice.request.requestId
                    && event.request.requestId !== planNote.request.requestId);
                assert.match(planEditor.request.questions[0].detail, /draft plan/);
                session.capabilities.questions.respond(planEditor.request.requestId, {
                    answers: [{ selected: [], custom: 'edited fixture plan' }],
                });
                assert.equal((await planCommand).accepted, true);
                const planResult = await waitForLive(event => event.type === 'user.message'
                    && event.source === 'command-output' && event.label === '/plan'
                    && event.text.startsWith('PLAN_DIALOG_RESULT:'));
                assert.equal(planResult.text, 'PLAN_DIALOG_RESULT:Review|Keep the extension flow|true|edited fixture plan');

                live.length = 0;
                assert.equal((await session.submit({ text: '/goal fixture objective', clientMessageId: 'goal-command' }, 'turn')).accepted, true);
                const goalResult = await waitForLive(event => event.type === 'user.message'
                    && event.source === 'command-output' && event.label === '/goal'
                    && event.text.startsWith('GOAL_COMMAND:'));
                assert.equal(goalResult.text, 'GOAL_COMMAND:fixture objective');
                const beforeSide = await readFile(file, 'utf8');
                const deltas = [];
                assert.deepEqual(await session.capabilities.sideQuery.ask('What have we done?', { onText: delta => deltas.push(delta) }),
                    { answer: 'Side answer from Pi' });
                assert.equal(deltas.join(''), 'Side answer from Pi');
                assert.match(sideRequests.at(-1), /second backend reply from Pi/);
                const cancelled = AbortSignal.abort();
                assert.deepEqual(await session.capabilities.sideQuery.ask('Cancelled', { signal: cancelled }), { answer: null });
                await session.submit({ text: '/pi-suggest', clientMessageId: 'suggestion' }, 'turn');
                assert.ok(live.some(event => event.source === 'command-output' && event.label === '/pi-suggest' && event.text === 'Side answer from Pi'));
                await session.submit({ text: '/pi-tree ' + replayed.find(event => event.source === 'user').anchor, clientMessageId: 'tree' }, 'turn');
                assert.ok(live.some(event => event.source === 'command-output' && event.label === '/pi-tree' && event.text.includes(turns[0][0])));
                assert.equal(await readFile(file, 'utf8'), beforeSide);
                assert.ok((await session.capabilities.context.usage('full')).used > 0);

                const forked = await session.capabilities.fork.fork(undefined, 'Forked title');
                const rewind = await session.capabilities.rewind.rewind(currentUser.anchor, 'conversation');
                assert.equal(rewind.kind, 'rewound', JSON.stringify(rewind));
                const firstAnchor = replayed.find(event => event.source === 'user').anchor;
                const rewindToFirst = await session.capabilities.rewind.rewind(firstAnchor, 'conversation');
                assert.equal(rewindToFirst.kind, 'rewound', JSON.stringify(rewindToFirst));
                await session.submit({ text: `/fork ${firstAnchor}`, clientMessageId: 'tree-fork' }, 'turn');
                const forkCommand = live.find(event => event.source === 'command-output' && event.label === '/fork');
                const forkFromTree = { sessionId: forkCommand?.text.match(/\/resume ([a-f0-9-]+)/)?.[1] };
                assert.ok(forkFromTree.sessionId);
                for (const [ref, count] of [[forked, 6], [rewind.session, 4], [rewindToFirst.session, 0], [forkFromTree, 1]]) {
                    const path = (await nativeSessionFiles(agentDir)).find(path => path.endsWith(`${ref.sessionId}.jsonl`));
                    assert.ok(path);
                    forkPaths.push(path);
                    const contents = await readFile(path, 'utf8');
                    assert.equal(entries(contents)[0].parentSession, file);
                    assert.deepEqual(messages(contents), transcript.slice(0, count));
                    const reopenedFork = await backend.open({ kind: 'resume', sessionId: ref.sessionId, cwd }, host);
                    await reopenedFork.dispose();
                }
                assert.equal((await backend.catalog.info(forked.sessionId, cwd)).title.text, 'Forked title');
                await session.capabilities.rename.rename('Renamed Pi session');
                assert.ok(live.some(event => event.type === 'session.title' && event.title === 'Renamed Pi session'));
                assert.equal((await backend.catalog.info(header.id, cwd)).title.text, 'Renamed Pi session');
                assert.equal(session.rpc.child, child);
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
                const postCompactUsage = compaction.find(event => event.type === 'context.usage');
                assert.equal(postCompactUsage?.used, end?.postTokens,
                    'compaction must publish Pi\'s post-compaction estimate immediately');
                assert.ok(postCompactUsage.used < contextUsage.at(-1),
                    `compaction must reduce measured context usage: ${JSON.stringify({ turns: contextUsage, after: postCompactUsage.used })}`);
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
    assert.deepEqual((await nativeSessionFiles(agentDir)).sort(), [file, ...forkPaths].sort());
    assert.deepEqual(requests.slice(0, 3).map(request => request.messages), turns.slice(0, 3).map((_, index) => transcript.slice(0, index * 2 + 1)));
    assert.ok(summaries.length >= 1, 'Pi asked its model for a compaction summary');
    assert.deepEqual(requests.slice(1).map(request => request.effort), ['high', 'low', 'low']);
    assert.deepEqual(entries(appended).filter(entry => entry.type === 'thinking_level_change').slice(-2)
        .map(entry => entry.thinkingLevel), ['high', 'low']);
    assert.equal(entries(appended).filter(entry => entry.type === 'compaction').length, 1);

    if (!profile) {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
        const image = { id: 'fixture-image', mediaType: 'image/png', width: 1, height: 1, read: async () => png };
        const fresh = await backend.open({ kind: 'new', cwd }, host);
        const live = [];
        fresh.subscribe(batch => live.push(...batch));
        try {
            assert.equal((await fresh.submit({ text: 'Fixture image prompt', clientMessageId: 'image',
                blocks: [{ type: 'text', text: 'Fixture image prompt' }, { type: 'image' }], images: [image] }, 'turn')).accepted, true);
            await imageTurn;
            const done = fresh.activeTurn.done;
            assert.equal((await fresh.submit({ text: '/steer Fixture steer', clientMessageId: 'steer', images: [image] }, 'steer')).accepted, true);
            assert.equal((await fresh.submit({ text: 'Fixture follow-up', clientMessageId: 'follow' }, 'followup')).accepted, true);
            assert.ok(live.some(event => event.type === 'pending.changed' && event.items.some(item => item.id === 'steer')));
            releaseImageTurn();
            await done;
            assert.equal(imageInputs.length, 3);
            assert.ok(imageInputs[0].some(block => block.image_url?.url?.startsWith('data:image/png;base64,')));
            assert.ok(imageInputs[1].some(block => block.image_url?.url?.startsWith('data:image/png;base64,')));
            assert.ok(live.some(event => event.type === 'pending.changed' && event.claimed?.includes('steer')));
            assert.ok(live.some(event => event.type === 'user.message' && event.source === 'injected' && event.text === 'Fixture steer'));
        } finally {
            releaseImageTurn();
            await fresh.dispose();
        }
        const resumed = await backend.open({ kind: 'resume', sessionId: fresh.sessionId, cwd }, host);
        try {
            const imageRows = (await resumed.history()).filter(event => event.type === 'user.message' && event.images?.length);
            assert.equal(imageRows.length, 2);
            assert.equal(imageRows[1].images[0].width, 1);
            assert.deepEqual(await imageRows[1].images[0].read(), png);
        } finally { await resumed.dispose(); }
    }
});

test('Pi tools project live output and structured cards', async () => {
    const { PiCliSession } = await import('../session.js');
    const session = new PiCliSession({ kind: 'new', cwd: '/tmp' }, {});
    session.activeTurn = { assistants: [] };
    const live = [];
    session.subscribe(batch => live.push(...batch));
    session.onRecord({ type: 'tool_execution_start', toolCallId: 'test', toolName: 'bash', args: { command: 'pwd' } });
    for (const text of ['first\n', 'first\nsecond\n']) {
        session.onRecord({ type: 'tool_execution_update', toolCallId: 'test', partialResult: { content: [{ type: 'text', text }] } });
    }
    session.onRecord({ type: 'tool_execution_end', toolCallId: 'test', result: { content: [{ type: 'text', text: 'first\nsecond\n' }] } });
    const [call, first, second, result] = live;
    assert.equal(call.presentation.card, 'terminal');
    assert.equal(first.text, 'first\n');
    assert.equal(second.text, 'second\n');
    assert.equal(result.presentation.output, 'first\nsecond\n');
    assert.equal(call.step, result.step);
    assert.deepEqual((await session.history()).map(event => event.type), ['tool.call', 'tool.result']);
});

test('Pi extension todos and subagents project live and on replay', async () => {
    const { PiCliSession } = await import('../session.js');
    const session = new PiCliSession({ kind: 'new', cwd: '/tmp' }, {});
    session.activeTurn = { assistants: [] };
    session.onRecord({ type: 'tool_execution_start', toolCallId: 'todo-1', toolName: 'todo' });
    const todos = { todos: [{ text: 'First task', done: false }, { text: 'Done task', done: true }] };
    session.onRecord({ type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result: { details: todos } });
    session.onRecord({ type: 'tool_execution_start', toolCallId: 'delegate', toolName: 'subagent' });
    const agent = { index: 3, agent: 'reviewer', task: 'Review the changes', exitCode: 0 };
    session.onRecord({ type: 'tool_execution_update', toolCallId: 'delegate', toolName: 'subagent',
        partialResult: { details: { results: [{ ...agent, progress: { status: 'running' } }] } } });
    assert.equal((await session.history()).filter(event => event.type === 'subagent.end').length, 0);
    const result = { details: { results: [{ ...agent, finalOutput: 'Review finished' }] } };
    session.onRecord({ type: 'tool_execution_end', toolCallId: 'delegate', toolName: 'subagent', result });
    const replay = new PiCliSession({ kind: 'new', cwd: '/tmp' }, {});
    replay.replayEntry({ type: 'message', message: { role: 'toolResult', toolName: 'todo', toolCallId: 'todo-1', details: todos } });
    replay.replayEntry({ type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'delegate', ...result } });
    const nativeTodos = { tasks: [{ id: 1, subject: 'Review changes', status: 'in_progress' },
        { id: 2, subject: 'Discarded task', status: 'deleted' }], nextId: 3 };
    const todoEntry = { type: 'custom', customType: 'rpiv-todo-state', id: 'todo-state', data: nativeTodos };
    session.onRecord({ type: 'tool_execution_end', toolCallId: 'todo-2', toolName: 'todo', result: { details: nativeTodos } });
    session.rpc = { request: async () => ({ entries: [todoEntry], leafId: todoEntry.id }) };
    await session.captureAnchors({ userAnchors: [] });
    replay.replayEntry(todoEntry);
    const clearedTodo = { ...todoEntry, id: 'todo-clear', parentId: todoEntry.id, data: { tasks: [], nextId: 1 } };
    const inactiveTodo = { ...todoEntry, id: 'todo-sibling', parentId: todoEntry.id };
    session.rpc = { request: async () => ({ entries: [clearedTodo, inactiveTodo], leafId: clearedTodo.id }) };
    await session.captureAnchors({ userAnchors: [] });
    replay.replayEntry(clearedTodo);

    const launchArgs = { async: true, agent: 'builder', task: 'Build the changes' };
    const launch = { details: { mode: 'single', runId: 'build-run', asyncId: 'build-run', results: [] } };
    const notice = { customType: 'subagent-notify', details: { runs: [{ runId: 'build-run', status: 'completed' }] } };
    session.onRecord({ type: 'tool_execution_start', toolCallId: 'build-call', toolName: 'subagent', args: launchArgs });
    session.onRecord({ type: 'tool_execution_end', toolCallId: 'build-call', toolName: 'subagent', result: launch });
    session.activeTurn.resolve = () => {};
    session.finishTurn({ kind: 'completed' });
    session.onRecord({ type: 'message_end', message: { role: 'custom', ...notice } });
    session.onRecord({ type: 'message_end', message: { role: 'custom', ...notice } });
    replay.replayEntry({ type: 'message', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'build-call', name: 'subagent', arguments: launchArgs },
    ] } });
    replay.replayEntry({ type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'build-call', ...launch } });
    replay.replayEntry({ type: 'custom_message', ...notice });

    for (const instance of [session, replay]) {
        const events = await instance.history();
        assert.deepEqual(events.filter(event => event.type === 'todo.write').map(event => event.items), [
            [{ content: 'First task', status: 'pending' }, { content: 'Done task', status: 'completed' }],
            [{ content: 'Review changes', status: 'in_progress' }],
            [],
        ]);
        const children = events.filter(event => event.type.startsWith('subagent.'));
        assert.deepEqual(children.map(event => event.type), ['subagent.start', 'subagent.end', 'subagent.start', 'subagent.end']);
        assert.equal(children[0].agentId, children[1].agentId);
        assert.equal(children[1].status, 'completed');
        assert.equal(children[1].summary, 'Review finished');
        assert.equal(children[2].background, true);
        assert.equal(children[2].description, launchArgs.task);
        assert.equal(children[2].agentId, children[3].agentId);
        assert.equal(children[3].status, 'completed');
    }
});
