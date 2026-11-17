import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HistoryStore } from '../src/session.js';
import { DAY_MS, Listening, artistOf, firstArtist, shortDate } from '../src/stats.js';
import { Usage } from '../src/usage.js';
import { startServer, tempDataDir } from './helpers.js';

// 17-11-2026 a mediodía, hora local: los días de las estadísticas son locales, como los del consumo
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const at = (daysAgo, minutes = 0, now = NOW) => new Date(now - daysAgo * DAY_MS + minutes * 60_000).toISOString();
const yt = (n, title = `Canción ${n}`, artist = 'Alguien', extra = {}) => ({ key: `yt:${String(n).padStart(11, 'a')}`, platform: 'youtube', title, artist, durationSec: 200, thumb: `https://i.ytimg.com/vi/${n}/x.jpg`, ...extra });
const sp = (n, title, artist) => ({ key: `sp:${String(n).padStart(22, '0')}`, platform: 'spotify', title, artist, durationSec: 200, thumb: null });
const SEARCH = { type: 'search', name: 'Búsqueda' };
const HOME_RADIO = { type: 'radio', name: 'Tu radio' };
const play = (track, daysAgo, { minutes = 0, source = SEARCH, now = NOW } = {}) => ({ at: at(daysAgo, minutes, now), source, track });
const listening = (o = {}) => new Listening({ now: NOW, userId: 'u_aaaaaaaaaa', ...o });
const keys = rows => rows.map(row => row.track.key);
const num = key => Number(key.replace(/^yt:a*/, ''));

// Escribe el historial como lo deja el servidor: un archivo por año, una línea por escucha
function writeHistory(dir, entries) {
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) appendFileSync(join(dir, `history-${new Date(entry.at).getUTCFullYear()}.jsonl`), JSON.stringify(entry) + '\n');
}

// ------------------------------------------------------------------ historial entero

test('historial: all() lee todos los años, se salta las líneas rotas y ve lo que se añade', () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, 'history-2024.jsonl'), `${JSON.stringify(play(yt(1), 700))}\n`);
    writeFileSync(join(dir, 'history-2025.jsonl'), [
        JSON.stringify(play(yt(2), 400)),
        '{"at":"2025-10-13T10:00:00.000Z","source":{"type":"se',        // línea a medias (el servidor se cortó al escribir)
        JSON.stringify({ at: 'ayer', source: SEARCH, track: yt(3) }),   // sin fecha válida
        JSON.stringify({ at: at(399), source: SEARCH }),                // sin canción
        '',
        JSON.stringify(play(yt(4), 399)),
    ].join('\n'));
    writeFileSync(join(dir, 'history-2026.jsonl.20261117T101010'), `${JSON.stringify(play(yt(9), 1))}\n`);     // algo retirado: no cuenta
    const history = new HistoryStore(dir, { now: () => NOW });
    assert.deepEqual(history.all().map(entry => num(entry.track.key)), [1, 2, 4]);
    assert.ok(!history.recent(10).some(entry => entry.track?.key === yt(1).key), 'recent() sigue mirando solo este año y el anterior');

    history.append({ track: yt(5), source: SEARCH });
    assert.deepEqual(history.all().map(entry => num(entry.track.key)), [1, 2, 4, 5], 'lo que se apunta se ve al momento');
    appendFileSync(join(dir, 'history-2024.jsonl'), `${JSON.stringify(play(yt(6), 690))}\n`);
    assert.deepEqual(history.all().map(entry => num(entry.track.key)), [1, 6, 2, 4, 5], 'y lo que cambie en disco por fuera, también');
    assert.deepEqual(new HistoryStore(tempDataDir()).all(), [], 'sin historial, nada');
});

// ------------------------------------------------------------------ la misma canción

