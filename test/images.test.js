import assert from 'node:assert/strict';
import test from 'node:test';
import { piImageInputs, piTranscriptImages } from '../images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function image(data = png, mediaType = 'image/png') {
    return {
        id: 'fixture',
        mediaType,
        width: 1,
        height: 1,
        async read() { return data; },
    };
}

test('Pi image ingress validates and encodes PNG attachments', async () => {
    const [input] = await piImageInputs([image()]);
    assert.equal(input.type, 'image');
    assert.equal(input.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(input.data, 'base64'), png);
});

test('Pi image ingress rejects unsupported types and forged dimensions', async () => {
    await assert.rejects(piImageInputs([image(png, 'image/gif')]), /PNG or JPEG/);
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(4096, 16);
    await assert.rejects(piImageInputs([image(oversized)]), /Invalid or oversized/);
});

test('Pi image ingress enforces the per-message count before reading', async () => {
    let reads = 0;
    const rows = Array.from({ length: 9 }, () => ({
        mediaType: 'image/png',
        async read() { reads++; return png; },
    }));
    await assert.rejects(piImageInputs(rows), /Too many images/);
    assert.equal(reads, 0);
});

test('Pi transcript images expose lazy byte and dimension facades', async () => {
    const [row] = piTranscriptImages([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }], 'call-1');
    assert.equal(row.id, 'call-1#0');
    assert.equal(row.width, 1);
    assert.equal(row.height, 1);
    assert.equal(row.bytes, png.byteLength);
    assert.deepEqual(await row.read(), png);
});
