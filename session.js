import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readPiBranch, messageText, piBranch, requirePiSessionFile, writePiFork } from './catalog.js';
import { dirname, join } from 'node:path';
import { modelSpec } from './catalog-models.js';
import { PiRpc } from './rpc.js';
import { askPiSideQuery } from './side-query.js';
import { createPiExtensionState, piPlainText, piTodos, piSubagents } from './extension-state.js';
import { piImageInputs, piImageLimits, piTranscriptImages } from './images.js';
import { PiInteractions } from './interactions.js';
import { piToolCall, piToolResult } from './presentation.js';
import { createPiPromptInjector } from './prompt-injection.js';
import { bridgeCommand } from './rpc-extension.js';
function ev(e) {
    return e;
}
// Pi extensions register commands before they know which host mode they will
// run in. TUI-only plugins such as pi-sidebar therefore keep advertising their
// slash commands under RPC, where their `ctx.mode === "tui"` guards and
// `ctx.ui.custom()` calls are no-ops. Hide those commands from dsh-tui's menu.
const TUI_ONLY_COMMAND = /^(?:sidebar(?:-.*)?|sessions-manager|btw-resume|tool-view|tool-display|open-tui|lens-widget-toggle)$/u;
const TUI_ONLY_SOURCES = new Set([
    'git:github.com/suemi994/pi-sidebar',
    'npm:pi-open-tui',
    'npm:pi-ui-enhancement',
]);
function isTuiOnlyCommand(command) {
    return TUI_ONLY_COMMAND.test(command.name) || TUI_ONLY_SOURCES.has(command.sourceInfo?.source);
}
function configuredHiddenCommands() {
    return new Set((process.env.PI_HIDDEN_COMMANDS ?? '').split(',').map(name => name.trim()).filter(Boolean));
}
const localOverrides = [
    { name: 'tree', description: 'Navigate or fork Pi branches, or inspect one with /tree <entry-id>' },
    { name: 'fork', description: 'Fork the current Pi branch, or use /fork <entry-id>' },
];
const localCommands = [
    { name: 'steer', description: 'Send an instruction at the next Pi tool boundary' },
    ...localOverrides,
    { name: 'suggest', description: 'Suggest next prompts based on this conversation' },
];
const commandAliases = new Map(localCommands.slice(1).map(command => [
    'pi-' + command.name, command.name,
]));
const reservedCommandNames = new Set([
    ...localCommands.map(command => command.name), ...commandAliases.keys(), bridgeCommand, 'restore', 'rewind',
]);
export class PiCliSession {
    backendId = 'pi';
    sessionId;
    ref;
    capabilities = {
        native: {},
        permissions: {
            respond: (requestId, decision) => this.interactions.respondPermission(requestId, decision),
            pending: () => this.interactions.pendingPermissions(),
        },
        questions: {
            respond: (requestId, answers) => this.interactions.respondQuestion(requestId, answers),
            cancel: requestId => this.interactions.cancelQuestion(requestId),
        },
        images: { limits: piImageLimits },
        sideQuery: { ask: (prompt, options) => askPiSideQuery(this, prompt, options) },
        promptSuggestion: { suggest: signal => this.suggestFollowUp(signal) },
        commands: { localOverrides, list: () => this.listCommands() },
        infoStatus: createPiExtensionState(),
        context: { usage: async () => {
            const { contextUsage } = await this.rpc.request('get_session_stats');
            if (contextUsage?.tokens == null) throw new Error('Pi has no current context measurement');
            return { used: contextUsage.tokens, max: contextUsage.contextWindow, categories: [] };
        } },
        rename: { rename: async title => {
            await this.rpc.request('set_session_name', { name: title });
            this.title = title;
            this.emitLive([ev({ type: 'session.title', title, source: 'user' })], { replay: false });
        } },
        fork: { fork: (anchor, title) => this.forkSession(anchor, title) },
        rewind: { rewind: async (anchor, mode) => {
            if (mode !== 'conversation') return { kind: 'refused', reason: 'Pi supports conversation rewind only' };
            try {
                return { kind: 'rewound', session: await this.forkSession(anchor, undefined, true) };
            } catch (error) {
                return { kind: 'refused', reason: error.message };
            }
        } },
        models: {
            list: async () => (await this.rpc.request('get_available_models')).models.map(model => ({
                provider: model.provider,
                id: model.id,
                label: model.name,
            })),
            // The pieces `list()` gave, passed back whole: `pi` takes them joined.
            current: () => ({ provider: this.providerId, model: this.modelId }),
            set: async (ref) => {
                // dst sends the provider only when it differs from the current one, and
                // a provider name is passed back exactly as `list()` gave it, so a spec
                // built from both is the whole route even with slashes inside either.
                const { models: rows } = await this.rpc.request('get_available_models');
                const row = ref.provider === undefined || ref.provider === ''
                    ? rows.find(model => model.provider === this.providerId && model.id === ref.model)
                        ?? rows.find(model => modelSpec(model.provider, model.id) === ref.model)
                    : rows.find(model => modelSpec(model.provider, model.id) === modelSpec(ref.provider, ref.model));
                if (row === undefined)
                    return { kind: 'refused', reason: `unknown model: ${modelSpec(ref.provider, ref.model)}` };
                try {
                    const model = await this.rpc.request('set_model', { provider: row.provider, modelId: row.id });
                    this.setRoute(model.provider, model.id);
                    this.contextWindow = model.contextWindow;
                    this.acceptsImages = model.input?.includes('image');
                    await this.refreshEffort();
                    this.emitCapacity();
                    await this.refreshStats();
                } catch (error) {
                    return { kind: 'refused', reason: error.message };
                }
                this.emitLive([ev({ type: 'model.changed', model: this.modelId, provider: this.providerId, source: 'user' })], { replay: false });
                return { kind: 'switched' };
            },
        },
        // Pi's own `/compact`: the summary and the checkpoint are written into the
        // native session file, so Pi CLI sees the same compaction afterwards.
        compact: { run: () => this.runCompact() },
        effort: {
            levels: () => this.effortLevels,
            current: () => this.thinkingLevel,
            set: async id => {
                // Pi has no reset command. Auto leaves the session's Pi setting in place.
                if (id === null) return;
                if (!this.effortLevels.some(level => level.id === id)) {
                    throw new Error(`Pi model does not support thinking level: ${id}`);
                }
                await this.rpc.request('set_thinking_level', { level: id });
                const state = await this.rpc.request('get_state');
                this.updateThinkingLevel(state.thinkingLevel);
                if (state.thinkingLevel !== id) throw new Error(`Pi applied thinking level ${state.thinkingLevel} instead of ${id}`);
            },
        },
    };
    effortLevels = [];
    thinkingLevel;
    cwd;
    host;
    piSessionId;
    sessionFile;
    modelOverride;
    activeTurn;
    rpc;
    contextWindow;
    providerId = '';
    modelId = '';
    status = 'starting';
    seq = 0;
    turnNo = 0;
    stepNo = 0;
    curAttemptId = '';
    sideQueries = new AbortController();
    sessionCost;
    title;
    entryCursor;
    liveAnchors = new Map();
    queued = [];
    interactions;
    childStates = new Map();
    acceptsImages;
    streamed = new Set();
    compacting = false;
    branchCommandRunning = false;
    promptInjector;
    toolSteps = new Map();
    toolOutput = new Map();
    listeners = new Set();
    historyEvents = [];
    earlyEvents = [];
    constructor(target, host) {
        this.host = host;
        this.cwd = target.native?.summary.cwd ?? target.cwd ?? host.cwd ?? process.cwd();
        const sid = target.native?.summary.id ?? randomUUID();
        this.sessionId = sid;
        this.piSessionId = sid;
        this.interactions = new PiInteractions({
            emit: batch => this.emitLive(batch, { replay: false }),
            send: (record, callback) => this.rpc.send(record, callback),
            onPendingChange: waiting => this.updateInteractionStatus(waiting),
            debug: message => this.host.debug?.(message),
        });
        this.ref = { backendId: 'pi', sessionId: sid };
        this.sessionFile = target.native?.path;
        this.title = target.native?.summary.title?.text;
        this.modelOverride = process.env.PI_MODEL || undefined;
        this.promptInjector = createPiPromptInjector({
            sessionId: sid,
            onError: message => this.emitLive([ev({ type: 'notice', level: 'warning', text: message })], { replay: false }),
        });
    }
    setRoute(provider, id) {
        this.providerId = provider;
        this.modelId = id;
    }
    handleRpcExit(error) {
        const wasStarting = this.status === 'starting';
        this.sideQueries.abort();
        this.capabilities.infoStatus.close();
        this.interactions.cancelAll({ respond: false });
        if (!wasStarting) this.setStatus('disposed');
        if (this.activeTurn) this.finishTurn({ kind: 'error', message: error.message });
        if (!wasStarting) this.host.warn?.(error.message);
    }
    async extensionCommands() {
        const { commands } = await this.rpc.request('get_commands');
        const hidden = configuredHiddenCommands();
        return commands.filter(command => !hidden.has(command.name) && !isTuiOnlyCommand(command));
    }
    restoreCommand(commands) {
        return ['restore', 'rewind'].map(name => commands.find(command => command.name === name
            && command.source === 'extension')).find(Boolean);
    }
    async listCommands() {
        const commands = await this.extensionCommands();
        const restore = this.restoreCommand(commands);
        return [
            ...localCommands,
            ...localCommands.filter(command => command.name !== 'steer')
                .map(({ name, description }) => ({ name: 'pi-' + name, description, aliasFor: name })),
            ...(restore ? [{ name: 'restore', description: restore.description ?? 'Restore a Pi checkpoint' }] : []),
            ...commands.filter(command => !reservedCommandNames.has(command.name))
                .map(({ name, description }) => ({ name, description })),
        ];
    }
    async forkSession(anchor, title, rewind = false, fromTree = false) {
        const expectedStatus = fromTree ? 'running' : 'idle';
        if (this.status !== expectedStatus || this.compacting) throw new Error('Wait for Pi to finish before creating a branch');
        const path = this.sessionFile;
        if (!path) throw new Error('Pi has no persisted session to fork');
        const { entries, leafId } = await this.rpc.request('get_entries');
        if (this.status !== expectedStatus || this.compacting) throw new Error('Pi started another operation');
        const id = anchor === undefined ? leafId : this.liveAnchors.get(anchor) ?? anchor;
        const branch = piBranch(entries, id);
        if (!id || branch.at(-1)?.id !== id) throw new Error('Pi branch entry is unavailable');
        if (rewind) {
            if (branch.at(-1).message?.role !== 'user') throw new Error('Choose a Pi user message to rewind');
            branch.pop();
        }
        return writePiFork(path, this.sessionId, this.cwd, branch, title);
    }
    emitCapacity() {
        if (this.contextWindow > 0) {
            this.emitLive([ev({ type: 'context.capacity', contextWindow: this.contextWindow })], { replay: false });
        }
    }
    emitContextUsage(used, max = this.contextWindow) {
        if (!Number.isFinite(used) || used < 0) return;
        this.emitLive([ev({ type: 'context.usage', used, ...(max > 0 ? { max } : {}) })], { replay: false });
    }
    async refreshStats() {
        try {
            const { sessionId, sessionFile, cost, contextUsage } = await this.rpc.request('get_session_stats', {}, 3000);
            if (this.status === 'disposed' || sessionId !== this.sessionId) return;
            this.sessionFile = sessionFile || this.sessionFile;
            this.sessionCost = Number.isFinite(cost) ? { amount: cost, currency: 'USD', source: 'backend' } : undefined;
            if (contextUsage?.contextWindow > 0 && contextUsage.contextWindow !== this.contextWindow) {
                this.contextWindow = contextUsage.contextWindow;
                this.emitCapacity();
            }
            if (contextUsage?.tokens != null) {
                this.emitContextUsage(contextUsage.tokens, contextUsage.contextWindow);
            }
        } catch (error) {
            this.host.debug?.(error.message);
        }
    }
    async refreshRuntimeState(state, { emitCapacity = true } = {}) {
        state ??= await this.rpc.request('get_state');
        if (state.sessionId && state.sessionId !== this.sessionId) {
            throw new Error('Pi RPC switched to a different session');
        }
        const previousWindow = this.contextWindow;
        if (state.model) {
            this.setRoute(state.model.provider, state.model.id);
            if (Number.isFinite(state.model.contextWindow)) this.contextWindow = state.model.contextWindow;
            this.acceptsImages = state.model.input?.includes('image');
        }
        this.sessionFile = state.sessionFile || this.sessionFile;
        if (emitCapacity && this.contextWindow > 0 && this.contextWindow !== previousWindow) {
            this.emitCapacity();
        }
        return state;
    }
    async captureAnchors(turn) {
        try {
            const fields = this.entryCursor ? { since: this.entryCursor } : {};
            const { entries } = await this.rpc.request('get_entries', fields, 3000);
            this.entryCursor = entries.at(-1)?.id ?? this.entryCursor;
            const users = entries.filter(entry => entry.message?.role === 'user');
            if (users.length > 0 && users.length === turn.userAnchors.length) {
                users.forEach((entry, index) => this.liveAnchors.set(turn.userAnchors[index], entry.id));
                if (!this.title && this.status !== 'disposed') {
                    const title = messageText(users[0].message).replace(/\s+/g, ' ').trim().slice(0, 160);
                    if (title) {
                        this.title = title;
                        this.emitLive([ev({ type: 'session.title', title, source: 'auto' })], { replay: false });
                    }
                }
                const assistants = entries.filter(entry => entry.message?.role === 'assistant');
                if (assistants.length === turn.assistants.length) {
                    assistants.forEach((entry, index) => {
                        if (turn.assistants[index]) this.liveAnchors.set(turn.assistants[index], entry.id);
                    });
                }
            }
        } catch (error) {
            this.host.debug?.(error.message);
        }
    }
    async runCompact() {
        if (this.status !== 'idle' || this.activeTurn || this.compacting) throw new Error('Pi is running a turn; compact after it finishes');
        if (this.rpc === undefined) throw new Error('Pi session is not open');
        // Pi aborts any in-flight work itself and summarizes the active branch.
        this.compacting = true;
        try {
            await this.rpc.request('compact', {}, 600_000);
            await this.refreshStats();
        } finally { this.compacting = false; }
    }
    async refreshEffort(state) {
        const { levels } = await this.rpc.request('get_available_thinking_levels');
        this.effortLevels = levels.map(id => ({ id, label: id }));
        this.updateThinkingLevel((state ?? await this.rpc.request('get_state')).thinkingLevel);
    }
    updateThinkingLevel(level) {
        if (level === this.thinkingLevel) return;
        this.thinkingLevel = level;
        this.emitLive([ev({ type: 'effort.changed', effort: level })], { replay: false });
    }
    async start() {
        if (!(await stat(this.cwd)).isDirectory()) throw new Error(`Missing Pi project directory: ${this.cwd}`);
        if (this.sessionFile) {
            await requirePiSessionFile(this.sessionFile, this.piSessionId, this.cwd);
            const branch = await readPiBranch(this.sessionFile);
            if (!this.modelOverride) {
                const lastModel = branch.findLast(entry => entry.type === 'model_change' ||
                    (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.model));
                if (lastModel?.type === 'model_change') this.setRoute(lastModel.provider, lastModel.modelId);
                else if (lastModel) this.setRoute(lastModel.message.provider, lastModel.message.model);
            }
            for (const entry of branch) this.replayEntry(entry);
        }
        const args = ['--mode', 'rpc', '--extension', fileURLToPath(new URL('./rpc-extension.js', import.meta.url))];
        if (this.sessionFile) args.push('--session', this.sessionFile);
        else args.push('--session-id', this.piSessionId);
        if (this.modelOverride) args.push('--model', this.modelOverride);
        this.rpc = new PiRpc(args, this.cwd, record => this.onRecord(record), (error, closing) => {
            if (closing || this.status === 'disposed') return;
            this.handleRpcExit(error);
        });
        try {
            const state = await this.refreshRuntimeState(undefined, { emitCapacity: false });
            if (this.turnNo) {
                try {
                    const { entries } = await this.rpc.request('get_entries', {}, 3000);
                    this.entryCursor = entries.at(-1)?.id;
                } catch (error) {
                    this.host.debug?.(error.message);
                }
            }
            await this.refreshEffort(state);
            await this.refreshStats();
            if (this.turnNo) this.pushHistory([ev({ type: 'turn.end', turn: this.turnNo,
                reason: { kind: 'completed' }, time: Date.now(), cost: this.sessionCost })]);
            this.title = state.sessionName || this.title;
            const ready = [
                ev({ type: 'session.ready', sessionId: this.sessionId, cwd: this.cwd, model: this.modelId,
                    provider: this.providerId, contextWindow: this.contextWindow, title: this.title, effort: this.thinkingLevel }),
                ev({ type: 'mode.changed', modeId: 'Pi native' }),
            ];
            if (this.title) ready.push(ev({ type: 'session.title', title: this.title, source: state.sessionName ? 'user' : 'auto' }));
            this.emitLive(ready, { replay: false });
        } catch (error) {
            this.interactions.cancelAll({ respond: false });
            this.capabilities.infoStatus.close();
            await this.rpc.close();
            throw error;
        }
        this.setStatus('idle');
        if (this.interactions.hasPending()) this.setStatus('requires-action');
    }
    replayEntry(o) {
        if (o?.type === 'compaction' || o?.type === 'branch_summary') {
            // A checkpoint in the native file is settled history: show its summary
            // the same way a live compaction does.
            const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
            if (summary !== '') {
                this.pushHistory([ev({
                    type: 'user.message', id: `h-compact-${++this.seq}`, anchor: '', seq: this.seq,
                    turn: this.turnNo, time: Date.parse(o.timestamp) || Date.now(),
                    source: 'compaction', text: summary, blocks: [{ type: 'text', text: summary }],
                })]);
            }
            return;
        }
        if (o?.type !== 'message')
            return;
        const m = o.message;
        if (!m)
            return;
        const time = Date.parse(o.timestamp) || Date.now();
        const blocks = Array.isArray(m.content) ? m.content : [];
        const thinkingText = blocks.filter(block => block?.type === 'thinking')
            .map(block => block.thinking ?? block.text ?? '').join('\n');
        if (m.role === 'user') {
            if (this.turnNo) this.pushHistory([ev({ type: 'turn.end', turn: this.turnNo, reason: { kind: 'completed' }, time: Date.now() })]);
            this.turnNo += 1;
            this.stepNo = 0;
            this.toolSteps.clear();
            const text = messageText(m);
            this.pushHistory([
                ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time }),
                ev({ type: 'user.message', id: `h-u-${this.turnNo}`, anchor: o.id ?? '', seq: ++this.seq, turn: this.turnNo, time, source: 'user', text, blocks: [{ type: 'text', text }], images: piTranscriptImages(m.content, o.id ?? `h-u-${this.turnNo}`) }),
            ]);
            return;
        }
        if (m.role === 'assistant') {
            const text = messageText(m);
            if (text || thinkingText) {
                this.stepNo += 1;
                const att = `h-att-${this.turnNo}-${this.stepNo}`;
                this.pushHistory([this.assistantMessage(att, text, thinkingText, o.id, time, m.model)]);
            }
            this.pushHistory(this.usageEvents(m, time));
            for (const call of blocks.filter(block => block?.type === 'toolCall')) {
                this.pushHistory([this.toolCall(call.id, call.name, call.arguments, time)]);
            }
        } else if (m.role === 'toolResult') {
            this.pushHistory([this.toolResult(m.toolCallId, m, m.isError, time), ...this.toolState(m.toolCallId, m.toolName, m, true, m.isError, time)]);
        }
    }
    onEvent(e) {
        switch (e.type) {
        case 'message_update': {
            if (e.message && e.message.role !== 'assistant') return;
            const update = e.assistantMessageEvent;
            const kind = update?.type === 'text_delta' ? 'text'
                : update?.type === 'thinking_delta' ? 'reasoning' : undefined;
            if (kind && update.delta) {
                this.openIfNeeded();
                this.streamed.add(kind);
                this.emitDelta(kind, update.delta, update.contentIndex);
            }
            break;
        }
        case 'message_start':
            if (e.message?.role === 'user') this.onNativeUser(e.message);
            break;
        case 'message_end': this.onMessageEnd(e.message); break;
        case 'tool_execution_start':
            this.emitLive([this.toolCall(e.toolCallId, e.toolName, e.args)], { replay: false });
            break;
        case 'tool_execution_update': this.onToolUpdate(e); break;
        case 'tool_execution_end':
            this.emitLive([this.toolResult(e.toolCallId, e.result, e.isError),
                ...this.toolState(e.toolCallId, e.toolName, e.result, true, e.isError)], { replay: false });
            this.toolOutput.delete(e.toolCallId);
            break;
        }
    }
    emitDelta(kind, text, index = 0) {
        this.emitLive([ev({ type: 'assistant.delta', attemptId: this.curAttemptId, index, time: Date.now(),
            turn: this.turnNo, step: this.stepNo, delta: { kind, text } })], { replay: false, wake: 'frame' });
    }
    openIfNeeded() {
        if (this.curAttemptId)
            return;
        this.stepNo += 1;
        this.curAttemptId = `att${this.turnNo}_${this.stepNo}`;
        this.emitLive([
            ev({ type: 'step.start', turn: this.turnNo, step: this.stepNo, time: Date.now() }),
            ev({ type: 'assistant.attempt.start', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, model: this.modelId }),
        ], { replay: false });
    }
    closeAttempt() {
        if (!this.curAttemptId)
            return;
        this.emitLive([
            ev({ type: 'assistant.attempt.end', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, outcome: 'committed' }),
            ev({ type: 'step.end', turn: this.turnNo, step: this.stepNo, time: Date.now() }),
        ], { replay: false });
        this.curAttemptId = '';
        this.streamed.clear();
    }
    assistantMessage(attemptId, text, thinking, anchor = attemptId, time = Date.now(), model = this.modelId) {
        const blocks = [];
        if (thinking) blocks.push({ type: 'reasoning', text: thinking });
        if (text) blocks.push({ type: 'text', text });
        return ev({ type: 'assistant.message', seq: ++this.seq, anchor, attemptId, time,
            turn: this.turnNo, step: this.stepNo, model, blocks, canonical: true });
    }
    onMessageEnd(msg) {
        if (msg?.role !== 'assistant') return;
        const text = messageText(msg);
        const thinking = (Array.isArray(msg.content) ? msg.content : []).filter(block => block?.type === 'thinking')
            .map(block => block.thinking ?? block.text ?? '').join('\n');
        let anchor;
        if (text || thinking) {
            this.openIfNeeded();
            if (thinking && !this.streamed.has('reasoning')) this.emitDelta('reasoning', thinking);
            if (text && !this.streamed.has('text')) this.emitDelta('text', text);
            anchor = this.curAttemptId;
            this.emitLive([this.assistantMessage(anchor, text, thinking)], { replay: false });
        }
        this.activeTurn.assistants.push(anchor);
        this.emitLive(this.usageEvents(msg), { replay: false });
        this.closeAttempt();
    }
    usageEvents(message, time = Date.now()) {
        const { usage } = message;
        if (!usage || !(usage.totalTokens > 0 || usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) return [];
        return [ev({ type: 'usage', seq: ++this.seq, turn: this.turnNo, step: this.stepNo,
            model: message.model, time, usage: {
                input: usage.input ?? 0, output: usage.output ?? 0,
                cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
            } })];
    }
    toolCall(callId, name, args, time = Date.now()) {
        const step = ++this.stepNo;
        this.toolSteps.set(callId, { step, name, args });
        return ev({ type: 'tool.call', seq: ++this.seq, turn: this.turnNo, step, callId, name,
            argsJson: JSON.stringify(args ?? {}), presentation: piToolCall(name, args, this.cwd), time });
    }
    onToolUpdate(e) {
        this.emitLive(this.toolState(e.toolCallId, e.toolName, e.partialResult, false, false), { replay: false, wake: 'frame' });
        const text = messageText(e.partialResult);
        const previous = this.toolOutput.get(e.toolCallId) ?? '';
        this.toolOutput.set(e.toolCallId, text);
        const delta = text.startsWith(previous) ? text.slice(previous.length) : text ? '\n' + text : '';
        if (delta) this.emitLive([ev({ type: 'tool.output', callId: e.toolCallId, text: delta, time: Date.now() })],
            { replay: false, wake: 'frame' });
    }
    toolResult(callId, result, isError, time = Date.now()) {
        const call = this.toolSteps.get(callId);
        const text = messageText(result) || (typeof result?.structuredContent === 'string' ? result.structuredContent : '');
        return ev({ type: 'tool.result', seq: ++this.seq, turn: this.turnNo, step: call?.step ?? this.stepNo,
            callId, isError: Boolean(isError), time, content: text ? [{ type: 'text', text }] : [], text,
            images: piTranscriptImages(result?.content, callId),
            errorText: isError ? text : undefined, presentation: piToolResult(call?.name, call?.args, result, isError) });
    }
    toolState(id, name, result, final, isError, time = Date.now()) {
        name ||= this.toolSteps.get(id)?.name;
        if (name === 'subagent') return piSubagents(id, result?.details, this.childStates, time, final, isError);
        const todo = final && !isError && piTodos(name, result?.details);
        return todo ? [todo] : [];
    }
    emitPending(change = {}) {
        this.emitLive([{ type: 'pending.changed',
            items: this.queued.map(({ id, text, placement }) => ({ id, text, placement })), ...change }], { replay: false });
    }
    onNativeUser(message) {
        const turn = this.activeTurn;
        if (!turn.receivedInitialUser) {
            turn.receivedInitialUser = true;
            return;
        }
        const actual = messageText(message);
        const exact = this.queued.findIndex(entry => entry.message.trim() === actual.trim());
        const index = exact >= 0 ? exact : this.queued.findIndex(entry => entry.placement === 'steer');
        const queued = index >= 0 ? this.queued.splice(index, 1)[0] : this.queued.shift();
        if (!queued) return;
        const anchor = `pi-user-${randomUUID()}`;
        turn.userAnchors.push(anchor);
        this.emitPending({ claimed: [queued.id] });
        this.emitLive([{ type: 'user.message', id: queued.id, anchor, seq: ++this.seq,
            turn: this.turnNo, time: Date.now(), source: queued.placement === 'steer' ? 'injected' : 'user',
            label: queued.placement === 'steer' ? 'steering' : undefined, text: queued.text,
            blocks: [{ type: 'text', text: actual }], images: queued.images }], { replay: false });
    }
    async submitQueued(input, placement, message, images) {
        const queued = { id: input.clientMessageId, text: input.text, placement, message, images: input.images };
        this.queued.push(queued);
        this.emitPending();
        try {
            const response = await this.rpc.request(placement === 'steer' ? 'steer' : 'follow_up', { message, images });
            if (response?.disposition === 'handled' && this.queued.includes(queued)) {
                this.queued = this.queued.filter(item => item !== queued);
                this.emitPending({ claimed: [queued.id] });
            }
            return { accepted: true };
        } catch (error) {
            this.queued = this.queued.filter(item => item !== queued);
            this.emitPending({ discarded: [queued.id] });
            return { accepted: false, reason: error.message };
        }
    }
    setStatus(status) {
        this.status = status;
        this.emitLive([ev({ type: 'session.status', status })], { replay: false });
    }
    updateInteractionStatus(waiting) {
        if (this.status === 'starting' || this.status === 'disposed') return;
        const status = waiting ? 'requires-action' : this.activeTurn || this.branchCommandRunning ? 'running' : 'idle';
        if (status !== this.status) this.setStatus(status);
    }
    emitLive(batch, meta) {
        if (!batch.length) return;
        for (const e of batch) {
            if (!['assistant.delta', 'tool.output'].includes(e.type)) this.historyEvents.push(e);
        }
        if (this.listeners.size === 0) {
            this.earlyEvents.push(...batch);
            return;
        }
        for (const l of this.listeners)
            l(batch, meta);
    }
    async history() {
        return this.historyEvents;
    }
    /** Seed history without re-emitting to live listeners. */
    pushHistory(batch) {
        for (const e of batch)
            this.historyEvents.push(e);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        if (this.earlyEvents.length) {
            const flush = this.earlyEvents;
            this.earlyEvents = [];
            listener(flush, { replay: false });
        }
        return () => {
            this.listeners.delete(listener);
        };
    }
    async suggestFollowUp(signal) {
        const locale = this.host.locale?.() === 'zh' ? 'Chinese' : 'English';
        const { answer } = await this.capabilities.sideQuery.ask(
            `Predict one short follow-up message the user would naturally send next, in ${locale}. Write it from the user's perspective. Return one plain-text line under 140 characters, with no quotes or markup. If there is no clear follow-up, return NONE.`,
            { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        const text = answer?.trim();
        if (!text || text === 'NONE' || text.length > 160 || /^[!/`]/u.test(text)
            || /[\p{Cc}\u2028\u2029]/u.test(text)) return;
        return text;
    }
    async refreshBranch(previousLeaf) {
        const { entries, leafId } = await this.rpc.request('get_entries');
        if (previousLeaf === leafId || this.status === 'disposed') return false;
        await this.refreshRuntimeState(undefined, { emitCapacity: false });
        if (this.status === 'disposed') return false;
        this.emitLive([{ type: 'session.reset', trigger: 'pi-branch' }], { replay: false });
        this.historyEvents.length = 0;
        this.turnNo = 0;
        this.stepNo = 0;
        this.liveAnchors.clear();
        this.toolSteps.clear();
        this.childStates.clear();
        this.entryCursor = entries.at(-1)?.id;
        for (const entry of piBranch(entries, leafId)) this.replayEntry(entry);
        if (this.turnNo) this.pushHistory([{ type: 'turn.end', turn: this.turnNo,
            reason: { kind: 'completed' }, time: Date.now() }]);
        const history = [...this.historyEvents];
        for (const listener of this.listeners) listener(history, { replay: true });
        this.emitLive([{ type: 'session.ready', sessionId: this.sessionId, cwd: this.cwd,
            model: this.modelId, provider: this.providerId, contextWindow: this.contextWindow,
            title: this.title, effort: this.thinkingLevel }], { replay: false });
        await this.refreshStats();
        return true;
    }
    async runRestore(args) {
        const command = this.restoreCommand(await this.extensionCommands());
        if (!command) throw new Error(this.host.locale?.() === 'zh'
            ? '当前 Pi 扩展未提供检查点恢复命令' : 'No Pi extension provides checkpoint restore');
        const { leafId } = await this.rpc.request('get_entries');
        const bridge = '/' + bridgeCommand;
        await this.rpc.request('prompt', { message: bridge + ' prepare-restore' });
        try {
            await this.rpc.request('prompt', { message: '/' + command.name + (args ? ' ' + args : '') }, null);
        } finally {
            await this.rpc.request('prompt', { message: bridge + ' finish-restore' });
            await this.refreshBranch(leafId);
        }
    }
    async pickTreeEntry(rows, title, zh, leafId) {
        const selected = await this.interactions.select(randomUUID(), title, rows.map(row => row.label));
        const entry = rows.find(row => row.label === selected)?.entry;
        if (!entry || this.status === 'disposed') return;
        const rewind = zh ? '回退到此处并编辑消息' : 'Rewind here and edit message';
        const fork = zh ? '从此处派生会话' : 'Fork a session from here';
        const action = await this.interactions.select(randomUUID(), zh ? 'Pi 分支操作' : 'Pi branch action', [rewind, fork]);
        if (this.status === 'disposed') return;
        if (action === fork) return this.forkNotice(await this.forkSession(entry.id, undefined, false, true), zh);
        if (action === rewind) {
            await this.rpc.request('prompt', { message: `/${bridgeCommand} navigate ${entry.id}` }, null);
            if (await this.refreshBranch(leafId)) await this.promptInjector(messageText(entry.message));
        }
    }
    forkNotice(forked, zh) {
        return zh ? `已派生 Pi 会话。使用 /resume ${forked.sessionId} 打开。`
            : `Created a Pi branch. Open it with /resume ${forked.sessionId}.`;
    }
    async runLocalCommand(input, command, anchor, label) {
        this.emitLive([ev({ type: 'pending.changed', items: [], claimed: [input.clientMessageId] })], { replay: false });
        let text;
        let level = 'info';
        const zh = this.host.locale?.() === 'zh';
        const interactive = (command === 'tree' && !anchor) || command === 'restore';
        if (interactive) {
            this.branchCommandRunning = true;
            this.updateInteractionStatus(false);
        }
        try {
            if (command !== 'restore' && anchor && (command === 'suggest' || /\s/.test(anchor))) {
                throw new Error(zh ? `参数无效：${label}` : `Invalid arguments for ${label}`);
            }
            if (command === 'restore') {
                await this.runRestore(anchor);
            } else if (command === 'suggest') {
                const locale = zh ? 'Chinese' : 'English';
                const result = await this.capabilities.sideQuery.ask(
                    `Suggest 2 or 3 distinct next messages the user could send to advance this conversation. Write concise, copyable prompts in ${locale}.`);
                if (result.answer === null && !result.error) return { accepted: true };
                if (result.error) throw new Error(result.error);
                text = result.answer;
            } else if (command === 'fork') {
                text = this.forkNotice(await this.forkSession(anchor), zh);
            } else {
                const { entries, leafId } = await this.rpc.request('get_entries');
                const active = new Set(piBranch(entries, leafId).map(entry => entry.id));
                const branch = anchor ? piBranch(entries, anchor) : entries;
                if (anchor && branch.at(-1)?.id !== anchor) throw new Error(zh ? '找不到该 Pi 节点' : 'Pi tree entry was not found');
                const nearestUser = new Map();
                const rows = [];
                for (const entry of branch) {
                    const parent = nearestUser.get(entry.parentId);
                    const isUser = entry.message?.role === 'user';
                    nearestUser.set(entry.id, isUser ? entry.id : parent);
                    if (!isUser) continue;
                    const preview = piPlainText(messageText(entry.message)).replace(/\s+/g, ' ').slice(0, 65);
                    rows.push({ entry, label: `${active.has(entry.id) ? '●' : '○'} ${entry.id} ← ${parent ?? '∅'}  ${preview}` });
                }
                const title = zh ? 'Pi 会话树（● 当前分支，○ 其他分支）' : 'Pi session tree (● active branch, ○ other branch)';
                if (!rows.length) text = zh ? 'Pi 会话树暂无消息' : 'The Pi session tree has no messages yet.';
                else if (!anchor) text = await this.pickTreeEntry(rows, title, zh, leafId);
                else text = [title, ...rows.map(row => row.label)].join('\n');
            }
        } catch (error) {
            level = 'error';
            text = error.message;
        } finally {
            if (interactive) {
                this.branchCommandRunning = false;
                this.updateInteractionStatus(this.interactions.hasPending());
            }
        }
        if (text && this.status !== 'disposed') {
            const event = level === 'error' ? { type: 'notice', level, text } : {
                type: 'user.message', id: input.clientMessageId, anchor: '', seq: ++this.seq,
                turn: this.turnNo, time: Date.now(), source: 'command-output', displayLive: true,
                label, text, blocks: [{ type: 'text', text }],
            };
            this.emitLive([event], { replay: false });
        }
        return { accepted: true };
    }
    async submit(input, placement) {
        let text = input.text;
        let message = input.blocks?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') ?? text;
        const steer = /^\/steer(?:\s+|$)/i;
        if (steer.test(text.trimStart())) {
            text = text.trimStart().replace(steer, '').trim();
            message = message.trimStart().replace(steer, '').trim();
            if (!text) return { accepted: false, reason: 'Usage: /steer <message>' };
            if (!this.activeTurn) return { accepted: false, reason: 'Pi has no active turn to steer' };
            placement = 'steer';
            input = { ...input, text };
        }
        if (input.blocks?.some(block => !['text', 'image'].includes(block.type)) || input.attachments?.length) {
            return { accepted: false, reason: 'Pi supports text and image input' };
        }
        if (input.blocks?.some(block => block.type === 'image') && !input.images?.length) {
            return { accepted: false, reason: 'Pi image attachments could not be loaded' };
        }
        if (input.images?.length && this.acceptsImages === false) {
            return { accepted: false, reason: 'The selected Pi model does not support image input' };
        }
        let images;
        try { if (input.images?.length) images = await piImageInputs(input.images); }
        catch (error) { return { accepted: false, reason: error.message }; }
        const local = /^\/((?:pi-)?(?:suggest|tree|fork)|restore)(?:\s+([\s\S]+))?$/.exec(text.trim());
        if (local) {
            if (this.status !== 'idle' || this.compacting) return { accepted: false, reason: 'Pi session is not idle' };
            const [, name, anchor] = local;
            return this.runLocalCommand(input, commandAliases.get(name) ?? name, anchor, '/' + name);
        }
        const commandName = /^\/([^\s]+)/.exec(text.trim())?.[1];
        if (commandName === bridgeCommand) return { accepted: false, reason: 'This command is reserved for the Pi backend' };
        if (commandName && TUI_ONLY_COMMAND.test(commandName)) {
            return { accepted: false, reason: `/${commandName} is only available in Pi's own TUI` };
        }
        if (this.activeTurn && !this.activeTurn.settling && !this.activeTurn.cancelling && ['steer', 'followup'].includes(placement)) {
            return this.submitQueued(input, placement, message, images);
        }
        if (this.status !== 'idle' || this.activeTurn || this.compacting) {
            return { accepted: false, reason: 'Pi session is not idle', dropped: true };
        }
        let resolveTurn;
        const done = new Promise(resolve => { resolveTurn = resolve; });
        const anchor = `pi-user-${randomUUID()}`;
        const turn = { done, resolve: resolveTurn, cancelled: false, userAnchors: [anchor], assistants: [] };
        this.activeTurn = turn;
        this.turnNo += 1;
        this.stepNo = 0;
        this.toolSteps.clear();
        this.toolOutput.clear();
        this.childStates.clear();
        this.curAttemptId = '';
        this.emitPending({ claimed: [input.clientMessageId] });
        this.emitLive([
            ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time: Date.now() }),
            ev({ type: 'user.message', id: input.clientMessageId, anchor, seq: ++this.seq,
                turn: this.turnNo, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text: message }], images: input.images }),
        ], { replay: false });
        this.setStatus('running');
        try {
            const response = await this.rpc.request('prompt', { message, images });
            if (this.activeTurn === turn && response?.disposition === 'handled') {
                await this.settleTurn(turn, { kind: turn.cancelled ? 'aborted' : 'completed' });
            }
        } catch (error) {
            if (this.activeTurn === turn) {
                if (error.code === 'PI_RPC_TIMEOUT') {
                    this.setStatus('disposed');
                    this.capabilities.infoStatus.close();
                    this.interactions.cancelAll({ respond: false });
                    await this.rpc.close();
                }
                this.finishTurn({ kind: 'error', message: error.message });
            }
        }
        return { accepted: true };
    }
    onRecord(record) {
        if (record.type === 'extension_ui_request') {
            if (record.method === 'set_editor_text') {
                if (typeof record.text === 'string' && record.text !== '') void this.promptInjector(record.text);
                return;
            }
            if (record.method === 'setTitle' && typeof record.title === 'string') {
                const title = record.title.trim();
                if (title) {
                    this.title = title;
                    this.emitLive([ev({ type: 'session.title', title, source: 'auto' })], { replay: false });
                }
                return;
            }
            if (record.method === 'notify' && typeof record.message === 'string') {
                const level = ['warning', 'error'].includes(record.notifyType) ? record.notifyType : 'notice';
                this.emitLive([{ type: 'notice', level, text: record.message }], { replay: false });
            } else if (!this.interactions.handle(record)) this.capabilities.infoStatus.update(record);
            return;
        }
        if (record.type === 'thinking_level_changed') {
            this.updateThinkingLevel(record.level);
            return;
        }
        // Compaction runs outside a turn (manual `/compact`, or Pi's own automatic
        // boundary), so these are handled before the turn gate.
        if (record.type === 'compaction_start') {
            this.emitLive([ev({ type: 'compaction.start', trigger: record.reason === 'manual' ? 'manual' : 'auto', cancellable: false, time: Date.now() })], { replay: false });
            return;
        }
        if (record.type === 'compaction_end') {
            const result = record.result;
            const ok = result !== undefined && record.aborted !== true;
            this.emitLive([ev({
                    type: 'compaction.end',
                    ok,
                    ...(ok ? {
                        contextReplaced: true,
                        summary: typeof result.summary === 'string' ? result.summary : undefined,
                        preTokens: typeof result.tokensBefore === 'number' ? result.tokensBefore : undefined,
                        postTokens: typeof result.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : undefined,
                    } : {}),
                    ...(typeof record.errorMessage === 'string' && record.errorMessage !== '' ? { error: record.errorMessage } : {}),
                    time: Date.now(),
                })], { replay: false });
            if (ok && typeof result.estimatedTokensAfter === 'number') {
                // Pi reports null from get_context_stats until another assistant
                // settles after compaction. Publish its own post-compaction
                // estimate now so the footer does not keep the replaced value.
                this.emitContextUsage(result.estimatedTokensAfter);
            }
            if (ok && typeof result.summary === 'string' && result.summary.trim() !== '') {
                const summary = result.summary.trim();
                this.emitLive([ev({
                    type: 'user.message', id: `compact-${++this.seq}`, anchor: '', seq: this.seq,
                    turn: this.turnNo, time: Date.now(),
                    source: 'compaction', text: summary, blocks: [{ type: 'text', text: summary }],
                })], { replay: false });
            }
            return;
        }
        const turn = this.activeTurn;
        if (!turn) return;
        const message = record.type === 'message_end' && record.message;
        if (message?.role === 'assistant') {
            turn.error = message.stopReason === 'error' ? message.errorMessage || 'Pi provider failed' : undefined;
            turn.aborted = message.stopReason === 'aborted';
            if (message.model && (message.model !== this.modelId || message.provider !== this.providerId)) {
                this.setRoute(message.provider, message.model);
                this.emitLive([ev({ type: 'model.changed', model: this.modelId, provider: this.providerId, source: 'fallback' })], { replay: false });
            }
        }
        if (record.type === 'agent_settled') {
            const reason = record.aborted || turn.cancelled || turn.aborted ? { kind: 'aborted' }
                : turn.error ? { kind: 'error', message: turn.error } : { kind: 'completed' };
            void this.settleTurn(turn, reason);
        } else this.onEvent(record);
    }
    async settleTurn(turn, reason) {
        if (turn.settling) return;
        turn.settling = true;
        await Promise.all([
            this.refreshStats(),
            this.captureAnchors(turn),
            this.refreshRuntimeState().catch(error => this.host.debug?.(error.message)),
        ]);
        if (this.activeTurn === turn) this.finishTurn(turn.cancelled ? { kind: 'aborted' } : reason);
    }
    finishTurn(reason) {
        const turn = this.activeTurn;
        if (!turn) return;
        this.activeTurn = undefined;
        this.closeAttempt();
        if (this.queued.length) {
            const ids = this.queued.splice(0).map(item => item.id);
            this.emitPending(this.status === 'disposed' ? { discarded: ids } : { dropped: ids });
        }
        for (const [agentId, owner] of this.childStates) {
            if (owner !== 'ended') this.emitLive([{ type: 'subagent.end', agentId,
                status: reason.kind === 'aborted' ? 'cancelled' : 'unknown', time: Date.now() }], { replay: false });
        }
        this.emitLive([ev({ type: 'turn.end', turn: this.turnNo, reason, time: Date.now(), cost: this.sessionCost })], { replay: false });
        if (this.status !== 'disposed') {
            this.setStatus(this.interactions.hasPending() ? 'requires-action' : 'idle');
        }
        turn.resolve();
    }
    async cancel(cause) {
        const turn = this.activeTurn;
        if (!turn) {
            if (this.branchCommandRunning) this.interactions.cancelAll();
            return { stillQueued: [], outcome: 'confirmed' };
        }
        const covered = this.queued.map(item => item.id);
        turn.cancelling = true;
        try {
            this.interactions.cancelAll();
            if (cause !== 'user') {
                await this.rpc.request('clear_queue');
                const discarded = this.queued.splice(0).map(item => item.id);
                if (discarded.length) this.emitPending({ discarded });
            }
            turn.cancelled = true;
            await this.rpc.request('abort');
            await turn.done;
            return { stillQueued: [], outcome: 'confirmed' };
        } catch {
            return { stillQueued: this.queued.map(item => item.id), outcome: 'unknown' };
        } finally { turn.cancelling = false; }
    }
    async dispose() {
        this.status = 'disposed';
        this.sideQueries.abort();
        this.capabilities.infoStatus.close();
        this.interactions.cancelAll();
        this.listeners.clear();
        if (this.activeTurn) this.activeTurn.cancelled = true;
        await this.rpc?.close();
        this.finishTurn({ kind: 'aborted', cause: 'disposed' });
    }
}
export function piSessionPrefs(host) {
    const base = host.dataDir ?? join(host.cwd ?? process.cwd(), '.dsh-pi');
    const file = join(base, 'pi', 'sessions.json');
    const read = () => {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        }
        catch {
            return {};
        }
    };
    const write = (obj) => {
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(obj));
        }
        catch {
            /* non-fatal */
        }
    };
    return {
        lastSession() {
            return read().last;
        },
        setLastSession(sessionId) {
            const o = read();
            o.last = sessionId;
            write(o);
        },
        touch(_sessionId) {
            /* nothing to do */
        },
        forget(sessionId) {
            const o = read();
            delete o[sessionId];
            if (o.last === sessionId)
                delete o.last;
            write(o);
        },
    };
}
