import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { AudioCache } from '../src/audio.js';
import { UserStores } from '../src/stores.js';
import { OWNER, PASSWORD, fakeAudio, fakeOpen, startServer, tempDataDir } from './helpers.js';

const track = n => ({ key: `yt:aaaaaaaaaa${n}`, platform: 'youtube', title: `Canción ${n}`, artist: 'Alguien', durationSec: 200, thumb: null });
const HERS = 'clave-de-la-pareja';

// ------------------------------------------------------------------ cuentas

test('cuentas: alta, nombres sin distinguir mayúsculas y reglas del nombre', () => {
    const auth = new Auth(tempDataDir());
    assert.equal(auth.hasUsers(), false);
    const first = auth.createUser('Ana', PASSWORD);
    const second = auth.createUser('luis.m', HERS);
    assert.deepEqual([first.admin, second.admin], [true, false], 'el primero es el dueño');
    assert.equal(auth.findUser('ANA').id, first.id);
    assert.throws(() => auth.createUser('ana', PASSWORD), /Ya existe/);
    assert.throws(() => auth.createUser('a', PASSWORD), /nombre de usuario/);
    assert.throws(() => auth.createUser('con espacio', PASSWORD), /nombre de usuario/);
    assert.throws(() => auth.createUser('pepe', 'corta'), /8 caracteres/);
    assert.equal(auth.renameUser(second.id, 'Luis').name, 'Luis');
    assert.throws(() => auth.renameUser(second.id, 'ANA'), /Ya existe/);
    assert.deepEqual(auth.users().map(u => u.name), ['Ana', 'Luis']);
});

test('cuentas: entrar con nombre y contraseña; sin nombre entra el dueño', () => {
    const auth = new Auth(tempDataDir());
    const owner = auth.createUser('Ana', PASSWORD);
    const other = auth.createUser('Luis', HERS);
    assert.equal(auth.checkLogin('ana', PASSWORD).id, owner.id);
    assert.equal(auth.checkLogin('Luis', HERS).id, other.id);
    assert.equal(auth.checkLogin(undefined, PASSWORD).id, owner.id, 'la app antigua no manda nombre');
    assert.equal(auth.checkLogin(undefined, HERS), null, 'sin nombre no vale la contraseña de otro');
    assert.equal(auth.checkLogin('Luis', PASSWORD), null);
    assert.equal(auth.checkLogin('nadie', PASSWORD), null);
});

test('cuentas: cambiar la contraseña anula las otras sesiones de ESE usuario y nada más', () => {
    const auth = new Auth(tempDataDir());
    const ana = auth.createUser('Ana', PASSWORD);
    const luis = auth.createUser('Luis', HERS);
    const [phone, web, his] = [auth.issueToken(ana.id, 'móvil'), auth.issueToken(ana.id, 'web'), auth.issueToken(luis.id, 'móvil')];
    assert.equal(auth.verify(phone).user.name, 'Ana');
    auth.setPassword(ana.id, 'otra-clave-nueva', { keepToken: phone });
    assert.ok(auth.verify(phone), 'el dispositivo desde el que se cambia sigue dentro');
    assert.equal(auth.verify(web), null);
    assert.ok(auth.verify(his), 'el otro usuario ni se entera');
    assert.equal(auth.checkLogin('Ana', PASSWORD), null);
    assert.ok(auth.checkLogin('Ana', 'otra-clave-nueva'));
});

