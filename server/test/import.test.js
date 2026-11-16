import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, parseLink } from '../src/sources.js';
import { MatchStore, cleanTitle, pickMatch, sameArtist } from '../src/matches.js';
import { PendingImports } from '../src/importers.js';
import { startServer, tempDataDir } from './helpers.js';

// Canciones de prueba. YouTube: yt:aaaaaaaaaa0… Spotify: sp:<22 caracteres>
const yt = (n, extra = {}) => ({ key: `yt:aaaaaaaaaa${n}`, platform: 'youtube', title: `Vídeo ${n}`, artist: 'Canal', durationSec: 200, thumb: `https://i.ytimg.com/vi/aaaaaaaaaa${n}/hqdefault.jpg`, ...extra });
const sp = (n, extra = {}) => ({ key: `sp:${'A'.repeat(21)}${n}`, platform: 'spotify', title: `Canción ${n}`, artist: 'Artista', durationSec: 200, thumb: null, ...extra });
const YT_LIST = 'https://www.youtube.com/playlist?list=PLabcdefghij0123456789';
const SP_LIST = 'https://open.spotify.com/intl-es/playlist/37i9dQZF1DWXRqgorJj26U?si=abc';

// ------------------------------------------------------------------ enlaces y claves

test('parseLink reconoce canciones y listas de YouTube y Spotify, y nada más', () => {
    assert.deepEqual(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { kind: 'yt-video', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseLink('https://youtu.be/dQw4w9WgXcQ?t=42'), { kind: 'yt-video', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'), { kind: 'yt-video', id: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseLink(YT_LIST), { kind: 'yt-playlist', id: 'PLabcdefghij0123456789' });
    assert.deepEqual(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij0123456789'), { kind: 'yt-playlist', id: 'PLabcdefghij0123456789', alsoVideo: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'), { kind: 'yt-video', id: 'dQw4w9WgXcQ' }, 'una mezcla con vídeo se queda en el vídeo');
    assert.equal(parseLink('https://www.youtube.com/playlist?list=RDCLAK5uy_abcdefgh').kind, 'yt-mix');
    assert.deepEqual(parseLink(SP_LIST), { kind: 'sp-playlist', id: '37i9dQZF1DWXRqgorJj26U' });
    assert.deepEqual(parseLink('https://open.spotify.com/track/0ofHAoxe9vBkTCp2UQIavz'), { kind: 'sp-track', id: '0ofHAoxe9vBkTCp2UQIavz' });
    for (const bad of ['amen break', 'https://example.com/watch?v=dQw4w9WgXcQ', 'file:///etc/passwd', 'https://open.spotify.com/artist/0ofHAoxe9vBkTCp2UQIavz', 'https://youtube.com.evil.net/watch?v=dQw4w9WgXcQ', '']) {
        assert.equal(parseLink(bad), null, bad);
    }
});

test('parseKey: una canción de Spotify es válida pero no tiene audio propio', () => {
    assert.deepEqual(parseKey('sp:0ofHAoxe9vBkTCp2UQIavz'), { key: 'sp:0ofHAoxe9vBkTCp2UQIavz', platform: 'spotify', url: null });
    assert.equal(parseKey('sp:corto'), null);
});

test('cleanTitle quita coletillas de edición, no las que hacen otra canción', () => {
    assert.equal(cleanTitle('Dreams - 2004 Remaster'), 'Dreams');
    assert.equal(cleanTitle('Heroes (2017 Remaster)'), 'Heroes');
    assert.equal(cleanTitle('Song 2 - Live at Wembley'), 'Song 2 - Live at Wembley');
    assert.equal(cleanTitle('Blue Monday (Remix)'), 'Blue Monday (Remix)');
});

// ------------------------------------------------------------------ coincidencias

test('coincidencia: elige el resultado de duración más cercana, lo guarda y no vuelve a buscar', async () => {
    const dir = tempDataDir();
    const queries = [];
    // El primero no se parece; el segundo es el videoclip (5 s más); el tercero y el cuarto clavan la duración
    const search = async query => { queries.push(query); return [yt(1, { durationSec: 600 }), yt(3, { durationSec: 205 }), yt(2, { durationSec: 200 }), yt(4, { durationSec: 200 })]; };
    const store = new MatchStore(dir, { search });
    const track = sp(1, { title: 'Dreams - 2004 Remaster', artist: 'Fleetwood Mac' });
    assert.equal(await store.resolve(track.key), null, 'una canción que nadie ha apuntado no se puede buscar');
    store.remember([track]);
    assert.equal(store.decorate(track).match, 'pending');
    const [a, b] = await Promise.all([store.resolve(track.key), store.resolve(track.key)]);
    assert.equal(a.yt.key, yt(2).key, 'la duración más cercana y, a igualdad, la que salía antes');
    assert.equal(a, b);
    assert.deepEqual(queries, ['Fleetwood Mac Dreams'], 'una sola búsqueda, con el título limpio');
    const shown = store.decorate(track);
    assert.deepEqual([shown.match, shown.thumb], ['auto', yt(2).thumb]);
    assert.equal((await new MatchStore(dir, { search }).resolve(track.key)).yt.key, yt(2).key, 'sobrevive a un reinicio');
    assert.equal(queries.length, 1);
});

test('coincidencia: el canal del propio artista va primero; dentro de él, la duración más cercana', () => {
    const c = (n, artist, durationDiff) => ({ ...yt(n, { artist }), durationDiff });
    // El vídeo con letra clava la duración, pero existe el oficial: gana el oficial
    assert.equal(pickMatch([c(1, 'Queen Official', 4), c(2, 'GlyphoricVibes', 0)], 'Queen').key, yt(1).key);
    // Dos del canal del artista: gana el audio del disco (duración exacta) frente al videoclip
    assert.equal(pickMatch([c(1, 'Fleetwood Mac', 6), c(2, 'Fleetwood Mac', 0), c(3, 'Otro', 0)], 'Fleetwood Mac').key, yt(2).key);
    // Sin canal del artista entre los parecidos: la duración más cercana
    assert.equal(pickMatch([c(1, 'TopPop', 3), c(2, 'Timeless Music', 1)], 'Blondie').key, yt(2).key);
    // El oficial dura muy distinto (otra versión): no cuenta, se elige entre los parecidos
    assert.equal(pickMatch([c(1, 'Queen Official', 90), c(2, 'Cualquiera', 2)], 'Queen').key, yt(2).key);
    // Nada parecido: el primer resultado. Sin resultados: nada.
    assert.equal(pickMatch([c(1, 'A', 200), c(2, 'B', null)], 'X').key, yt(1).key);
    assert.equal(pickMatch([], 'X'), null);
    assert.ok(sameArtist('NirvanaVEVO', 'Nirvana') && sameArtist('AC/DC', 'AC/DC') && sameArtist('Karol G', 'KAROL G, Judeline'));
    assert.ok(!sameArtist('Timeless Music', 'The Animals') && !sameArtist('Canal', ''));
});

test('coincidencia: si el buscador vuelve vacío una vez, se pregunta otra', async () => {
    let calls = 0;
    const store = new MatchStore(tempDataDir(), { search: async () => (++calls === 1 ? [] : [yt(5)]) });
    store.remember([sp(1)]);
    assert.equal((await store.resolve(sp(1).key)).yt.key, yt(5).key);
    assert.equal(calls, 2);
});

test('coincidencia: sin duración parecida se queda con el primero; sin resultados, sin coincidencia', async () => {
    const far = new MatchStore(tempDataDir(), { search: async () => [yt(1, { durationSec: 900 }), yt(2, { durationSec: 30 })] });
    far.remember([sp(1)]);
    assert.equal((await far.resolve(sp(1).key)).yt.key, yt(1).key);
    const none = new MatchStore(tempDataDir(), { search: async () => [] });
    none.remember([sp(1)]);
    assert.equal(await none.resolve(sp(1).key), null);
    assert.equal(none.decorate(sp(1)).match, 'pending');
});

test('coincidencia elegida a mano', async () => {
    const store = new MatchStore(tempDataDir(), { search: async () => [yt(1), yt(2)] });
    store.remember([sp(1)]);
    await store.resolve(sp(1).key);
    assert.equal(store.choose(sp(1).key, yt(2)).yt.key, yt(2).key);
    assert.equal(store.decorate(sp(1)).match, 'manual');
    assert.equal((await store.resolve(sp(1).key)).yt.key, yt(2).key, 'la elegida a mano no se vuelve a buscar');
    assert.equal(store.choose(sp(1).key, sp(2)), null, 'solo vale una canción de YouTube');
    assert.equal(store.choose('sp:desconocida', yt(1)), null);
});

test('las listas leídas caducan y no se acumulan', () => {
    let now = 0;
    const pending = new PendingImports({ ttlMs: 1000, max: 2, now: () => now });
    const a = pending.put('a');
    assert.equal(pending.get(a), 'a');
    now = 2000;
    assert.equal(pending.get(a), null);
    const [b, c, d] = ['b', 'c', 'd'].map(value => pending.put(value));
    assert.deepEqual([pending.get(b), pending.get(c), pending.get(d)], [null, 'c', 'd']);
});

// ------------------------------------------------------------------ por la API

const importers = {
    youtubePlaylist: async () => ({ platform: 'youtube', title: 'Lista de YouTube', thumb: yt(0).thumb, truncated: false, tracks: [yt(0), yt(1), yt(2), yt(1), { key: 'malo', title: 'x' }] }),
    spotifyPlaylist: async () => ({ platform: 'spotify', title: 'Breakcore essentials', thumb: 'https://i.scdn.co/image/x', truncated: true, tracks: [sp(1), sp(2)] }),
    spotifyTrack: async id => ({ key: `sp:${id}`, platform: 'spotify', title: 'Suelta', artist: 'Alguien', durationSec: 180, thumb: 'https://i.scdn.co/image/y' }),
    youtubeVideo: async id => ({ key: `yt:${id}`, platform: 'youtube', title: 'Un vídeo', artist: 'Canal', durationSec: 100, thumb: null }),
};
const newList = async (s, name = 'breakcore') => (await s.call('POST', '/api/lists', { name })).body.list;

test('importar de YouTube: se enseña qué trae, se confirma y repetir añade solo lo nuevo', async () => {
    const s = await startServer({ importers });
    try {
        const list = await newList(s);
        await s.call('POST', `/api/lists/${list.id}/tracks`, { track: yt(1) });
        const preview = (await s.call('POST', '/api/import/preview', { listId: list.id, url: YT_LIST })).body;
        assert.deepEqual(
            [preview.platform, preview.title, preview.count, preview.newCount, preview.already, preview.truncated],
            ['youtube', 'Lista de YouTube', 3, 2, 1, false], 'los repetidos y los no válidos de la lista de fuera no cuentan',
        );
        assert.equal((await s.call('GET', `/api/lists/${list.id}`)).body.list.count, 1, 'ver qué trae no añade nada');
        const done = (await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.importId })).body;
        assert.deepEqual([done.added, done.list.count], [2, 3]);
        const again = (await s.call('POST', '/api/import/preview', { listId: list.id, url: YT_LIST })).body;
        assert.deepEqual([again.newCount, again.already], [0, 3]);
        assert.equal((await s.call('POST', `/api/lists/${list.id}/import`, { importId: again.importId })).body.added, 0);
    } finally { await s.close(); }
});

