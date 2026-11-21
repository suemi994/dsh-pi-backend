import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { piCliBackend, piCliManifest } from '../backend.js';
import { piBranch, writePiFork } from '../catalog.js';

test('Pi registers its public backend identifier as pi', async () => {
    const plugin = JSON.parse(await readFile(new URL('../dsh-plugin.json', import.meta.url), 'utf8'));
    const contribution = plugin.contributes['x-dsh-tui'][0];
    assert.equal(piCliManifest.id, 'pi');
    assert.equal(piCliBackend.id, 'pi');
    assert.equal(piCliManifest.shortLabel, 'Pi');
    assert.equal(contribution.spec.id, 'pi');
    assert.equal(contribution.spec.shortLabel, 'Pi');
});

test('Pi fork files preserve the selected branch as a new native session', async t => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-pi-fork-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const path = join(temp, 'source.jsonl');
    const header = { type: 'session', id: 'source', cwd: temp, timestamp: '2026-01-01T00:00:00.000Z' };
    const branch = [
        { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'First' } },
        { type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'Reply' } },
        { type: 'message', id: 'user-2', parentId: 'assistant-1', message: { role: 'user', content: 'Second' } },
    ];
    const source = [header, ...branch].map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path, source);

    assert.deepEqual(piBranch(branch, 'assistant-1').map(entry => entry.id), ['user-1', 'assistant-1']);
    const ref = await writePiFork(path, 'source', temp, branch, 'Forked title');
    assert.equal(ref.backendId, 'pi');
    const files = await readdir(temp);
    const forkFile = files.find(name => name !== 'source.jsonl' && name.endsWith('.jsonl'));
    assert.ok(forkFile);
    const forkPath = join(temp, forkFile);
    const rows = (await readFile(forkPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows[0].id, ref.sessionId);
    assert.equal(rows[0].parentSession, path);
    assert.equal(rows[0].cwd, temp);
    assert.deepEqual(rows.slice(1, 4), branch);
    assert.equal(rows[4].type, 'session_info');
    assert.equal(rows[4].name, 'Forked title');
    assert.equal(await readFile(path, 'utf8'), source);
    assert.equal(files.some(name => name.endsWith('.tmp')), false);
    if (process.platform !== 'win32') assert.equal((await stat(forkPath)).mode & 0o777, 0o600);
    assert.equal(dirname(forkPath), temp);
});
