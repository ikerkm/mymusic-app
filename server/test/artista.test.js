import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { YtMusic, bigThumb, dedupeReleases, kindOf, listenersOf, nameMatch, pickArtists, sameName, words } from '../src/ytmusic.js';
import { startServer } from './helpers.js';

// Página de artista y de disco (§18), con un doble de YouTube Music: sin red

const id = (prefix, n) => `${prefix}${String(n).padStart(11 - prefix.length, '0')}`;
const ARTIST = 'UC' + 'a'.repeat(22);
const OTHER = 'UC' + 'b'.repeat(22);
const FEAT = 'UC' + 'c'.repeat(22);
const ALBUM = 'MPREb_album0001';
const EMPTY_ALBUM = 'MPREb_vacio0001';

const song = (n, artist = 'Halcyon Drift') => ({ key: `yt:${id('seed', n)}`, platform: 'youtube', title: `Canción ${n}`, artist, durationSec: 200 + n, thumb: `https://lh3.googleusercontent.com/s${n}=w544-h544-l90-rj` });

/** Doble del cliente de YouTube Music. `calls` apunta cada llamada; `fail` hace fallar las que se digan. */
function fakeClient({ fail = new Set(), delayMs = 0 } = {}) {
    const calls = [];
    const pages = {
        [ARTIST]: {
            id: ARTIST, name: 'Halcyon Drift', image: 'https://lh3.googleusercontent.com/banner=w1080-h450',
            albums: [{ id: ALBUM, title: 'Paper Satellites', kind: 'album', year: 2023, thumb: 'https://lh3.googleusercontent.com/ps=w544-h544-l90-rj' }],
            singles: [{ id: 'MPREb_single001', title: 'Low Orbit', kind: 'single', year: 2024, thumb: null }],
            related: [{ id: OTHER, name: 'Kettle Drift', listeners: '220 K', thumb: null }],
            songs: Array.from({ length: 30 }, (_, i) => song(i + 1)),
        },
        [FEAT]: { id: FEAT, name: 'Sora Kite', image: null, albums: [], singles: [], related: [], songs: [song(90, 'Sora Kite')] },
    };
    const albums = {
        [ALBUM]: {
            id: ALBUM, title: 'Paper Satellites', kind: 'album', year: 2023, thumb: 'https://lh3.googleusercontent.com/ps=w544-h544-l90-rj',
            artists: [{ id: ARTIST, name: 'Halcyon Drift' }],
            tracks: [1, 2, 3, 4].map(n => ({ ...song(n), thumb: 'https://lh3.googleusercontent.com/ps=w544-h544-l90-rj' })),
        },
        [EMPTY_ALBUM]: { id: EMPTY_ALBUM, title: 'Nada', kind: 'ep', year: 2020, thumb: null, artists: [], tracks: [] },
    };
    const search = {
        'halcyon drift': [
            { id: ARTIST, name: 'Halcyon Drift', listeners: '4,1 M', thumb: 'https://lh3.googleusercontent.com/hd=w544-h544-l90-rj' },
            { id: 'UC' + 'd'.repeat(22), name: 'The Weeknd', listeners: '240 M', thumb: null },
            { id: 'UC' + 'e'.repeat(22), name: 'Halcyon Days', listeners: '220 K', thumb: null },
        ],
        'sora kite': [{ id: FEAT, name: 'Sora Kite', listeners: '1 M', thumb: null }],
        'amen break 174': [{ id: 'UC' + 'f'.repeat(22), name: 'Amen', listeners: '5 K', thumb: null }],
    };
    const step = async (what, arg) => {
        calls.push(`${what}:${arg}`);
        if (delayMs) await sleep(delayMs);
        if (fail.has(what)) throw new Error(`YouTube Music no responde (${what})`);
    };
    return {
        calls,
        fail,
        searchArtists: async query => { await step('search', query); return search[words(query).join(' ')] ?? []; },
        artist: async artistId => { await step('artist', artistId); return pages[artistId] ? structuredClone(pages[artistId]) : null; },
        album: async albumId => { await step('album', albumId); return albums[albumId] ? structuredClone(albums[albumId]) : null; },
    };
}

