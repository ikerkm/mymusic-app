import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRange } from '../src/app.js';
import { parseKey } from '../src/sources.js';
import { PASSWORD, fakeAudio, startServer as start } from './helpers.js';

const KEY = 'yt:dQw4w9WgXcQ';

test('parseRange', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange('bytes=0-', 100), [0, 99]);
    assert.deepEqual(parseRange('bytes=10-19', 100), [10, 19]);
    assert.deepEqual(parseRange('bytes=90-500', 100), [90, 99]);
    assert.deepEqual(parseRange('bytes=-30', 100), [70, 99]);
    assert.equal(parseRange('bytes=100-', 100), 'invalid');
    assert.equal(parseRange('bytes=50-40', 100), 'invalid');
    assert.equal(parseRange('bytes=-', 100), 'invalid');
    assert.equal(parseRange('items=0-5', 100), 'invalid');
});

test('parseKey solo admite claves de plataformas conocidas', () => {
    assert.equal(parseKey(KEY).url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    for (const bad of ['yt:corto', 'yt:dQw4w9WgXcQ:extra', 'http://127.0.0.1/', 'file:///etc/passwd', 'yt:dQw4w9WgX/Q', '', undefined]) {
        assert.equal(parseKey(bad), null, String(bad));
    }
});

test('login: contraseña correcta da token; la incorrecta no, y a los 5 fallos bloquea', async () => {
    const s = await start();
    try {
        assert.ok(s.token.length > 30);
        assert.equal((await s.api('/api/me', { token: s.token })).status, 200);
        for (let i = 0; i < 5; i++) assert.equal((await s.login('mala')).status, 401);
        assert.equal((await s.login('mala')).status, 429);
        assert.equal((await s.login(PASSWORD)).status, 429, 'bloqueado aunque ahora acierte');
    } finally { await s.close(); }
});

test('en disco solo quedan hashes, nunca la contraseña ni el token', async () => {
    const s = await start();
    try {
        const all = readdirSync(s.dir).filter(f => f.endsWith('.json')).map(f => readFileSync(join(s.dir, f), 'utf8')).join('\n');
        assert.ok(!all.includes(PASSWORD));
        assert.ok(!all.includes(s.token));
    } finally { await s.close(); }
});

test('sin token, todo lo privado responde 401', async () => {
    const s = await start();
    try {
        for (const path of ['/api/me', '/api/search?q=x', `/api/stream/${KEY}`]) {
            assert.equal((await s.api(path)).status, 401, path);
            assert.equal((await s.api(path, { token: 'x'.repeat(43) })).status, 401, path);
        }
        assert.equal(s.open.calls.length, 0, 'sin token no se lanza ninguna extracción');
        assert.equal((await s.api('/api/health')).status, 200);
    } finally { await s.close(); }
});

test('sin contraseña fijada no se puede entrar', async () => {
    const s = await start({ password: null });
    try {
        assert.equal((await s.login('cualquiera')).status, 503);
    } finally { await s.close(); }
});

test('cerrar sesión invalida el token y la lista anterior queda en removed/', async () => {
    const s = await start();
    try {
        assert.equal((await s.api('/api/logout', { method: 'POST', token: s.token })).status, 200);
        assert.equal((await s.api('/api/me', { token: s.token })).status, 401);
        assert.ok(existsSync(join(s.dir, 'removed')));
    } finally { await s.close(); }
});

test('cambiar la contraseña invalida las sesiones y conserva lo anterior en removed/', async () => {
    const s = await start();
    try {
        s.auth.setPassword(s.owner.id, 'otra-clave-distinta');
        assert.equal((await s.api('/api/me', { token: s.token })).status, 401);
        assert.equal((await s.login(PASSWORD)).status, 401);
        assert.equal((await s.login('otra-clave-distinta')).status, 200);
        assert.ok(readdirSync(join(s.dir, 'removed')).some(f => f.startsWith('users.json.')));
    } finally { await s.close(); }
});

test('búsqueda', async () => {
    const s = await start();
    try {
        const res = await s.api('/api/search?q=amen%20break', { token: s.token });
        // `liked`: cada canción dice si está en el «me gusta» del usuario (test/likes.test.js).
        // `artists`: la fila «Artistas» (§18, test/artista.test.js); aquí no hay YouTube Music, sale vacía.
        assert.deepEqual(await res.json(), { results: [{ key: KEY, title: 'resultado de amen break', liked: false }], artists: [] });
        assert.equal((await s.api('/api/search?q=', { token: s.token })).status, 400);
    } finally { await s.close(); }
});

test('búsqueda: si YouTube devuelve una página vacía, se pregunta otra vez (una sola)', async () => {
    let calls = 0;
    const s = await start({ search: async q => (++calls === 1 ? [] : [{ key: KEY, title: `resultado de ${q}` }]) });
    try {
        const { body } = await s.call('GET', '/api/search?q=rick%20astley');
        assert.equal(body.results.length, 1, 'la segunda vez sí trae');
        assert.equal(calls, 2);
    } finally { await s.close(); }
    let empty = 0;
    const t = await start({ search: async () => { empty++; return []; } });
    try {
        assert.deepEqual((await t.call('GET', '/api/search?q=nada%20de%20nada')).body.results, []);
        assert.equal(empty, 2, 'si sigue vacía, «Sin resultados» sin más intentos');
    } finally { await t.close(); }
});

test('audio completo: 200 con tipo y tamaño exactos', async () => {
    const s = await start();
    try {
        const res = await s.api(`/api/stream/${KEY}`, { token: s.token });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'audio/webm');
        assert.equal(res.headers.get('content-length'), '40000');
        assert.equal(res.headers.get('accept-ranges'), 'bytes');
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), s.bytes);
    } finally { await s.close(); }
});

