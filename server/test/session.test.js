import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ListStore, cleanTrack } from '../src/lists.js';
import { HistoryStore, SessionStore } from '../src/session.js';
import { startServer, tempDataDir } from './helpers.js';

// Canciones de prueba con claves válidas: yt:aaaaaaaaaa0, yt:aaaaaaaaaa1…
const track = n => ({ key: `yt:aaaaaaaaaa${n}`, platform: 'youtube', title: `Canción ${n}`, artist: 'Alguien', durationSec: 200, thumb: `https://i.ytimg.com/vi/${n}/x.jpg` });
const tracks = n => Array.from({ length: n }, (_, i) => track(i));
const keys = view => [view.window.prev, view.window.current, view.window.next].map(e => e?.track.key.slice(-1) ?? '-').join('');
const source = { type: 'list', id: 'l_0000000000', name: 'breakcore' };

// ------------------------------------------------------------------ listas

test('cleanTrack: solo claves válidas, título obligatorio, carátula https', () => {
    assert.equal(cleanTrack({ key: 'http://evil/', title: 'x' }), null);
    assert.equal(cleanTrack({ key: 'yt:aaaaaaaaaa1' }), null);
    const clean = cleanTrack({ key: 'yt:aaaaaaaaaa1', title: '  Hola  ', thumb: 'http://inseguro/x.jpg', durationSec: '12.6', extra: 'fuera' });
    assert.deepEqual(clean, { key: 'yt:aaaaaaaaaa1', platform: 'youtube', title: 'Hola', artist: null, durationSec: 13, thumb: null });
});

test('listas: crear, añadir sin duplicar, mover, renombrar', () => {
    const lists = new ListStore(tempDataDir());
    assert.equal(lists.create('   '), null);
    const { id } = lists.create('  breakcore ');
    assert.equal(lists.get(id).name, 'breakcore');
    assert.equal(lists.addTracks(id, tracks(3)).added, 3);
    assert.equal(lists.addTracks(id, [track(1), track(7)]).added, 1, 'la repetida no entra');
    assert.deepEqual(lists.get(id).tracks.map(t => t.key.slice(-1)), ['0', '1', '2', '7']);
    lists.moveTrack(id, track(7).key, 0);
    assert.deepEqual(lists.get(id).tracks.map(t => t.key.slice(-1)), ['7', '0', '1', '2']);
    assert.equal(lists.rename(id, 'otra').name, 'otra');
    assert.deepEqual(lists.all().map(l => [l.name, l.count, l.durationSec]), [['otra', 4, 800]]);
    assert.equal(lists.get('../../etc/passwd'), null);
});

test('listas: lo quitado va a la papelera, no se borra', () => {
    const dir = tempDataDir();
    const lists = new ListStore(dir);
    const { id } = lists.create('coche');
    lists.addTracks(id, tracks(2));
    lists.removeTrack(id, track(0).key);
    const line = JSON.parse(readFileSync(join(dir, 'removed', 'tracks.jsonl'), 'utf8').trim());
    assert.equal(line.track.key, track(0).key);
    assert.equal(line.listName, 'coche');
    assert.equal(lists.remove(id), true);
    assert.equal(lists.get(id), null);
    assert.ok(readdirSync(join(dir, 'removed')).some(f => f.startsWith(`${id}.json.`)), 'la lista está en removed/');
});

// ------------------------------------------------------------------ sesión

test('sesión: la ventana es anterior / actual / siguiente y avanza canción a canción', () => {
    const s = new SessionStore(tempDataDir());
    assert.equal(s.view(), null);
    let v = s.start({ source, tracks: tracks(4), startKey: track(1).key });
    assert.equal(keys(v), '012');
    assert.deepEqual([v.index, v.count, v.source.name], [1, 4, 'breakcore']);
    assert.equal(keys(s.goto(3)), '23-', 'en la última no hay siguiente');
    assert.equal(keys(s.goto(0)), '-01');
    assert.equal(s.goto(9), null);
});

test('sesión: repetir todo enlaza el final con el principio', () => {
    const s = new SessionStore(tempDataDir());
    s.start({ source, tracks: tracks(3) });
    assert.equal(keys(s.setOptions({ repeat: 'all' })), '201');
    assert.equal(keys(s.goto(2)), '120');
    assert.equal(s.setOptions({ repeat: 'nada' }).repeat, 'all', 'un valor desconocido no cambia nada');
});

test('sesión: aleatorio conserva la que suena, y al quitarlo vuelve el orden natural en esa canción', () => {
    const s = new SessionStore(tempDataDir(), { random: () => 0 });      // barajado determinista
    s.start({ source, tracks: tracks(5), startKey: track(2).key });
    let v = s.setOptions({ shuffle: true });
    assert.equal(v.index, 0);
    assert.equal(v.window.current.track.key, track(2).key);
    assert.equal(new Set(s.session.order).size, 5, 'siguen estando las cinco');
    s.goto(3);
    const playing = s.currentKey;
    v = s.setOptions({ shuffle: false });
    assert.equal(v.window.current.track.key, playing);
    assert.deepEqual(s.session.order, tracks(5).map(t => t.key));
});

