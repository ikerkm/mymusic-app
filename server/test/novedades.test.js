import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_DAYS, DAY_MS, FollowStore, NEW_DAYS, ReleaseWatch, releaseKey } from '../src/follows.js';
import { YtMusic, modeDate, words } from '../src/ytmusic.js';
import { PASSWORD, startServer, tempDataDir } from './helpers.js';

// Artistas que sigues y sus novedades (§21), con un doble de YouTube Music: sin red

const HD = 'UC' + 'h'.repeat(22);        // Halcyon Drift
const SK = 'UC' + 's'.repeat(22);        // Sora Kite
const OK = 'UC' + 'o'.repeat(22);        // DJ Okapi
const GONE = 'UC' + 'x'.repeat(22);      // ya no existe
const NOW = new Date(2026, 10, 18, 10, 0, 0).getTime();
const daysAgo = (n, now = NOW) => new Date(now - n * DAY_MS).toISOString().slice(0, 10);
const album = (id, title, kind, year) => ({ id: `MPREb_${id}`, title, kind, year, thumb: `https://lh3.googleusercontent.com/${id}=w544-h544-l90-rj` });

/** Doble de YouTube Music: páginas y fechas que cada prueba puede cambiar; `calls` apunta cada llamada. */
function fakeClient() {
    const calls = [];
    const fail = new Set();
    const failIds = new Set();
    const pages = {
        [HD]: { id: HD, name: 'Halcyon Drift', releases: [album('hdnew00001', 'Low Orbit (Remixes)', 'ep', 2026), album('hdold00001', 'Paper Satellites', 'album', 2023)] },
        [SK]: { id: SK, name: 'Sora Kite', releases: [album('sknew00001', 'Static Bloom', 'album', 2026), album('collab0001', 'Signal Fade', 'single', 2026)] },
        [OK]: { id: OK, name: 'DJ Okapi', releases: [album('okold00001', 'Tunnel Vision 2', 'single', 2026), album('collab0001', 'Signal Fade', 'single', 2026)] },
    };
    const dates = {
        MPREb_hdnew00001: daysAgo(5),
        MPREb_sknew00001: daysAgo(12),
        MPREb_collab0001: daysAgo(20),
        MPREb_okold00001: daysAgo(80),
    };
    const search = {
        'halcyon drift': [{ id: HD, name: 'Halcyon Drift', listeners: '4,1 M', thumb: 'https://lh3.googleusercontent.com/hd=w544-h544-l90-rj' }],
        'sora kite': [{ id: SK, name: 'Sora Kite', listeners: '1 M', thumb: 'https://lh3.googleusercontent.com/sk=w544-h544-l90-rj' }],
        'dj okapi': [{ id: OK, name: 'DJ Okapi', listeners: '90 K', thumb: null }],
    };
    const step = (what, arg) => {
        calls.push(`${what}:${arg}`);
        if (fail.has(what)) throw new Error(`YouTube Music no responde (${what})`);
    };
    return {
        calls, fail, failIds, pages, dates,
        searchArtists: async query => { step('search', query); return structuredClone(search[words(query).join(' ')] ?? []); },
        artist: async id => { step('artist', id); const p = pages[id]; return p ? { id, name: p.name, image: null, albums: [], singles: [], related: [], songs: [] } : null; },
        album: async id => { step('album', id); return { id, title: 'Disco', kind: 'album', year: 2026, thumb: null, artists: [], tracks: [] }; },
        releases: async id => { step('releases', id); if (failIds.has(id)) throw new Error('caída'); return pages[id] ? structuredClone(pages[id]) : null; },
        releaseDate: async id => { step('date', id); return dates[id] ?? null; },
    };
}

function watch({ client = fakeClient(), clock = { now: NOW } } = {}) {
    const ytmusic = new YtMusic({ client, timeoutMs: 2000 });
    const logs = [];
    const w = new ReleaseWatch(tempDataDir(), { ytmusic, now: () => clock.now, pauseMs: 0, log: m => logs.push(m) });
    return { w, client, clock, logs, ytmusic };
}
const titles = items => items.map(item => item.release.title);