test('importar: enlaces que no valen y confirmaciones que no corresponden', async () => {
    const s = await startServer({ importers: { ...importers, spotifyPlaylist: async () => { throw new Error('Spotify no responde'); } } });
    try {
        const list = await newList(s);
        const other = await newList(s, 'otra');
        const preview = url => s.call('POST', '/api/import/preview', { listId: list.id, url });
        assert.deepEqual([(await preview('hola')).status, (await preview('hola')).body.error], [400, 'bad_link']);
        assert.equal((await preview('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).body.error, 'not_a_playlist');
        assert.equal((await preview('https://www.youtube.com/playlist?list=RDCLAK5uy_abcdefgh')).body.error, 'mix_not_supported');
        assert.deepEqual([(await preview(SP_LIST)).status, (await preview(SP_LIST)).body.error], [502, 'import_failed']);
        assert.equal((await s.call('POST', '/api/import/preview', { listId: 'l_0000000000', url: YT_LIST })).status, 404);
        const ok = (await preview(YT_LIST)).body;
        assert.equal((await s.call('POST', `/api/lists/${other.id}/import`, { importId: ok.importId })).status, 410, 'la confirmación es para la lista que se pidió');
        assert.equal((await s.call('POST', `/api/lists/${list.id}/import`, { importId: 'i_noexiste' })).status, 410);
        assert.equal((await s.api('/api/import/preview', { method: 'POST', body: '{}' })).status, 401);
    } finally { await s.close(); }
});

test('importar de Spotify: las canciones suenan por su coincidencia en YouTube, buscada al primer uso', async () => {
    const searched = [];
    const matchSearch = async query => { searched.push(query); return [yt(7, { durationSec: 198 }), yt(8, { durationSec: 260 })]; };
    const s = await startServer({ importers, matchSearch });
    try {
        const list = await newList(s);
        const preview = (await s.call('POST', '/api/import/preview', { listId: list.id, url: SP_LIST })).body;
        assert.deepEqual([preview.platform, preview.count, preview.truncated], ['spotify', 2, true]);
        await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.importId });
        let tracks = (await s.call('GET', `/api/lists/${list.id}`)).body.list.tracks;
        assert.deepEqual(tracks.map(t => [t.platform, t.match, t.thumb]), [['spotify', 'pending', null], ['spotify', 'pending', null]]);
        assert.equal(searched.length, 0, 'importar no busca nada todavía');

        const { body: { session } } = await s.call('POST', '/api/session', { listId: list.id });
        const res = await s.api(`/api/stream/${sp(1).key}`, { token: s.token });
        assert.equal(res.status, 200);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), s.bytes);
        assert.deepEqual(s.open.calls.slice(0, 1), ['https://www.youtube.com/watch?v=aaaaaaaaaa7'], 'el audio sale de la coincidencia');
        assert.ok(s.cache.items.has(yt(7).key) && !s.cache.items.has(sp(1).key), 'en memoria se guarda por la clave de YouTube');
        assert.ok(s.cache.pinned.has(yt(7).key), 'y queda fijada mientras suena');
        assert.equal(session.window.current.track.key, sp(1).key, 'la sesión sigue hablando de la canción de Spotify');

        tracks = (await s.call('GET', `/api/lists/${list.id}`)).body.list.tracks;
        assert.deepEqual([tracks[0].match, tracks[0].thumb], ['auto', yt(7).thumb]);
        assert.equal((await s.call('GET', '/api/session')).body.session.window.current.track.match, 'auto');
    } finally { await s.close(); }
});