test('estadísticas: la misma canción por Spotify y por YouTube cuenta como una sola', () => {
    const spotify = sp(1, 'Blinding Lights', 'The Weeknd');
    const video = yt(1, 'The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO');
    const matched = yt(2, 'un vídeo cualquiera', 'Canal');           // la coincidencia guardada de la de Spotify
    const audioKeyOf = key => (key === spotify.key ? matched.key : key);
    const l = listening({ audioKeyOf, history: [play(spotify, 3), play(video, 2), play(matched, 1), play(yt(3), 1), play(yt(3), 0)] });
    assert.deepEqual(l.auto('top').rows.map(row => [row.track.key, row.plays]), [[matched.key, 3], [yt(3).key, 2]], 'se enseña la versión que sonó la última vez');
    const stats = l.stats('7');
    assert.deepEqual([stats.plays, stats.songs, stats.artists], [5, 2, 2]);
    assert.deepEqual(stats.topArtists.map(artist => [artist.name, artist.plays, artist.songs]), [['The Weeknd', 3, 1], ['Alguien', 2, 1]], 'el artista, el de su versión de Spotify');
    // Sin la coincidencia, el vídeo con otro título no se puede saber que es la misma
    assert.equal(listening({ history: [play(spotify, 3), play(matched, 1)] }).stats('7').songs, 2);
});

// ------------------------------------------------------------------ periodos

test('estadísticas: 7 días, 30 días y siempre, con el historial de varios años', () => {
    const dir = tempDataDir();
    writeHistory(dir, [
        play(yt(5), 700), play(yt(4), 400), play(yt(4), 399),
        play(yt(3), 30),            // justo fuera de los 30 días
        play(yt(2), 29),            // justo dentro
        play(yt(2), 7),             // justo fuera de los 7 días
        play(yt(1), 6),             // justo dentro
        play(yt(1), 0),
    ]);
    const l = listening({ history: new HistoryStore(dir).all() });
    const view = period => {
        const stats = l.stats(period);
        return [stats.period, stats.plays, stats.songs, stats.topTracks.map(row => [num(row.track.key), row.plays])];
    };
    assert.deepEqual(view('7'), ['7', 2, 1, [[1, 2]]]);
    assert.deepEqual(view('30'), ['30', 4, 2, [[1, 2], [2, 2]]], 'a igualdad, la que sonó más tarde');
    assert.deepEqual(view('all'), ['all', 8, 5, [[1, 2], [2, 2], [4, 2], [3, 1], [5, 1]]]);
    const all = l.stats('all');
    assert.deepEqual([all.days, all.from, all.to, all.historySince], [null, null, '2026-11-17', at(700)]);
    assert.deepEqual([l.stats('7').from, l.stats('30').from], ['2026-11-11', '2026-10-19']);
    assert.deepEqual(keys(l.auto('top').rows), [yt(1).key, yt(2).key]);
});

// ------------------------------------------------------------------ «Lo más escuchado»

test('lo más escuchado: al menos 2 escuchas en 30 días, por número de escuchas y hasta 50', () => {
    const history = [];
    for (let n = 1; n <= 60; n++) history.push(play(yt(n), 10, { minutes: n }), play(yt(n), 3, { minutes: n }));
    history.push(play(yt(61), 1));                                    // una sola vez: no entra
    for (let i = 0; i < 5; i++) history.push(play(yt(62), 20 - i));
    history.push(play(yt(63), 40), play(yt(63), 35));                 // dos veces, pero hace más de 30 días
    const top = listening({ history }).auto('top');
    assert.equal(top.count, 50);
    assert.deepEqual(top.rows.slice(0, 3).map(row => [num(row.track.key), row.plays]), [[62, 5], [60, 2], [59, 2]]);
    assert.equal(num(top.rows.at(-1).track.key), 12);
    assert.ok(!top.rows.some(row => [61, 63].includes(num(row.track.key))));
    assert.deepEqual([top.name, top.description, top.saveName], ['Lo más escuchado', 'Lo que más veces ha sonado en los últimos 30 días, al menos 2 veces. Hasta 50.', `Lo más escuchado · ${shortDate(NOW)}`]);
    assert.equal(shortDate(NOW), '17 nov');
});

// ------------------------------------------------------------------ «Hace tiempo que no suena»