// ------------------------------------------------------------------ piezas sueltas

test('fecha de un disco: la que más se repite entre sus canciones; si empatan, la más nueva', () => {
    assert.equal(modeDate(['2025-11-06T09:00:00-08:00', '2025-11-06', '2026-02-11', '2025-11-06']), '2025-11-06', 'un videoclip subido después no la cambia');
    assert.equal(modeDate(['2026-04-30', '2026-05-11']), '2026-05-11');
    assert.equal(modeDate(['', 'ayer', null, undefined]), null);
    assert.equal(modeDate([]), null);
});

test('un lanzamiento se reconoce por tipo, nombre y año, aunque cambie de id', () => {
    assert.equal(releaseKey({ kind: 'single', title: 'Dracula (con JENNIE)', year: 2026 }), releaseKey({ kind: 'single', title: 'dracula  con jennie', year: 2026 }));
    assert.notEqual(releaseKey({ kind: 'single', title: 'Dracula', year: 2025 }), releaseKey({ kind: 'single', title: 'Dracula', year: 2026 }));
});

test('seguir: cada usuario lo suyo, en su archivo; el más reciente primero; dejar de seguir', () => {
    const dir = tempDataDir();
    let t = 1000;
    const store = new FollowStore(dir, { now: () => (t += 1000) });
    assert.deepEqual(store.list(), []);
    store.follow({ id: HD, name: 'Halcyon Drift', thumb: 'http://inseguro/x.jpg' });
    store.follow({ id: SK, name: 'Sora Kite', thumb: 'https://lh3.googleusercontent.com/sk' });
    assert.deepEqual(store.list().map(a => a.id), [SK, HD]);
    assert.equal(store.list()[1].thumb, null, 'una foto que no es https no se guarda');
    const before = store.list()[1].at;
    store.follow({ id: HD, name: 'Halcyon Drift (nuevo nombre)' });
    assert.equal(store.list().find(a => a.id === HD).at, before, 'seguir otra vez no cambia desde cuándo');
    assert.throws(() => store.follow({ id: 'no-es-un-id', name: 'x' }));
    assert.equal(store.unfollow(SK), true);
    assert.equal(store.unfollow(SK), false);
    assert.equal(store.markSeen('MPREb_hdnew00001'), true);
    assert.equal(store.markSeen('MPREb_hdnew00001'), false);
    assert.equal(store.markSeen('../../etc'), false);
    const again = new FollowStore(dir);
    assert.deepEqual(again.ids(), [HD]);
    assert.equal(again.list()[0].name, 'Halcyon Drift (nuevo nombre)');
    assert.ok(again.isSeen('MPREb_hdnew00001'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'follows.json'), 'utf8'))), ['artists', 'seen']);
});

// ------------------------------------------------------------------ qué es una novedad

test('al seguir: sale lo de los últimos 30 días; lo viejo, no; y solo se pregunta la fecha de lo reciente', async () => {
    const { w, client } = watch();
    await w.check(HD);
    assert.ok(!client.calls.includes('date:MPREb_hdold00001'), 'un disco de 2023 no necesita fecha');
    const items = w.novedades([HD]);
    assert.deepEqual(titles(items), ['Low Orbit (Remixes)']);
    assert.deepEqual([items[0].when, items[0].appeared, items[0].artist], [daysAgo(5), false, { id: HD, name: 'Halcyon Drift' }]);
    assert.equal(w.entry(HD).thumb, 'https://lh3.googleusercontent.com/hd=w544-h544-l90-rj', 'la foto cuadrada sale de la búsqueda');
    assert.equal(w.latestOf(HD).title, 'Low Orbit (Remixes)');
});

