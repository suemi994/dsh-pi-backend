import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { readPiBranch, messageText, requirePiSessionFile } from './catalog.js';
import { dirname, join } from 'node:path';
import { modelSpec } from './catalog-models.js';
import { PiRpc } from './rpc.js';
function ev(e) {
    return e;
}
export class PiCliSession {
    backendId = 'pi-cli';
    sessionId;
    ref;
    /** `models` is what makes dst offer `/model`; without it the command is
     *  refused as backend-unavailable and no picker opens. */
    capabilities = {
        native: {},
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
                    await this.refreshEffort();
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
    modelSpec;
    /** The route apart as dst asks it back; `modelSpec` is what `pi` takes. */
    providerId = '';
    modelId = '';
    status = 'starting';
    seq = 0;
    turnNo = 0;
    stepNo = 0;
    curAttemptId = '';
    lastUsage = -1;
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
        this.ref = { backendId: 'pi-cli', sessionId: sid };
        this.sessionFile = target.native?.path;
        this.modelOverride = process.env.PI_MODEL || undefined;
        this.modelSpec = this.modelOverride ?? '';
        this.setRouteFromSpec();
    }
    /** `modelSpec` is the one source; the split is recorded for `current()`. */
    setRouteFromSpec() {
        const slash = this.modelSpec.indexOf('/');
        this.providerId = slash < 0 ? this.modelSpec : this.modelSpec.slice(0, slash);
        this.modelId = slash < 0 ? this.modelSpec : this.modelSpec.slice(slash + 1);
    }
    setRoute(provider, id) {
        this.providerId = provider;
        this.modelId = id;
        this.modelSpec = modelSpec(provider, id);
    }
    async runCompact() {
        if (this.status !== 'idle' || this.activeTurn) throw new Error('Pi is running a turn; compact after it finishes');
        if (this.rpc === undefined) throw new Error('Pi session is not open');
        // Pi aborts any in-flight work itself and summarizes the active branch.
        await this.rpc.request('compact', {}, 600_000);
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
            if (this.turnNo) this.pushHistory([ev({ type: 'turn.end', turn: this.turnNo, reason: { kind: 'completed' }, time: Date.now() })]);
        }
        const args = ['--mode', 'rpc'];
        if (this.sessionFile) args.push('--session', this.sessionFile);
        else args.push('--session-id', this.piSessionId);
        if (this.modelOverride) args.push('--model', this.modelOverride);
        this.rpc = new PiRpc(args, this.cwd, record => this.onRecord(record), (error, closing) => {
            if (closing || this.status === 'disposed') return;
            if (this.activeTurn) this.finishTurn({ kind: 'error', message: error.message });
            if (this.status !== 'starting') {
                this.setStatus('disposed');
                this.host.warn(error.message);
            }
        });
        try {
            const state = await this.rpc.request('get_state');
            if (state.sessionId !== this.sessionId) throw new Error('Pi RPC opened a different session');
            if (state.model) {
                this.setRoute(state.model.provider, state.model.id);
                this.contextWindow = state.model.contextWindow;
            }
            await this.refreshEffort(state);
        } catch (error) {
            await this.rpc.close();
            throw error;
        }
        this.emitLive([ev({ type: 'session.ready', sessionId: this.sessionId, cwd: this.cwd, model: this.modelSpec, provider: this.providerId })], { replay: false });
        this.setStatus('idle');
    }
    replayEntry(o) {
        if (o?.type === 'compaction') {
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
                ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time: Date.now() }),
                ev({ type: 'user.message', id: `h-u-${this.turnNo}`, anchor: '', seq: ++this.seq, turn: this.turnNo, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] }),
            ]);
            return;
        }
        if (m.role === 'assistant') {
            for (const tc of blocks.filter((b) => b?.type === 'toolCall')) {
                this.stepNo += 1;
                this.toolSteps.set(tc.id, this.stepNo);
                this.pushHistory([
                    ev({
                        type: 'tool.call',
                        seq: ++this.seq,
                        turn: this.turnNo,
                        step: this.stepNo,
                        callId: tc.id,
                        name: tc.name,
                        argsJson: JSON.stringify(tc.arguments ?? {}),
                        time: Date.now(),
                    }),
                ]);
            }
            const text = messageText(m);
            const thinking = thinkingText;
            if (!text && !thinking)
                return;
            this.stepNo += 1;
            const att = `h-att-${this.turnNo}-${this.stepNo}`;
            const steps = [ev({ type: 'assistant.attempt.start', attemptId: att, turn: this.turnNo, step: this.stepNo, model: this.modelSpec })];
            if (thinking)
                steps.push(ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'reasoning', text: thinking } }));
            if (text)
                steps.push(ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'text', text } }));
            steps.push(this.assistantMessage(att, text, thinking, o.id, Date.parse(o.timestamp) || Date.now()));
            steps.push(ev({ type: 'assistant.attempt.end', attemptId: att, turn: this.turnNo, step: this.stepNo, outcome: 'committed' }));
            this.pushHistory(steps);
            return;
        }
        if (m.role === 'toolResult') {
            const step = this.toolSteps.get(m.toolCallId) ?? this.stepNo;
            const out = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
            this.pushHistory([
                ev({ type: 'tool.result', seq: ++this.seq, turn: this.turnNo, step, callId: m.toolCallId, isError: !!m.isError, time: Date.now(), content: [], text: out }),
            ]);
        }
    }
    onEvent(e) {
        const t = e?.type;
        if (t === 'message_end') {
            this.onMessageEnd(e);
        }
        else if (t === 'tool_execution_start') {
            this.onToolStart(e);
        }
        else if (t === 'tool_execution_update') {
            this.onToolUpdate(e);
        }
        else if (t === 'tool_execution_end') {
            this.onToolEnd(e);
        }
        else if (t === 'message_update' && e.usage) {
            this.onUsage(e.usage);
        }
        // turn_start / turn_end / agent_* are synthesized locally; ignored here.
    }
    openIfNeeded() {
        if (this.curAttemptId)
            return;
        this.stepNo += 1;
        this.curAttemptId = `att${this.turnNo}_${this.stepNo}`;
        this.emitLive([ev({ type: 'assistant.attempt.start', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, model: this.modelSpec })], { replay: false });
    }
    closeAttempt() {
        if (!this.curAttemptId)
            return;
        this.emitLive([ev({ type: 'assistant.attempt.end', attemptId: this.curAttemptId, turn: this.turnNo, step: this.stepNo, outcome: 'committed' })], { replay: false });
        this.curAttemptId = '';
    }
    assistantMessage(attemptId, text, thinking, anchor = attemptId, time = Date.now()) {
        const blocks = [];
        if (thinking) blocks.push({ type: 'reasoning', text: thinking });
        if (text) blocks.push({ type: 'text', text });
        return ev({ type: 'assistant.message', seq: ++this.seq, anchor, attemptId, time,
            turn: this.turnNo, step: this.stepNo, model: this.modelSpec, blocks, canonical: true });
    }
    onMessageEnd(e) {
        // Use Pi's final message blocks as the canonical transcript entry.
        const msg = e?.message;
        if (!msg || msg.role !== 'assistant')
            return;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        const thinking = blocks.filter(block => block?.type === 'thinking')
            .map(block => block.thinking ?? block.text ?? '').join('\n');
        if (!text && !thinking)
            return;
        this.openIfNeeded();
        const att = this.curAttemptId;
        if (thinking)
            this.emitLive([ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'reasoning', text: thinking } })], { replay: false });
        if (text)
            this.emitLive([ev({ type: 'assistant.delta', attemptId: att, index: 0, time: Date.now(), turn: this.turnNo, step: this.stepNo, delta: { kind: 'text', text } })], { replay: false });
        this.emitLive([this.assistantMessage(att, text, thinking)], { replay: false });
        this.closeAttempt();
    }
    onToolStart(e) {
        this.stepNo += 1;
        this.toolSteps.set(e.toolCallId, this.stepNo);
        this.toolOutput.set(e.toolCallId, '');
        this.emitLive([ev({
                type: 'tool.call',
                seq: ++this.seq,
                turn: this.turnNo,
                step: this.stepNo,
                callId: e.toolCallId,
                name: e.toolName,
                argsJson: JSON.stringify(e.args ?? {}),
                time: Date.now(),
            })], { replay: false });
        // A tool closes the current reasoning/text attempt so text after the tool opens a new step.
        this.curAttemptId = '';
    }
    onToolUpdate(e) {
        const cur = this.toolOutput.get(e.toolCallId) ?? '';
        const o = e.output;
        let next = cur;
        if (o) {
            if ('set' in o && o.set !== undefined)
                next = o.set;
            else if (typeof o.append === 'string')
                next += o.append;
        }
        this.toolOutput.set(e.toolCallId, next);
    }
    onToolEnd(e) {
        const step = this.toolSteps.get(e.toolCallId) ?? this.stepNo;
        const res = e.result;
        let out = '';
        if (res) {
            if (typeof res.structuredContent === 'string')
                out = res.structuredContent;
            else if (Array.isArray(res.content))
                out = res.content.map((b) => b?.text ?? '').join('');
        }
        this.emitLive([ev({
                type: 'tool.result',
                seq: ++this.seq,
                turn: this.turnNo,
                step,
                callId: e.toolCallId,
                isError: !!e.isError,
                time: Date.now(),
                content: [],
                text: out,
            })], { replay: false });
    }
    onUsage(u) {
        const input = (u?.input ?? 0) + (u?.cacheRead ?? 0);
        const output = u?.output ?? 0;
        // pi repeats the same usage on every message_update; emit only on change.
        const used = input + output;
        if (used === this.lastUsage)
            return;
        this.lastUsage = used;
        if (this.contextWindow) this.emitLive([ev({ type: 'context.usage', used, max: this.contextWindow })], { replay: false });
    }
    setStatus(status) {
        this.status = status;
        this.emitLive([ev({ type: 'session.status', status })], { replay: false });
    }
    emitLive(batch, meta) {
        for (const e of batch)
            this.historyEvents.push(e);
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
    async submit(input, _placement) {
        if (this.status !== 'idle' || this.activeTurn)
            return { accepted: false, reason: 'Pi session is not idle' };
        if (input.blocks?.some(block => block.type !== 'text') || input.images?.length || input.attachments?.length)
            return { accepted: false, reason: 'Pi CLI backend currently accepts text only' };
        let resolveTurn;
        const done = new Promise(resolve => { resolveTurn = resolve; });
        const turn = { done, resolve: resolveTurn, cancelled: false };
        this.activeTurn = turn;
        this.turnNo += 1;
        this.stepNo = 0;
        this.toolSteps.clear();
        this.toolOutput.clear();
        this.curAttemptId = '';
        const text = input.text;
        this.emitLive([
            ev({ type: 'pending.changed', items: [], claimed: [input.clientMessageId] }),
            ev({ type: 'turn.start', turn: this.turnNo, origin: 'user', time: Date.now() }),
            ev({ type: 'user.message', id: input.clientMessageId, anchor: '', seq: ++this.seq,
                turn: this.turnNo, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] }),
        ], { replay: false });
        this.setStatus('running');
        try {
            const response = await this.rpc.request('prompt', { message: text });
            if (this.activeTurn === turn && response?.disposition === 'handled') {
                this.finishTurn({ kind: turn.cancelled ? 'aborted' : 'completed' });
            }
        } catch (error) {
            if (this.activeTurn === turn) {
                if (error.code === 'PI_RPC_TIMEOUT') {
                    this.setStatus('disposed');
                    await this.rpc.close();
                }
                this.finishTurn({ kind: 'error', message: error.message });
            }
        }
        await done;
        return { accepted: true };
    }
    onRecord(record) {
        if (record.type === 'extension_ui_request') {
            // Dismiss dialogs without approving an action the frontend cannot display.
            if (['select', 'confirm', 'input', 'editor'].includes(record.method)) {
                this.rpc.send({ type: 'extension_ui_response', id: record.id, cancelled: true }, () => {});
            }
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
            if (message.model) this.setRoute(message.provider, message.model);
        }
        if (record.type === 'agent_settled') {
            const reason = turn.cancelled || turn.aborted ? { kind: 'aborted' }
                : turn.error ? { kind: 'error', message: turn.error } : { kind: 'completed' };
            this.finishTurn(reason);
        } else this.onEvent(record);
    }
    finishTurn(reason) {
        const turn = this.activeTurn;
        if (!turn) return;
        this.activeTurn = undefined;
        this.closeAttempt();
        this.emitLive([ev({ type: 'turn.end', turn: this.turnNo, reason, time: Date.now() })], { replay: false });
        if (this.status !== 'disposed') this.setStatus('idle');
        turn.resolve();
    }
    async cancel(_cause) {
        const turn = this.activeTurn;
        if (!turn) return { stillQueued: [], outcome: 'confirmed' };
        turn.cancelled = true;
        try {
            await this.rpc.request('abort');
            await turn.done;
            return { stillQueued: [], outcome: 'confirmed' };
        } catch {
            return { stillQueued: [], outcome: 'unknown' };
        }
    }
    async dispose() {
        this.status = 'disposed';
        this.listeners.clear();
        if (this.activeTurn) this.activeTurn.cancelled = true;
        await this.rpc?.close();
        this.finishTurn({ kind: 'aborted', cause: 'disposed' });
    }
}
export function piSessionPrefs(host) {
    const base = host.dataDir ?? join(host.cwd ?? process.cwd(), '.dsh-pi-cli');
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