test('hace tiempo que no suena: de todas las listas, sin repetir, primero lo más antiguo y luego un barajado del día', () => {
    const dreams = sp(1, 'Dreams - 2004 Remaster', 'Fleetwood Mac');
    const dreamsVideo = yt(1, 'Fleetwood Mac - Dreams (Official Music Video)', 'Fleetwood Mac');
    const never = Array.from({ length: 30 }, (_, i) => yt(20 + i));
    const lists = [
        { id: 'l_likes00000', name: 'likes', tracks: [dreams, yt(10)] },
        { id: 'l_rock000000', name: 'rock', tracks: [dreamsVideo, yt(11), yt(12), yt(13), ...never, yt(11)] },
    ];
    const history = [
        play(dreamsVideo, 50),        // sonó por su vídeo: cuenta para la de «likes»
        play(yt(13), 60), play(yt(11), 40), play(yt(12), 35),
        play(yt(13), 5),              // ha vuelto a sonar: ya no está olvidada
        play(yt(10), 10),
        play(yt(99), 45),             // no está en ninguna lista
    ];
    const forgotten = listening({ history, lists }).auto('forgotten');
    assert.equal(forgotten.count, 33, '3 con escucha conocida y las 30 que nunca han sonado; cada una una sola vez');
    assert.deepEqual(forgotten.rows.slice(0, 3).map(row => [row.track.key, row.list.name, row.lastPlayedAt]), [
        [dreams.key, 'likes', at(50)], [yt(11).key, 'rock', at(40)], [yt(12).key, 'rock', at(35)],
    ]);
    assert.deepEqual(forgotten.rows[0].list, { id: 'l_likes00000', name: 'likes' });
    const rest = keys(forgotten.rows.slice(3));
    assert.ok(forgotten.rows.slice(3).every(row => row.lastPlayedAt === null && row.list.name === 'rock'));
    assert.deepEqual([...rest].sort(), never.map(track => track.key).sort());
    assert.notDeepEqual(rest, never.map(track => track.key), 'barajadas, no en el orden de la lista');
    assert.match(forgotten.description, /^33 canciones de tus listas que llevan más de 30 días sin sonar\./);

    // El mismo día sale igual (aunque se vuelva a calcular, y aunque la lista crezca); al día siguiente, otro orden
    const again = keys(listening({ history, lists }).auto('forgotten').rows.slice(3));
    assert.deepEqual(again, rest);
    const grown = [lists[0], { ...lists[1], tracks: [...lists[1].tracks, yt(50)] }];
    assert.deepEqual(keys(listening({ history, lists: grown }).auto('forgotten').rows.slice(3)).filter(key => key !== yt(50).key), rest);
    const evening = new Listening({ now: NOW + 9 * 3_600_000, userId: 'u_aaaaaaaaaa', history, lists });
    assert.deepEqual(keys(evening.auto('forgotten').rows.slice(3)), rest, 'a las 21:00 sigue igual');
    const tomorrow = new Listening({ now: NOW + DAY_MS, userId: 'u_aaaaaaaaaa', history, lists });
    assert.notDeepEqual(keys(tomorrow.auto('forgotten').rows.slice(3)), rest);
    const other = listening({ history, lists, userId: 'u_bbbbbbbbbb' });
    assert.notDeepEqual(keys(other.auto('forgotten').rows.slice(3)), rest, 'cada usuario tiene su barajado');

    // Hasta 50
    const many = [{ id: 'l_rock000000', name: 'rock', tracks: Array.from({ length: 70 }, (_, i) => yt(100 + i)) }];
    assert.equal(listening({ lists: many }).auto('forgotten').count, 50);
});

// ------------------------------------------------------------------ «Descubierto en la radio»