// Mezclas de YouTube para la radio: la de cada semilla trae 20 canciones de otros grupos
function fakeMixes() {
    const calls = [];
    const fetchMix = async ytId => {
        calls.push(ytId);
        const n = Number(ytId.slice(4));
        const entries = [{ id: ytId, title: `Canción ${n}`, uploader: 'Halcyon Drift', duration: 200 }];
        for (let i = 0; i < 20; i++) entries.push({ id: id(`mix${n}x`, i), title: `Banda ${n}-${i} - Tema ${i}`, uploader: `Banda ${n}-${i}`, duration: 190 });
        return entries;
    };
    fetchMix.calls = calls;
    return fetchMix;
}

// ------------------------------------------------------------------ piezas sueltas

test('fila «Artistas»: solo sale si lo buscado se parece de verdad a un artista', () => {
    assert.equal(nameMatch('Daft Punk', 'Daft Punk'), 'strong');
    assert.equal(nameMatch('daft punk get lucky', 'Daft Punk'), 'strong');      // el nombre es la mitad de la búsqueda
    assert.equal(nameMatch('rosal', 'ROSALÍA'), 'strong');                     // se está escribiendo
    assert.equal(nameMatch('rosalia', 'Rosalía'), 'strong');                   // sin tilde
    assert.equal(nameMatch('acdc', 'AC/DC'), 'strong');                        // sin signos
    assert.equal(nameMatch('米津玄師', '米津玄師'), 'strong');                  // otros alfabetos
    assert.equal(nameMatch('amen break 174', 'Amen'), 'weak');                 // una palabra de tres no basta
    assert.equal(nameMatch('halcyon drift', 'Halcyon Days'), 'weak');
    assert.equal(nameMatch('halcyon drift', 'The Weeknd'), null);
    assert.equal(nameMatch('', 'Air'), null);

    const results = [{ name: 'Halcyon Drift' }, { name: 'The Weeknd' }, { name: 'Halcyon Days' }, { name: 'Drift Halcyon' }, { name: 'Halcyon' }];
    // «Halcyon» a secas es la mitad de lo buscado: también se parece de verdad
    assert.deepEqual(pickArtists('halcyon drift', results).map(a => a.name), ['Halcyon Drift', 'Drift Halcyon', 'Halcyon']);
    assert.deepEqual(pickArtists('halcyon drift', results, 4).map(a => a.name), ['Halcyon Drift', 'Drift Halcyon', 'Halcyon', 'Halcyon Days']);
    assert.deepEqual(pickArtists('amen break 174', [{ name: 'Amen' }, { name: 'Breakbeat' }]), []);
    assert.deepEqual(pickArtists('air', [{ name: 'Air' }, { name: 'Air Supply' }]).map(a => a.name), ['Air', 'Air Supply']);
});

