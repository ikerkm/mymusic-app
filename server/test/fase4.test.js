import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ListStore } from '../src/lists.js';
import { OWNER, startServer, tempDataDir } from './helpers.js';

const track = n => ({ key: `yt:aaaaaaaaaa${n}`, platform: 'youtube', title: `Canción ${n}`, artist: 'Alguien', durationSec: 200, thumb: `https://i.ytimg.com/vi/${n}/x.jpg` });

// ------------------------------------------------------------------ papelera

test('papelera: enseña listas y canciones quitadas, lo más reciente primero', () => {
    let now = Date.parse('2026-11-17T08:00:00Z');
    const lists = new ListStore(tempDataDir(), { now: () => now });
    assert.deepEqual(lists.trash(), { lists: [], tracks: [] });
    const a = lists.create('rock');
    lists.addTracks(a.id, [track(0), track(1), track(2)]);
    lists.removeTrack(a.id, track(0).key);
    now += 60_000;
    lists.removeTrack(a.id, track(2).key);

    const trash = lists.trash();
    assert.deepEqual(trash.lists, []);
    assert.deepEqual(trash.tracks.map(t => [t.id, t.track.key.slice(-1), t.listId, t.listName]), [['t1', '2', a.id, 'rock'], ['t0', '0', a.id, 'rock']]);
    assert.equal(trash.tracks[0].removedAt, '2026-11-17T08:01:00.000Z');
});