test('ventana: 30 días en Inicio y 90 en «Ver todas», lo más nuevo primero; un disco de dos artistas sale una vez', async () => {
    const { w } = watch();
    for (const id of [HD, SK, OK]) await w.check(id);
    assert.deepEqual(titles(w.novedades([HD, SK, OK], { days: NEW_DAYS })), ['Low Orbit (Remixes)', 'Static Bloom', 'Signal Fade']);
    assert.deepEqual(titles(w.novedades([HD, SK, OK], { days: ALL_DAYS })), ['Low Orbit (Remixes)', 'Static Bloom', 'Signal Fade', 'Tunnel Vision 2']);
    assert.deepEqual(titles(w.novedades([OK], { days: ALL_DAYS })), ['Signal Fade', 'Tunnel Vision 2'], 'cada artista ve también lo compartido');
});

test('vuelta diaria: lo que aparece nuevo cuenta aunque su fecha sea vieja (reedición); si es de hace años, no', async () => {
    const { w, client, clock } = watch();
    await w.check(HD);
    clock.now += DAY_MS;
    client.pages[HD].releases.unshift(album('hdreis0001', 'Paper Satellites (Ed. ampliada)', 'album', 2026), album('hdvery0001', 'Demos 2009', 'album', 2009));
    client.dates.MPREb_hdreis0001 = '2023-04-01';
    await w.check(HD);
    const items = w.novedades([HD]);
    assert.deepEqual(titles(items), ['Paper Satellites (Ed. ampliada)', 'Low Orbit (Remixes)']);
    assert.deepEqual([items[0].appeared, items[0].when], [true, daysAgo(0, clock.now)], 'apareció hoy');
    assert.equal(items[1].appeared, false);
});

test('vuelta diaria: un disco que aparece y aún no tiene fecha cuenta desde que apareció', async () => {
    const { w, client, clock } = watch();
    await w.check(HD);
    clock.now += DAY_MS;
    client.pages[HD].releases.unshift(album('hdnodate01', 'Sin fecha', 'single', 2026));
    client.fail.add('date');
    await w.check(HD);
    const item = w.novedades([HD]).find(i => i.release.title === 'Sin fecha');
    assert.deepEqual([item.appeared, item.when], [false, daysAgo(0, clock.now)]);
    client.fail.delete('date');
    client.dates.MPREb_hdnodate01 = daysAgo(1, clock.now);
    clock.now += DAY_MS;
    await w.check(HD);
    assert.equal(w.novedades([HD]).find(i => i.release.title === 'Sin fecha').when, daysAgo(2, clock.now), 'cuando llega la fecha, manda la fecha');
});

test('tras más de 3 días sin mirar un artista, lo que aparezca no se toma como recién salido', async () => {
    const { w, client, clock } = watch();
    await w.check(HD);
    clock.now += 10 * DAY_MS;
    client.pages[HD].releases.unshift(album('hdgap00001', 'Salió en el hueco', 'single', 2026));
    client.dates.MPREb_hdgap00001 = '2026-06-01';
    await w.check(HD);
    assert.ok(!titles(w.novedades([HD])).includes('Salió en el hueco'));
});

test('un lanzamiento que cambia de id no es nuevo; uno que sale de la página se guarda mientras pueda ser novedad', async () => {
    const { w, client, clock } = watch();
    await w.check(SK);
    clock.now += DAY_MS;
    client.pages[SK].releases = [{ ...album('sknewid002', 'Static Bloom', 'album', 2026) }];
    await w.check(SK);
    const items = w.novedades([SK]);
    assert.deepEqual(titles(items), ['Static Bloom', 'Signal Fade'], '«Signal Fade» ya no está en la página pero sigue');
    assert.equal(items[0].release.id, 'MPREb_sknewid002', 'con el id nuevo');
    assert.equal(items[0].appeared, false);
    assert.ok(!client.calls.includes('date:MPREb_sknewid002'), 'su fecha ya se sabía');
});

