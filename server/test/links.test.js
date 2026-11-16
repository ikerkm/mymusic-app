import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// Identificadores con la forma de los de Spotify (22 letras o números)
const id = n => `Cancion${String(n).padStart(15, '0')}`;
const link = n => `https://open.spotify.com/track/${id(n)}`;

// Lector de canciones de mentira: sin red. Las que empiezan por «Rota» fallan siempre.
function fakeImporters() {
    const state = { calls: [], running: 0, peak: 0, flaky: new Set() };
    const importers = {
        spotifyTrack: async trackId => {
            state.calls.push(trackId);
            state.running++;
            state.peak = Math.max(state.peak, state.running);
            await new Promise(resolve => setTimeout(resolve, 5));
            state.running--;
            if (trackId.startsWith('Rota')) throw new Error('no se puede leer');
            if (state.flaky.delete(trackId)) throw new Error('fallo pasajero');
            return { key: `sp:${trackId}`, platform: 'spotify', title: `Título ${trackId.slice(-3)}`, artist: 'Alguien', durationSec: 200, thumb: 'https://i.scdn.co/image/x' };
        },
    };
    return { importers, state };
}

test('un bloque de enlaces de canciones de Spotify se lee, se resume y se añade en su orden', async () => {
    const { importers, state } = fakeImporters();
    const s = await startServer({ importers });
    try {
        const list = s.lists.create('breakcore');
        const links = [
            link(1),
            `https://open.spotify.com/intl-es/track/${id(2)}?si=abc123`,
            `spotify:track:${id(3)}`,
            link(1),                                              // repetida en el propio bloque
            'https://open.spotify.com/playlist/37i9dQZF1DWXRqgorJj26U',   // no es una canción
            'una línea cualquiera',
            `https://open.spotify.com/track/${'Rota'.padEnd(22, 'x')}`,    // no se puede leer
        ];
        const preview = await s.call('POST', '/api/import/links', { listId: list.id, links });
        assert.equal(preview.status, 200);
        assert.equal(preview.body.count, 3);
        assert.equal(preview.body.newCount, 3);
        assert.equal(preview.body.already, 0);
        assert.deepEqual(preview.body.batch, { read: 3, failed: 1, ignored: 2 });
        assert.equal(preview.body.platform, 'spotify');
        assert.equal(state.calls.filter(c => c.startsWith('Rota')).length, 2);      // se reintenta una vez
        assert.equal(s.lists.get(list.id).tracks.length, 0);                          // aún no se ha añadido nada

        const done = await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.body.importId });
        assert.equal(done.body.added, 3);
        assert.deepEqual(s.lists.get(list.id).tracks.map(t => t.key), [1, 2, 3].map(n => `sp:${id(n)}`));
        // Quedan apuntadas para buscarles coincidencia en YouTube la primera vez que suenen
        assert.ok(s.matches.get(`sp:${id(2)}`));
    } finally {
        await s.close();
    }
});

test('las tandas se suman a la misma importación y lo que ya está en la lista no se duplica', async () => {
    const { importers } = fakeImporters();
    const s = await startServer({ importers });
    try {
        const list = s.lists.create('entera');
        // La lista ya tenía las 100 primeras (lo que deja leer la página pública): aquí, las 3 primeras
        s.lists.addTracks(list.id, [1, 2, 3].map(n => ({ key: `sp:${id(n)}`, platform: 'spotify', title: `Título ${n}` })));

        const first = await s.call('POST', '/api/import/links', { listId: list.id, links: [1, 2, 3, 4, 5].map(link) });
        assert.equal(first.body.count, 5);
        assert.equal(first.body.newCount, 2);
        assert.equal(first.body.already, 3);

        const second = await s.call('POST', '/api/import/links', { listId: list.id, links: [5, 6, 7].map(link), importId: first.body.importId });
        assert.equal(second.body.importId, first.body.importId);
        assert.equal(second.body.count, 7);          // la 5 ya venía en la primera tanda
        assert.equal(second.body.newCount, 4);
        assert.deepEqual(second.body.batch, { read: 2, failed: 0, ignored: 0 });

        const done = await s.call('POST', `/api/lists/${list.id}/import`, { importId: first.body.importId });
        assert.equal(done.body.added, 4);
        assert.deepEqual(s.lists.get(list.id).tracks.map(t => t.key), [1, 2, 3, 4, 5, 6, 7].map(n => `sp:${id(n)}`));

        // Volver a pegar el mismo bloque no añade nada
        const again = await s.call('POST', '/api/import/links', { listId: list.id, links: [1, 2, 3, 4, 5, 6, 7].map(link) });
        assert.equal(again.body.newCount, 0);
        assert.equal(again.body.already, 7);
        assert.equal((await s.call('POST', `/api/lists/${list.id}/import`, { importId: again.body.importId })).body.added, 0);
        assert.equal(s.lists.get(list.id).tracks.length, 7);
    } finally {
        await s.close();
    }
});

test('un fallo pasajero se reintenta, y nunca se leen más de cuatro canciones a la vez', async () => {
    const { importers, state } = fakeImporters();
    const s = await startServer({ importers });
    try {
        const list = s.lists.create('larga');
        state.flaky.add(id(7));
        const all = Array.from({ length: 100 }, (_, n) => link(n + 1));
        const preview = await s.call('POST', '/api/import/links', { listId: list.id, links: all });
        assert.equal(preview.body.count, 100);
        assert.deepEqual(preview.body.batch, { read: 100, failed: 0, ignored: 0 });
        assert.ok(state.peak <= 4, `a la vez: ${state.peak}`);
        assert.ok(state.peak >= 2);
        const done = await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.body.importId });
        assert.equal(done.body.added, 100);
        assert.equal(s.lists.get(list.id).tracks[6].key, `sp:${id(7)}`);     // el orden del bloque se respeta
    } finally {
        await s.close();
    }
});

test('límites: tanda vacía o de más de 100, lista ajena o inexistente, importación de otro', async () => {
    const { importers } = fakeImporters();
    const s = await startServer({ importers });
    try {
        const list = s.lists.create('mía');
        const post = (body, as) => s.call('POST', '/api/import/links', body, as);
        assert.equal((await post({ listId: list.id, links: [] })).status, 400);
        assert.equal((await post({ listId: list.id, links: 'no es una lista' })).status, 400);
        assert.equal((await post({ listId: list.id, links: Array.from({ length: 101 }, (_, n) => link(n)) })).status, 400);
        assert.equal((await post({ listId: 'l_noexiste00', links: [link(1)] })).status, 404);
        assert.equal((await post({ listId: list.id, links: [link(1)], importId: 'i_noexiste' })).status, 410);

        // Otra persona no puede ni leer para mi lista ni seguir mi importación
        s.auth.createUser('otra', 'clave-de-la-otra');
        const other = (await (await s.login('clave-de-la-otra', 'otra', 'su móvil')).json()).token;
        assert.equal((await post({ listId: list.id, links: [link(1)] }, other)).status, 404);
        const mine = await post({ listId: list.id, links: [link(1)] });
        const hers = s.stores.for(s.auth.findUser('otra').id).lists.create('suya');
        assert.equal((await post({ listId: hers.id, links: [link(2)], importId: mine.body.importId }, other)).status, 410);

        // Solo líneas que no son canciones: se responde sin nada que añadir
        const nothing = await post({ listId: list.id, links: ['hola', 'https://example.com/x'] });
        assert.equal(nothing.status, 200);
        assert.equal(nothing.body.count, 0);
        assert.deepEqual(nothing.body.batch, { read: 0, failed: 0, ignored: 2 });
    } finally {
        await s.close();
    }
});