test('nombres, oyentes, tipos de lanzamiento y carátulas', () => {
    assert.ok(sameName('Extremoduro', 'Extremoduro (Oficial)'));
    assert.ok(sameName('Kettle Drift Official', 'Kettle Drift'));
    assert.ok(sameName('Beyoncé', 'BEYONCE'));
    assert.ok(!sameName('Air', 'Air Supply'));                                   // corto: tiene que ser igual
    assert.ok(!sameName('Rosalía', 'Rosalía Iglesias Tribute Band Oficial'));
    assert.equal(listenersOf('Artista • 65,2 M usuarios mensuales'), '65,2 M');
    assert.equal(listenersOf('536 K usuarios mensuales'), '536 K');
    assert.equal(listenersOf('Artista'), null);
    assert.equal(kindOf('Álbum • 2013', 'single'), 'album');
    assert.equal(kindOf('Single • 2023', 'album'), 'single');
    assert.equal(kindOf('EP • 1997', 'album'), 'ep');
    assert.equal(kindOf('2013', 'album'), 'album');
    assert.deepEqual(dedupeReleases([
        { kind: 'single', title: 'Human After All', year: 2005 }, { kind: 'single', title: 'Human After All', year: 2005 },
        { kind: 'single', title: 'Human After All (Medley)', year: 2005 }, { kind: 'album', title: 'Human After All', year: 2005 },
    ]).length, 3);
    assert.equal(bigThumb('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj'), 'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj');
    assert.equal(bigThumb('https://yt3.googleusercontent.com/abc=w120-h120-l90-rj'), 'https://yt3.googleusercontent.com/abc=w544-h544-l90-rj');
    assert.equal(bigThumb('https://i.ytimg.com/vi/x/hqdefault.jpg'), 'https://i.ytimg.com/vi/x/hqdefault.jpg');
    assert.equal(bigThumb('http://inseguro/x.jpg'), null);
});

test('YtMusic: guarda cada respuesta un día, junta peticiones iguales y no guarda los fallos', async () => {
    const client = fakeClient({ delayMs: 20 });
    let now = 0;
    const ytm = new YtMusic({ client, now: () => now });
    const [a, b] = await Promise.all([ytm.album(ALBUM), ytm.album(ALBUM)]);
    assert.equal(a.title, 'Paper Satellites');
    assert.equal(b.tracks.length, 4);
    await ytm.album(ALBUM);
    assert.equal(client.calls.filter(c => c === `album:${ALBUM}`).length, 1, 'dos a la vez y una tercera: una sola llamada');
    now += 24 * 60 * 60 * 1000 + 1;
    await ytm.album(ALBUM);
    assert.equal(client.calls.filter(c => c === `album:${ALBUM}`).length, 2, 'pasado un día se vuelve a leer');

    client.fail.add('artist');
    await assert.rejects(ytm.artist(ARTIST), /no responde/);
    client.fail.delete('artist');
    assert.equal((await ytm.artist(ARTIST)).name, 'Halcyon Drift', 'un fallo no se queda guardado');

    // Identificadores que no son de YouTube Music: ni se pregunta
    const before = client.calls.length;
    assert.equal(await ytm.artist('../../etc'), null);
    assert.equal(await ytm.album('PLnoesundisco'), null);
    assert.equal(client.calls.length, before);
});

test('YtMusic: la página del artista lleva sus oyentes y su foto, que salen de la búsqueda', async () => {
    const client = fakeClient();
    const ytm = new YtMusic({ client });
    const page = await ytm.artist(ARTIST);
    assert.equal(page.listeners, '4,1 M');
    assert.equal(page.thumb, 'https://lh3.googleusercontent.com/hd=w544-h544-l90-rj');
    assert.ok(client.calls.includes('search:Halcyon Drift'), 'si no lo conocía, lo busca por su nombre');
    // Uno que salió como «parecido» ya se conoce: no hace falta buscarlo
    assert.equal((await ytm.findArtist('Kettle Drift')), null, 'en la búsqueda doble no existe');
    assert.equal((await ytm.findArtist('Halcyon Drift')).id, ARTIST);
    assert.equal(await ytm.findArtist('Un canal de letras cualquiera'), null);
});

// ------------------------------------------------------------------ API