test('cambiar coincidencia: ver candidatos, elegir uno y que suene ese', async () => {
    const s = await startServer({ importers, matchSearch: async () => [yt(7, { durationSec: 200 }), yt(8, { durationSec: 260 })] });
    try {
        const list = await newList(s);
        const preview = (await s.call('POST', '/api/import/preview', { listId: list.id, url: SP_LIST })).body;
        await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.importId });
        const key = encodeURIComponent(sp(1).key);
        await (await s.api(`/api/stream/${sp(1).key}`, { token: s.token })).arrayBuffer();

        const info = (await s.call('GET', `/api/match/${key}`)).body;
        assert.deepEqual([info.current.key, info.auto, info.candidates.map(c => [c.key, c.durationDiff])], [yt(7).key, true, [[yt(7).key, 0], [yt(8).key, 60]]]);
        assert.equal((await s.call('PUT', `/api/match/${key}`, { track: sp(2) })).status, 400);
        assert.equal((await s.call('PUT', `/api/match/${key}`, { track: yt(8) })).body.current.key, yt(8).key);
        assert.equal((await s.call('GET', `/api/lists/${list.id}`)).body.list.tracks[0].match, 'manual');
        await (await s.api(`/api/stream/${sp(1).key}`, { token: s.token })).arrayBuffer();
        assert.equal(s.open.calls.at(-1), 'https://www.youtube.com/watch?v=aaaaaaaaaa8');
        assert.equal((await s.call('GET', '/api/match/sp%3Adesconocida')).status, 404);
    } finally { await s.close(); }
});

