import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

function absolute(path) {
    return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}

function storage(cwd, allProjects) {
    const override = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (override) return { dir: absolute(override), grouped: false };
    const root = join(absolute(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')), 'sessions');
    if (allProjects) return { dir: root, grouped: true };
    const key = absolute(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
    return { dir: join(root, `--${key}--`), grouped: false };
}

async function dirents(dir) {
    try { return await readdir(dir, { withFileTypes: true }); }
    catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
        throw error;
    }
}

function entries(text) {
    return text.split('\n').flatMap(line => {
        if (!line.trim()) return [];
        try {
            const entry = JSON.parse(line);
            return entry && typeof entry.type === 'string' ? [entry] : [];
        } catch { return []; }
    });
}

export function messageText(message) {
    if (typeof message?.content === 'string') return message.content;
    return Array.isArray(message?.content)
        ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
        : '';
}

const WINDOW = 64 * 1024;
async function describe(path, cwd) {
    let file;
    try {
        file = await open(path, 'r');
        const stat = await file.stat();
        if (!stat.isFile() || !stat.size) return;
        const readWindow = async position => {
            const buffer = Buffer.alloc(Math.min(WINDOW, stat.size - position));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            return buffer.toString('utf8', 0, bytesRead);
        };
        const head = await readWindow(0);
        const first = entries(stat.size <= WINDOW ? head : head.slice(0, head.lastIndexOf('\n') + 1));
        const header = first[0];
        if (header?.type !== 'session' || typeof header.id !== 'string' ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header.id) ||
            typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) return;
        if (cwd && absolute(header.cwd) !== absolute(cwd)) return;
        let tail = first;
        if (stat.size > WINDOW) {
            const trailing = await readWindow(stat.size - WINDOW);
            tail = entries(trailing.slice(trailing.indexOf('\n') + 1));
        }
        const name = tail.findLast(entry => entry.type === 'session_info');
        const title = (typeof name?.name === 'string' ? name.name : '').trim();
        const prompt = first.find(entry => entry.type === 'message' && entry.message?.role === 'user');
        const model = tail.findLast(entry => entry.type === 'model_change' ||
            (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.model));
        const promptText = messageText(prompt?.message).replace(/\s+/g, ' ').trim();
        return {
            path,
            summary: {
                id: header.id, backendId: 'pi', kind: { kind: 'root' },
                title: { text: (title || promptText || basename(header.cwd) || header.cwd).slice(0, 160),
                    source: title ? 'renamed' : promptText ? 'prompt' : 'fallback' },
                cwd: header.cwd, createdAt: Date.parse(header.timestamp) || stat.mtimeMs,
                updatedAt: stat.mtimeMs, bytes: stat.size, hasPrompt: Boolean(prompt) || stat.size > WINDOW,
                model: model?.modelId ?? model?.message?.model,
                agentPreset: undefined, label: undefined, branch: undefined, childCount: 0,
            },
        };
    } catch (error) {
        if (!['ENOENT', 'EACCES', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
    } finally { await file?.close(); }
}

async function scan(scope = {}, onPartial) {
    const cwd = scope.cwd ?? process.cwd();
    const { dir, grouped } = storage(cwd, scope.allProjects);
    const dirs = grouped
        ? (await dirents(dir)).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(dir, entry.name))
        : [dir];
    const paths = [];
    for (const folder of dirs) {
        for (const entry of await dirents(folder)) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(join(folder, entry.name));
        }
    }
    const rows = [];
    const sorted = () => rows.toSorted((a, b) => b.summary.updatedAt - a.summary.updatedAt || a.path.localeCompare(b.path));
    for (let i = 0; i < paths.length; i += 24) {
        const batch = await Promise.all(paths.slice(i, i + 24).map(path => describe(path, scope.allProjects ? undefined : cwd)));
        rows.push(...batch.filter(Boolean));
        if (onPartial && (i === 0 || i % 240 === 0)) onPartial(sorted().map(row => row.summary));
    }
    return sorted();
}

export async function resolvePiSession(id, cwd) {
    const rows = await scan(cwd ? { cwd } : { allProjects: true });
    const matches = rows.filter(row => row.summary.id === id);
    const unique = new Map();
    for (const row of matches) unique.set(await realpath(row.path), row);
    if (unique.size > 1) throw new Error(`Pi session ID is ambiguous: ${id}`);
    return unique.values().next().value;
}

export async function requirePiSessionFile(path, id, cwd) {
    const row = await describe(path, cwd);
    if (row?.summary.id !== id) throw new Error(`Pi session file is missing or changed: ${path}`);
}

export async function readPiBranch(path) {
    const [, ...all] = entries(await readFile(path, 'utf8'));
    return piBranch(all, all.findLast(item => typeof item.id === 'string')?.id);
}

export function piBranch(all, leafId) {
    const byId = new Map(all.filter(entry => typeof entry.id === 'string').map(entry => [entry.id, entry]));
    if (!byId.size) return all;
    const branch = [];
    const seen = new Set();
    let entry = byId.get(leafId);
    while (entry && !seen.has(entry.id)) {
        branch.push(entry);
        seen.add(entry.id);
        entry = byId.get(entry.parentId);
    }
    return branch.reverse();
}

// Pi's RPC fork/clone switches its active session. Persist a native child
// directly so a dsh-tui fork leaves the original RPC session bound.
export async function writePiFork(path, sessionId, cwd, branch, title) {
    const source = await open(path, 'r');
    let parent;
    try {
        const buffer = Buffer.alloc(WINDOW);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
        const head = buffer.toString('utf8', 0, bytesRead);
        [parent] = entries(head.slice(0, head.indexOf('\n') + 1));
    } finally { await source.close(); }
    if (parent?.type !== 'session' || parent.id !== sessionId) throw new Error('Pi session file changed');
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const header = { ...parent, id, cwd, timestamp, parentSession: path };
    const copied = branch.slice();
    if (title) copied.push({
        type: 'session_info', id: randomUUID().slice(0, 8),
        parentId: copied.at(-1)?.id ?? null, timestamp, name: title,
    });
    const destination = join(dirname(path), `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
    const temporary = `${destination}.tmp`;
    const data = [header, ...copied].map(entry => JSON.stringify(entry)).join('\n') + '\n';
    const output = await open(temporary, 'wx', 0o600);
    try {
        try { await output.writeFile(data); }
        finally { await output.close(); }
        await rename(temporary, destination);
    } finally { await unlink(temporary).catch(() => {}); }
    return { backendId: 'pi', sessionId: id };
}

async function removePiSessionFile(path) {
    const result = spawnSync('trash', path.startsWith('-') ? ['--', path] : [path], {
        encoding: 'utf8', timeout: 10_000,
    });
    if (result.status === 0 || !existsSync(path)) return;
    try {
        await unlink(path);
    } catch (error) {
        const stderr = result.stderr?.trim().split(/\r?\n/)[0];
        const hint = [result.error?.message, stderr].filter(Boolean).join(' · ');
        throw new Error(`${error.message}${hint ? ` (trash: ${hint})` : ''}`, { cause: error });
    }
}

export function createPiCliCatalog() {
    return {
        async list(scope, onPartial) { return (await scan(scope, onPartial)).map(row => row.summary); },
        async info(id, cwd) { return (await resolvePiSession(id, cwd))?.summary; },
        async preview(id, { cwd, limit = 8 } = {}) {
            const row = await resolvePiSession(id, cwd);
            if (!row || limit <= 0) return [];
            return (await readPiBranch(row.path)).flatMap(entry => {
                const role = entry.type === 'message' && entry.message?.role;
                if (role !== 'user' && role !== 'assistant') return [];
                const text = messageText(entry.message);
                return text ? [{ role, text: text.slice(0, 2000), at: Date.parse(entry.timestamp) || undefined }] : [];
            }).slice(-limit);
        },
        async delete(id, cwd) {
            const row = await resolvePiSession(id, cwd);
            if (!row) throw new Error(`Pi session not found: ${id}`);
            const path = await realpath(row.path);
            if (!path.endsWith('.jsonl')) throw new Error(`Not a Pi session file: ${path}`);
            await requirePiSessionFile(path, id, cwd);
            await removePiSessionFile(path);
        },
    };
}