test('fechas: si YouTube Music falla se intenta en la siguiente vuelta; si no hay fecha, no se insiste', async () => {
    const { w, client, clock, logs } = watch();
    client.fail.add('date');
    await w.check(HD);
    assert.equal(w.novedades([HD]).length, 0, 'al seguir y sin fecha, aún no se sabe si es reciente');
    assert.ok(logs.some(m => m.includes('fecha de «Low Orbit (Remixes)»')));
    client.fail.delete('date');
    clock.now += DAY_MS;
    await w.check(HD);
    assert.equal(w.novedades([HD]).length, 1);
    delete client.dates.MPREb_sknew00001;
    await w.check(SK);
    const asked = client.calls.filter(c => c === 'date:MPREb_sknew00001').length;
    clock.now += DAY_MS;
    await w.check(SK);
    assert.equal(client.calls.filter(c => c === 'date:MPREb_sknew00001').length, asked, 'sin fecha: no se vuelve a preguntar');
});

test('leer un artista dos veces a la vez hace una sola lectura; uno que ya no existe da null', async () => {
    const { w, client } = watch();
    const [a, b] = await Promise.all([w.check(HD), w.page(HD)]);
    assert.equal(a.name, 'Halcyon Drift');
    assert.equal(b.name, 'Halcyon Drift');
    assert.equal(client.calls.filter(c => c === `releases:${HD}`).length, 1);
    assert.equal(await w.check(GONE), null);
    assert.equal(await w.check('no-es-un-id'), null);
});

test('lo apuntado se guarda: otro arranque lo lee', async () => {
    const { w } = watch();
    await w.check(HD);
    const again = new ReleaseWatch(w.path.replace(/[\\/]releases\.json$/, ''), { ytmusic: null, now: () => NOW });
    assert.deepEqual(titles(again.novedades([HD])), ['Low Orbit (Remixes)']);
    assert.ok(again.knows('MPREb_hdnew00001'));
    assert.ok(!again.knows('MPREb_nada000001'));
});

// ------------------------------------------------------------------ vuelta diaria

test('vuelta diaria: desde las 4, una vez al día por artista, sin repetir un fallo reciente, y sigue tras un fallo', async () => {
    const { w, client, clock, logs } = watch({ clock: { now: new Date(2026, 10, 18, 3, 30).getTime() } });
    assert.deepEqual(w.due([HD, SK]), [], 'antes de las 4, nada');
    clock.now = new Date(2026, 10, 17, 12, 0).getTime();          // ayer ya se miró Sora Kite
    await w.check(SK);
    clock.now = new Date(2026, 10, 18, 4, 5).getTime();
    assert.deepEqual(w.due([HD, SK, HD]), [HD, SK]);
    client.failIds.add(SK);
    const result = await w.round([HD, SK, OK]);
    assert.deepEqual([result.checked, result.failed], [2, 1]);
    assert.ok(logs.some(m => m.startsWith('[novedades] vuelta diaria: 2 artistas mirados, 1 con fallo')));
    assert.ok(logs.some(m => m.includes('no se pudo mirar Sora Kite')));
    assert.deepEqual(w.due([HD, SK, OK]), [], 'mirados hoy; Sora Kite falló hace nada');
    clock.now += 3 * 3600_000;
    assert.deepEqual(w.due([HD, SK, OK]), [SK], 'pasadas 2 h, se reintenta el que falló');
    clock.now = new Date(2026, 10, 19, 4, 10).getTime();
    assert.deepEqual(w.due([HD, OK]), [HD, OK], 'al día siguiente, otra vez');
});

// ------------------------------------------------------------------ rutas

async function server(extra = {}) {
    const client = fakeClient();
    const clock = { now: NOW };
    const s = await startServer({ ytmusicClient: client, releasesNow: () => clock.now, artistsWaitMs: 500, ...extra });
    // Espera a que acabe la lectura que lanzó «Seguir» (las fechas van en segundo plano)
    s.settle = id => s.releases.reading.get(id)?.done.catch(() => null) ?? Promise.resolve();
    return { s, client, clock };
}