test('descubierto en la radio: lo que puso la radio, sin repetir, lo último arriba y cómo está ahora', () => {
    const radio = (track, extra = {}) => ({ ...track, radio: true, ...extra });
    const lists = [
        { id: 'l_likes00000', name: 'likes', tracks: [sp(32, 'Song X', 'Band')] },
        { id: 'l_rock000000', name: 'rock (ahora)', tracks: [yt(31)] },
    ];
    const history = [
        play(radio(yt(30)), 5, { source: HOME_RADIO }),
        play(radio(yt(31)), 4, { source: { type: 'list', id: 'l_rock000000', name: 'rock' } }),      // la lista se ha renombrado después
        play(radio(yt(32, 'Band - Song X (Official Video)', 'BandVEVO'), { saved: true }), 3, { source: HOME_RADIO }),
        play(radio(yt(33), { saved: true }), 2, { source: SEARCH }),                                    // la guardó, pero ya no está en ninguna lista
        play(radio(yt(35)), 2, { minutes: 10, source: { type: 'list', id: 'l_gone000000', name: 'vieja' } }),
        play(radio(yt(30)), 1, { source: HOME_RADIO }),                                                // otra vez: sale una vez, con la última
        play(yt(34), 0),                                                                               // la eligió él: no es de la radio
    ];
    const found = listening({ history, lists }).auto('radio');
    assert.deepEqual(found.rows.map(row => [num(row.track.key), row.at, row.via, row.savedIn?.name ?? null]), [
        [30, at(1), 'Tu radio', null],
        [35, at(2, 10), 'radio de vieja', null],
        [33, at(2), 'radio de una búsqueda', null],
        [32, at(3), 'Tu radio', 'likes'],
        [31, at(4), 'radio de rock (ahora)', 'rock (ahora)'],
    ]);
    assert.deepEqual(found.rows[3].savedIn, { id: 'l_likes00000', name: 'likes' });
    assert.equal(found.unsaved, 3);
    assert.ok(found.rows.every(row => row.track.radio === undefined && row.track.saved === undefined), 'las canciones salen limpias: al ponerlas no son «de la radio»');

    const lots = Array.from({ length: 120 }, (_, i) => play(radio(yt(200 + i)), 20, { minutes: i }));
    const capped = listening({ history: lots }).auto('radio');
    assert.deepEqual([capped.count, num(capped.rows[0].track.key), num(capped.rows.at(-1).track.key)], [100, 319, 220]);
});

// ------------------------------------------------------------------ artistas

test('estadísticas: artistas por su firma, con su forma más frecuente, el primero de varios y la carátula de su canción más escuchada', () => {
    const history = [
        ...[3, 2, 1].map(d => play(yt(40, 'Bohemian Rhapsody', 'Queen'), d)),
        ...[3, 2].map(d => play(yt(41, 'Under Pressure', 'Queen Official'), d)),
        play(yt(42, 'Radio Ga Ga', 'Queen - Topic'), 2),
        play(yt(44, 'The Weeknd - Starboy (Official Video)', 'TheWeekndVEVO'), 4),
        ...[2, 1].map(d => play(sp(43, 'Starboy', 'The Weeknd, Daft Punk'), d)),
        play(yt(45, 'Get Lucky', 'Daft Punk'), 1),
        play(yt(46, 'Sin artista', null), 1),
    ];
    const thumbOf = track => (track.platform === 'spotify' ? 'https://i.ytimg.com/vi/coincidencia/x.jpg' : track.thumb);
    const stats = listening({ history, thumbOf }).stats('7');
    assert.deepEqual([stats.plays, stats.songs, stats.artists], [11, 6, 3]);
    assert.deepEqual(stats.topArtists.map(artist => [artist.name, artist.plays, artist.songs, artist.thumb]), [
        ['Queen', 6, 3, yt(40).thumb],
        ['The Weeknd', 3, 1, 'https://i.ytimg.com/vi/coincidencia/x.jpg'],
        ['Daft Punk', 1, 1, yt(45).thumb],
    ]);
    assert.deepEqual([firstArtist('The Weeknd, Daft Punk'), firstArtist('Queen - Topic'), firstArtist(null)], ['The Weeknd', 'Queen', '']);
    assert.equal(listening({ history }).stats('7').topArtists[1].thumb, null, 'sin carátula, null');
});

