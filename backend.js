import { spawnSync } from 'node:child_process';
import { PiCliSession, piSessionPrefs } from './session.js';
import { createPiCliCatalog, resolvePiSession } from './catalog.js';
export const piCliManifest = {
    id: 'pi-cli',
    label: { kind: 'literal', text: 'Pi (CLI)' },
    shortLabel: 'Pi CLI',
    inTree: false,
    backendExport: 'backend',
    // The session serves `/model` off the `pi` CLI's own catalog; declaring it is
    // how dst admits the capability name and offers the command.
    capabilities: ['models', 'effort', 'compact'],
    grants: [],
};
export const piCliBackend = {
    id: 'pi-cli',
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
        return session;
    },
    launch: {
        sessionPrefs: (host) => piSessionPrefs(host),
        resumeCommand: (sessionId) => `dsh-tui --backend pi-cli --resume ${sessionId}`,
    },
    catalog: createPiCliCatalog(),
};
