#!/usr/bin/env node
/**
 * Install (or remove) the Pi migration adapter in an installed dsh-tui.
 *
 * dsh-tui has no public seam for migration sources: `MIGRATION_ADAPTERS` is a
 * fixed list in its core. So this script applies the adapter through pnpm's
 * patch mechanism (`pnpm patch` → copy → `pnpm patch-commit`), which survives
 * reinstalls of the same version and is recorded in the profile's
 * `pnpm.patchedDependencies`.
 *
 * An upgrade to another dsh-tui version invalidates the patch (pnpm refuses to
 * apply a patch built for a different version), so re-run this script after
 * `dsh-tui update`.
 *
 *   node pi-agent/dsh-backend-pi-cli/migrate/apply.mjs            # install
 *   node pi-agent/dsh-backend-pi-cli/migrate/apply.mjs --revert   # remove
 *   node pi-agent/dsh-backend-pi-cli/migrate/apply.mjs --profile /path/to/profile
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argOf = name => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
};
const packageName = '@deepseek-harness-tui/dsh-tui';
const dshHome = process.env.DSH_HOME?.trim() || join(process.env.HOME ?? '', '.dsh');
const profile = resolve(argOf('--profile') ?? join(dshHome, 'profiles', 'dsh-tui'));
const revert = process.argv.includes('--revert');

if (!existsSync(join(profile, 'package.json'))) {
    console.error(`not a dsh profile: ${profile}`);
    process.exit(1);
}
const pnpm = (...args) => execFileSync('pnpm', args, { cwd: profile, stdio: 'inherit' });
const installedVersion = () => {
    const manifest = JSON.parse(readFileSync(join(profile, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8'));
    return manifest.version;
};

if (revert) {
    const key = `${packageName}@${installedVersion()}`;
    const manifestPath = join(profile, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const patches = manifest.pnpm?.patchedDependencies ?? {};
    if (patches[key] !== undefined) {
        delete patches[key];
        if (Object.keys(patches).length === 0) delete manifest.pnpm.patchedDependencies;
        if (manifest.pnpm !== undefined && Object.keys(manifest.pnpm).length === 0) delete manifest.pnpm;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    // pnpm records patches in pnpm-workspace.yaml (and the resolved hash in the
    // lockfile); leaving either behind makes the next install demand a file
    // this script is about to delete. Clear all three, install, then delete.
    const stripBlock = (file, header) => {
        if (!existsSync(file)) return;
        const lines = readFileSync(file, 'utf8').split('\n');
        const out = [];
        let skipping = false;
        for (const line of lines) {
            if (line.startsWith(`${header}:`)) { skipping = true; continue; }
            if (skipping) {
                if (line.startsWith(' ') || line.trim() === '') continue;
                skipping = false;
            }
            out.push(line);
        }
        writeFileSync(file, `${out.join('\n').replace(/\n+$/, '')}\n`);
    };
    stripBlock(join(profile, 'pnpm-workspace.yaml'), 'patchedDependencies');
    stripBlock(join(profile, 'pnpm-lock.yaml'), 'patchedDependencies');
    pnpm('install', '--force');
    if (existsSync(join(profile, 'patches'))) {
        for (const file of readdirSync(join(profile, 'patches')).filter(name => name.startsWith('@deepseek-harness-tui__dsh-tui@'))) {
            rmSync(join(profile, 'patches', file));
        }
    }
    console.log('Pi migration adapter removed.');
    process.exit(0);
}

const version = installedVersion();
const editDir = mkdtempSync(join(tmpdir(), 'dsh-tui-pi-patch-'));
try {
    pnpm('patch', `${packageName}@${version}`, '--edit-dir', editDir);
    const adapters = join(editDir, 'lib', 'types', 'dsh-adapter', 'migrate', 'adapters');
    if (!existsSync(adapters)) throw new Error(`unexpected dsh-tui layout: ${adapters} is missing`);
    for (const file of ['pi.parse.js', 'pi.js']) {
        copyFileSync(join(here, file), join(adapters, file));
    }
    const indexPath = join(editDir, 'lib', 'types', 'dsh-adapter', 'migrate', 'index.js');
    let index = readFileSync(indexPath, 'utf8');
    if (!index.includes("'./adapters/pi.js'")) {
        index = index.replace(/(import \{ grokBuildAdapter \} from '\.\/adapters\/grok-build\.js';\n)/, "$1import { piAdapter } from './adapters/pi.js';\n");
    }
    if (!index.includes('piAdapter')) throw new Error('could not find the adapter import anchor in dsh-tui');
    index = index.replace(/(\s+)grokBuildAdapter,\n(\];)/, '$1grokBuildAdapter,$1piAdapter,\n$2');
    if (!/MIGRATION_ADAPTERS = \[[\s\S]*?piAdapter,[\s\S]*?\];/.test(index)) {
        throw new Error('could not add piAdapter to MIGRATION_ADAPTERS');
    }
    writeFileSync(indexPath, index);
    pnpm('patch-commit', editDir);
    // pnpm excludes nested `node_modules` from the edit copy, so patch-commit also
    // records every vendored `vendor/dsh-std/**/node_modules` file as deleted.
    // Keep only this adapter's three files, then reinstall so the clean patch is
    // the one actually applied (and the vendored files are back).
    const patchFile = join(profile, 'patches', `${packageName.replace('/', '__')}@${version}.patch`);
    if (existsSync(patchFile)) {
        const text = readFileSync(patchFile, 'utf8');
        // JS split keeps a zero-width match at index 0; drop blank parts so every
        // section is handled as a section.
        const parts = text.split(/(?=^diff --git )/m).filter(part => part !== '');
        const keep = parts.filter(part => /^diff --git a\/lib\/types\/dsh-adapter\/migrate\/(index\.js|adapters\/pi\.js|adapters\/pi\.parse\.js) b\//m.test(part));
        // Re-running against an already-patched copy can emit the same file twice;
        // a duplicated `new file` section fails to apply.
        const unique = new Map();
        for (const part of keep) {
            const path = /^diff --git a\/(.+?) b\//.exec(part)?.[1];
            if (path !== undefined) unique.set(path, part);
        }
        const clean = [...unique.values()].join('');
        if (clean !== text) {
            writeFileSync(patchFile, clean);
            pnpm('install', '--force');
        }
    }
    console.log(`Pi migration adapter installed for ${packageName}@${version}. Restart dsh-tui.`);
}
finally {
    rmSync(editDir, { recursive: true, force: true });
}
