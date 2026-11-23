import { registerHooks } from 'node:module';

const codexBackendSuffix = '/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/backends/codex/backend.js';
const noiseDeclaration = 'const STDERR_NOISE = [/bubblewrap/iu, /could not create PATH aliases/iu];';
const activeWriterNoise = /\b(?:Failed to create session|failed to initialize thread persistence): thread-store conflict: thread [0-9a-f-]+ already has an active writer\b/iu;

registerHooks({
    load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (loaded.format !== 'module' || !url.startsWith('file:') || !url.endsWith(codexBackendSuffix)) {
            return loaded;
        }

        const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
        // Apply only to the known declaration. The hub still records both lines,
        // and the resume RPC still supplies the error if rejoining fails.
        const index = source.indexOf(noiseDeclaration);
        if (index === -1 || index !== source.lastIndexOf(noiseDeclaration)) {
            return loaded;
        }
        const patchedDeclaration = noiseDeclaration.replace('];', `, ${activeWriterNoise}];`);
        return { ...loaded, source: source.replace(noiseDeclaration, patchedDeclaration) };
    },
});
