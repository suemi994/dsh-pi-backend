import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PiCliSession, piSessionPrefs } from './session.js';
import { createPiCliCatalog, resolvePiSession } from './catalog.js';

const tuiPackage = '@deepseek-harness-tui/dsh-tui';

function tuiPackageRoot() {
    try {
        return new URL('.', import.meta.resolve(tuiPackage + '/package.json'));
    } catch {
        // A development checkout linked into a profile can resolve outside its node_modules.
        const profile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'dsh-tui');
        return pathToFileURL(join(profile, 'node_modules', tuiPackage, '/'));
    }
}

async function hasPromptSuggestionSupport(root) {
    try {
        const [policy, controls, composer] = await Promise.all([
            readFile(new URL('lib/types/adapter/channel/ui-policy.js', root), 'utf8'),
            readFile(new URL('lib/types/dsh-adapter/channel/core/session-controls.js', root), 'utf8'),
            readFile(new URL('lib/types/components/PromptInput.js', root), 'utf8'),
        ]);
        // These hooks also identify profile patches installed before this check was added.
        return policy.includes("'promptSuggestion'")
            && controls.includes('suggestFollowUp(session, current, event.turn)')
            && composer.includes('input-suggestion-accept')
            && composer.includes('setInput(visibleSuggestion.text,');
    } catch {
        return false;
    }
}

export const piCliManifest = {
    id: 'pi',
    label: { kind: 'literal', text: 'Pi' },
    shortLabel: 'Pi',
    inTree: false,
    backendExport: 'backend',
    capabilities: ['permissions', 'questions', 'models', 'effort', 'compact', 'sideQuery', 'commands', 'context', 'images', 'rename', 'fork', 'rewind'],
    grants: [],
};
export const piCliBackend = {
    id: 'pi',
    descriptor: { label: 'Pi (CLI)' },
    async detect(_host) {
        const result = spawnSync('pi', ['--version'], { timeout: 5000, encoding: 'utf8' });
        if (result.error || result.status !== 0) return { installed: false, hint: 'Install Pi and make pi available on PATH' };
        return { installed: true, auth: 'unknown', version: result.stdout.trim() || undefined };
    },
    async open(target, host) {
        let native;
        if (target.kind === 'resume') {
            native = await resolvePiSession(target.sessionId, target.cwd);
            if (!native) throw new Error(`Pi session not found: ${target.sessionId}`);
        }
        const session = new PiCliSession({ ...target, native }, host);
        await session.start();
        if (host.appVersion && !(await hasPromptSuggestionSupport(tuiPackageRoot()))) {
            const version = host.appVersion;
            const warning = host.locale?.() === 'zh'
                ? `dsh-tui ${version} 未检测到 Pi 自动建议的宿主支持。请应用与该版本匹配的宿主补丁，或用 /suggest 手动获取建议。`
                : `Pi automatic suggestion support was not detected in dsh-tui ${version}. Apply a compatible host patch or use /suggest for manual suggestions.`;
            session.emitLive([{ type: 'notice', level: 'warning', key: 'pi-prompt-suggestion-host', text: warning }], { replay: false });
        }
        return session;
    },
    launch: {
        sessionPrefs: (host) => piSessionPrefs(host),
        resumeCommand: (sessionId) => `dsh-tui --backend pi --resume ${sessionId}`,
    },
    catalog: createPiCliCatalog(),
};
