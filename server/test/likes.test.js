import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LikeSet, likeSigs } from '../src/likes.js';
import { ListStore } from '../src/lists.js';
import { startServer, tempDataDir } from './helpers.js';

const yt = (n, title = `Canción ${n}`, artist = 'Alguien') => ({ key: `yt:aaaaaaaaaa${n}`, platform: 'youtube', title, artist, durationSec: 200, thumb: `https://i.ytimg.com/vi/${n}/x.jpg` });
const sp = (n, title, artist) => ({ key: `sp:${String(n).padStart(22, '0')}`, platform: 'spotify', title, artist, durationSec: 200, thumb: null });

// ------------------------------------------------------------------ la lista del corazón

test('me gusta: sin listas no hay lista del corazón; con `create` se crea «Me gusta» y queda apuntada', () => {
    const dir = tempDataDir();
    const lists = new ListStore(dir);
    assert.equal(lists.likesId(), null);
    assert.equal(existsSync(join(dir, 'likes.json')), false, 'preguntar no crea nada');
    const id = lists.likesId({ create: true });
    assert.deepEqual([lists.get(id).name, lists.get(id).tracks], ['Me gusta', []]);
    assert.equal(lists.likesId(), id);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'likes.json'), 'utf8')), { listId: id });
    // Otro almacén sobre la misma carpeta (el servidor reiniciado) llega a la misma
    assert.equal(new ListStore(dir).likesId({ create: true }), id);
});

test('me gusta: adopta la lista que ya se llama «likes» (la más antigua) y la sigue aunque se renombre', () => {
    let now = Date.parse('2026-11-17T08:00:00Z');
    const dir = tempDataDir();
    const lists = new ListStore(dir, { now: () => (now += 1000) });
    const rock = lists.create('rock');
    const likes = lists.create('  LIKES ');
    lists.create('Me gústa');
    assert.equal(lists.likesId({ create: true }), likes.id, 'no crea otra: adopta la suya');
    assert.equal(lists.all().length, 3);
    lists.rename(likes.id, 'favoritas de siempre');
    assert.equal(lists.likesId(), likes.id, 'es la apuntada, se llame como se llame');
    assert.equal(new ListStore(dir).likesId(), likes.id);
    assert.equal(lists.summaryOf(lists.get(likes.id)).likes, true);
    assert.equal(lists.summaryOf(lists.get(rock.id)).likes, undefined);
});

test('me gusta: sale la primera de las listas, marcada; las demás siguen por antigüedad', () => {
    let now = Date.parse('2026-11-17T08:00:00Z');
    const lists = new ListStore(tempDataDir(), { now: () => (now += 1000) });
    for (const name of ['rock', 'coche', 'likes', 'gym']) lists.create(name);
    assert.deepEqual(lists.all().map(list => [list.name, list.likes ?? false]), [['likes', true], ['rock', false], ['coche', false], ['gym', false]]);
});

test('me gusta: si la lista va a la papelera deja de serlo; restaurada, vuelve a serlo', () => {
    let now = Date.parse('2026-11-17T08:00:00Z');
    const lists = new ListStore(tempDataDir(), { now: () => (now += 1000) });
    const likes = lists.create('likes');
    lists.create('rock');
    assert.equal(lists.likesId(), likes.id);
    lists.remove(likes.id);
    assert.equal(lists.likesId(), null);
    assert.deepEqual(lists.all().map(list => [list.name, list.likes ?? false]), [['rock', false]]);
    lists.restoreList(lists.trash().lists[0].id);
    assert.equal(lists.likesId(), likes.id);
    // Con la suya en la papelera, el corazón crea otra; la vieja, restaurada después, es ya una lista normal
    lists.remove(likes.id);
    const fresh = lists.likesId({ create: true });
    assert.notEqual(fresh, likes.id);
    lists.restoreList(lists.trash().lists[0].id);
    assert.equal(lists.likesId(), fresh);
    assert.equal(lists.all().filter(list => list.likes).length, 1);
});

