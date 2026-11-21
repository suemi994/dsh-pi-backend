import { messageText } from './catalog.js';
import { stripVTControlCharacters } from 'node:util';

const empty = [];

export function piPlainText(value) {
    return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}

function clean(value) {
    return piPlainText(value).slice(0, 500);
}

export function createPiExtensionState() {
    const values = new Map();
    const listeners = new Set();
    let rows = empty;
    const publish = () => { for (const listener of listeners) listener(); };
    return {
        getSnapshot: () => rows,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        update(record) {
            const status = record.method === 'setStatus';
            if (!status && record.method !== 'setWidget') return;
            const key = status ? record.statusKey : record.widgetKey;
            if (typeof key !== 'string' || !key) return;
            const id = (status ? 'status:' : 'widget:') + clean(key).slice(0, 100);
            const lines = status ? [record.statusText] : record.widgetLines;
            const text = (Array.isArray(lines) ? lines : []).filter(line => typeof line === 'string')
                .slice(0, 30).map(clean).join('\n');
            if (text) {
                if (values.size >= 32 && !values.has(id)) return;
                if (values.get(id) === text) return;
                values.set(id, text);
            } else if (!values.delete(id)) return;
            rows = [...values];
            publish();
        },
        close() {
            if (!values.size) return;
            values.clear();
            rows = empty;
            publish();
        },
    };
}

export function piTodos(name, details) {
    if (!['todo', 'todo_write', 'TodoWrite', 'update_plan'].includes(name)) return;
    return todoSnapshot(details);
}

export function piTodoEntry(entry) {
    if (entry?.type === 'custom' && entry.customType === 'rpiv-todo-state') return todoSnapshot(entry.data);
}

function todoSnapshot(details) {
    const rows = Array.isArray(details) ? details : details?.todos ?? details?.plan ?? details?.tasks;
    if (!Array.isArray(rows)) return;
    const items = [];
    for (const row of rows) {
        const content = row?.content ?? row?.text ?? row?.step ?? row?.subject;
        const status = typeof row?.done === 'boolean' ? row.done ? 'completed' : 'pending' : row?.status;
        if (status === 'deleted') continue;
        if (typeof content !== 'string' || !['pending', 'in_progress', 'completed'].includes(status)) return;
        items.push({ content, status });
    }
    return { type: 'todo.write', items };
}

function childOutcome(status) {
    switch (status) {
    case 'complete':
    case 'completed': return 'completed';
    case 'failed':
    case 'timed_out':
    case 'timeout': return 'failed';
    case 'aborted':
    case 'cancelled':
    case 'stopped':
    case 'paused': return 'cancelled';
    }
}

export function piSubagents(callId, details, active, time, final, isError) {
    const events = [];
    const results = Array.isArray(details) ? details : details?.results;
    if (Array.isArray(results)) results.forEach((row, index) => {
        if (typeof row?.agent !== 'string' || typeof row.task !== 'string') return;
        const agentId = `pi:${callId}:${row.index ?? index}`;
        const reported = row.status ?? row.progress?.status;
        if (active.get(agentId) === 'ended' || (reported === 'pending' && !final)) return;
        if (!active.has(agentId)) {
            active.set(agentId, callId);
            events.push({ type: 'subagent.start', agentId, parentCallId: callId,
                description: row.task || row.agent, kind: row.agent, model: row.model, background: false, depth: 1, time });
        }
        const usage = row.usage ? { input: row.usage.input, output: row.usage.output } : undefined;
        const messages = Array.isArray(row.messages) ? row.messages : [];
        const summary = row.errorMessage || row.error || row.finalOutput
            || messageText(messages.findLast(message => message?.role === 'assistant'));
        let status = childOutcome(reported);
        if (final && !status && !row.detached) {
            if (row.stopped || row.interrupted) status = 'cancelled';
            else if (row.timedOut || isError) status = 'failed';
            else if (Number.isInteger(row.exitCode)) status = row.exitCode === 0 ? 'completed' : 'failed';
        }
        if (status) {
            active.set(agentId, 'ended');
            events.push({ type: 'subagent.end', agentId, status, summary, usage, time });
        } else if (summary || usage) {
            events.push({ type: 'subagent.progress', agentId, summary, usage });
        }
    });
    if (final) {
        for (const [agentId, owner] of active) {
            if (owner !== callId) continue;
            active.set(agentId, 'ended');
            events.push({ type: 'subagent.end', agentId, status: isError ? 'failed' : 'unknown', time });
        }
    }
    return events;
}

export function piBackgroundStart(callId, args, details, runs, time) {
    const runId = details?.asyncId;
    if (typeof runId !== 'string' || runs.has(runId) || details.mode === 'management') return;
    if (details.results?.length || (!args?.async && details.background !== true && !details.runId)) return;
    const kind = typeof args?.agent === 'string' ? args.agent : 'subagent';
    const description = typeof args?.task === 'string' ? args.task : kind;
    const agentId = `pi:async:${runId}`;
    runs.set(runId, agentId);
    return { type: 'subagent.start', agentId, parentCallId: callId, description, kind,
        model: args?.options?.model ?? args?.model, background: true, depth: 1, time };
}

export function piBackgroundEnds(completions, runs, time) {
    if (!Array.isArray(completions)) return [];
    const events = [];
    for (const run of completions) {
        const agentId = runs.get(run?.runId);
        if (!agentId) continue;
        const status = childOutcome(run.status ?? run.state)
            ?? (typeof run.success === 'boolean' ? run.success ? 'completed' : 'failed' : 'unknown');
        runs.delete(run.runId);
        events.push({ type: 'subagent.end', agentId, status, time });
    }
    return events;
}
