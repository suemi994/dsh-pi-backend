/**
 * Pi session parsing (pure): one Pi JSONL session → one MigrationSession.
 *
 * Pi stores an append-only tree: a `session` header, then entries with
 * `id`/`parentId`. Only the active branch (last entry walked back to the root)
 * is the conversation; abandoned branches stay out. Message entries carry
 * Pi's AgentMessage shape (`user`, `assistant`, `toolResult`, `system`);
 * assistant blocks are `text`, `thinking` (reasoning) and `toolCall`, whose
 * results arrive in later `toolResult` entries and pair by call id.
 * `compaction` entries become native checkpoints, `session_info` names the
 * session, and `custom_message` entries are machine context for the next call.
 */
import { isRecord, parseJsonl } from '../parse/jsonl.js';
import { isInjectedText, unwrapUserText } from '../parse/injection.js';
import { emptyStats } from '../parse/role-turns.js';
import { normalizeTitle } from '../parse/title.js';
import { CallIndex, IMAGE_PLACEHOLDER, closeToolPairs, newStep } from '../parse/tools.js';

function toMillis(value) {
    return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}

/** Text of one message's content, with images as placeholders. */
function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER);
        else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
}

function thinkingText(content) {
    if (!Array.isArray(content)) return '';
    return content.filter(block => isRecord(block) && block.type === 'thinking')
        .map(block => typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '')
        .filter(text => text !== '').join('\n\n');
}

/** The active branch: walk from the last entry back through `parentId`. */
export function activeBranch(entries) {
    const byId = new Map();
    for (const entry of entries) {
        if (isRecord(entry) && typeof entry.id === 'string') byId.set(entry.id, entry);
    }
    if (byId.size === 0) return entries;
    const branch = [];
    const seen = new Set();
    let entry = [...entries].reverse().find(item => isRecord(item) && typeof item.id === 'string');
    while (entry !== undefined && !seen.has(entry.id)) {
        branch.push(entry);
        seen.add(entry.id);
        entry = typeof entry.parentId === 'string' ? byId.get(entry.parentId) : undefined;
    }
    return branch.reverse();
}

/**
 * Parse one Pi session file.
 * @returns The session, or undefined when it has no header cwd or no prompt.
 */