test('audio por tramos: 206 con Content-Range, y solo una extracción', async () => {
    const s = await start();
    try {
        const cases = [['bytes=1000-1999', 1000, 1999], ['bytes=39000-', 39000, 39999], ['bytes=-500', 39500, 39999]];
        for (const [range, start, end] of cases) {
            const res = await s.api(`/api/stream/${KEY}`, { token: s.token, headers: { Range: range } });
            assert.equal(res.status, 206, range);
            assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/40000`);
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), s.bytes.subarray(start, end + 1), range);
        }
        const bad = await s.api(`/api/stream/${KEY}`, { token: s.token, headers: { Range: 'bytes=40000-' } });
        assert.equal(bad.status, 416);
        assert.equal(bad.headers.get('content-range'), 'bytes */40000');
        assert.equal(s.open.calls.length, 1);
    } finally { await s.close(); }
});

test('clave no válida: 400 sin lanzar extracción', async () => {
    const s = await start();
    try {
        assert.equal((await s.api('/api/stream/yt:corto', { token: s.token })).status, 400);
        assert.equal(s.open.calls.length, 0);
    } finally { await s.close(); }
});

test('si la extracción falla: 502 con mensaje llano', async () => {
    const s = await start({ bytes: Buffer.alloc(0), openOptions: { filesize: null, stderr: 'ERROR: [youtube] xx: Video unavailable' } });
    try {
        const res = await s.api(`/api/stream/${KEY}`, { token: s.token });
        assert.equal(res.status, 502);
        // El motivo en claro va también en `reason` y su tipo en `code` (canciones que fallan, §19, test/fallos.test.js)
        assert.deepEqual(await res.json(), { error: 'extract_failed', message: 'El vídeo ya no está disponible', reason: 'El vídeo ya no está disponible', code: 'unavailable' });
    } finally { await s.close(); }
});

test('pista que no cabe en memoria: se sirve en tubería directa, sin saltos', async () => {
    const s = await start({ bytes: fakeAudio(30_000), cacheOptions: { trackMaxBytes: 10_000 } });
    try {
        const res = await s.api(`/api/stream/${KEY}`, { token: s.token });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('accept-ranges'), 'none');
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), s.bytes);
        assert.equal(s.cache.items.size, 0, 'no se queda en memoria');
    } finally { await s.close(); }
});

test('si el cliente corta a media canción, el lector se libera', async () => {
    const s = await start({ bytes: fakeAudio(400_000), openOptions: { delayMs: 5 } });
    try {
        const abort = new AbortController();
        const res = await s.api(`/api/stream/${KEY}`, { token: s.token, signal: abort.signal });
        await res.body.getReader().read();
        abort.abort();
        const buffer = s.cache.items.get(KEY);
        for (let i = 0; i < 100 && buffer.readers > 0; i++) await new Promise(r => setTimeout(r, 10));
        assert.equal(buffer.readers, 0);
    } finally { await s.close(); }
});