test('sesión: empezar en aleatorio con canción elegida la pone primera', () => {
    const s = new SessionStore(tempDataDir());
    const v = s.start({ source, tracks: tracks(6), startKey: track(4).key, shuffle: true });
    assert.equal(v.window.current.track.key, track(4).key);
    assert.equal(v.index, 0);
});

test('cola: a continuación, al final, reordenar y quitar', () => {
    const s = new SessionStore(tempDataDir());
    s.start({ source, tracks: tracks(3), startKey: track(1).key });      // 0 [1] 2
    assert.equal(keys(s.enqueue(track(8), 'next')), '018');              // 0 [1] 8 2
    s.enqueue(track(9), 'end');                                          // 0 [1] 8 2 9
    assert.deepEqual(s.session.order.map(k => k.slice(-1)), ['0', '1', '8', '2', '9']);
    assert.equal(keys(s.enqueue(track(9), 'next')), '019', 'una que ya estaba se recoloca');
    assert.equal(s.count, 5);
    assert.equal(s.moveQueued(0, 3), null, 'lo ya sonado no se mueve');
    assert.equal(keys(s.moveQueued(4, 2)), '012');                       // 0 [1] 2 9 8
    assert.equal(s.removeQueued(1), null, 'la que suena no se quita');
    assert.equal(keys(s.removeQueued(2)), '019');
    assert.equal(s.queue(1, 20).entries.length, 3);
});

test('sesión: sobrevive a un reinicio del servidor', () => {
    const dir = tempDataDir();
    const a = new SessionStore(dir);
    a.start({ source, tracks: tracks(4) });
    a.goto(2);
    a.report({ index: 2, positionMs: 45_000 });
    const b = new SessionStore(dir);
    const v = b.view();
    assert.deepEqual([v.index, v.positionMs, v.source.name], [2, 45_000, 'breakcore']);
});

test('historial: una canción cuenta a partir de los 30 s, y una sola vez por escucha', () => {
    const dir = tempDataDir();
    const s = new SessionStore(dir);
    const h = new HistoryStore(dir);
    s.start({ source, tracks: tracks(3) });
    assert.equal(s.report({ index: 0, positionMs: 10_000 }).played, null);
    assert.equal(s.report({ index: 1, positionMs: 99_000 }), null, 'informe de otra canción: se ignora');
    const first = s.report({ index: 0, positionMs: 31_000 }).played;
    assert.equal(first.track.key, track(0).key);
    assert.equal(s.report({ index: 0, positionMs: 60_000 }).played, null);
    h.append(first);
    s.goto(1);
    h.append(s.report({ index: 1, positionMs: 40_000 }).played);
    assert.deepEqual(h.recent(10).map(e => e.track.key.slice(-1)), ['1', '0'], 'lo más reciente primero');
});

// ------------------------------------------------------------------ por la API

test('API: de crear una lista a escucharla canción a canción', async () => {
    const s = await startServer();
    try {
        const { body: { list } } = await s.call('POST', '/api/lists', { name: 'breakcore' });
        for (const t of tracks(3)) assert.equal((await s.call('POST', `/api/lists/${list.id}/tracks`, { track: t })).body.added, 1);
        assert.equal((await s.call('POST', `/api/lists/${list.id}/tracks`, { track: track(0) })).body.added, 0);
        assert.equal((await s.call('GET', '/api/lists')).body.lists[0].count, 3);
        assert.equal((await s.call('GET', `/api/lists/${list.id}`)).body.list.tracks.length, 3);

        let { body: { session } } = await s.call('POST', '/api/session', { listId: list.id, startKey: track(1).key });
        assert.equal(keys(session), '012');
        ({ body: { session } } = await s.call('POST', '/api/session/goto', { index: 2 }));
        assert.equal(keys(session), '12-');
        ({ body: { session } } = await s.call('POST', '/api/session/goto', { key: track(0).key }));
        assert.equal(keys(session), '-01', 'también por clave de canción');
        assert.equal((await s.call('POST', '/api/session/goto', { key: 'yt:noestaenlis' })).status, 400);
        ({ body: { session } } = await s.call('PUT', '/api/session', { repeat: 'one' }));
        assert.equal(session.repeat, 'one');
        await s.call('POST', '/api/session/goto', { index: 2 });
        assert.equal((await s.call('POST', '/api/session/goto', { index: 7 })).status, 400);
        assert.equal((await s.call('GET', '/api/session')).body.session.index, 2);
        assert.equal((await s.call('GET', '/api/session/queue?from=0&limit=2')).body.entries.length, 2);

        assert.equal((await s.call('PUT', '/api/session/state', { key: track(2).key, positionMs: 35_000 })).body.ok, true);
        assert.equal((await s.call('PUT', `/api/lists/${list.id}`, { name: 'break' })).body.list.name, 'break');
        assert.equal((await s.call('GET', '/api/history?distinct=1')).body.entries[0].track.key, track(2).key);

        assert.equal((await s.call('DELETE', `/api/lists/${list.id}`)).status, 200);
        assert.equal((await s.call('GET', `/api/lists/${list.id}`)).status, 404);
        assert.equal((await s.call('GET', '/api/session')).body.session.count, 3, 'la sesión en curso no depende de la lista');
    } finally { await s.close(); }
});