test('estadísticas: en YouTube el artista no siempre es el canal (canal de letras, «- Topic», VEVO, «Canción - Remaster»)', () => {
    const cases = [
        [yt(60, 'Rick Astley - Never Gonna Give You Up', 'Amazing Lyrics'), 'Rick Astley'],
        [yt(61, 'Rema, Selena Gomez - Calm Down (Official Video)', 'Lyrics Hub'), 'Rema'],
        [yt(62, 'Radio Ga Ga', 'Queen - Topic'), 'Queen'],
        [yt(63, 'Señorita', 'UncleMurdaVEVO'), 'UncleMurda'],
        [yt(64, 'Arcángel - FN8 (Video Lyric)', 'Arcangel'), 'Arcangel'],
        [yt(65, 'Stairway to Heaven - Live', 'Led Zeppelin'), 'Led Zeppelin'],
        [yt(66, 'Bohemian Rhapsody - 2011 Remaster', 'Queen Official'), 'Queen'],
        [yt(67, 'ITZY "BORN TO BE" M/V', 'JYP Entertainment'), 'JYP Entertainment'],
        [sp(68, 'Starboy', 'The Weeknd, Daft Punk'), 'The Weeknd'],
        [yt(69, 'Nadie - Nada', null), ''],
    ];
    assert.deepEqual(cases.map(([track]) => artistOf(track)), cases.map(([, artist]) => artist));
    const history = [...[2, 1].map(d => play(yt(70, 'Rick Astley - Never Gonna Give You Up', 'Amazing Lyrics'), d)), play(yt(71, 'Together Forever', 'Rick Astley'), 1)];
    const { topArtists } = listening({ history }).stats('7');
    assert.deepEqual(topArtists.map(artist => [artist.name, artist.plays, artist.songs]), [['Rick Astley', 3, 2]], 'el canal de letras cuenta para el artista del título');
});

// ------------------------------------------------------------------ tiempo escuchado

test('estadísticas: el tiempo sale del consumo por días locales; sin datos, todo a cero', () => {
    const usageDays = {
        '2026-09-01': { listenedMs: 16_000 },
        '2026-10-20': { listenedMs: 1_000, searches: 3 },
        '2026-11-10': { listenedMs: 4_000 },
        '2026-11-11': { listenedMs: 2_000 },
        '2026-11-17': { listenedMs: 8_000, plays: 2 },
        '2026-11-18': { listenedMs: 99_000 },        // un reloj adelantado: lo de mañana no cuenta
    };
    const l = listening({ usageDays, history: [play(yt(1), 2)] });
    assert.deepEqual(['7', '30', 'all'].map(period => l.stats(period).listenedMs), [10_000, 15_000, 31_000]);
    assert.deepEqual([l.stats('7').listenedSince, l.stats('7').historySince], ['2026-09-01', at(2)]);

    const empty = listening().stats('30');
    assert.deepEqual(empty, { period: '30', days: 30, from: '2026-10-19', to: '2026-11-17', listenedMs: 0, listenedSince: null, historySince: null, plays: 0, songs: 0, artists: 0, topTracks: [], topArtists: [] });
    assert.deepEqual(listening().summary(), {
        lists: [
            { kind: 'top', name: 'Lo más escuchado', count: 0 },
            { kind: 'forgotten', name: 'Hace tiempo que no suena', count: 0 },
            { kind: 'radio', name: 'Descubierto en la radio', count: 0, unsaved: 0 },
        ],
        stats: { period: '7', listenedMs: 0, songs: 0, artists: 0, plays: 0 },
    });
    assert.equal(listening().auto('nada'), null);
    assert.equal(listening().auto('constructor'), null);
    assert.equal(listening().auto('__proto__'), null);
});

test('consumo: daysOf junta los meses de un usuario, también lo que aún no se ha guardado', () => {
    let now = new Date(2026, 9, 31, 20, 0, 0).getTime();
    const dir = tempDataDir();
    const usage = new Usage(dir, { now: () => now });
    usage.add('u_a', { listenedMs: 1_000 });
    usage.add('u_b', { listenedMs: 7_000 });
    usage.flush();
    now = new Date(2026, 10, 1, 9, 0, 0).getTime();
    usage.add('u_a', { listenedMs: 2_000 });
    const fresh = new Usage(dir, { now: () => now });
    assert.deepEqual(Object.keys(fresh.daysOf('u_a')), ['2026-10-31'], 'otro proceso solo ve lo guardado');
    assert.deepEqual(Object.entries(usage.daysOf('u_a')).map(([day, c]) => [day, c.listenedMs]), [['2026-10-31', 1_000], ['2026-11-01', 2_000]]);
    assert.deepEqual(Object.keys(usage.daysOf('u_b')), ['2026-10-31']);
    assert.deepEqual(usage.daysOf('u_c'), {});
    assert.deepEqual(new Usage(tempDataDir()).daysOf('u_a'), {});
});

