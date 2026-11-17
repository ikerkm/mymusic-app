import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureStore, reasonOf } from '../src/failures.js';
import { startServer, tempDataDir } from './helpers.js';

// Canciones que fallan (§19): el apartado de cada usuario y el «otro enlace», común a todos

const id = (prefix, n) => `${prefix}${String(n).padStart(11 - prefix.length, '0')}`;
const song = (n, extra = {}) => ({ key: `yt:${id('song', n)}`, platform: 'youtube', title: `Canción ${n}`, artist: 'Halcyon Drift', durationSec: 245, thumb: null, ...extra });
const AGE = 'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.';

test('motivos en claro', () => {
    assert.deepEqual(reasonOf(AGE), { code: 'age', text: 'Tiene restricción de edad' });
    assert.equal(reasonOf("ERROR: [youtube] x: Sign in to confirm you're not a bot").code, 'bot');
    assert.equal(reasonOf('ERROR: [youtube] x: Video unavailable. This video has been removed').code, 'unavailable');
    assert.equal(reasonOf('ERROR: [youtube] x: Private video').code, 'unavailable');
    assert.deepEqual(reasonOf('ERROR: unable to download video data: HTTP Error 403: Forbidden'), { code: 'forbidden', text: 'YouTube rechazó la descarga' });
    assert.deepEqual(reasonOf('algo\nERROR: otra cosa rara'), { code: 'other', text: 'otra cosa rara' });
    assert.equal(reasonOf('').text, 'No se pudo sacar el audio');
});

test('FailureStore: cuenta las veces (no los reintentos seguidos), la más reciente primero y se olvida al resolver', () => {
    let now = Date.parse('2026-11-17T12:00:00Z');
    const dir = tempDataDir();
    const store = new FailureStore(dir, { now: () => now });
    store.note(song(1), reasonOf(AGE), { list: { id: 'l_aaaaaaaaaa', name: 'breakcore' } });
    now += 5_000;
    assert.equal(store.note(song(1), reasonOf(AGE)).count, 1, 'un reintento del reproductor no suma');
    now += 120_000;
    const again = store.note(song(1), reasonOf(AGE));
    assert.equal(again.count, 2);
    assert.deepEqual(again.list, { id: 'l_aaaaaaaaaa', name: 'breakcore' }, 'se conserva la lista');
    now += 1_000;
    store.note(song(2), reasonOf('HTTP Error 403: Forbidden'));
    assert.deepEqual(store.all().map(f => f.key), [song(2).key, song(1).key]);
    assert.equal(new FailureStore(dir).count, 2, 'queda en disco');
    assert.equal(store.remove(song(1).key), true);
    assert.equal(store.remove(song(1).key), false);
    assert.equal(store.count, 1);
});

test('API: una canción que no se puede sacar da el motivo, queda apuntada y sale al volver a sonar', async () => {
    // Las dos primeras extracciones fallan (el intento y el reintento del servidor); la tercera va bien
    const s = await startServer({ openOptions: { failFirst: 2, stderr: AGE } });
    try {
        const list = s.lists.create('breakcore');
        s.lists.addTracks(list.id, [song(1), song(2)]);
        await s.call('POST', '/api/session', { listId: list.id });
        const failed = await s.api(`/api/stream/${encodeURIComponent(song(1).key)}`, { token: s.token });
        assert.equal(failed.status, 502);
        assert.deepEqual(await failed.json(), { error: 'extract_failed', message: 'Tiene restricción de edad', reason: 'Tiene restricción de edad', code: 'age' });

        const { body } = await s.call('GET', '/api/failures');
        assert.equal(body.count, 1);
        const [item] = body.failures;
        assert.equal(item.key, song(1).key);
        assert.equal(item.track.title, 'Canción 1');
        assert.equal(item.track.liked, false);
        assert.equal(item.reason, 'Tiene restricción de edad');
        assert.equal(item.count, 1);
        assert.deepEqual(item.list, { id: list.id, name: 'breakcore' });
        assert.equal((await s.call('GET', `/api/failures/${encodeURIComponent(song(1).key)}`)).body.failure.code, 'age');

        // Otro usuario no ve los fallos de este
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        assert.equal((await s.call('GET', '/api/failures', undefined, other)).body.count, 0);

        // Vuelve a sonar bien: sale del apartado
        const ok = await s.api(`/api/stream/${encodeURIComponent(song(1).key)}`, { token: s.token });
        assert.equal(ok.status, 200);
        await ok.arrayBuffer();
        assert.equal((await s.call('GET', '/api/failures')).body.count, 0);
    } finally {
        await s.close();
    }
});

test('API: una de Spotify sin nada en YouTube queda apuntada como «No se ha encontrado en YouTube»', async () => {
    const s = await startServer({ matchSearch: async () => [] });
    try {
        const track = { key: 'sp:4uLU6hMCjMI75M1A2tKUQC', platform: 'spotify', title: 'Rara', artist: 'Nadie', durationSec: 200 };
        await s.call('POST', '/api/session', { track });
        const res = await s.api(`/api/stream/${encodeURIComponent(track.key)}`, { token: s.token });
        assert.equal(res.status, 502);
        assert.equal((await res.json()).code, 'nomatch');
        const [item] = (await s.call('GET', '/api/failures')).body.failures;
        assert.equal(item.track.title, 'Rara');
        assert.equal(item.list, null);
    } finally {
        await s.close();
    }
});