test('API: reproducir una canción suelta y encolar otras', async () => {
    const s = await startServer();
    try {
        assert.equal((await s.call('GET', '/api/session')).body.session, null);
        assert.equal((await s.call('POST', '/api/session/goto', { index: 0 })).status, 404);
        let { body: { session } } = await s.call('POST', '/api/session', { track: track(0) });
        assert.deepEqual([session.source.type, session.count, keys(session)], ['search', 1, '-0-']);
        ({ body: { session } } = await s.call('POST', '/api/session/queue', { track: track(1), mode: 'end' }));
        ({ body: { session } } = await s.call('POST', '/api/session/queue', { track: track(2), mode: 'next' }));
        assert.equal(keys(session), '-02');
        assert.equal((await s.call('POST', '/api/session', { track: { key: 'file:///etc/passwd', title: 'x' } })).status, 400);
        ({ body: { session } } = await s.call('PATCH', '/api/session', { repeat: 'all' }));
        assert.equal(keys(session), '102');

        // Mover y quitar por clave; repetir la misma orden de quitar no se lleva otra canción por delante
        await s.call('POST', '/api/session/queue', { track: track(3), mode: 'end' });            // [0] 2 1 3
        ({ body: { session } } = await s.call('POST', '/api/session/queue/move', { key: track(3).key, to: 1 }));
        assert.deepEqual(s.sessions.session.order.map(k => k.slice(-1)), ['0', '3', '2', '1']);
        const remove = () => s.call('DELETE', `/api/session/queue/${encodeURIComponent(track(3).key)}`);
        assert.equal((await remove()).body.session.count, 3);
        const again = await remove();
        assert.deepEqual([again.status, again.body.session.count], [200, 3], 'la segunda vez no quita nada');
        assert.deepEqual(s.sessions.session.order.map(k => k.slice(-1)), ['0', '2', '1']);
        assert.equal((await s.call('DELETE', `/api/session/queue/${encodeURIComponent(track(0).key)}`)).status, 400, 'la que suena no se quita');
    } finally { await s.close(); }
});

test('API: la siguiente canción se prepara sola y ni ella ni la actual se sueltan de la memoria', async () => {
    const s = await startServer({ cacheOptions: { maxBytes: 50_000 }, prefetchDelayMs: 15 });
    try {
        await s.call('POST', '/api/session', { track: track(0) });
        await s.call('POST', '/api/session/queue', { track: track(1), mode: 'end' });
        await (await s.api(`/api/stream/${track(0).key}`, { token: s.token })).arrayBuffer();      // el reproductor pide la actual
        for (let i = 0; i < 100 && s.open.calls.length < 2; i++) await new Promise(r => setTimeout(r, 10));
        assert.deepEqual(s.open.calls.map(url => url.slice(-1)), ['0', '1'], 'la siguiente se extrajo sin que nadie la pidiera');
        assert.deepEqual([...s.cache.pinned].map(k => k.slice(-1)).sort(), ['0', '1']);
        // Otra canción llena la memoria por encima del tope: se suelta ella, no las fijadas
        await (await s.api('/api/stream/yt:aaaaaaaaaa5', { token: s.token })).arrayBuffer();
        for (let i = 0; i < 100 && s.cache.items.size > 2; i++) await new Promise(r => setTimeout(r, 10));
        assert.deepEqual([...s.cache.items.keys()].map(k => k.slice(-1)).sort(), ['0', '1']);
    } finally { await s.close(); }
});

test('API: saltar deprisa no prepara canciones por las que solo se pasa', async () => {
    const s = await startServer({ prefetchDelayMs: 60 });
    try {
        const { body: { list } } = await s.call('POST', '/api/lists', { name: 'larga' });
        for (const t of tracks(6)) await s.call('POST', `/api/lists/${list.id}/tracks`, { track: t });
        await s.call('POST', '/api/session', { listId: list.id });
        for (const index of [1, 2, 3]) await s.call('POST', '/api/session/goto', { index });
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(s.open.calls.map(url => url.slice(-1)), ['4'], 'solo la siguiente de donde se quedó');
    } finally { await s.close(); }
});

test('API: listas y sesión exigen token', async () => {
    const s = await startServer();
    try {
        for (const path of ['/api/lists', '/api/session', '/api/history', '/api/session/queue']) {
            assert.equal((await s.api(path)).status, 401, path);
        }
        assert.ok(!existsSync(join(s.dir, 'lists')));
    } finally { await s.close(); }
});