test('una canción de Spotify sin nada parecido en YouTube: 502 con mensaje, sin extraer', async () => {
    const s = await startServer({ importers, matchSearch: async () => [] });
    try {
        await s.call('POST', '/api/session', { track: sp(1) });
        const res = await s.api(`/api/stream/${sp(1).key}`, { token: s.token });
        assert.deepEqual([res.status, (await res.json()).error], [502, 'no_match']);
        assert.equal(s.open.calls.length, 0);
    } finally { await s.close(); }
});

test('buscador: un enlace de canción da esa canción; uno de lista avisa de que se importa', async () => {
    const s = await startServer({ importers, matchSearch: async () => [yt(7)] });
    try {
        const search = async q => (await s.call('GET', `/api/search?q=${encodeURIComponent(q)}`)).body;
        assert.deepEqual((await search('https://youtu.be/dQw4w9WgXcQ')).results.map(t => t.key), ['yt:dQw4w9WgXcQ']);
        const fromSpotify = (await search('https://open.spotify.com/track/0ofHAoxe9vBkTCp2UQIavz')).results;
        assert.deepEqual(fromSpotify.map(t => [t.key, t.platform, t.match]), [['sp:0ofHAoxe9vBkTCp2UQIavz', 'spotify', 'pending']]);
        assert.ok(s.matches.get('sp:0ofHAoxe9vBkTCp2UQIavz'), 'queda apuntada para poder buscar su coincidencia al reproducirla');
        assert.deepEqual(await search(YT_LIST), { results: [], hint: 'playlist' });
        assert.deepEqual(await search('https://example.com/cancion'), { results: [], hint: 'bad_link' });
        assert.equal((await search('amen break')).results[0].title, 'resultado de amen break', 'el texto normal sigue buscando');
    } finally { await s.close(); }
});