test('papelera: restaurar una canción la devuelve a su lista, al final, y deja de salir', () => {
    const dir = tempDataDir();
    const lists = new ListStore(dir);
    const a = lists.create('rock');
    lists.addTracks(a.id, [track(0), track(1), track(2)]);
    lists.removeTrack(a.id, track(0).key);

    assert.deepEqual(lists.restoreTrack('t7'), { error: 'not_found' });
    const { added, list } = lists.restoreTrack('t0');
    assert.equal(added, 1);
    assert.deepEqual(list.tracks.map(t => t.key.slice(-1)), ['1', '2', '0']);
    assert.deepEqual(lists.trash().tracks, []);
    assert.deepEqual(lists.restoreTrack('t0'), { error: 'not_found' }, 'no se restaura dos veces');
    // Nada se borra: la línea de la papelera sigue en su archivo
    assert.equal(readFileSync(join(dir, 'removed', 'tracks.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.ok(existsSync(join(dir, 'removed', 'restored.jsonl')));

    // Quitada otra vez, vuelve a salir (es otra línea)
    lists.removeTrack(a.id, track(0).key);
    assert.deepEqual(lists.trash().tracks.map(t => t.id), ['t1']);
});

test('papelera: si la lista de una canción ya no existe, hay que elegir otra', () => {
    const lists = new ListStore(tempDataDir());
    const a = lists.create('rock');
    const b = lists.create('pop');
    lists.addTracks(a.id, [track(0), track(1)]);
    lists.removeTrack(a.id, track(1).key);
    lists.remove(a.id);

    const [item] = lists.trash().tracks;
    assert.equal(item.listId, null, 'su lista ya no está');
    assert.equal(item.listName, 'rock', 'pero se sabe cómo se llamaba');
    assert.deepEqual(lists.restoreTrack(item.id), { error: 'list_gone' });
    assert.deepEqual(lists.restoreTrack(item.id, 'l_0000000000'), { error: 'list_gone' });
    assert.equal(lists.restoreTrack(item.id, b.id).added, 1);
    assert.deepEqual(lists.get(b.id).tracks.map(t => t.key.slice(-1)), ['1']);
});

test('papelera: restaurar una lista la devuelve entera y con el mismo identificador', () => {
    const dir = tempDataDir();
    const lists = new ListStore(dir);
    const a = lists.create('rock');
    lists.addTracks(a.id, [track(0), track(1)]);
    lists.remove(a.id);
    assert.deepEqual(lists.all(), []);

    const [item] = lists.trash().lists;
    assert.deepEqual([item.name, item.count], ['rock', 2]);
    assert.match(item.removedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    assert.deepEqual(lists.restoreList('../../etc/passwd'), { error: 'not_found' });
    assert.deepEqual(lists.restoreList('l_0000000000.json.20261117T080000'), { error: 'not_found' });
    const { list } = lists.restoreList(item.id);
    assert.equal(list.id, a.id);
    assert.deepEqual(lists.get(a.id).tracks.map(t => t.key.slice(-1)), ['0', '1']);
    assert.deepEqual(lists.trash().lists, []);
    assert.deepEqual(readdirSync(join(dir, 'removed')), [], 'el archivo ha vuelto a su sitio');
});

test('API: la papelera es de cada usuario, y restaurar pide el tipo y el identificador', async () => {
    const s = await startServer();
    try {
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        const list = s.lists.create('rock');
        s.lists.addTracks(list.id, [track(0), track(1)]);
        await s.call('DELETE', `/api/lists/${list.id}/tracks/${track(0).key}`);

        const mine = (await s.call('GET', '/api/trash')).body;
        assert.deepEqual(mine.tracks.map(t => [t.id, t.track.title, t.listName]), [['t0', 'Canción 0', 'rock']]);
        assert.deepEqual((await s.call('GET', '/api/trash', undefined, other)).body, { lists: [], tracks: [] }, 'la otra cuenta no ve nada');

        assert.equal((await s.call('POST', '/api/trash/restore', {})).status, 400);
        assert.equal((await s.call('POST', '/api/trash/restore', { type: 'track', id: 't0' }, other)).status, 404, 'ni puede restaurar lo de otro');
        const back = await s.call('POST', '/api/trash/restore', { type: 'track', id: 't0' });
        assert.deepEqual([back.status, back.body.ok, back.body.added, back.body.list.count], [200, true, 1, 2]);

        await s.call('DELETE', `/api/lists/${list.id}`);
        const [gone] = (await s.call('GET', '/api/trash')).body.lists;
        assert.equal(gone.name, 'rock');
        assert.equal((await s.call('POST', '/api/trash/restore', { type: 'list', id: gone.id })).body.list.id, list.id);
        assert.equal((await s.call('GET', '/api/lists')).body.lists.length, 1);
        assert.equal((await s.call('GET', '/api/trash')).status, 200);
        assert.equal((await s.api('/api/trash')).status, 401, 'sin entrar no se ve');
    } finally {
        await s.close();
    }
});

// ------------------------------------------------------------------ «Probar extracción»

test('API: «Probar extracción» dice si el buscador y YouTube responden, sin tocar la memoria de audio', async () => {
    const s = await startServer({ search: async () => [{ key: 'yt:jNQXAC9IVRw', title: 'Me at the zoo' }] });
    try {
        const { status, body } = await s.call('POST', '/api/diagnostics/extract');
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.search.ok, true);
        assert.equal(body.extract.ok, true);
        assert.ok(Number.isFinite(body.search.ms) && Number.isFinite(body.extract.ms));
        assert.deepEqual(s.open.calls, ['https://www.youtube.com/watch?v=jNQXAC9IVRw']);
        assert.equal(s.cache.items.size, 0, 'no guarda nada en la memoria de audio');
        assert.equal((await s.api('/api/diagnostics/extract', { method: 'POST' })).status, 401);
    } finally {
        await s.close();
    }
});

test('API: «Probar extracción» explica el fallo cuando YouTube no entrega audio o el buscador se cae', async () => {
    const s = await startServer({
        search: async () => { throw new Error('sin red'); },
        openOptions: { failFirst: 5, stderr: 'ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot' },
    });
    try {
        const { body } = await s.call('POST', '/api/diagnostics/extract');
        assert.equal(body.ok, false);
        assert.equal(body.search.ok, false);
        assert.equal(body.extract.ok, false);
        assert.equal(typeof body.extract.message, 'string');
        assert.ok(body.extract.message.length > 0);
    } finally {
        await s.close();
    }
});

test('API: «Probar extracción» no espera para siempre', async () => {
    // Un yt-dlp que se queda colgado: ni da audio ni termina
    const s = await startServer({ openOptions: { hang: true }, probeTimeoutMs: 80 });
    try {
        const started = Date.now();
        const { body } = await s.call('POST', '/api/diagnostics/extract');
        assert.equal(body.extract.ok, false);
        assert.ok(Date.now() - started < 3000);
        assert.equal(s.owner.name, OWNER);
    } finally {
        await s.close();
    }
});