test('API: Buscar trae la fila «Artistas» solo cuando lo escrito es un artista', async () => {
    const client = fakeClient();
    const s = await startServer({ ytmusicClient: client });
    try {
        const hit = await s.call('GET', '/api/search?q=halcyon%20drift');
        assert.equal(hit.status, 200);
        assert.equal(hit.body.results.length, 1, 'las canciones, como siempre');
        assert.deepEqual(hit.body.artists.map(a => a.name), ['Halcyon Drift', 'Halcyon Days']);
        assert.deepEqual(Object.keys(hit.body.artists[0]).sort(), ['id', 'listeners', 'name', 'thumb']);
        assert.deepEqual((await s.call('GET', '/api/search?q=amen%20break%20174')).body.artists, []);
        // Un enlace pegado no pregunta a YouTube Music
        const before = client.calls.length;
        await s.call('GET', '/api/search?q=https%3A%2F%2Fexample.com%2Fx');
        assert.equal(client.calls.length, before);
        // Si YouTube Music falla, la búsqueda sale igual, sin la fila
        client.fail.add('search');
        const failed = await s.call('GET', '/api/search?q=sora%20kite');
        assert.equal(failed.status, 200);
        assert.equal(failed.body.results.length, 1);
        assert.deepEqual(failed.body.artists, []);
    } finally {
        await s.close();
    }
});

test('API: si YouTube Music tarda, Buscar no lo espera', async () => {
    const s = await startServer({ ytmusicClient: fakeClient({ delayMs: 400 }), artistsWaitMs: 50 });
    try {
        const started = Date.now();
        const { status, body } = await s.call('GET', '/api/search?q=halcyon%20drift');
        assert.equal(status, 200);
        assert.deepEqual(body.artists, []);
        assert.ok(Date.now() - started < 350, `tardó ${Date.now() - started} ms`);
    } finally {
        await s.close();
    }
});

test('API: página del artista, sus canciones y el disco', async () => {
    const client = fakeClient();
    const s = await startServer({ ytmusicClient: client });
    try {
        // La primera de sus más escuchadas está en el «me gusta»
        const likes = s.lists.create('likes');
        s.lists.addTracks(likes.id, [song(1)]);

        const { status, body } = await s.call('GET', `/api/artist/${ARTIST}`);
        assert.equal(status, 200);
        const artist = body.artist;
        assert.equal(artist.name, 'Halcyon Drift');
        assert.equal(artist.listeners, '4,1 M');
        assert.equal(artist.songsCount, 30);
        assert.equal(artist.top.length, 5);
        assert.equal(artist.top[0].liked, true);
        assert.equal(artist.top[1].liked, false);
        assert.equal(artist.songs, undefined, 'la lista entera va aparte');
        assert.deepEqual(artist.albums.map(a => a.title), ['Paper Satellites']);
        assert.deepEqual(artist.singles.map(a => a.kind), ['single']);
        assert.deepEqual(artist.related, [{ id: OTHER, name: 'Kettle Drift', listeners: '220 K', thumb: null }]);

        const songs = (await s.call('GET', `/api/artist/${ARTIST}/songs`)).body.list;
        assert.equal(songs.count, 30);
        assert.equal(songs.tracks.length, 30);
        assert.equal(songs.name, 'Halcyon Drift');
        assert.equal(songs.durationSec, Array.from({ length: 30 }, (_, i) => 201 + i).reduce((a, b) => a + b));

        const album = (await s.call('GET', `/api/album/${ALBUM}`)).body.album;
        assert.equal(album.title, 'Paper Satellites');
        assert.equal(album.count, 4);
        assert.deepEqual(album.artists, [{ id: ARTIST, name: 'Halcyon Drift' }]);
        assert.equal(album.tracks[0].liked, true);

        assert.equal((await s.call('GET', '/api/artist/noesunid')).status, 400);
        assert.equal((await s.call('GET', '/api/album/OLAK5uy_x')).status, 400);
        assert.equal((await s.call('GET', `/api/artist/${'UC' + 'z'.repeat(22)}`)).status, 404);
        assert.equal((await s.call('GET', '/api/album/MPREb_noexiste1')).status, 404);
        client.fail.add('album');
        const failed = await s.call('GET', '/api/album/MPREb_otro00001');
        assert.deepEqual(failed, { status: 502, body: { error: 'ytmusic_failed' } });
        // Sin sesión no se ve nada
        assert.equal((await s.api(`/api/artist/${ARTIST}`)).status, 401);
    } finally {
        await s.close();
    }
});

