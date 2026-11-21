const MiB = 1024 * 1024;
export const piImageLimits = Object.freeze({
    mediaTypes: ['image/png', 'image/jpeg'],
    maxImageBytes: 8 * MiB,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 24 * MiB,
    maxImageDimension: 2048,
    maxImagePixels: 2048 * 2048,
});

export async function piImageInputs(images = []) {
    if (images.length > piImageLimits.maxImagesPerMessage) throw new Error('Too many images for Pi');
    let total = 0;
    const inputs = [];
    for (const image of images) {
        if (!piImageLimits.mediaTypes.includes(image.mediaType)) throw new Error('Pi image input requires PNG or JPEG');
        const data = await image.read();
        const size = imageSize(Buffer.from(data.buffer, data.byteOffset, data.byteLength), image.mediaType);
        total += data.byteLength;
        if (data.byteLength > piImageLimits.maxImageBytes || total > piImageLimits.maxMessageImageBytes) {
            throw new Error('Pi image attachment limit exceeded');
        }
        if (!size || size.width > piImageLimits.maxImageDimension || size.height > piImageLimits.maxImageDimension) {
            throw new Error('Invalid or oversized Pi image dimensions');
        }
        inputs.push({ type: 'image', mimeType: image.mediaType, data: Buffer.from(data).toString('base64') });
    }
    return inputs;
}

function imageSize(data, type) {
    if (type === 'image/png') {
        if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a' || data.toString('ascii', 12, 16) !== 'IHDR') return;
        const width = data.readUInt32BE(16);
        const height = data.readUInt32BE(20);
        if (width && height) return { width, height };
        return;
    }
    if (data[0] !== 0xff || data[1] !== 0xd8) return;
    let offset = 2;
    while (offset + 4 <= data.length && data[offset++] === 0xff) {
        while (data[offset] === 0xff) offset++;
        const marker = data[offset++];
        if (offset + 2 > data.length || marker === 0xda || marker === 0xd9) return;
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) return;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
            const width = data.readUInt16BE(offset + 5);
            const height = data.readUInt16BE(offset + 3);
            if (width && height) return { width, height };
            return;
        }
        offset += length;
    }
}

export function piTranscriptImages(content, id) {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block, index) => {
        if (block?.type !== 'image' || !piImageLimits.mediaTypes.includes(block.mimeType) ||
            typeof block.data !== 'string' || !block.data || block.data.length > 32 * MiB) return [];
        const { data, mimeType: mediaType } = block;
        let size;
        const measure = () => size ??= imageSize(Buffer.from(data, 'base64'), mediaType) ?? { width: 1, height: 1 };
        return [{
            id: `${id}#${index}`, mediaType,
            bytes: Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
            get width() { return measure().width; },
            get height() { return measure().height; },
            async read(signal) { signal?.throwIfAborted(); return Buffer.from(data, 'base64'); },
        }];
    });
}
