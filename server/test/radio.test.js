import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ARTIST_BLOCK_MS, Radio, RadioMemory, SKIP_SONG_MS, SongSet, songSig } from '../src/radio.js';
import { SessionStore } from '../src/session.js';
import { startServer, tempDataDir } from './helpers.js';

// Identificadores de YouTube de 11 caracteres a partir de un prefijo y un número
const id = (prefix, n) => `${prefix}${String(n).padStart(11 - prefix.length, '0')}`;
const yt = (prefix, n) => `yt:${id(prefix, n)}`;
const seedTrack = n => ({ key: yt('seed', n), platform: 'youtube', title: `Grupo ${n} - Semilla ${n}`, artist: `Grupo ${n}`, durationSec: 200, thumb: null });

// Generador de azar repetible, para que las pruebas no dependan de la suerte
function rng(seed = 1) {
    let x = seed;
    return () => {
        x = (x * 1664525 + 1013904223) % 4294967296;
        return x / 4294967296;
    };
}

/**
 * Doble de las mezclas de YouTube. La mezcla de la semilla N trae: la propia semilla, 6 canciones
 * de su mismo artista (lo que vicia la radio del bot) y 20 de otros artistas, propias de esa semilla.
 */
function fakeMixes({ shared = [] } = {}) {
    const calls = [];
    const fetchMix = async ytId => {
        calls.push(ytId);
        const n = Number(ytId.slice(4));
        const entries = [{ id: ytId, title: `Grupo ${n} - Semilla ${n}`, uploader: `Grupo ${n}`, duration: 200 }];
        for (let i = 0; i < 6; i++) entries.push({ id: id(`own${n}x`, i), title: `Grupo ${n} - Otra suya ${i}`, uploader: `Grupo ${n}`, duration: 210 });
        for (let i = 0; i < 20; i++) entries.push({ id: id(`mix${n}x`, i), title: `Banda ${n}-${i} - Tema ${n}-${i} (Official Video)`, uploader: `Banda ${n}-${i}`, duration: 190 });
        entries.push(...shared);
        return entries;
    };
    fetchMix.calls = calls;
    return fetchMix;
}

const newMemory = () => new RadioMemory(tempDataDir());

// ------------------------------------------------------------------ reconocer la misma canción

