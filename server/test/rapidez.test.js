// Primer intento de cada canción sin la «tele Samsung» de yt-dlp; el reintento, como siempre (docs/RAPIDEZ.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioCache } from '../src/audio.js';
import { audioArgs } from '../src/ytdlp.js';
import { fakeAudio, fakeOpen } from './helpers.js';

const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const clients = args => {
    const i = args.indexOf('--extractor-args');
    return i === -1 ? null : args[i + 1];
};

function withEnv(vars, fn) {
    const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(before)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

test('primer intento sin la tele Samsung; el reintento con los clientes de yt-dlp tal cual', () => {
    withEnv({ YTDLP_FAST_CLIENTS: undefined, YTDLP_PLAYER_CLIENT: undefined }, () => {
        assert.equal(clients(audioArgs(URL)), 'youtube:player_client=default,-tv_samsung', 'sin decir nada, es el primer intento');
        assert.equal(clients(audioArgs(URL, { attempt: 1 })), 'youtube:player_client=default,-tv_samsung');
        assert.equal(clients(audioArgs(URL, { attempt: 2 })), null, 'el reintento, como siempre');
        assert.equal(audioArgs(URL).at(-1), URL);
    });
});

test('YTDLP_FAST_CLIENTS vacío lo apaga, y YTDLP_PLAYER_CLIENT manda sobre todo', () => {
    withEnv({ YTDLP_FAST_CLIENTS: '', YTDLP_PLAYER_CLIENT: undefined }, () => {
        assert.equal(clients(audioArgs(URL)), null);
    });
    withEnv({ YTDLP_FAST_CLIENTS: undefined, YTDLP_PLAYER_CLIENT: 'web' }, () => {
        const args = audioArgs(URL);
        assert.equal(clients(args), 'youtube:player_client=web');
        assert.equal(args.filter(a => a === '--extractor-args').length, 1, 'nunca dos a la vez');
        assert.equal(clients(audioArgs(URL, { attempt: 2 })), 'youtube:player_client=web');
    });
});

test('AudioCache dice a la fuente qué intento es: un rechazo del primero se reintenta por el camino de siempre', async () => {
    const bytes = fakeAudio(12_000);
    const open = fakeOpen(bytes, { failFirst: 1 });
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open });
    await cache.get('yt:aaaaaaaaaaa', URL, { aacToAdts: false }).waitHeader();
    assert.deepEqual(open.options.map(o => o.attempt), [1, 2]);
    assert.ok(open.options.every(o => o.aacToAdts === false), 'el resto de opciones sigue igual');
});