test('migración: de la versión de un solo usuario salen la cuenta del dueño y su carpeta, sin perder nada', () => {
    const dir = tempDataDir();
    // Estado de la versión anterior: auth.json, un token, una lista, la sesión y el historial en la raíz
    const salt = 'aa'.repeat(16);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ salt, hash: scryptSync(PASSWORD, salt, 64).toString('hex'), updatedAt: '2026-11-16T12:55:27.000Z' }));
    const before = new Auth(tempDataDir());
    const someone = before.createUser('x1', PASSWORD);
    const raw = before.issueToken(someone.id, 'Xiaomi POCOPHONE F1');
    const [entry] = JSON.parse(readFileSync(before.tokensPath, 'utf8'));
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify([{ id: entry.id, device: entry.device, hash: entry.hash, createdAt: entry.createdAt }]));     // sin userId, como antes
    mkdirSync(join(dir, 'lists'));
    writeFileSync(join(dir, 'lists', 'l_0123456789.json'), JSON.stringify({ id: 'l_0123456789', name: 'breakcore', createdAt: 'a', updatedAt: 'a', tracks: [track(1)] }));
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ id: 's_1', source: { type: 'search', name: 'Búsqueda' }, shuffle: false, base: [track(1).key], order: [track(1).key], tracks: { [track(1).key]: track(1) } }));
    writeFileSync(join(dir, 'session-state.json'), JSON.stringify({ id: 's_1', index: 0, positionMs: 61000, repeat: 'off', visit: 0, loggedVisit: -1 }));
    writeFileSync(join(dir, 'history-2026.jsonl'), JSON.stringify({ at: '2026-11-16T14:00:00.000Z', source: {}, track: track(1) }) + '\n');

    const auth = new Auth(dir, { ownerName: 'Ana' });
    const owner = auth.owner();
    assert.deepEqual([owner.name, owner.admin], ['Ana', true]);
    assert.ok(auth.checkLogin('ana', PASSWORD), 'la contraseña de antes es la de su cuenta');
    assert.equal(auth.verify(raw).user.id, owner.id, 'su móvil sigue dentro sin volver a entrar');
    assert.ok(!existsSync(join(dir, 'auth.json')) && readdirSync(join(dir, 'removed')).some(f => f.startsWith('auth.json.')), 'auth.json queda en removed/');

    const stores = new UserStores(dir);
    assert.deepEqual(stores.adoptLegacy(owner.id).sort(), ['history-2026.jsonl', 'lists', 'session-state.json', 'session.json']);
    const mine = stores.for(owner.id);
    assert.deepEqual(mine.lists.all().map(l => [l.name, l.count]), [['breakcore', 1]]);
    assert.deepEqual([mine.sessions.view().positionMs, mine.history.recent(5).length], [61000, 1]);
    assert.deepEqual(stores.adoptLegacy(owner.id), [], 'arrancar otra vez no mueve nada');
    assert.equal(new Auth(dir, { ownerName: 'Otro' }).owner().name, 'Ana', 'ni cambia el nombre ya puesto');
    assert.throws(() => stores.for('../../fuera'), /no válido/);
});

// ------------------------------------------------------------------ por la API

// Servidor con dos usuarios: la dueña (token s.token) y su pareja (devuelve su token)
async function withPartner(options) {
    const s = await startServer(options);
    s.auth.createUser('pareja', HERS);
    const partner = (await (await s.login(HERS, 'Pareja', 'su móvil')).json()).token;
    return { s, partner };
}

test('API: cada usuario entra con lo suyo y /me dice quién es', async () => {
    const { s, partner } = await withPartner();
    try {
        assert.deepEqual((await s.call('GET', '/api/me')).body.user, { name: OWNER, admin: true });
        assert.deepEqual((await s.call('GET', '/api/me', undefined, partner)).body.user, { name: 'pareja', admin: false });
        assert.equal((await s.login(PASSWORD, 'pareja')).status, 401, 'la contraseña de uno no abre la cuenta del otro');
        const login = await (await s.login(HERS, 'PAREJA')).json();
        assert.deepEqual(login.user, { name: 'pareja', admin: false });
    } finally { await s.close(); }
});

