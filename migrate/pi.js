/**
 * Pi adapter: `<PI_CODING_AGENT_DIR>/sessions/--<munged-cwd>--/<timestamp>_<id>.jsonl`.
 * Discovery lives here; the session format is parsed by the pure pi.parse.ts.
 * The browse scan reads a head window for the header and first prompt and a
 * tail window for the latest `session_info` name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { piHeadInfo, piTailName, parsePiSession } from './pi.parse.js';
import { countEntries } from './scan.js';
import { fingerprintOf, loadText, readTail, runScan, walkFiles, withHead } from './scan-fs.js';
import { normalizeTitle } from '../parse/title.js';

const isSession = name => name.endsWith('.jsonl');
const WALK = { maxDepth: 3, match: isSession };

function absolute(path) {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return resolve(path);
}

/** Where Pi keeps sessions: the session-dir override, else the agent dir. */
function sessionRoots() {
    const override = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (override !== undefined && override.trim() !== '') return [absolute(override.trim())];
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    return [join(agentDir === undefined || agentDir.trim() === '' ? join(homedir(), '.pi', 'agent') : absolute(agentDir.trim()), 'sessions')];
}

function sourceIdOf(ref) {
    const match = /_([0-9A-Za-z][0-9A-Za-z._-]*[0-9A-Za-z])\.jsonl$/u.exec(ref);
    return match?.[1] ?? ref;
}

function readOne(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
    return parsePiSession({ raw, sourceId: sourceIdOf(path) });
}

async function summarize({ ref, fp }) {
    const head = await withHead(ref, fp.size, raw => piHeadInfo(raw));
    if (head === undefined) return null;
    let name;
    try {
        name = piTailName(await readTail(ref, 64 * 1024, fp.size));
    }
    catch {
        name = undefined;
    }
    const title = normalizeTitle(name ?? head.title);
    return {
        agentId: 'pi',
        sessionKey: head.id,
        ref,
        title,
        cwd: head.cwd,
        lastMessageAt: fp.mtimeMs,
        createdAt: head.timestamp || fp.mtimeMs,
    };
}

export const piAdapter = {
    id: 'pi',
    label: 'Pi',
    roots: sessionRoots,
    discover() {
        const roots = this.roots();
        const sessions = [];
        const walk = (dir, depth) => {
            if (depth > WALK.maxDepth) return;
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) walk(path, depth + 1);
                else if (entry.isFile() && isSession(entry.name)) {
                    try {
                        if (statSync(path).size > 64 * 1024 * 1024) continue;
                    }
                    catch {
                        continue;
                    }
                    const session = readOne(path);
                    if (session !== undefined) sessions.push(session);
                }
            }
        };
        for (const root of roots) walk(root, 0);
        return { roots, sessions };
    },
    count() {
        return countEntries(this.roots(), { maxDepth: WALK.maxDepth, fileMatch: isSession });
    },
    walk: WALK,
    async scan(options) {
        const files = walkFiles(this.roots(), { ...WALK, signal: options?.signal });
        return runScan(files, file => file.path, fingerprintOf, options, summarize);
    },
    async load(ref) {
        const raw = await loadText(ref);
        if (typeof raw !== 'string') return raw;
        return parsePiSession({ raw, sourceId: sourceIdOf(ref) }) ?? { skip: 'not-a-session' };
    },
};