// ------------------------------------------------------------------ SoundCloud

test('SoundCloud: enlaces, claves, importar una lista y audio pedido para reenvolver', async () => {
    assert.deepEqual(parseLink('https://soundcloud.com/forss/flickermood?si=x&utm_source=clipboard'), { kind: 'sc-track', user: 'forss', slug: 'flickermood' });
    assert.deepEqual(parseLink('https://m.soundcloud.com/forss/sets/soulhack'), { kind: 'sc-playlist', user: 'forss', slug: 'soulhack' });
    assert.deepEqual(parseLink('https://on.soundcloud.com/AbCd1234'), { kind: 'sc-short', id: 'AbCd1234' });
    for (const bad of ['https://soundcloud.com/discover', 'https://soundcloud.com/forss', 'https://soundcloud.com/forss/sets', 'https://soundcloud.com/forss/likes', 'https://soundcloud.com/forss/flickermood/s-AbCdEf', 'https://on.soundcloud.com/a/b']) {
        assert.equal(parseLink(bad), null, bad);
    }
    assert.deepEqual(parseKey('sc:293'), { key: 'sc:293', platform: 'soundcloud', url: 'https://api.soundcloud.com/tracks/293', aacToAdts: true });
    assert.equal(parseKey('sc:abc'), null);

    const sc = n => ({ key: `sc:${n}`, platform: 'soundcloud', title: `Pista ${n}`, artist: 'Forss', durationSec: 214, thumb: 'https://i1.sndcdn.com/x.jpg' });
    const s = await startServer({
        importers: {
            ...importers,
            soundcloudTrack: async () => sc(293),
            soundcloudSet: async () => ({ platform: 'soundcloud', title: 'Soulhack', thumb: null, truncated: false, tracks: [sc(290), sc(291)] }),
            soundcloudShort: async code => ({ Lista123: { kind: 'sc-playlist', user: 'forss', slug: 'soulhack' }, Cancion1: { kind: 'sc-track', user: 'forss', slug: 'flickermood' } }[code] ?? null),
        },
    });
    try {
        const search = async q => (await s.call('GET', `/api/search?q=${encodeURIComponent(q)}`)).body;
        assert.deepEqual((await search('https://soundcloud.com/forss/flickermood')).results.map(t => [t.key, t.platform]), [['sc:293', 'soundcloud']]);
        assert.deepEqual((await search('https://on.soundcloud.com/Cancion1')).results.map(t => t.key), ['sc:293'], 'el enlace corto se sigue');
        assert.deepEqual(await search('https://on.soundcloud.com/Lista123'), { results: [], hint: 'playlist' });
        assert.deepEqual(await search('https://on.soundcloud.com/NoExiste9'), { results: [], hint: 'bad_link' });

        const list = await newList(s);
        const preview = (await s.call('POST', '/api/import/preview', { listId: list.id, url: 'https://on.soundcloud.com/Lista123' })).body;
        assert.deepEqual([preview.platform, preview.title, preview.count, preview.newCount], ['soundcloud', 'Soulhack', 2, 2]);
        assert.equal((await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.importId })).body.added, 2);
        assert.equal((await s.call('POST', '/api/import/preview', { listId: list.id, url: 'https://soundcloud.com/forss/flickermood' })).body.error, 'not_a_playlist');

        await (await s.api('/api/stream/sc:290', { token: s.token })).arrayBuffer();
        assert.deepEqual([s.open.calls.at(-1), s.open.options.at(-1)], ['https://api.soundcloud.com/tracks/290', { aacToAdts: true }]);
        await (await s.api('/api/stream/yt:dQw4w9WgXcQ', { token: s.token })).arrayBuffer();
        assert.deepEqual(s.open.options.at(-1), { aacToAdts: undefined }, 'lo de YouTube se sirve tal cual');
    } finally { await s.close(); }
});