test('listas: addTracks con `top` mete las canciones arriba, en su orden; sin él, al final', () => {
    const lists = new ListStore(tempDataDir());
    const a = lists.create('rock');
    lists.addTracks(a.id, [yt(0), yt(1)]);
    assert.equal(lists.addTracks(a.id, [yt(2), yt(3), yt(0)], { top: true }).added, 2);
    lists.addTracks(a.id, [yt(4)]);
    assert.deepEqual(lists.get(a.id).tracks.map(t => t.key.slice(-1)), ['2', '3', '0', '1', '4']);
});

// ------------------------------------------------------------------ la misma canción por otra vía

test('me gusta: reconoce la misma canción venga de Spotify o de YouTube', () => {
    const likes = new LikeSet([
        sp(1, 'Blinding Lights', 'The Weeknd'),
        sp(2, 'Starboy', 'The Weeknd, Daft Punk'),
        sp(3, 'Dreams - 2004 Remaster', 'Fleetwood Mac'),
        sp(4, 'Around the World', 'Daft Punk'),
    ]);
    const same = [
        yt(1, 'The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO'),
        yt(2, 'Blinding Lights', 'The Weeknd - Topic'),
        yt(3, 'Blinding Lights - The Weeknd (Lyrics)', 'Letras HD'),
        yt(4, 'The Weeknd - Starboy ft. Daft Punk (Official Video)', 'TheWeekndVEVO'),
        yt(5, 'The Weeknd — Starboy (feat. Daft Punk) [Official Audio]', 'The Weeknd'),
        yt(6, 'Fleetwood Mac - Dreams (Official Music Video) [4K Remaster]', 'Fleetwood Mac'),
        yt(7, 'Daft Punk - Around The World (Official Music Video Remastered)', 'Daft Punk'),
    ];
    for (const track of same) assert.equal(likes.has(track), true, track.title);
    assert.equal(likes.find(same[3]), sp(2).key, 'dice cuál de la lista es');
});

test('me gusta: otra versión, otro artista o un artista desconocido NO cuentan como la misma', () => {
    const likes = new LikeSet([sp(1, 'Blinding Lights', 'The Weeknd'), yt(8, 'Intro', 'The xx')]);
    const other = [
        yt(1, 'The Weeknd - Blinding Lights (Remix)', 'TheWeekndVEVO'),
        yt(2, 'The Weeknd - Blinding Lights (Live at the BRITs)', 'TheWeekndVEVO'),
        yt(3, 'Blinding Lights (Acoustic)', 'The Weeknd'),
        yt(4, 'Blinding Lights', 'Loud Luxury'),
        yt(5, 'Blinding Lights', null),
        yt(6, 'Intro', 'M83'),
        yt(7, 'Blinding Lights - Piano Cover', 'Peter Bence'),
    ];
    for (const track of other) assert.equal(likes.has(track), false, track.title);
    assert.deepEqual(likeSigs({ title: '', artist: 'Nadie' }), []);
    assert.equal(likes.has({}), false);
});

test('me gusta: una canción de Spotify es la misma que el vídeo del que suena (su coincidencia)', () => {
    const audio = { [sp(1).key]: yt(1).key };
    const audioKeyOf = key => (key.startsWith('sp:') ? audio[key] ?? null : key);
    // Títulos que no se parecen: solo las une la coincidencia guardada
    const likes = new LikeSet([sp(1, 'Canción rara', 'Alguien')], audioKeyOf);
    assert.equal(likes.find(yt(1, 'un vídeo cualquiera', 'Canal')), sp(1).key);
    assert.equal(likes.has(yt(2, 'un vídeo cualquiera', 'Canal')), false);
    // Y al revés: en la lista está el vídeo y se pregunta por la de Spotify
    const byVideo = new LikeSet([yt(1, 'un vídeo cualquiera', 'Canal')], audioKeyOf);
    assert.equal(byVideo.find(sp(1, 'Canción rara', 'Alguien')), yt(1).key);
});

// ------------------------------------------------------------------ API