test('API: sin YouTube Music, las rutas de artista y disco no existen', async () => {
    const s = await startServer();
    try {
        assert.equal((await s.call('GET', `/api/artist/${ARTIST}`)).status, 404);
        assert.equal((await s.call('POST', '/api/session', { album: ALBUM })).status, 404);
        assert.equal((await s.call('GET', '/api/search?q=halcyon')).body.artists.length, 0);
    } finally {
        await s.close();
    }
});

test('API: «Guardar como lista» copia el disco a una lista nueva', async () => {
    const s = await startServer({ ytmusicClient: fakeClient() });
    try {
        const { status, body } = await s.call('POST', `/api/album/${ALBUM}/save`, {});
        assert.equal(status, 201);
        assert.equal(body.list.name, 'Paper Satellites');
        assert.equal(body.list.count, 4);
        const saved = s.lists.get(body.list.id);
        assert.deepEqual(saved.tracks.map(t => t.key), [1, 2, 3, 4].map(n => `yt:${id('seed', n)}`));
        assert.equal(saved.tracks[0].artist, 'Halcyon Drift');

        const named = await s.call('POST', `/api/album/${ALBUM}/save`, { name: 'para el coche' });
        assert.equal(named.body.list.name, 'para el coche');
        assert.equal((await s.call('POST', `/api/album/${ALBUM}/save`, { name: '  ' })).status, 400);
        assert.equal((await s.call('POST', `/api/album/${EMPTY_ALBUM}/save`, {})).body.error, 'empty_list');
        assert.equal((await s.call('GET', '/api/lists')).body.lists.length, 2);
    } finally {
        await s.close();
    }
});

test('API: «Ir al artista» encuentra los artistas de una canción', async () => {
    const s = await startServer({ ytmusicClient: fakeClient() });
    const of = q => s.call('GET', `/api/artists/of?${new URLSearchParams(q)}`);
    try {
        // De Spotify (o de un disco de YouTube Music): varios artistas separados por comas
        const both = await of({ key: 'sp:4uLU6hMCjMI75M1A2tKUQC', title: 'Signal Fade', artist: 'Halcyon Drift, Sora Kite' });
        assert.deepEqual(both.body.artists.map(a => a.id), [ARTIST, FEAT]);
        // De YouTube: un canal de letras no es el artista; se saca del título
        const lyrics = await of({ key: `yt:${id('lyr', 1)}`, title: 'Halcyon Drift - Glass Engine (Lyrics)', artist: 'LyricsVault' });
        assert.deepEqual(lyrics.body.names, ['Halcyon Drift']);
        assert.deepEqual(lyrics.body.artists.map(a => a.name), ['Halcyon Drift']);
        // Canal automático «X - Topic»
        assert.deepEqual((await of({ key: `yt:${id('top', 1)}`, title: 'Glass Engine', artist: 'Halcyon Drift - Topic' })).body.names, ['Halcyon Drift']);
        // Nadie en YouTube Music se llama así
        assert.deepEqual((await of({ key: `yt:${id('abc', 1)}`, title: 'Un vídeo', artist: 'Un canal cualquiera' })).body.artists, []);
        assert.equal((await of({ key: 'nada', title: 'x', artist: 'y' })).status, 400);
    } finally {
        await s.close();
    }
});

