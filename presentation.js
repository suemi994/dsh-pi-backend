import { messageText } from './catalog.js';

export function piToolCall(name, args, cwd) {
    if (name === 'bash' && typeof args?.command === 'string') {
        return { card: 'terminal', title: args.command, cwd, category: 'exec' };
    }
    if (name === 'write' && typeof args?.path === 'string' && typeof args.content === 'string') {
        return { card: 'diff', title: args.path, diffs: [{ path: args.path, oldText: null, newText: args.content }], category: 'mutate' };
    }
}

export function piToolResult(name, args, result, isError) {
    if (isError) return;
    if (name === 'bash' && typeof args?.command === 'string') {
        return { card: 'terminal', title: args.command, output: messageText(result), category: 'exec' };
    }
    if (name === 'read' && typeof args?.path === 'string') {
        const text = messageText(result);
        return { card: 'read', title: args.path, path: args.path, content: text ? [{ type: 'text', text }] : [] };
    }
    if (name === 'edit' && typeof args?.path === 'string') {
        const edits = Array.isArray(args.edits) ? args.edits : [args];
        const diffs = edits.filter(edit => typeof edit?.oldText === 'string' && typeof edit.newText === 'string')
            .map(edit => ({ path: args.path, oldText: edit.oldText, newText: edit.newText }));
        if (diffs.length === 1) return { card: 'diff', title: args.path, diffs, category: 'mutate' };
    }
}