export function parsePiSession({ raw, sourceId }) {
    const { records, badLines } = parseJsonl(raw);
    const stats = { ...emptyStats(), badLines };
    const header = records.find(record => isRecord(record) && record.type === 'session');
    if (header === undefined || typeof header.cwd !== 'string' || header.cwd === '')
        return undefined;
    const id = typeof header.id === 'string' && header.id !== '' ? header.id : sourceId;
    const rest = records.filter(record => record !== header);
    const branch = activeBranch(rest);

    let turns = [];
    let current;
    let step;
    let model;
    let name;
    let startedAt = toMillis(header.timestamp);
    let pendingCompaction;
    let pendingInputs = [];
    let sawStep = false;
    const calls = new CallIndex();

    const openTurn = (prompt) => {
        if (prompt !== '') {
            stats.filtered += pendingInputs.length;
            pendingInputs = [];
        }
        current = pendingCompaction === undefined ? { prompt, steps: [] } : { prompt, compaction: pendingCompaction, steps: [] };
        pendingCompaction = undefined;
        turns.push(current);
        step = undefined;
        sawStep = false;
    };
    const modelStep = () => {
        if (current === undefined) openTurn('');
        if (step === undefined || sawStep) {
            step = newStep(model);
            step.inputs = pendingInputs;
            pendingInputs = [];
            current.steps.push(step);
            sawStep = false;
        }
        return step;
    };

    for (const entry of branch) {
        if (!isRecord(entry)) continue;
        const time = toMillis(entry.timestamp);
        if (startedAt === 0 && time !== 0) startedAt = time;
        switch (entry.type) {
            case 'session_info':
                if (typeof entry.name === 'string' && entry.name.trim() !== '') name = entry.name;
                break;
            case 'model_change':
                if (typeof entry.modelId === 'string' && entry.modelId !== '') model = entry.modelId;
                break;
            case 'compaction': {
                // Pi cut the window here: the summary is a native checkpoint before
                // the next turn, and the model no longer sees earlier entries.
                const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
                if (summary !== '') {
                    pendingCompaction = model === undefined ? { summary } : { summary, model };
                    current = undefined;
                    step = undefined;
                }
                break;
            }
            case 'branch_summary':
                if (typeof entry.summary === 'string' && entry.summary.trim() !== '') {
                    pendingInputs.push(entry.summary.trim());
                    stats.meta += 1;
                }
                break;
            case 'custom_message': {
                if (entry.display === false) break;
                const text = contentText(entry.content).trim();
                if (text !== '') {
                    pendingInputs.push(text);
                    stats.meta += 1;
                }
                break;
            }
            case 'context_edit':
                stats.filtered += 1;
                break;
            case 'message': {
                const message = entry.message;
                if (!isRecord(message)) break;
                if (typeof message.model === 'string' && message.model !== '') model = message.model;
                if (message.role === 'user') {
                    const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: contentText(message.content) }];
                    const texts = [];
                    for (const block of parts) {
                        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
                            if (isRecord(block) && block.type === 'image') texts.push(IMAGE_PLACEHOLDER);
                            continue;
                        }
                        if (isInjectedText(block.text)) {
                            stats.filtered += 1;
                            continue;
                        }
                        const text = unwrapUserText(block.text);
                        if (text !== '') texts.push(text);
                    }
                    const prompt = texts.join('\n\n').trim();
                    if (prompt === '') break;
                    openTurn(prompt);
                }
                else if (message.role === 'assistant') {
                    const text = contentText(message.content).trim();
                    const thinking = thinkingText(message.content);
                    const toolCalls = Array.isArray(message.content)
                        ? message.content.filter(block => isRecord(block) && block.type === 'toolCall')
                        : [];
                    if (text === '' && thinking === '' && toolCalls.length === 0) break;
                    const target = modelStep();
                    if (thinking !== '') target.blocks.push({ type: 'reasoning', text: thinking });
                    if (text !== '') target.blocks.push({ type: 'text', text });
                    for (const call of toolCalls) {
                        const id = typeof call.id === 'string' && call.id !== '' ? call.id : `pi-call-${stats.droppedToolResults + calls.stepOf.size + 1}`;
                        const name = typeof call.name === 'string' && call.name !== '' ? call.name : 'unknown';
                        const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
                        target.blocks.push({ type: 'tool-call', id, name, arguments: args });
                        calls.register(target);
                    }
                    sawStep = true;
                    if (message.stopReason === 'aborted' && current !== undefined) current.aborted = true;
                }
                else if (message.role === 'toolResult') {
                    if (typeof message.toolCallId !== 'string') {
                        calls.orphans += 1;
                        break;
                    }
                    calls.attach(message.toolCallId, contentText(message.content), message.isError === true);
                    sawStep = true;
                }
                else {
                    // `system` carries the prompt/tool snapshot at a compaction
                    // boundary; it is not a turn of its own.
                    stats.filtered += 1;
                }
                break;
            }
            default:
                break;
        }
    }

    stats.filtered += pendingInputs.length;
    if (pendingCompaction !== undefined) {
        turns.push({ prompt: '', compaction: pendingCompaction, steps: [] });
    }
    turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0 || turn.compaction !== undefined);
    stats.droppedToolResults = calls.orphans + closeToolPairs(turns);
    if (!turns.some(turn => turn.prompt !== ''))
        return undefined;

    const firstPrompt = turns.find(turn => turn.prompt !== '')?.prompt;
    const title = normalizeTitle(name ?? (firstPrompt === undefined ? undefined : unwrapUserText(firstPrompt)));
    return {
        sourceId: id,
        cwd: header.cwd,
        ...(title === '' ? {} : { title }),
        titleExplicit: name !== undefined,
        startedAt: startedAt || Date.now(),
        turns,
        stats,
    };
}

/** Header facts a browse scan needs, without parsing the whole file. */
export function piHeadInfo(raw) {
    const lines = raw.split('\n');
    let header;
    let prompt;
    for (const line of lines) {
        if (line.trim() === '') continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!isRecord(entry)) continue;
        if (entry.type === 'session' && header === undefined) {
            header = entry;
            continue;
        }
        if (prompt !== undefined) continue;
        if (entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user') {
            const blocks = Array.isArray(entry.message.content)
                ? entry.message.content
                : [{ type: 'text', text: contentText(entry.message.content) }];
            const texts = blocks.filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text).filter(text => !isInjectedText(text) && text.trim() !== '')
                .map(text => unwrapUserText(text)).filter(text => text !== '');
            if (texts.length > 0) prompt = texts.join('\n\n');
        }
    }
    if (header === undefined || typeof header.cwd !== 'string' || header.cwd === '') return undefined;
    const id = typeof header.id === 'string' && header.id !== '' ? header.id : undefined;
    if (id === undefined) return undefined;
    return { id, cwd: header.cwd, timestamp: toMillis(header.timestamp), title: prompt };
}

/** The last explicit session name in a tail window (`session_info`). */
export function piTailName(raw) {
    let name;
    for (const line of raw.split('\n')) {
        if (!line.includes('session_info')) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (isRecord(entry) && entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim() !== '') name = entry.name;
    }
    return name;
}
