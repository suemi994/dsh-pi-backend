import { piPlainText } from './extension-state.js';

const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor']);

function event(type, fields) {
    return { type, ...fields };
}

function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}

export class PiInteractions {
    constructor({ emit, send, onPendingChange, debug }) {
        this.emit = emit;
        this.send = send;
        this.onPendingChange = onPendingChange;
        this.debug = debug;
    }

    permissions = new Map();

    questions = new Map();

    handle(record) {
        if (!DIALOG_METHODS.has(record.method)) return false;
        if (record.method === 'confirm') this.openPermission(record);
        else this.openQuestion(record);
        return true;
    }

    select(requestId, title, options) {
        return new Promise(resolve => this.openQuestion({ id: requestId, method: 'select', title, options }, resolve));
    }

    openPermission(record) {
        const request = {
            requestId: record.id,
            toolName: 'Pi extension',
            displayName: record.title || 'Pi extension approval',
            title: record.title,
            description: record.message,
            defaultToNo: true,
            options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'reject', kind: 'reject' },
            ],
        };
        const entry = { request, timer: undefined };
        entry.timer = this.scheduleTimeout(record.timeout, () => {
            this.finishPermission(record.id, undefined, 'cancelled', false);
        });
        this.permissions.set(record.id, entry);
        this.emit([event('permission.request', { request })]);
        this.pendingChanged();
    }

    openQuestion(record, resolve) {
        const values = record.method === 'select' ? record.options ?? [] : [];
        let labels = values.map(value => value.split('\n').map(piPlainText).join('\n').trim());
        if (new Set(labels).size !== labels.length) {
            labels = labels.map((label, index) => `#${index + 1} ${label}`);
        }
        const detail = record.method === 'editor' && typeof record.prefill === 'string'
            ? `Starting value:\n${record.prefill}`
            : typeof record.placeholder === 'string' ? record.placeholder : undefined;
        const request = {
            requestId: record.id,
            questions: [{
                question: record.title || 'Pi extension question',
                ...(detail ? { detail } : {}),
                options: labels.map(label => ({ label })),
                ...(record.method === 'select' ? { hideCustomInput: true } : {}),
            }],
        };
        const entry = { request, resolve, choices: new Map(labels.map((label, index) => [label, values[index]])), timer: undefined };
        entry.timer = this.scheduleTimeout(record.timeout, () => {
            this.finishQuestion(record.id, undefined, false);
        });
        this.questions.set(record.id, entry);
        this.emit([event('question.request', { request })]);
        this.pendingChanged();
    }

    respondPermission(requestId, decision) {
        // Pi has no persistent approval scope. Refuse an unoffered allow-always
        // rather than report persistence the backend cannot provide.
        const confirmed = decision?.kind === 'allow-once';
        return this.finishPermission(requestId, confirmed, confirmed ? 'allow-once' : 'rejected', true);
    }

    pendingPermissions() {
        return [...this.permissions.values()].map(entry => entry.request);
    }

    respondQuestion(requestId, answers) {
        const entry = this.questions.get(requestId);
        if (entry === undefined) return false;
        const answer = answers?.answers?.[0];
        const selected = Array.isArray(answer?.selected) ? answer.selected : [];
        const custom = typeof answer?.custom === 'string' ? answer.custom : undefined;
        let value;
        if (custom !== undefined && custom !== '') value = custom;
        else if (selected.length > 0) value = entry.choices.get(selected[0]) ?? selected[0];
        else if (custom !== undefined) value = custom;
        else return this.finishQuestion(requestId, undefined, true);
        return this.finishQuestion(requestId, value, true);
    }

    cancelQuestion(requestId) {
        return this.finishQuestion(requestId, undefined, true);
    }

    cancelAll({ respond = true } = {}) {
        for (const requestId of [...this.permissions.keys()]) {
            this.finishPermission(requestId, undefined, 'cancelled', respond);
        }
        for (const requestId of [...this.questions.keys()]) {
            this.finishQuestion(requestId, undefined, respond);
        }
    }

    hasPending() {
        return this.permissions.size + this.questions.size > 0;
    }

    finishPermission(requestId, confirmed, outcome, respond) {
        const entry = this.permissions.get(requestId);
        if (entry === undefined) return false;
        clearTimeout(entry.timer);
        this.permissions.delete(requestId);
        if (respond) {
            this.sendResponse(confirmed === undefined
                ? { type: 'extension_ui_response', id: requestId, cancelled: true }
                : { type: 'extension_ui_response', id: requestId, confirmed });
        }
        this.emit([event('permission.settled', { requestId, outcome })]);
        this.pendingChanged();
        return true;
    }

    finishQuestion(requestId, value, respond) {
        const entry = this.questions.get(requestId);
        if (entry === undefined) return false;
        clearTimeout(entry.timer);
        this.questions.delete(requestId);
        if (entry.resolve) entry.resolve(respond ? value : undefined);
        else if (respond) {
            this.sendResponse(value === undefined
                ? { type: 'extension_ui_response', id: requestId, cancelled: true }
                : { type: 'extension_ui_response', id: requestId, value });
        }
        this.emit([event('question.settled', { requestId })]);
        this.pendingChanged();
        return true;
    }

    scheduleTimeout(timeout, onTimeout) {
        if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return undefined;
        const timer = setTimeout(onTimeout, timeout);
        timer.unref?.();
        return timer;
    }

    sendResponse(response) {
        try {
            this.send(response, error => {
                if (error) this.debug?.(`Pi interaction response failed: ${errorText(error)}`);
            });
        } catch (error) {
            this.debug?.(`Pi interaction response failed: ${errorText(error)}`);
        }
    }

    pendingChanged() {
        this.onPendingChange?.(this.permissions.size + this.questions.size > 0);
    }
}