// ------------------------------------------------------------------ API

const ago = (days, minutes = 0) => new Date(Date.now() - days * DAY_MS - minutes * 60_000).toISOString();
const hist = (track, days, minutes = 0, source = SEARCH) => ({ at: ago(days, minutes), source, track });

// La dueña: «likes» (1, 2) y «rock» (3, 4 y una de Spotify). Ha escuchado 1 tres veces, 3 dos veces y dos de la radio.
async function withHistory(options = {}) {
    const s = await startServer(options);
    const likes = s.lists.create('likes');
    s.lists.addTracks(likes.id, [yt(1), yt(2)]);
    const rock = s.lists.create('rock');
    s.lists.addTracks(rock.id, [yt(3), yt(4), sp(5, 'Starboy', 'The Weeknd')]);
    writeHistory(join(s.dir, 'users', s.owner.id), [
        hist(yt(1), 3), hist(yt(3), 3, -30), hist(yt(1), 2), hist(yt(3), 2, -30), hist(yt(1), 1),
        hist({ ...yt(9), radio: true }, 1, -30, HOME_RADIO),
        hist({ ...yt(8), radio: true }, 0, 30, { type: 'list', id: rock.id, name: 'rock' }),
    ]);
    return { s, likes, rock };
}

test('API: «Para ti» trae las tres listas y el resumen de 7 días; cada lista, sus canciones con los datos de su fila', async () => {
    const { s, likes, rock } = await withHistory();
    try {
        s.usage.add(s.owner.id, { listenedMs: 5_000 });
        const home = (await s.call('GET', '/api/auto')).body;
        assert.deepEqual(home, {
            lists: [
                { kind: 'top', name: 'Lo más escuchado', count: 2 },
                { kind: 'forgotten', name: 'Hace tiempo que no suena', count: 3 },
                { kind: 'radio', name: 'Descubierto en la radio', count: 2, unsaved: 2 },
            ],
            stats: { period: '7', listenedMs: 5_000, songs: 4, artists: 1, plays: 7 },
        });

        const top = (await s.call('GET', '/api/auto/top')).body.list;
        assert.deepEqual([top.kind, top.name, top.count, top.saveName], ['top', 'Lo más escuchado', 2, `Lo más escuchado · ${shortDate(Date.now())}`]);
        assert.deepEqual(top.tracks.map(t => [num(t.key), t.plays, t.liked]), [[1, 3, true], [3, 2, false]]);
        assert.equal(top.tracks[0].title, 'Canción 1');

        const forgotten = (await s.call('GET', '/api/auto/forgotten')).body.list;
        assert.deepEqual(forgotten.tracks.map(t => t.list.name).sort(), ['likes', 'rock', 'rock']);
        assert.ok(forgotten.tracks.every(t => t.lastPlayedAt === null));
        const spotify = forgotten.tracks.find(t => t.key.startsWith('sp:'));
        assert.equal(spotify.match, 'pending', 'las de Spotify salen como en las listas (con su coincidencia)');

        let radio = (await s.call('GET', '/api/auto/radio')).body.list;
        assert.deepEqual(radio.tracks.map(t => [num(t.key), t.via, t.savedIn]), [[8, 'radio de rock', null], [9, 'Tu radio', null]]);
        assert.equal(typeof radio.tracks[0].at, 'string');
        // La guarda en «rock» (como siempre: «Añadir a una lista…») y ya sale guardada
        await s.call('POST', `/api/lists/${rock.id}/tracks`, { track: yt(9) });
        radio = (await s.call('GET', '/api/auto/radio')).body.list;
        assert.deepEqual([radio.unsaved, radio.tracks[1].savedIn], [1, { id: rock.id, name: 'rock' }]);

        // No salen en Listas
        assert.deepEqual((await s.call('GET', '/api/lists')).body.lists.map(list => list.id), [likes.id, rock.id]);
        for (const kind of ['nada', 'constructor', '__proto__', 'TOP']) {
            assert.deepEqual(await s.call('GET', `/api/auto/${kind}`), { status: 404, body: { error: 'auto_not_found' } }, kind);
        }
        assert.equal((await s.api('/api/auto')).status, 401);
    } finally {
        await s.close();
    }
});