test('API: listas, sesión e historial de cada usuario están separados', async () => {
    const { s, partner } = await withPartner();
    try {
        const mine = (await s.call('POST', '/api/lists', { name: 'breakcore' })).body.list;
        await s.call('POST', `/api/lists/${mine.id}/tracks`, { track: track(1) });
        const hers = (await s.call('POST', '/api/lists', { name: 'city pop' }, partner)).body.list;

        assert.deepEqual((await s.call('GET', '/api/lists')).body.lists.map(l => l.name), ['breakcore']);
        assert.deepEqual((await s.call('GET', '/api/lists', undefined, partner)).body.lists.map(l => l.name), ['city pop']);
        assert.equal((await s.call('GET', `/api/lists/${mine.id}`, undefined, partner)).status, 404, 'no ve la lista del otro ni sabiendo su id');
        assert.equal((await s.call('POST', `/api/lists/${mine.id}/tracks`, { track: track(2) }, partner)).status, 404);
        assert.equal((await s.call('DELETE', `/api/lists/${mine.id}`, undefined, partner)).status, 404);

        await s.call('POST', '/api/session', { listId: mine.id });
        await s.call('POST', '/api/session', { track: track(7) }, partner);
        assert.equal((await s.call('GET', '/api/session')).body.session.source.name, 'breakcore');
        assert.equal((await s.call('GET', '/api/session', undefined, partner)).body.session.window.current.track.key, track(7).key);

        await s.call('PUT', '/api/session/state', { key: track(1).key, positionMs: 40_000 });
        assert.equal((await s.call('GET', '/api/history')).body.entries.length, 1);
        assert.equal((await s.call('GET', '/api/history', undefined, partner)).body.entries.length, 0);

        // Importar: lo leído por uno no lo puede confirmar el otro
        assert.ok(existsSync(join(s.dir, 'users', s.owner.id, 'lists', `${mine.id}.json`)));
        assert.ok(existsSync(join(s.dir, 'users', s.auth.findUser('pareja').id, 'lists', `${hers.id}.json`)));
    } finally { await s.close(); }
});

test('API: en memoria quedan fijadas las canciones de las sesiones de todos', async () => {
    const { s, partner } = await withPartner({ cacheOptions: { maxBytes: 90_000 } });
    try {
        await s.call('POST', '/api/session', { track: track(1) });
        await s.call('POST', '/api/session', { track: track(2) }, partner);
        for (const [n, token] of [[1, s.token], [2, partner], [5, s.token]]) {
            await (await s.api(`/api/stream/${track(n).key}`, { token })).arrayBuffer();
        }
        for (let i = 0; i < 100 && s.cache.items.size > 2; i++) await new Promise(r => setTimeout(r, 10));
        assert.deepEqual([...s.cache.items.keys()].map(k => k.slice(-1)).sort(), ['1', '2'], 'se suelta la que no es de ninguna sesión');
    } finally { await s.close(); }
});

test('API: una sesión por usuario; solo un dispositivo la lleva y «Continuar» en otro se la queda', async () => {
    const s = await startServer();
    try {
        const web = (await (await s.login(PASSWORD, OWNER, 'navegador')).json()).token;
        const list = (await s.call('POST', '/api/lists', { name: 'coche' })).body.list;
        for (const n of [1, 2, 3]) await s.call('POST', `/api/lists/${list.id}/tracks`, { track: track(n) });

        assert.equal((await s.call('POST', '/api/session', { listId: list.id })).body.session.active, true);       // empieza en el móvil
        const seen = (await s.call('GET', '/api/session', undefined, web)).body.session;
        assert.deepEqual([seen.active, seen.source.name, seen.device], [false, 'coche', undefined], 'el navegador ve la sesión, sin llevarla');
        assert.deepEqual([(await s.call('POST', '/api/session/goto', { index: 1 }, web)).status, (await s.call('PUT', '/api/session/state', { index: 0, positionMs: 5000 }, web)).status], [409, 409]);
        assert.equal((await s.call('POST', '/api/session/goto', { index: 1 })).status, 200);
        await s.call('PUT', '/api/session/state', { index: 1, positionMs: 33_000 });

        const taken = (await s.call('POST', '/api/session/claim', undefined, web)).body.session;                  // «Continuar» en el navegador
        assert.deepEqual([taken.active, taken.index, taken.positionMs], [true, 1, 33_000], 'sigue donde iba el móvil');
        assert.equal((await s.call('POST', '/api/session/goto', { index: 2 })).body.error, 'other_device', 'ahora es el móvil el que no la lleva');
        assert.equal((await s.call('GET', '/api/session')).body.session.active, false);
        assert.equal((await s.call('PUT', '/api/session', { repeat: 'all' })).status, 200, 'aleatorio, repetir y cola sí se pueden tocar desde cualquiera');
        assert.equal((await s.call('POST', '/api/session/goto', { index: 2 }, web)).status, 200);
    } finally { await s.close(); }
});

