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
export function fakeOpen(bytes, { chunk = 1000, delayMs = 1, filesize = bytes.length, cutAt = null, stderr = '', failFirst = 0 } = {}) {
    const calls = [];
    const open = url => {
        calls.push(url);
        const stdout = new PassThrough();
        let killed = false;
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        // failFirst: las primeras N llamadas no dan audio (como un rechazo pasajero de YouTube)
        const failing = calls.length <= failFirst;
        const limit = failing ? 0 : (cutAt ?? bytes.length);
        stdout.on('end', () => resolveDone({ code: cutAt === null && !failing ? 0 : 1, stderr: failing && !stderr ? 'ERROR: rechazo pasajero' : stderr }));
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
            meta: Promise.resolve(filesize === null || failing ? null : { filesize, ext: 'webm' }),
            done,
            kill: () => { killed = true; stdout.destroy(); },
        };
    };
    open.calls = calls;
    return open;
}

export const PASSWORD = 'una-clave-de-prueba';

// Servidor de prueba en un puerto libre, con yt-dlp y el buscador sustituidos por dobles
export async function startServer({ bytes = fakeAudio(40_000), openOptions = {}, cacheOptions = {}, password = PASSWORD, search, prefetchDelayMs = 20 } = {}) {
    const [{ createApp }, { Auth }, { AudioCache }, { ListStore }, { SessionStore, HistoryStore }] = await Promise.all([
        import('../src/app.js'), import('../src/auth.js'), import('../src/audio.js'), import('../src/lists.js'), import('../src/session.js'),
    ]);
    const dir = tempDataDir();
    const auth = new Auth(dir);
    if (password) auth.setPassword(password);
    const open = fakeOpen(bytes, openOptions);
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open, ...cacheOptions });
    const lists = new ListStore(dir);
    const sessions = new SessionStore(dir);
    const history = new HistoryStore(dir);
    const { AppDist } = await import('../src/appdist.js');
    const app = createApp({
        auth, cache, open, lists, sessions, history, appDist: new AppDist(dir), prefetchDelayMs, version: 'test',
        search: search ?? (async q => [{ key: 'yt:dQw4w9WgXcQ', title: `resultado de ${q}` }]),
    });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (path, { token, ...init } = {}) => fetch(base + path, {
        ...init,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const login = async (pw = PASSWORD) => api('/api/login', { method: 'POST', body: JSON.stringify({ password: pw, device: 'prueba' }) });
    const token = password ? (await (await login()).json()).token : null;
    // Atajo: petición autenticada con cuerpo JSON → { status, body }
    const call = async (method, path, body) => {
        const res = await api(path, { method, token, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { dir, auth, cache, open, lists, sessions, history, api, call, login, token, bytes, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function collect(iterable) {
    const parts = [];
    for await (const part of iterable) parts.push(part);
    return Buffer.concat(parts);
}
