import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Carpeta de datos nueva para cada prueba (no se borra: queda en el temporal del sistema)
export const tempDataDir = () => mkdtempSync(join(tmpdir(), 'mymusic-test-'));

// Bytes de prueba con cabecera de WebM, para que el tipo se detecte como audio/webm
export function fakeAudio(length) {
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) bytes[i] = i % 251;
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes);
    return bytes;
}

/**
 * Doble de openAudio(): entrega `bytes` a trozos, como haría yt-dlp.
 * @param {Buffer} bytes
 * @param {object} o
 * @param {number|null} o.filesize  tamaño que «anuncia» (null = no lo anuncia)
 * @param {number} o.cutAt          si se da, el proceso «muere» tras mandar esos bytes
 */
export function fakeOpen(bytes, { chunk = 1000, delayMs = 1, filesize = bytes.length, cutAt = null, stderr = '' } = {}) {
    const calls = [];
    const open = url => {
        calls.push(url);
        const stdout = new PassThrough();
        let killed = false;
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const limit = cutAt ?? bytes.length;
        stdout.on('end', () => resolveDone({ code: cutAt === null ? 0 : 1, stderr }));
        stdout.on('close', () => resolveDone({ code: 1, stderr }));
        (async () => {
            for (let i = 0; i < limit && !killed; i += chunk) {
                stdout.write(bytes.subarray(i, Math.min(i + chunk, limit)));
                await sleep(delayMs);
            }
            if (!killed) stdout.end();
        })();
        return {
            stdout,
            meta: Promise.resolve(filesize === null ? null : { filesize, ext: 'webm' }),
            done,
            kill: () => { killed = true; stdout.destroy(); },
        };
    };
    open.calls = calls;
    return open;
}

export async function collect(iterable) {
    const parts = [];
    for await (const part of iterable) parts.push(part);
    return Buffer.concat(parts);
}