test('API: descartar, candidatos y «otro enlace» (común a todos, y elegir el suyo lo quita)', async () => {
    const search = async q => [
        { key: `yt:${id('altv', 1)}`, platform: 'youtube', title: `${q} (Topic)`, artist: 'Halcyon Drift - Topic', durationSec: 245, thumb: null },
        { key: `yt:${id('altv', 2)}`, platform: 'youtube', title: `${q} (live)`, artist: 'Otro', durationSec: 330, thumb: null },
    ];
    const importers = { youtubeVideo: async videoId => ({ key: `yt:${videoId}`, platform: 'youtube', title: 'Pegado', artist: 'Canal', durationSec: 244, thumb: null }) };
    const s = await startServer({ openOptions: { failFirst: 4, stderr: AGE }, search, importers });
    const stream = key => s.api(`/api/stream/${encodeURIComponent(key)}`, { token: s.token }).then(r => r.arrayBuffer().then(() => r.status));
    try {
        await s.call('POST', '/api/session', { track: song(1) });
        assert.equal(await stream(song(1).key), 502);
        await s.call('POST', '/api/session', { track: song(2) });
        assert.equal(await stream(song(2).key), 502);
        assert.equal((await s.call('GET', '/api/failures')).body.count, 2);

        // Descartar: deja de salir, sin tocar nada más
        const dismissed = await s.call('DELETE', `/api/failures/${encodeURIComponent(song(2).key)}`);
        assert.deepEqual(dismissed.body, { ok: true, count: 1 });
        assert.equal((await s.call('DELETE', `/api/failures/${encodeURIComponent(song(2).key)}`)).status, 404);

        // Candidatos: búsqueda por artista y título, con lo que se alejan de su duración
        const candidates = (await s.call('GET', `/api/failures/${encodeURIComponent(song(1).key)}/candidates`)).body;
        assert.equal(candidates.current, song(1).key, 'ahora suena desde el suyo');
        assert.deepEqual(candidates.candidates.map(c => c.durationDiff), [0, 85]);
        assert.match(candidates.candidates[0].title, /^Halcyon Drift Canción 1/);

        // Elegir otro: sale del apartado y, para cualquier usuario, suena desde ese vídeo
        const chosen = candidates.candidates[0];
        const linked = await s.call('PUT', `/api/failures/${encodeURIComponent(song(1).key)}/link`, { track: chosen });
        assert.equal(linked.status, 200);
        assert.equal(linked.body.count, 0);
        assert.equal(s.alternates.get(song(1).key).key, chosen.key);
        const before = s.open.calls.length;
        await stream(song(1).key);
        assert.ok(s.open.calls.slice(before).every(url => url.includes(id('altv', 1))), `pide el otro vídeo: ${s.open.calls.slice(before).join(', ')}`);

        // Pegar un enlace
        s.stores.for(s.owner.id).failures.note(song(3), reasonOf(AGE));      // las extracciones ya no fallan: se apunta a mano
        assert.equal((await s.call('GET', '/api/failures')).body.failures[0]?.key, song(3).key);
        assert.equal((await s.call('PUT', `/api/failures/${encodeURIComponent(song(3).key)}/link`, { url: 'https://example.com/x' })).body.error, 'bad_link');
        const pasted = await s.call('PUT', `/api/failures/${encodeURIComponent(song(3).key)}/link`, { url: `https://youtu.be/${id('pega', 1)}` });
        assert.equal(pasted.body.current.title, 'Pegado');
        assert.equal(s.alternates.get(song(3).key).key, `yt:${id('pega', 1)}`);

        // Elegir el suyo propio quita el otro enlace
        s.stores.for(s.owner.id).failures.note(song(1), reasonOf(AGE));
        await s.call('PUT', `/api/failures/${encodeURIComponent(song(1).key)}/link`, { track: song(1) });
        assert.equal(s.alternates.get(song(1).key), null);
        assert.equal((await s.call('PUT', '/api/failures/yt:nada/link', { track: song(1) })).status, 404);
    } finally {
        await s.close();
    }
});

test('API: en una de Spotify, «otro enlace» cambia su coincidencia', async () => {
    const yt = { key: `yt:${id('coin', 1)}`, platform: 'youtube', title: 'Rara (vídeo)', artist: 'Nadie', durationSec: 200, thumb: null };
    const s = await startServer({ matchSearch: async () => [yt], openOptions: { failFirst: 2, stderr: 'HTTP Error 403: Forbidden' } });
    try {
        const track = { key: 'sp:4uLU6hMCjMI75M1A2tKUQC', platform: 'spotify', title: 'Rara', artist: 'Nadie', durationSec: 200 };
        await s.call('POST', '/api/session', { track });
        await (await s.api(`/api/stream/${encodeURIComponent(track.key)}`, { token: s.token })).arrayBuffer();
        assert.equal((await s.call('GET', '/api/failures')).body.failures[0].code, 'forbidden');
        const other = { ...yt, key: `yt:${id('coin', 2)}`, title: 'Rara (audio)' };
        await s.call('PUT', `/api/failures/${encodeURIComponent(track.key)}/link`, { track: other });
        assert.equal(s.matches.get(track.key).yt.key, other.key);
        assert.equal(s.matches.get(track.key).auto, false);
        assert.equal(s.alternates.get(track.key), null, 'no se usa el otro enlace: es su coincidencia');
    } finally {
        await s.close();
    }
});