test('API: cambiar la propia contraseña desde la app', async () => {
    const { s, partner } = await withPartner();
    try {
        const other = (await (await s.login(HERS, 'pareja', 'tablet')).json()).token;
        const change = body => s.call('POST', '/api/password', body, partner);
        assert.equal((await change({ current: 'no-es-esta', next: 'nueva-clave-larga' })).status, 401);
        assert.deepEqual([(await change({ current: HERS, next: 'corta' })).status, (await change({ current: HERS, next: 'corta' })).body.error], [400, 'weak_password']);
        assert.equal((await change({ current: HERS, next: 'nueva-clave-larga' })).status, 200);
        assert.equal((await s.call('GET', '/api/me', undefined, partner)).status, 200, 'este dispositivo sigue dentro');
        assert.equal((await s.call('GET', '/api/me', undefined, other)).status, 401, 'su otro dispositivo, no');
        assert.equal((await s.call('GET', '/api/me')).status, 200, 'la dueña, intacta');
        assert.equal((await s.login('nueva-clave-larga', 'pareja')).status, 200);
        assert.equal((await s.login(HERS, 'pareja')).status, 401);
    } finally { await s.close(); }
});

// ------------------------------------------------------------------ extracciones a la vez

test('como mucho N extracciones a la vez; las demás esperan su turno y salen todas', async () => {
    const open = fakeOpen(fakeAudio(4_000), { delayMs: 15 });
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open, maxConcurrent: 2 });
    const buffers = [1, 2, 3, 4, 5].map(n => cache.get(`yt:aaaaaaaaaa${n}`, `u${n}`));
    assert.equal(open.calls.length, 2, 'solo arrancan dos');
    assert.deepEqual([cache.running, cache.waiting.length], [2, 3]);
    await Promise.all(buffers.map(buffer => buffer.waitHeader()));
    for (let i = 0; i < 200 && cache.running > 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual([open.calls.length, cache.running, cache.waiting.length], [5, 0, 0]);
    assert.ok(buffers.every(buffer => buffer.done && !buffer.error));
});

test('una extracción que falla también libera su turno', async () => {
    const open = fakeOpen(Buffer.alloc(0), { filesize: null });
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open, maxConcurrent: 1, attempts: 1 });
    const [a, b] = [cache.get('yt:aaaaaaaaaa1', 'u1'), cache.get('yt:aaaaaaaaaa2', 'u2')];
    await assert.rejects(a.waitHeader());
    await assert.rejects(b.waitHeader());
    assert.deepEqual([open.calls.length, cache.running], [2, 0]);
});

test('API: si el dispositivo que llevaba la sesión ya no existe, la toma el que pregunta', async () => {
    const s = await startServer();
    try {
        const old = (await (await s.login(PASSWORD, OWNER, 'móvil viejo')).json()).token;
        await s.call('POST', '/api/session', { track: track(1) }, old);
        await s.call('POST', '/api/session/queue', { track: track(2), mode: 'end' }, old);
        assert.equal((await s.call('POST', '/api/session/goto', { index: 1 })).status, 409, 'mientras exista, manda él');
        await s.call('POST', '/api/logout', undefined, old);
        const moved = await s.call('POST', '/api/session/goto', { index: 1 });
        assert.deepEqual([moved.status, moved.body.session.active, moved.body.session.index], [200, true, 1]);
    } finally { await s.close(); }
});