test('API: «Guardar como lista» copia lo de ahora a una lista normal, que ya no cambia sola', async () => {
    const { s } = await withHistory();
    try {
        const saved = await s.call('POST', '/api/auto/top/save', {});
        assert.equal(saved.status, 201);
        assert.deepEqual([saved.body.list.name, saved.body.list.count], [`Lo más escuchado · ${shortDate(Date.now())}`, 2]);
        const named = await s.call('POST', '/api/auto/radio/save', { name: '  de la radio  ' });
        assert.deepEqual([named.status, named.body.list.name, named.body.list.count], [201, 'de la radio', 2]);

        const all = (await s.call('GET', '/api/lists')).body.lists;
        assert.deepEqual(all.map(list => list.name), ['likes', 'rock', saved.body.list.name, 'de la radio']);
        const copy = s.lists.get(saved.body.list.id);
        assert.deepEqual(copy.tracks.map(t => num(t.key)), [1, 3]);
        assert.ok(copy.tracks.every(t => t.plays === undefined && t.liked === undefined), 'se guardan las canciones, no los datos de la fila');
        assert.ok(s.lists.get(named.body.list.id).tracks.every(t => t.radio === undefined));

        // Escucha más: la automática cambia, la guardada no
        writeHistory(join(s.dir, 'users', s.owner.id), [hist(yt(4), 0, 1), hist(yt(4), 0)]);
        assert.equal((await s.call('GET', '/api/auto/top')).body.list.count, 3);
        assert.equal(s.lists.get(saved.body.list.id).tracks.length, 2);

        assert.deepEqual(await s.call('POST', '/api/auto/top/save', { name: '   ' }), { status: 400, body: { error: 'bad_name' } });
        assert.equal((await s.call('POST', '/api/auto/top/save', { name: 5 })).status, 400);
        assert.deepEqual(await s.call('POST', '/api/auto/nada/save', { name: 'x' }), { status: 404, body: { error: 'auto_not_found' } });
        assert.equal((await s.call('GET', '/api/lists')).body.lists.length, 4, 'nada de eso ha creado listas');

        // Otra cuenta, sin historial: nada que guardar
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        assert.deepEqual(await s.call('POST', '/api/auto/top/save', { name: 'x' }, other), { status: 400, body: { error: 'empty_list' } });
        assert.deepEqual((await s.call('GET', '/api/lists', undefined, other)).body.lists, []);
    } finally {
        await s.close();
    }
});

test('API: una lista automática se reproduce como una lista, y «Sonando de» dice su nombre', async () => {
    const { s } = await withHistory();
    try {
        const first = await s.call('POST', '/api/session', { auto: 'top' });
        assert.equal(first.status, 200);
        assert.deepEqual(first.body.session.source, { type: 'auto', id: 'top', name: 'Lo más escuchado' });
        assert.deepEqual([first.body.session.count, num(first.body.session.window.current.track.key), first.body.session.window.current.track.liked], [2, 1, true]);
        const chosen = (await s.call('POST', '/api/session', { auto: 'top', startKey: yt(3).key })).body.session;
        assert.equal(num(chosen.window.current.track.key), 3);
        const shuffled = (await s.call('POST', '/api/session', { auto: 'forgotten', shuffle: true })).body.session;
        assert.deepEqual([shuffled.shuffle, shuffled.count, shuffled.source.id], [true, 3, 'forgotten']);
        const radio = (await s.call('POST', '/api/session', { auto: 'radio' })).body.session;
        assert.equal(radio.window.current.track.radio, undefined, 'lo que puso la radio entra como canción normal');

        // Lo que suena desde ella se apunta con su origen (para «Continuar»), y no vuelve a «Descubierto en la radio»
        await s.call('PUT', '/api/session/state', { key: radio.window.current.track.key, positionMs: 40_000 });
        const last = (await s.call('GET', '/api/history?limit=1')).body.entries[0];
        assert.deepEqual(last.source, { type: 'auto', id: 'radio', name: 'Descubierto en la radio' });
        assert.equal(last.track.radio, undefined);
        assert.equal((await s.call('GET', '/api/auto/radio')).body.list.tracks[0].at < last.at, true);

        assert.deepEqual(await s.call('POST', '/api/session', { auto: 'nada' }), { status: 404, body: { error: 'auto_not_found' } });
        assert.equal((await s.call('POST', '/api/session', { auto: 7 })).status, 404);
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        assert.deepEqual(await s.call('POST', '/api/session', { auto: 'top' }, other), { status: 400, body: { error: 'empty_list' } });
        assert.equal((await s.call('GET', '/api/session')).body.session.source.id, 'radio', 'la sesión de la otra cuenta no se ha tocado');
    } finally {
        await s.close();
    }
});

