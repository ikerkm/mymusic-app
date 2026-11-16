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
    const options = [];
    const open = (url, opts) => {
        options.push(opts);
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
    open.options = options;
    return open;
}

export const PASSWORD = 'una-clave-de-prueba';
export const OWNER = 'duena';

// Servidor de prueba en un puerto libre, con yt-dlp y el buscador sustituidos por dobles
export async function startServer({ bytes = fakeAudio(40_000), openOptions = {}, cacheOptions = {}, password = PASSWORD, search, prefetchDelayMs = 20, matchSearch, importers, webDir } = {}) {
    const [{ createApp }, { Auth }, { AudioCache }, { UserStores }] = await Promise.all([
        import('../src/app.js'), import('../src/auth.js'), import('../src/audio.js'), import('../src/stores.js'),
    ]);
    const dir = tempDataDir();
    const auth = new Auth(dir);
    // El dueño de las pruebas se llama «duena». Sus almacenes se exponen como s.lists, s.sessions, s.history.
    const owner = password ? auth.createUser(OWNER, password) : null;
    const open = fakeOpen(bytes, openOptions);
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open, ...cacheOptions });
    const stores = new UserStores(dir);
    const { lists, sessions, history } = owner ? stores.for(owner.id) : {};
    const { AppDist } = await import('../src/appdist.js');
    const { MatchStore } = await import('../src/matches.js');
    const { PendingImports } = await import('../src/importers.js');
    // Buscador de coincidencias y lectores de listas de fuera: dobles, sin red
    const matches = new MatchStore(dir, { search: matchSearch ?? (async () => []) });
    const app = createApp({
        auth, cache, open, stores, appDist: new AppDist(dir), prefetchDelayMs, version: 'test',
        matches, importers: importers ?? {}, pending: new PendingImports(), webDir,
        search: search ?? (async q => [{ key: 'yt:dQw4w9WgXcQ', title: `resultado de ${q}` }]),
    });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (path, { token, ...init } = {}) => fetch(base + path, {
        ...init,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    // Sin `user` entra el dueño, como hacen las versiones de la app anteriores a las cuentas
    const login = async (pw = PASSWORD, user = undefined, device = 'prueba') => api('/api/login', { method: 'POST', body: JSON.stringify({ user, password: pw, device }) });
    const token = password ? (await (await login()).json()).token : null;
    // Atajo: petición autenticada con cuerpo JSON → { status, body }. `as` = token de otro dispositivo o usuario.
    const call = async (method, path, body, as = token) => {
        const res = await api(path, { method, token: as, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { dir, auth, owner, stores, cache, open, lists, sessions, history, matches, api, call, login, token, bytes, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function collect(iterable) {
    const parts = [];
    for await (const part of iterable) parts.push(part);
    return Buffer.concat(parts);
}