test('API: el corazón crea «Me gusta», mete las nuevas arriba y no duplica', async () => {
    const s = await startServer();
    try {
        const first = await s.call('PUT', '/api/likes', { track: yt(0), liked: true });
        assert.deepEqual([first.status, first.body.liked, first.body.added, first.body.list.name, first.body.list.count, first.body.list.likes], [200, true, 1, 'Me gusta', 1, true]);
        await s.call('PUT', '/api/likes', { track: yt(1), liked: true });
        const again = await s.call('PUT', '/api/likes', { track: yt(0), liked: true });
        assert.deepEqual([again.body.liked, again.body.added, again.body.list.count], [true, 0, 2]);

        const { lists } = (await s.call('GET', '/api/lists')).body;
        assert.deepEqual(lists.map(list => [list.name, list.likes, list.count]), [['Me gusta', true, 2]]);
        const detail = (await s.call('GET', `/api/lists/${lists[0].id}`)).body.list;
        assert.equal(detail.likes, true);
        assert.deepEqual(detail.tracks.map(t => [t.key.slice(-1), t.liked]), [['1', true], ['0', true]], 'la última marcada, arriba');
    } finally {
        await s.close();
    }
});

test('API: cada canción dice si está en «me gusta»: búsqueda, lista, sesión, cola e historial', async () => {
    const s = await startServer({ search: async () => [yt(0), yt(1)] });
    try {
        const rock = s.lists.create('rock');
        s.lists.addTracks(rock.id, [yt(0), yt(1), yt(2)]);
        await s.call('PUT', '/api/likes', { track: yt(1), liked: true });

        assert.deepEqual((await s.call('GET', '/api/search?q=algo')).body.results.map(t => t.liked), [false, true]);
        assert.deepEqual((await s.call('GET', `/api/lists/${rock.id}`)).body.list.tracks.map(t => t.liked), [false, true, false]);

        const { session } = (await s.call('POST', '/api/session', { listId: rock.id, startKey: yt(1).key })).body;
        assert.deepEqual([session.window.prev.track.liked, session.window.current.track.liked, session.window.next.track.liked], [false, true, false]);
        assert.deepEqual((await s.call('GET', '/api/session/queue?from=0')).body.entries.map(e => e.track.liked), [false, true, false]);

        await s.call('PUT', '/api/session/state', { key: yt(1).key, positionMs: 40_000 });
        assert.deepEqual((await s.call('GET', '/api/history')).body.entries.map(e => [e.track.key.slice(-1), e.track.liked]), [['1', true]]);

        // Al quitar el corazón, la misma sesión lo dice ya
        const off = await s.call('PUT', '/api/likes', { track: yt(1), liked: false });
        assert.deepEqual([off.body.liked, off.body.removed, off.body.list.count], [false, 1, 0]);
        assert.equal((await s.call('GET', '/api/session')).body.session.window.current.track.liked, false);
    } finally {
        await s.close();
    }
});

test('API: con una lista «likes» importada de Spotify, el corazón la usa y reconoce la versión de YouTube', async () => {
    const s = await startServer();
    try {
        const likes = s.lists.create('likes');
        const spotify = sp(1, 'Blinding Lights', 'The Weeknd');
        s.lists.addTracks(likes.id, [spotify, sp(2, 'Starboy', 'The Weeknd, Daft Punk')]);
        const video = yt(1, 'The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO');

        // Ya está (por Spotify): marcar la de YouTube no añade nada
        const on = await s.call('PUT', '/api/likes', { track: video, liked: true });
        assert.deepEqual([on.body.added, on.body.list.id, on.body.list.name, on.body.list.count], [0, likes.id, 'likes', 2]);
        assert.equal((await s.call('GET', '/api/lists')).body.lists.length, 1, 'no se ha creado otra lista');

        // Una nueva entra arriba de las importadas
        await s.call('PUT', '/api/likes', { track: yt(5), liked: true });
        assert.deepEqual(s.lists.get(likes.id).tracks.map(t => t.key), [yt(5).key, spotify.key, sp(2).key]);

        // Quitar el corazón desde el vídeo saca la de Spotify, y va a la papelera (recuperable)
        const off = await s.call('PUT', '/api/likes', { track: video, liked: false });
        assert.deepEqual([off.body.liked, off.body.removed, off.body.list.count], [false, 1, 2]);
        assert.deepEqual(s.lists.get(likes.id).tracks.map(t => t.key), [yt(5).key, sp(2).key]);
        const trash = (await s.call('GET', '/api/trash')).body.tracks;
        assert.deepEqual(trash.map(item => [item.track.key, item.listName]), [[spotify.key, 'likes']]);
        const back = await s.call('POST', '/api/trash/restore', { type: 'track', id: trash[0].id });
        assert.equal(back.body.list.count, 3);

        // Quitar el corazón de algo que no está no hace nada
        const none = await s.call('PUT', '/api/likes', { track: yt(9), liked: false });
        assert.deepEqual([none.status, none.body.removed, none.body.list.count], [200, 0, 3]);
    } finally {
        await s.close();
    }
});