test('API: un disco y las canciones de un artista suenan como una lista que no es suya', async () => {
    const s = await startServer({ ytmusicClient: fakeClient() });
    try {
        const album = await s.call('POST', '/api/session', { album: ALBUM, startKey: `yt:${id('seed', 3)}` });
        assert.equal(album.status, 200);
        assert.deepEqual(album.body.session.source, { type: 'album', id: ALBUM, name: 'Paper Satellites' });
        assert.equal(album.body.session.count, 4);
        assert.equal(album.body.session.window.current.track.key, `yt:${id('seed', 3)}`);

        const artist = await s.call('POST', '/api/session', { artist: ARTIST, shuffle: true });
        assert.deepEqual(artist.body.session.source, { type: 'artist', id: ARTIST, name: 'Halcyon Drift' });
        assert.equal(artist.body.session.count, 30);
        assert.equal(artist.body.session.shuffle, true);

        assert.equal((await s.call('POST', '/api/session', { album: 'x' })).status, 400);
        assert.equal((await s.call('POST', '/api/session', { album: 'MPREb_noexiste1' })).status, 404);
        assert.equal((await s.call('POST', '/api/session', { album: EMPTY_ALBUM })).body.error, 'empty_list');
        // Lo que suena desde un disco queda en el historial con su origen
        assert.equal((await s.call('GET', '/api/lists')).body.lists.length, 0, 'no crea ninguna lista');
    } finally {
        await s.close();
    }
});

test('API: la radio de un artista empieza con una de sus 5 más escuchadas y aprende aparte', async () => {
    const fetchMix = fakeMixes();
    const s = await startServer({ ytmusicClient: fakeClient(), fetchMix });
    try {
        const { status, body } = await s.call('POST', '/api/session', { radio: 'artist', artistId: ARTIST });
        assert.equal(status, 200);
        assert.deepEqual(body.session.source, { type: 'radio', id: `artist:${ARTIST}`, name: 'Radio de Halcyon Drift' });
        const opener = body.session.window.current.track;
        assert.ok([1, 2, 3, 4, 5].map(n => `yt:${id('seed', n)}`).includes(opener.key), 'la primera es una de sus 5 más escuchadas');
        assert.ok(!opener.radio, 'la primera la ha elegido él, no la radio');
        assert.equal(body.session.count, 6, 'detrás, una tanda de 5 parecidas');
        assert.ok(fetchMix.calls.every(call => Number(call.slice(4)) <= 20), 'las semillas son de sus 20 más escuchadas');

        // Saltar una que puso la radio (suena y se deja enseguida) se apunta en la radio de ese artista, no en «Tu radio»
        const second = (await s.call('POST', '/api/session/goto', { index: 1 })).body.session.window.current.track;
        assert.equal(second.radio, true);
        await (await s.api(`/api/stream/${encodeURIComponent(second.key)}`, { token: s.token })).arrayBuffer();
        await s.call('POST', '/api/session/goto', { index: 2 });
        const memory = s.stores.for(s.owner.id).radio;
        assert.deepEqual(memory.skips[`artist:${ARTIST}`].map(e => e.key), [second.key]);
        assert.equal(memory.skips.home, undefined, '«Tu radio» no se entera');

        assert.equal((await s.call('POST', '/api/session', { radio: 'artist', artistId: 'nada' })).status, 400);
        assert.equal((await s.call('POST', '/api/session', { radio: 'artist', artistId: 'UC' + 'z'.repeat(22) })).status, 404);
    } finally {
        await s.close();
    }
});

test('API: la opción «Radio» en un disco sigue con parecidas de ese disco', async () => {
    const fetchMix = fakeMixes();
    const s = await startServer({ ytmusicClient: fakeClient(), fetchMix });
    try {
        await s.call('PUT', '/api/radio', { enabled: true });
        const { body } = await s.call('POST', '/api/session', { album: ALBUM, startKey: `yt:${id('seed', 4)}` });
        assert.equal(body.session.count, 4);
        let count = 4;
        for (let i = 0; i < 50 && count === 4; i++) {
            await sleep(20);
            count = (await s.call('GET', '/api/session')).body.session.count;
        }
        assert.equal(count, 9, 'al quedar una, llega una tanda');
        assert.ok(fetchMix.calls.every(call => [1, 2, 3, 4].includes(Number(call.slice(4)))), 'semillas: las del disco');
    } finally {
        await s.close();
    }
});