test('rutas: seguir, ver «Tus artistas» y las novedades, abrir el disco quita el punto, dejar de seguir', async () => {
    const { s, client } = await server();
    try {
        let r = await s.call('GET', `/api/artist/${HD}`);
        assert.equal(r.body.artist.following, false);
        r = await s.call('PUT', `/api/follows/${HD}`);
        assert.deepEqual([r.status, r.body.following, r.body.artist.name], [200, true, 'Halcyon Drift']);
        await s.settle(HD);                                 // las fechas van en segundo plano
        await s.call('PUT', `/api/follows/${OK}`);
        await s.settle(OK);
        assert.equal(client.calls.filter(c => c === `releases:${HD}`).length, 1, 'seguir hace una sola lectura de la página');
        r = await s.call('GET', `/api/artist/${HD}`);
        assert.equal(r.body.artist.following, true);

        r = await s.call('GET', '/api/novedades');
        assert.deepEqual([r.body.days, r.body.following, r.body.unseen], [30, 2, 2]);
        assert.deepEqual(r.body.releases.map(x => [x.title, x.artist.name, x.seen, x.appeared]), [
            ['Low Orbit (Remixes)', 'Halcyon Drift', false, false],
            ['Signal Fade', 'DJ Okapi', false, false],
        ]);
        assert.equal(r.body.releases[0].when, daysAgo(5));
        assert.equal(r.body.releases[0].kind, 'ep');
        r = await s.call('GET', '/api/novedades?days=90');
        assert.deepEqual([r.body.days, r.body.unseen, r.body.releases.length], [90, 2, 3]);

        r = await s.call('GET', '/api/follows');
        assert.deepEqual(r.body.artists.map(a => [a.name, a.isNew, a.latest.title]), [
            ['Halcyon Drift', true, 'Low Orbit (Remixes)'],
            ['DJ Okapi', true, 'Signal Fade'],
        ]);
        assert.equal(r.body.unseen, 2);

        await s.call('GET', '/api/album/MPREb_hdnew00001');
        r = await s.call('GET', '/api/novedades');
        assert.deepEqual([r.body.unseen, r.body.releases[0].seen], [1, true]);
        r = await s.call('GET', '/api/follows');
        assert.deepEqual(r.body.artists.map(a => [a.name, a.isNew]), [['DJ Okapi', true], ['Halcyon Drift', false]], 'con novedad sin abrir, primero');

        r = await s.call('POST', '/api/novedades/MPREb_collab0001/seen');
        assert.deepEqual([r.status, r.body.unseen], [200, 0], 'quitar el punto sin volver a pedir el disco');
        assert.equal((await s.call('POST', '/api/novedades/no-es-un-id/seen')).status, 400);
        r = await s.call('POST', '/api/novedades/MPREb_nada000001/seen');
        assert.equal(r.status, 200, 'un disco que no es de nadie que se siga no se apunta');
        assert.ok(!JSON.stringify(s.stores.for(s.owner.id).follows.seen).includes('MPREb_nada000001'));

        r = await s.call('DELETE', `/api/follows/${OK}`);
        assert.deepEqual([r.status, r.body.following], [200, false]);
        r = await s.call('GET', '/api/follows');
        assert.deepEqual(r.body.artists.map(a => a.name), ['Halcyon Drift']);
        r = await s.call('GET', '/api/novedades');
        assert.deepEqual([r.body.following, r.body.releases.map(x => x.title)], [1, ['Low Orbit (Remixes)']]);
    } finally {
        await s.close();
    }
});

test('rutas: sin novedad, «Tus artistas» enseña lo último (con fecha o año) y ordena por nombre', async () => {
    const { s, clock } = await server();
    try {
        await s.call('PUT', `/api/follows/${OK}`);
        await s.call('PUT', `/api/follows/${HD}`);
        await Promise.all([s.settle(OK), s.settle(HD)]);
        clock.now += 40 * DAY_MS;                           // ya no hay nada de los últimos 30 días
        const r = await s.call('GET', '/api/follows');
        assert.deepEqual(r.body.artists.map(a => [a.name, a.isNew, a.latest.title, a.latest.when]), [
            ['DJ Okapi', false, 'Signal Fade', daysAgo(60, clock.now)],
            ['Halcyon Drift', false, 'Low Orbit (Remixes)', daysAgo(45, clock.now)],
        ]);
        assert.equal(r.body.unseen, 0);
    } finally {
        await s.close();
    }
});

