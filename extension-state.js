import { messageText } from './catalog.js';

const sessions = new Map();
const listeners = new Set();
const empty = [];
const publish = () => { for (const listener of listeners) listener(); };

function section(el, ui, key, title, rows, emptyText) {
    return [
        el(ui.Text, { key: `${key}:title`, bold: true, color: 'accent' }, title),
        ...(rows.length ? rows : [
            el(ui.Text, { key: `${key}:empty`, dimColor: true }, emptyText),
        ]),
    ];
}

export function piExtensionPanel({ React, ui, host, height }) {
    const { sessionId, lang, todos, subagents } = host.snapshot();
    const extensionRows = React.useSyncExternalStore(listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }, () => sessions.get(sessionId)?.rows ?? empty);
    const el = React.createElement;
    const zh = lang === 'zh';
    const todoRows = todos.map((todo, index) => el(ui.Text, { key: `todo:${index}` },
        `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'} ${clean(todo.content)}`));
    const subagentRows = subagents.map((subagent, index) => {
        const icon = subagent.status === 'completed' ? '✓'
            : subagent.status === 'failed' ? '×'
                : ['starting', 'running'].includes(subagent.status) ? '●' : '?';
        return el(ui.Text, { key: `subagent:${subagent.agentId || index}` },
            `${icon} ${clean(subagent.description || subagent.agentId || '')} · ${clean(subagent.status || 'unknown')}`);
    });
    return el(ui.ScrollBox, { flexDirection: 'column', maxHeight: height, paddingX: 1 },
        ...section(el, ui, 'extensions', zh ? 'Pi 扩展' : 'Pi extensions',
            extensionRows.map(([key, text]) => el(ui.Text, { key }, text)),
            zh ? '暂无 Pi 扩展状态' : 'No Pi extension status'),
        ...section(el, ui, 'todos', zh ? 'Todo' : 'Todo', todoRows,
            zh ? '暂无 Todo' : 'No todos'),
        ...section(el, ui, 'subagents', zh ? '子代理' : 'Subagents', subagentRows,
            zh ? '暂无子代理' : 'No subagents'));
}

function clean(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 500);
}

export function createPiExtensionState(sessionId) {
    const values = new Map();
    const state = { rows: empty };
    return {
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
                values.set(id, text);
            } else values.delete(id);
            state.rows = [...values];
            sessions.set(sessionId, state);
            publish();
        },
        close() {
            if (sessions.get(sessionId) !== state) return;
            sessions.delete(sessionId);
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