test('API: si la canción está por Spotify y por YouTube, quitar el corazón saca las dos', async () => {
    const s = await startServer();
    try {
        const likes = s.lists.create('likes');
        const video = yt(1, 'The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO');
        s.lists.addTracks(likes.id, [sp(1, 'Blinding Lights', 'The Weeknd'), video, yt(2)]);
        const off = await s.call('PUT', '/api/likes', { track: video, liked: false });
        assert.deepEqual([off.body.removed, off.body.list.count], [2, 1]);
        assert.equal((await s.call('GET', '/api/search?q=x')).body.results[0].liked, false);
    } finally {
        await s.close();
    }
});

test('API: el «me gusta» es de cada usuario', async () => {
    const s = await startServer({ search: async () => [yt(0)] });
    try {
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        await s.call('PUT', '/api/likes', { track: yt(0), liked: true });

        assert.equal((await s.call('GET', '/api/search?q=x')).body.results[0].liked, true);
        assert.equal((await s.call('GET', '/api/search?q=x', undefined, other)).body.results[0].liked, false);
        assert.deepEqual((await s.call('GET', '/api/lists', undefined, other)).body.lists, [], 'a la otra cuenta no se le crea nada');

        const hers = await s.call('PUT', '/api/likes', { track: yt(0), liked: true }, other);
        assert.deepEqual([hers.body.added, hers.body.list.count], [1, 1]);
        assert.notEqual(hers.body.list.id, (await s.call('GET', '/api/lists')).body.lists[0].id);
    } finally {
        await s.close();
    }
});

test('API: el corazón pide una canción válida y decir si se marca o se quita; sin entrar, 401', async () => {
    const s = await startServer();
    try {
        assert.equal((await s.call('PUT', '/api/likes', { liked: true })).body.error, 'bad_track');
        assert.equal((await s.call('PUT', '/api/likes', { track: { key: 'http://127.0.0.1/', title: 'x' }, liked: true })).status, 400);
        assert.equal((await s.call('PUT', '/api/likes', { track: yt(0) })).body.error, 'bad_request');
        assert.equal((await s.call('PUT', '/api/likes', { track: yt(0), liked: 'sí' })).status, 400);
        assert.deepEqual((await s.call('GET', '/api/lists')).body.lists, [], 'nada de eso ha creado la lista');
        assert.equal((await s.api('/api/likes', { method: 'PUT', body: JSON.stringify({ track: yt(0), liked: true }) })).status, 401);
    } finally {
        await s.close();
    }
});

test('API: marcar una canción que puso la radio la deja guardada (ya no es «de la radio»)', async () => {
    const s = await startServer();
    try {
        await s.call('POST', '/api/session', { track: yt(0) });
        assert.equal(s.sessions.appendRadio([yt(1), yt(2)]), 2);
        await s.call('PUT', '/api/likes', { track: yt(1), liked: true });
        const entries = (await s.call('GET', '/api/session/queue?from=0')).body.entries;
        assert.deepEqual(entries.map(e => [e.track.radio ?? false, e.track.saved ?? false, e.track.liked]), [[false, false, false], [true, true, true], [true, false, false]]);
    } finally {
        await s.close();
    }
});