test('rutas: errores — id malo, artista que no existe, YouTube Music caído (no se sigue)', async () => {
    const { s, client } = await server();
    try {
        assert.equal((await s.call('PUT', '/api/follows/no-es-un-id')).status, 400);
        assert.equal((await s.call('DELETE', '/api/follows/no-es-un-id')).status, 400);
        assert.equal((await s.call('PUT', `/api/follows/${GONE}`)).status, 404);
        client.fail.add('releases');
        assert.equal((await s.call('PUT', `/api/follows/${SK}`)).status, 502);
        const r = await s.call('GET', '/api/follows');
        assert.deepEqual(r.body.artists, []);
        client.fail.delete('releases');
        assert.equal((await s.call('PUT', `/api/follows/${SK}`)).status, 200);
    } finally {
        await s.close();
    }
});

test('rutas: lo que sigue cada usuario es suyo', async () => {
    const { s } = await server();
    try {
        s.auth.createUser('pareja', 'otra-clave-de-prueba');
        const hers = (await (await s.login('otra-clave-de-prueba', 'pareja')).json()).token;
        await s.call('PUT', `/api/follows/${HD}`);
        await s.settle(HD);
        let r = await s.call('GET', '/api/follows', undefined, hers);
        assert.deepEqual(r.body.artists, []);
        r = await s.call('GET', '/api/novedades', undefined, hers);
        assert.deepEqual([r.body.following, r.body.releases], [0, []]);
        await s.call('PUT', `/api/follows/${HD}`, undefined, hers);
        await s.call('GET', '/api/album/MPREb_hdnew00001', undefined, hers);
        r = await s.call('GET', '/api/novedades');
        assert.equal(r.body.releases[0].seen, false, 'lo que abre ella no quita el punto al otro');
    } finally {
        await s.close();
    }
});

test('rutas: «Los que más escuchas» sale de sus estadísticas, con su artista de YouTube Music, sin los que ya sigue', async () => {
    const { s, client } = await server();
    try {
        const track = (n, artist) => ({ key: `yt:${String(n).padStart(11, 'b')}`, platform: 'youtube', title: `Tema ${n}`, artist, durationSec: 200 });
        for (let i = 0; i < 3; i++) s.history.append({ track: track(1, 'Sora Kite'), source: { type: 'search' } });
        for (let i = 0; i < 2; i++) s.history.append({ track: track(2, 'Halcyon Drift'), source: { type: 'search' } });
        s.history.append({ track: track(3, 'Nadie Conocido'), source: { type: 'search' } });
        let r = await s.call('GET', '/api/follows/suggestions');
        assert.deepEqual(r.body.artists.map(a => [a.name, a.plays]), [['Sora Kite', 3], ['Halcyon Drift', 2]]);
        assert.equal(r.body.artists[0].id, SK);
        await s.call('PUT', `/api/follows/${SK}`);
        r = await s.call('GET', '/api/follows/suggestions');
        assert.deepEqual(r.body.artists.map(a => a.name), ['Halcyon Drift']);
        client.fail.add('search');
        s.ytmusic.cache.clear();
        r = await s.call('GET', '/api/follows/suggestions');
        assert.deepEqual([r.status, r.body.artists], [200, []], 'si YouTube Music falla, sale vacía');
    } finally {
        await s.close();
    }
});

test('rutas: sin YouTube Music no hay seguir ni novedades', async () => {
    const s = await startServer({ password: PASSWORD });
    try {
        assert.equal((await s.call('GET', '/api/follows')).status, 404);
        assert.equal((await s.call('GET', '/api/novedades')).status, 404);
        assert.equal((await s.call('PUT', `/api/follows/${HD}`)).status, 404);
    } finally {
        await s.close();
    }
});
