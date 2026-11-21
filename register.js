import { piCliBackend, piCliManifest } from './backend.js';
import { piExtensionPanel } from './extension-state.js';

export const backend = piCliBackend;
export const manifest = piCliManifest;

export const name = 'pi-cli-panel';
export function apply(ctx) {
    return ctx?.get('tuiPanels')?.register({
        apiVersion: 1, id: 'extensions', title: 'Pi Extensions', icon: 'π', component: piExtensionPanel,
    });
}