test('firma: el mismo tema se reconoce en otro vídeo y viniendo de Spotify', () => {
    const set = new SongSet().add({ key: 'yt:aaaaaaaaaaa', platform: 'youtube', title: 'Queen – Bohemian Rhapsody (Official Video Remastered)', artist: 'Queen Official' });
    assert.ok(set.has({ key: 'yt:bbbbbbbbbbb', title: 'Queen - Bohemian Rhapsody (Lyrics)', artist: 'Letras HD' }), 'otro vídeo de la misma canción');
    assert.ok(set.has({ key: 'yt:ccccccccccc', title: 'Bohemian Rhapsody', artist: 'Queen - Topic' }), 'el audio del canal automático');
    assert.ok(set.has({ key: 'sp:0000000000000000000000', platform: 'spotify', title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen' }), 'la de Spotify');
    assert.ok(set.has({ key: 'yt:ddddddddddd', title: 'Bohemian Rhapsody - Queen', artist: 'Un canal' }), 'título y artista al revés');
    assert.ok(!set.has({ key: 'yt:eeeeeeeeeee', title: "Queen - Don't Stop Me Now", artist: 'Queen Official' }), 'otra canción del mismo artista');
    assert.ok(!set.has({ key: 'yt:fffffffffff', title: 'Panic! At The Disco - Bohemian Rhapsody', artist: 'Fueled By Ramen' }), 'mismo título, otro artista');
    assert.ok(set.has({ key: 'yt:aaaaaaaaaaa', title: 'cualquier cosa' }), 'por clave');
    assert.deepEqual(songSig({ title: 'AC/DC - Thunderstruck (Official Video)', artist: 'acdcVEVO' }), { title: 'thunderstruck', artist: 'acdc' });
    assert.deepEqual(songSig({ platform: 'spotify', title: 'Baila Conmigo (feat. Rauw)', artist: 'Selena Gomez' }), { title: 'baila conmigo', artist: 'selenagomez' });
});

// ------------------------------------------------------------------ el motor

test('radio: una tanda parte de varias semillas, no repite artista y no trae nada de la lista', async () => {
    const fetchMix = fakeMixes();
    const radio = new Radio({ fetchMix, random: rng(7) });
    const memory = newMemory();
    const list = Array.from({ length: 10 }, (_, i) => seedTrack(i));
    const exclude = new SongSet();
    list.forEach(track => exclude.add(track));
    const { tracks, seeds } = await radio.batch({ scope: 'list:x', seedKeys: list.map(t => t.key), exclude, memory });

    assert.equal(tracks.length, 5);
    assert.equal(seeds.length, 3, 'tres semillas');
    assert.equal(new Set(seeds).size, 3);
    assert.ok(tracks.every(t => t.radio === true && t.platform === 'youtube' && /^yt:/.test(t.key)));
    assert.ok(tracks.every(t => !list.some(l => l.key === t.key)), 'ninguna es de la lista');
    const artists = tracks.map(t => songSig(t).artist);
    assert.equal(new Set(artists).size, 5, 'como mucho una canción por artista');
    const origins = new Set(tracks.map(t => t.key.slice(6, 7)));
    assert.ok(origins.size >= 2, 'salen de mezclas de más de una semilla');
    assert.equal(memory.recent.length, 5, 'quedan apuntadas en la memoria');
});

test('radio: no repite semilla hasta pasar por todas, y no repite canción entre tandas', async () => {
    const fetchMix = fakeMixes();
    const radio = new Radio({ fetchMix, random: rng(3) });
    const memory = newMemory();
    const seedKeys = Array.from({ length: 9 }, (_, i) => yt('seed', i));
    const exclude = new SongSet();
    const all = [];
    const seedsSeen = [];
    for (let batch = 0; batch < 3; batch++) {
        const { tracks, seeds } = await radio.batch({ scope: 'list:x', seedKeys, exclude, memory });
        all.push(...tracks);
        seedsSeen.push(...seeds);
    }
    assert.equal(new Set(seedsSeen).size, 9, 'en tres tandas han pasado las nueve semillas');
    assert.equal(new Set(all.map(t => t.key)).size, all.length, 'ninguna canción repetida');
    // Cuarta tanda: empieza otra vuelta de semillas
    const again = await radio.batch({ scope: 'list:x', seedKeys, exclude, memory });
    assert.equal(again.seeds.length, 3);
    assert.ok(again.tracks.every(t => !all.some(a => a.key === t.key)), 'lo ya puesto no vuelve');
});

test('radio: lo que ya puso no vuelve aunque se pida muchas veces (no se vicia)', async () => {
    const radio = new Radio({ fetchMix: fakeMixes(), random: rng(11) });
    const memory = newMemory();
    const seedKeys = [yt('seed', 1), yt('seed', 2)];
    const seen = new Set();
    const artistsCount = new Map();
    for (let batch = 0; batch < 8; batch++) {
        const { tracks } = await radio.batch({ scope: 'list:y', seedKeys, exclude: new SongSet(), memory });
        for (const t of tracks) {
            assert.ok(!seen.has(t.key), `repetida: ${t.title}`);
            seen.add(t.key);
            const artist = songSig(t).artist;
            artistsCount.set(artist, (artistsCount.get(artist) ?? 0) + 1);
        }
    }
    // Dos semillas dan 2 × 26 candidatas: tienen que haber salido casi todas antes de quedarse sin nada
    assert.ok(seen.size >= 35, `solo ${seen.size} distintas`);
    // El artista de cada semilla no acapara: sus 6 canciones salen repartidas, nunca dos en una tanda
    assert.ok((artistsCount.get('grupo1') ?? 0) <= 6);
});

test('radio: la misma canción en dos vídeos entra una sola vez, y los vídeos largos o cortos no entran', async () => {
    const shared = [
        { id: id('dupA', 1), title: 'Los Mismos - El Tema (Official Video)', uploader: 'Los Mismos', duration: 200 },
        { id: id('dupB', 1), title: 'Los Mismos - El Tema (Lyrics)', uploader: 'Letras', duration: 201 },
        { id: id('long', 1), title: 'Varios - Grandes éxitos 2 horas', uploader: 'Recopilaciones', duration: 7200 },
        { id: id('shrt', 1), title: 'Alguien - Intro', uploader: 'Alguien', duration: 20 },
    ];
    const radio = new Radio({ fetchMix: fakeMixes({ shared }), random: rng(5) });
    const memory = newMemory();
    const all = [];
    // Hasta agotar las candidatas: 3 semillas × 26 propias + «El Tema» una vez
    for (let batch = 0; batch < 30; batch++) {
        const { tracks } = await radio.batch({ scope: 'list:z', seedKeys: [yt('seed', 1), yt('seed', 2), yt('seed', 3)], exclude: new SongSet(), memory });
        if (tracks.length === 0) break;
        all.push(...tracks);
    }
    assert.equal(all.length, 79);
    assert.equal(all.filter(t => /El Tema/.test(t.title)).length, 1, 'un solo vídeo de «El Tema»');
    assert.ok(!all.some(t => t.durationSec > 600 || t.durationSec < 60));
});

test('radio: sin semillas no hay tanda; si se acaban, da un salto con lo que ella misma puso', async () => {
    const radio = new Radio({ fetchMix: fakeMixes(), random: rng(2) });
    const memory = newMemory();
    assert.deepEqual(await radio.batch({ scope: 'loose', seedKeys: ['sc:123', 'sp:0000000000000000000000'], exclude: new SongSet(), memory }), { tracks: [], seeds: [] });

    // Una sola semilla y casi todo su mezcla ya excluida: tiene que tirar de la reserva
    const exclude = new SongSet();
    for (let i = 0; i < 6; i++) exclude.addKey(yt('own1x', i));
    for (let i = 0; i < 20; i++) exclude.addKey(yt('mix1x', i));
    const { tracks, seeds } = await radio.batch({ scope: 'loose', seedKeys: [yt('seed', 1)], fallbackKeys: [yt('seed', 8)], exclude, memory });
    assert.deepEqual(seeds, [yt('seed', 1), yt('seed', 8)]);
    assert.equal(tracks.length, 5);
    assert.ok(tracks.every(t => /^yt:(own8x|mix8x)/.test(t.key)));
});

test('radio: si YouTube falla en todas las mezclas, es un error; si falla en alguna, sigue', async () => {
    const memory = newMemory();
    const broken = new Radio({ fetchMix: async () => { throw new Error('YouTube no responde'); }, random: rng(1) });
    await assert.rejects(broken.batch({ scope: 'list:x', seedKeys: [yt('seed', 1)], exclude: new SongSet(), memory }), /no responde/);
    const good = fakeMixes();
    const half = new Radio({ fetchMix: async ytId => { if (ytId.endsWith('1')) throw new Error('fallo'); return good(ytId); }, random: rng(1) });
    const { tracks } = await half.batch({ scope: 'list:x', seedKeys: [yt('seed', 1), yt('seed', 2), yt('seed', 3)], exclude: new SongSet(), memory });
    assert.equal(tracks.length, 5);
});

test('radio: una mezcla lenta no frena la tanda, y cuando llega queda recordada', async () => {
    const good = fakeMixes();
    const calls = [];
    const fetchMix = async ytId => {
        calls.push(ytId);
        if (ytId.endsWith('1')) await sleep(250);       // la de la semilla 1 tarda
        return good(ytId);
    };
    const radio = new Radio({ fetchMix, random: rng(6), mixTimeoutMs: 60 });
    const memory = newMemory();
    const started = Date.now();
    const { tracks } = await radio.batch({ scope: 'list:x', seedKeys: [yt('seed', 1), yt('seed', 2), yt('seed', 3)], exclude: new SongSet(), memory });
    assert.ok(Date.now() - started < 200, 'no espera a la lenta');
    assert.equal(tracks.length, 5);
    assert.ok(tracks.every(t => !/^yt:(own1x|mix1x)/.test(t.key)), 'solo de las que llegaron a tiempo');

    // Si todas tardan, la tanda falla… pero las lecturas siguen por detrás y el siguiente intento las encuentra hechas
    const slow = new Radio({ fetchMix: async ytId => { calls.push(`lenta:${ytId}`); await sleep(120); return good(ytId); }, random: rng(6), mixTimeoutMs: 40 });
    await assert.rejects(slow.batch({ scope: 'list:y', seedKeys: [yt('seed', 4)], exclude: new SongSet(), memory }), /tarda demasiado/);
    await sleep(150);
    const again = await slow.batch({ scope: 'list:y', seedKeys: [yt('seed', 4)], exclude: new SongSet(), memory });
    assert.equal(again.tracks.length, 5);
    assert.equal(calls.filter(c => c === `lenta:${id('seed', 4)}`).length, 1, 'no se vuelve a pedir');
});

test('radio: la mezcla de una semilla se recuerda unas horas y la memoria del usuario se guarda en disco', async () => {
    const fetchMix = fakeMixes();
    let now = Date.parse('2026-11-17T10:00:00Z');
    const radio = new Radio({ fetchMix, random: rng(4), now: () => now });
    const dir = tempDataDir();
    const memory = new RadioMemory(dir, { now: () => now });
    await radio.batch({ scope: 'list:x', seedKeys: [yt('seed', 1)], exclude: new SongSet(), memory });
    await radio.batch({ scope: 'list:x', seedKeys: [yt('seed', 1)], exclude: new SongSet(), memory });
    assert.equal(fetchMix.calls.length, 1, 'la segunda tanda no vuelve a pedir la mezcla');
    now += 7 * 60 * 60 * 1000;
    await radio.batch({ scope: 'list:x', seedKeys: [yt('seed', 1)], exclude: new SongSet(), memory });
    assert.equal(fetchMix.calls.length, 2, 'pasadas las horas, sí');

    const reopened = new RadioMemory(dir, { now: () => now });
    assert.equal(reopened.recent.length, memory.recent.length);
    assert.equal(reopened.enabled, false, 'apagada mientras no se marque');
    reopened.setEnabled(true);
    assert.equal(new RadioMemory(dir).enabled, true);
    // Pasado el plazo de memoria (30 días), lo puesto puede volver
    now += 31 * 24 * 60 * 60 * 1000;
    assert.equal(new RadioMemory(dir, { now: () => now }).fresh().length, 0);
});

// ------------------------------------------------------------------ la sesión con radio

test('sesión: la tanda de la radio va al final, lo que pide el usuario se le adelanta y el aleatorio no la mezcla', () => {
    const sessions = new SessionStore(tempDataDir(), { random: rng(9) });
    const list = [0, 1, 2].map(seedTrack);
    sessions.start({ source: { type: 'list', id: 'l_0000000000', name: 'x' }, tracks: list });
    assert.equal(sessions.remaining, 2);
    const radioTracks = [0, 1].map(i => ({ key: yt('mix1x', i), platform: 'youtube', title: `R${i}`, artist: 'B', durationSec: 100, thumb: null, radio: true }));
    assert.equal(sessions.appendRadio(radioTracks), 2);
    assert.equal(sessions.appendRadio(radioTracks), 0, 'no entra dos veces');
    assert.equal(sessions.count, 5);
    assert.ok(sessions.queue(3, 5).entries.every(e => e.track.radio === true));

    // «Añadir a la cola» se coloca por delante de lo que puso la radio; «a continuación», tras la que suena
    const extra = { key: yt('seed', 7), platform: 'youtube', title: 'Pedida', artist: 'A', durationSec: 100, thumb: null };
    sessions.enqueue(extra, 'end');
    assert.deepEqual(sessions.allTracks().map(t => t.title), ['Grupo 0 - Semilla 0', 'Grupo 1 - Semilla 1', 'Grupo 2 - Semilla 2', 'Pedida', 'R0', 'R1']);

    // Aleatorio: se barajan las del usuario; las de la radio siguen al final y en su orden
    sessions.setOptions({ shuffle: true });
    assert.deepEqual(sessions.allTracks().slice(-2).map(t => t.title), ['R0', 'R1']);
    sessions.setOptions({ shuffle: false });
    assert.deepEqual(sessions.allTracks().slice(-2).map(t => t.title), ['R0', 'R1']);

    // Guardada en una lista deja de contar como «de la radio»
    assert.equal(sessions.markSaved(radioTracks[0].key), true);
    assert.equal(sessions.markSaved(radioTracks[0].key), false);
    assert.equal(sessions.markSaved(list[0].key), false, 'una canción normal no cambia');
    assert.equal(sessions.allTracks().find(t => t.title === 'R0').saved, true);
});

// ------------------------------------------------------------------ por la API

const waitFor = async (check, ms = 2000) => {
    for (const until = Date.now() + ms; Date.now() < until;) {
        const value = await check();
        if (value) return value;
        await sleep(15);
    }
    return null;
};

test('API: con «Radio» apagada la lista se acaba; al marcarla, sigue con canciones nuevas', async () => {
    const fetchMix = fakeMixes();
    const s = await startServer({ fetchMix });
    try {
        const list = s.lists.create('rock');
        s.lists.addTracks(list.id, [0, 1, 2].map(seedTrack));
        assert.deepEqual((await s.call('GET', '/api/radio')).body, { radio: { enabled: false, status: 'idle' } });

        // Apagada: llega al final y no se añade nada
        let { body } = await s.call('POST', '/api/session', { listId: list.id, startKey: yt('seed', 2) });
        assert.equal(body.session.radio.enabled, false);
        await sleep(60);
        assert.equal((await s.call('GET', '/api/session')).body.session.count, 3);
        assert.equal(fetchMix.calls.length, 0);

        // Se marca: como ya está en la última, se rellena enseguida
        assert.equal((await s.call('PUT', '/api/radio', { enabled: 'sí' })).status, 400);
        assert.equal((await s.call('PUT', '/api/radio', { enabled: true })).body.radio.enabled, true);
        const grown = await waitFor(async () => {
            const view = (await s.call('GET', '/api/session')).body.session;
            return view.count === 8 ? view : null;
        });
        assert.ok(grown, 'la sesión ha crecido en una tanda');
        assert.equal(grown.window.next.track.radio, true, 'la siguiente es de la radio');
        assert.equal(grown.radio.status, 'idle');
        const queue = (await s.call('GET', '/api/session/queue?from=3&limit=10')).body.entries;
        assert.equal(queue.length, 5);
        assert.ok(queue.every(e => e.track.radio === true && !/^yt:seed/.test(e.track.key)), 'ninguna de la lista');

        // El aviso al cliente: el informe de posición devuelve cuántas canciones tiene ya la sesión
        const report = (await s.call('PUT', '/api/session/state', { index: 2, positionMs: 1000 })).body;
        assert.deepEqual(report, { ok: true, count: 8, radio: 'idle' });

        // Avanzando, cuando vuelve a quedar una sola por detrás, llega otra tanda distinta
        await s.call('POST', '/api/session/goto', { index: 6 });
        const more = await waitFor(async () => ((await s.call('GET', '/api/session')).body.session.count === 13 ? true : null));
        assert.ok(more, 'segunda tanda');
        const all = (await s.call('GET', '/api/session/queue?from=0&limit=50')).body.entries.map(e => e.track.key);
        assert.equal(new Set(all).size, 13, 'sin repetidas');

        // Guardar en la lista una canción de la radio: entra en la lista y deja de ser «de la radio»
        const fromRadio = queue[0].track;
        assert.equal((await s.call('POST', `/api/lists/${list.id}/tracks`, { track: fromRadio })).body.added, 1);
        assert.equal(s.lists.get(list.id).tracks.at(-1).key, fromRadio.key);
        assert.equal(s.lists.get(list.id).tracks.at(-1).radio, undefined, 'en la lista se guarda limpia');
        assert.equal((await s.call('GET', '/api/session/queue?from=3&limit=1')).body.entries[0].track.saved, true);

        // Con «repetir todo» no hace falta radio: no se añade nada más
        await s.call('PUT', '/api/session', { repeat: 'all' });
        await s.call('POST', '/api/session/goto', { index: 12 });
        await sleep(60);
        assert.equal((await s.call('GET', '/api/session')).body.session.count, 13);
    } finally {
        await s.close();
    }
});

test('API: «Tu radio» parte del historial y de las listas, y sigue sola aunque la opción esté apagada', async () => {
    const fetchMix = fakeMixes();
    const s = await startServer({ fetchMix });
    try {
        // Sin nada escuchado ni listas no hay de dónde partir
        assert.deepEqual((await s.call('POST', '/api/session', { radio: 'home' })), { status: 422, body: { error: 'no_seeds' } });

        const list = s.lists.create('mías');
        s.lists.addTracks(list.id, [1, 2].map(seedTrack));
        s.history.append({ track: seedTrack(3), source: { type: 'search', name: 'Búsqueda' } });
        s.history.append({ track: { ...seedTrack(4), radio: true }, source: { type: 'radio', name: 'Tu radio' } });

        const { status, body } = await s.call('POST', '/api/session', { radio: 'home' });
        assert.equal(status, 200);
        assert.deepEqual(body.session.source, { type: 'radio', name: 'Tu radio' });
        assert.equal(body.session.count, 5);
        assert.equal(body.session.window.current.track.radio, true);
        assert.ok(!fetchMix.calls.includes(id('seed', 4)), 'lo que puso la radio no hace de semilla');
        assert.ok(fetchMix.calls.every(call => [1, 2, 3].includes(Number(call.slice(4)))));

        // Ninguna de las suyas, y al acercarse al final llega otra tanda (la opción sigue apagada)
        const first = (await s.call('GET', '/api/session/queue?from=0&limit=10')).body.entries.map(e => e.track.key);
        assert.ok(first.every(key => !/^yt:seed/.test(key)));
        assert.equal(body.session.radio.enabled, false);
        await s.call('POST', '/api/session/goto', { index: 3 });
        assert.ok(await waitFor(async () => ((await s.call('GET', '/api/session')).body.session.count === 10 ? true : null)));
    } finally {
        await s.close();
    }
});

test('API: una canción suelta con «Radio» marcada sigue con parecidas a ella', async () => {
    const fetchMix = fakeMixes();
    const s = await startServer({ fetchMix });
    try {
        await s.call('PUT', '/api/radio', { enabled: true });
        await s.call('POST', '/api/session', { track: seedTrack(5) });
        const view = await waitFor(async () => {
            const session = (await s.call('GET', '/api/session')).body.session;
            return session.count === 6 ? session : null;
        });
        assert.ok(view);
        assert.deepEqual(fetchMix.calls, [id('seed', 5)]);
        assert.equal(view.window.next.track.radio, true);
    } finally {
        await s.close();
    }
});

test('API: si la radio falla, la sesión sigue igual, se ve el estado y no se reintenta sin parar', async () => {
    let calls = 0;
    const s = await startServer({ fetchMix: async () => { calls++; throw new Error('YouTube no responde'); } });
    try {
        await s.call('PUT', '/api/radio', { enabled: true });
        await s.call('POST', '/api/session', { track: seedTrack(1) });
        const failed = await waitFor(async () => ((await s.call('GET', '/api/session')).body.session.radio.status === 'error' ? true : null));
        assert.ok(failed, 'el estado pasa a error');
        const before = calls;
        for (let i = 0; i < 5; i++) await s.call('PUT', '/api/session/state', { index: 0, positionMs: 1000 * i });
        await sleep(40);
        assert.equal(calls, before, 'no vuelve a intentarlo en cada informe');
        assert.equal((await s.call('GET', '/api/session')).body.session.count, 1);
    } finally {
        await s.close();
    }
});

test('API: sin motor de radio (servidor antiguo o pruebas), todo sigue como antes', async () => {
    const s = await startServer();
    try {
        await s.call('PUT', '/api/radio', { enabled: true });
        const { body } = await s.call('POST', '/api/session', { track: seedTrack(1) });
        assert.equal(body.session.count, 1);
        assert.equal((await s.call('POST', '/api/session', { radio: 'home' })).status, 404);
    } finally {
        await s.close();
    }
});

test('API: la radio de un usuario no toca la del otro', async () => {
    const s = await startServer({ fetchMix: fakeMixes() });
    try {
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        await s.call('PUT', '/api/radio', { enabled: true });
        assert.equal((await s.call('GET', '/api/radio', undefined, other)).body.radio.enabled, false);
        await s.call('POST', '/api/session', { track: seedTrack(1) }, other);
        await sleep(60);
        assert.equal((await s.call('GET', '/api/session', undefined, other)).body.session.count, 1);
    } finally {
        await s.close();
    }
});

// ------------------------------------------------------------------ aprende de lo que se salta (17-11)

const DAY = 24 * 60 * 60 * 1000;

test('radio aprende: una canción saltada no vuelve a esa radio en 15 días, y solo en esa', () => {
    let now = Date.parse('2026-11-17T12:00:00Z');
    const dir = tempDataDir();
    const memory = new RadioMemory(dir, { now: () => now });
    const song = { key: yt('sk', 1), platform: 'youtube', title: 'Grupo X - Tema 1 (Official Video)', artist: 'Grupo X' };
    assert.deepEqual(memory.skip('list:a', song), { skips: 1, blocked: null });
    assert.ok(memory.avoid('list:a').songs.has(song));
    assert.ok(memory.avoid('list:a').songs.has({ key: yt('sk', 2), title: 'Grupo X - Tema 1 (Lyrics)', artist: 'Letras' }), 'también en otro vídeo');
    assert.ok(!memory.avoid('list:b').songs.has(song), 'otra radio no se entera');
    assert.ok(!memory.avoid('home').songs.has(song));
    assert.ok(new RadioMemory(dir, { now: () => now }).avoid('list:a').songs.has(song), 'queda en disco');
    now += SKIP_SONG_MS - 1000;
    assert.ok(memory.avoid('list:a').songs.has(song), 'a los 14 días y pico sigue fuera');
    now += 2000;
    assert.ok(!memory.avoid('list:a').songs.has(song), 'a los 15 días puede volver');
});

test('radio aprende: 5 saltos de un artista en 30 días lo dejan fuera de esa radio 30 días; después empieza de cero', () => {
    let now = Date.parse('2026-11-17T12:00:00Z');
    const memory = new RadioMemory(tempDataDir(), { now: () => now });
    const song = n => ({ key: yt('ar', n), platform: 'youtube', title: `Grupo X - Tema ${n}`, artist: 'GrupoXVEVO' });
    for (let n = 1; n <= 4; n++) {
        assert.equal(memory.skip('list:a', song(n)).blocked, null);
        now += DAY;
    }
    assert.ok(!memory.avoid('list:a').artists.has('grupox'), 'con 4 saltos, aún no');
    memory.skip('list:b', song(9));
    assert.ok(!memory.avoid('list:a').artists.has('grupox'), 'un salto en otra radio no suma');
    const { skips, blocked } = memory.skip('list:a', song(5));
    assert.equal(skips, 5);
    assert.equal(blocked.until, new Date(now + ARTIST_BLOCK_MS).toISOString());
    assert.ok(memory.avoid('list:a').artists.has('grupox'), 'al quinto, fuera');
    assert.ok(!memory.avoid('list:b').artists.has('grupox'), 'solo en esa radio');
    assert.ok(!memory.avoid('home').artists.has('grupox'));
    now += ARTIST_BLOCK_MS - 1000;
    assert.ok(memory.avoid('list:a').artists.has('grupox'), 'fuera hasta cumplir los 30 días');
    now += 2000;
    assert.ok(!memory.avoid('list:a').artists.has('grupox'), 'a los 30 días vuelve');
    assert.equal(memory.skip('list:a', song(6)).skips, 1, 'los saltos de antes del bloqueo ya no cuentan');
    assert.ok(!memory.avoid('list:a').artists.has('grupox'));
});

test('radio aprende: 5 saltos repartidos en más de 30 días no echan al artista', () => {
    let now = Date.parse('2026-11-17T12:00:00Z');
    const memory = new RadioMemory(tempDataDir(), { now: () => now });
    for (let n = 1; n <= 5; n++) {
        memory.skip('home', { key: yt('sp', n), platform: 'youtube', title: `Grupo Y - Tema ${n}`, artist: 'Grupo Y' });
        now += 8 * DAY;          // saltos los días 0, 8, 16, 24 y 32
    }
    assert.ok(!memory.avoid('home').artists.has('grupoy'));
});

test('radio aprende: no pone lo saltado ni al artista que está fuera; otra radio sí', async () => {
    const memory = new RadioMemory(tempDataDir());
    // Grupo 1 (la mezcla de la semilla 1 trae 6 canciones suyas): 5 saltos en esta radio lo dejan fuera
    for (let i = 0; i < 5; i++) memory.skip('list:a', { key: yt('own1x', i), platform: 'youtube', title: `Grupo 1 - Otra suya ${i}`, artist: 'Grupo 1' });
    const skipped = { key: yt('mix1x', 0), platform: 'youtube', title: 'Banda 1-0 - Tema 1-0 (Official Video)', artist: 'Banda 1-0' };
    memory.skip('list:a', skipped);
    assert.ok(memory.avoid('list:a').artists.has('grupo1'));

    const radio = new Radio({ fetchMix: fakeMixes(), random: rng(5) });
    const seedKeys = [yt('seed', 1), yt('seed', 2)];
    const inA = [];
    for (let batch = 0; batch < 8; batch++) inA.push(...(await radio.batch({ scope: 'list:a', seedKeys, exclude: new SongSet(), memory })).tracks);
    assert.ok(inA.length >= 30, `solo ${inA.length}`);
    assert.ok(!inA.some(t => songSig(t).artist === 'grupo1'), 'Grupo 1 está fuera de esta radio');
    assert.ok(!inA.some(t => t.key === skipped.key), 'la saltada no vuelve');

    const inB = [];
    for (let batch = 0; batch < 4; batch++) inB.push(...(await radio.batch({ scope: 'list:b', seedKeys, exclude: new SongSet(), memory })).tracks);
    assert.ok(inB.some(t => songSig(t).artist === 'grupo1'), 'en otra radio Grupo 1 sí sale');
    assert.ok(inB.some(t => t.key === skipped.key), 'y la saltada también');
});

test('radio aprende: al dejar una canción de la radio se sabe cuánto sonó, o si no llegó a sonar', () => {
    let now = 1_000_000;
    const sessions = new SessionStore(tempDataDir(), { now: () => now });
    const radioTrack = n => ({ ...seedTrack(n), key: yt('rad', n), radio: true });
    const [r1, r2, r3] = [1, 2, 3].map(radioTrack);
    sessions.start({ source: { type: 'list', id: 'l_0123456789', name: 'rock' }, tracks: [seedTrack(9), r1, r2, r3] });
    assert.equal(sessions.leaving(), null, 'una canción propia no cuenta');

    now += 1000;
    sessions.goto(1);
    assert.deepEqual(sessions.leaving(), { track: r1, heardMs: null }, 'aún no ha empezado a sonar');
    now += 12_000;
    sessions.served(r1.key);          // en frío: el audio empieza a llegar a los 12 s
    now += 8_000;
    assert.equal(sessions.leaving().heardMs, 8_000, 'cuenta desde que empezó a sonar, no desde que se pidió');
    now += 4_000;
    sessions.report({ index: 1, positionMs: 12_000 });
    now += 2_000;
    assert.equal(sessions.leaving().heardMs, 14_000, 'desde el último informe de posición');

    // La siguiente ya estaba cargada (el reproductor la pidió antes): cuenta desde que se pasó a ella
    sessions.served(r2.key);
    now += 5_000;
    sessions.goto(2);
    now += 3_000;
    assert.equal(sessions.leaving().heardMs, 3_000);
    sessions.markSaved(r2.key);
    assert.equal(sessions.leaving(), null, 'guardada en una lista ya no es «de la radio»');

    now += 1000;
    sessions.goto(3);
    sessions.served(r3.key);
    now += 31_000;
    sessions.report({ index: 3, positionMs: 31_000 });
    assert.equal(sessions.leaving(), null, 'pasados 30 s cuenta como escuchada');
});

test('API: dejar antes de 15 s una canción que puso la radio de una lista lo aprende esa radio; oída un rato, sin llegar a sonar o propia, no', async () => {
    const s = await startServer({ fetchMix: fakeMixes() });
    try {
        const list = s.lists.create('rock');
        s.lists.addTracks(list.id, [0, 1, 2].map(seedTrack));
        await s.call('PUT', '/api/radio', { enabled: true });
        await s.call('POST', '/api/session', { listId: list.id, startKey: yt('seed', 2) });
        assert.ok(await waitFor(async () => ((await s.call('GET', '/api/session')).body.session.count === 8 ? true : null)), 'llega la tanda');
        const radioTracks = (await s.call('GET', '/api/session/queue?from=3&limit=5')).body.entries.map(e => e.track);
        const memory = s.stores.for(s.owner.id).radio;
        const scope = `list:${list.id}`;
        const listen = async key => { await (await s.api(`/api/stream/${encodeURIComponent(key)}`, { token: s.token })).arrayBuffer(); };

        await s.call('POST', '/api/session/goto', { index: 3 });          // deja una de la lista: no cuenta
        assert.equal(memory.skips[scope], undefined);

        await listen(radioTracks[0].key);                                    // suena y se deja enseguida: saltada
        await s.call('POST', '/api/session/goto', { index: 4 });
        assert.deepEqual(memory.skips[scope].map(e => e.key), [radioTracks[0].key]);

        await listen(radioTracks[1].key);                                    // suena 20 s: no es un salto
        await s.call('PUT', '/api/session/state', { index: 4, positionMs: 20_000 });
        await s.call('POST', '/api/session/goto', { index: 5 });

        await s.call('POST', '/api/session/goto', { index: 6 });          // se deja antes de que suene: no cuenta
        assert.deepEqual(memory.skips[scope].map(e => e.key), [radioTracks[0].key], 'solo la primera');
        assert.equal(memory.skips.home, undefined, '«Tu radio» no se entera');
        assert.ok(new RadioMemory(s.stores.dir(s.owner.id)).skips[scope], 'queda en disco');
    } finally {
        await s.close();
    }
});
