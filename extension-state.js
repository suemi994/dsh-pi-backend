import { messageText } from './catalog.js';

const empty = [];

function clean(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 500);
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
    const rows = Array.isArray(details) ? details : details?.todos ?? details?.plan;
    if (!Array.isArray(rows)) return;
    const items = [];
    for (const row of rows) {
        const content = row?.content ?? row?.text ?? row?.step;
        const status = typeof row?.done === 'boolean' ? row.done ? 'completed' : 'pending' : row?.status;
        if (typeof content !== 'string' || !['pending', 'in_progress', 'completed'].includes(status)) return;
        items.push({ content, status });
    }
    return { type: 'todo.write', items };
}

export function piSubagents(callId, details, active, time, final, isError) {
    const events = [];
    const results = Array.isArray(details) ? details : details?.results;
    if (Array.isArray(results)) results.forEach((row, index) => {
        if (typeof row?.agent !== 'string' || typeof row.task !== 'string') return;
        const agentId = `pi:${callId}:${index}`;
        if (active.get(agentId) === 'ended' || (row.status === 'pending' && !final)) return;
        if (!active.has(agentId)) {
            active.set(agentId, callId);
            events.push({ type: 'subagent.start', agentId, parentCallId: callId,
                description: row.task || row.agent, kind: row.agent, model: row.model, background: false, depth: 1, time });
        }
        const usage = row.usage ? { input: row.usage.input, output: row.usage.output } : undefined;
        const messages = Array.isArray(row.messages) ? row.messages : [];
        const summary = row.errorMessage || messageText(messages.findLast(message => message?.role === 'assistant'));
        const status = { completed: 'completed', failed: 'failed', aborted: 'cancelled' }[row.status];
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