test('API: con «Radio» marcada, una lista automática sigue con parecidas a lo que hay en ella', async () => {
    const calls = [];
    const fetchMix = async ytId => {
        calls.push(ytId);
        const tag = ytId.slice(-4);
        return Array.from({ length: 20 }, (_, i) => ({ id: `${tag}mix${String(i).padStart(4, '0')}`, title: `Grupo ${tag} ${i} - Tema ${tag} ${i}`, uploader: `Grupo ${tag} ${i}`, duration: 190 }));
    };
    const { s } = await withHistory({ fetchMix });
    try {
        await s.call('PUT', '/api/radio', { enabled: true });
        await s.call('POST', '/api/session', { auto: 'top' });
        let session = null;
        for (const until = Date.now() + 3000; Date.now() < until && !session;) {
            const view = (await s.call('GET', '/api/session')).body.session;
            if (view.count > 2) session = view;
            else await sleep(20);
        }
        assert.ok(session, 'la radio ha añadido canciones');
        assert.deepEqual(session.source, { type: 'auto', id: 'top', name: 'Lo más escuchado' });
        assert.ok(calls.length > 0 && calls.every(id => [yt(1).key, yt(3).key].includes(`yt:${id}`)), 'parte de las canciones de la sesión');
        const queue = (await s.call('GET', '/api/session/queue?from=0&limit=20')).body.entries;
        assert.ok(queue.slice(2).every(entry => entry.track.radio === true));
    } finally {
        await s.close();
    }
});

test('API: «Tus estadísticas» por periodo; cada cuenta ve lo suyo', async () => {
    const { s } = await withHistory();
    try {
        writeHistory(join(s.dir, 'users', s.owner.id), [hist(yt(4, 'Vieja', 'Otro grupo'), 20), hist(yt(6, 'Más vieja', 'Otro grupo'), 400)]);
        s.usage.add(s.owner.id, { listenedMs: 3_600_000 });
        const week = (await s.call('GET', '/api/stats')).body;
        assert.deepEqual([week.period, week.days, week.plays, week.songs, week.artists, week.listenedMs], ['7', 7, 7, 4, 1, 3_600_000]);
        assert.equal(week.listenedSince, week.to, 'el consumo empieza hoy');
        assert.deepEqual(week.topTracks.slice(0, 2).map(t => [num(t.key), t.plays, t.liked]), [[1, 3, true], [3, 2, false]]);
        assert.deepEqual(week.topArtists, [{ name: 'Alguien', plays: 7, songs: 4, thumb: yt(1).thumb }]);
        const month = (await s.call('GET', '/api/stats?period=30')).body;
        const ever = (await s.call('GET', '/api/stats?period=all')).body;
        assert.deepEqual([month.plays, month.artists, ever.plays, ever.songs, ever.from], [8, 2, 9, 6, null]);
        assert.ok(Date.parse(ever.historySince) < Date.now() - 399 * DAY_MS, 'desde la primera escucha');
        for (const period of ['365', 'semana', 'constructor', '']) {
            assert.deepEqual(await s.call('GET', `/api/stats?period=${period}`), { status: 400, body: { error: 'bad_period' } }, period);
        }

        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        const hers = (await s.call('GET', '/api/stats?period=all', undefined, other)).body;
        assert.deepEqual([hers.plays, hers.listenedMs, hers.listenedSince, hers.historySince, hers.topTracks], [0, 0, null, null, []]);
        assert.deepEqual((await s.call('GET', '/api/auto', undefined, other)).body.lists.map(list => list.count), [0, 0, 0]);
    } finally {
        await s.close();
    }
});
