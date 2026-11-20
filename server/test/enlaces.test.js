import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { SongLinkStore, soundcloudPage } from '../src/songlinks.js';

// Copiar y compartir el enlace de una canción (§22)

const YT_A = 'dQw4w9WgXcQ';
const YT_B = 'abcdefghijk';
const SP = 'sp:4uLU6hMCjMI75M1A2tKUQC';
const links = async (s, key) => s.call('GET', `/api/links/${encodeURIComponent(key)}`);

test('soundcloudPage: solo páginas de canción de soundcloud.com, sin «?…»', () => {
    assert.equal(soundcloudPage('https://soundcloud.com/forss/flickermood?si=x&utm_source=clipboard'), 'https://soundcloud.com/forss/flickermood');
    assert.equal(soundcloudPage('https://soundcloud.com/forss/flickermood/'), 'https://soundcloud.com/forss/flickermood');
    for (const bad of [null, '', 'https://api.soundcloud.com/tracks/293', 'http://soundcloud.com/forss/flickermood', 'https://soundcloud.com/forss', 'https://evil.com/forss/x', 'https://soundcloud.com/forss/sets/x', 'javascript:alert(1)']) {
        assert.equal(soundcloudPage(bad), null, String(bad));
    }
});

test('API: YouTube da su vídeo; con «otro enlace», el vídeo desde el que suena', async () => {
    const s = await startServer();
    try {
        assert.deepEqual((await links(s, `yt:${YT_A}`)).body, { links: [{ platform: 'youtube', url: `https://www.youtube.com/watch?v=${YT_A}` }] });
        s.alternates.set(`yt:${YT_A}`, { key: `yt:${YT_B}`, title: 'Otra subida', artist: 'Nadie', durationSec: 200, thumb: null }, 'duena');
        assert.deepEqual((await links(s, `yt:${YT_A}`)).body.links, [{ platform: 'youtube', url: `https://www.youtube.com/watch?v=${YT_B}` }]);
        assert.deepEqual([(await links(s, 'yt:corto')).status, (await links(s, 'zz:1')).status], [400, 400]);
        assert.equal((await s.api(`/api/links/yt:${YT_A}`)).status, 401, 'hace falta entrar');
    } finally {
        await s.close();
    }
});

test('API: Spotify da el de Spotify y el del vídeo de YouTube desde el que suena', async () => {
    const yt = { key: `yt:${YT_B}`, platform: 'youtube', title: 'Rara (vídeo)', artist: 'Nadie', durationSec: 200, thumb: null };
    let found = [yt];
    const s = await startServer({ matchSearch: async () => found });
    try {
        s.matches.remember([{ key: SP, platform: 'spotify', title: 'Rara', artist: 'Nadie', durationSec: 200 }]);
        assert.deepEqual((await links(s, SP)).body.links, [
            { platform: 'spotify', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' },
            { platform: 'youtube', url: `https://www.youtube.com/watch?v=${YT_B}` },
        ]);
        // Sin coincidencia en YouTube: solo el de Spotify
        found = [];
        const other = 'sp:1111111111111111111111';
        s.matches.remember([{ key: other, platform: 'spotify', title: 'Nadie la tiene', artist: 'Nadie', durationSec: 100 }]);
        assert.deepEqual((await links(s, other)).body.links, [{ platform: 'spotify', url: 'https://open.spotify.com/track/1111111111111111111111' }]);
    } finally {
        await s.close();
    }
});

test('API: SoundCloud busca su página la primera vez y la apunta para todos', async () => {
    const asked = [];
    let answer = 'https://soundcloud.com/forss/flickermood?si=abc';
    const importers = { soundcloudLink: async id => { asked.push(id); if (answer instanceof Error) throw answer; return answer; } };
    const s = await startServer({ importers });
    try {
        const want = { links: [{ platform: 'soundcloud', url: 'https://soundcloud.com/forss/flickermood' }] };
        assert.deepEqual((await links(s, 'sc:293')).body, want);
        assert.deepEqual((await links(s, 'sc:293')).body, want);
        assert.deepEqual(asked, ['293'], 'la segunda vez no se busca');
        assert.equal(new SongLinkStore(s.dir).get('sc:293'), 'https://soundcloud.com/forss/flickermood', 'queda en disco');

        // Si yt-dlp falla o da algo que no es una página de canción: 502, y no se apunta nada
        answer = new Error('HTTP Error 404');
        assert.deepEqual([(await links(s, 'sc:294')).status, (await links(s, 'sc:294')).body.error], [502, 'link_failed']);
        answer = 'https://api.soundcloud.com/tracks/295';
        assert.equal((await links(s, 'sc:295')).status, 502);
        assert.equal(new SongLinkStore(s.dir).get('sc:295'), null);

        // Con «otro enlace», el vídeo desde el que suena
        s.alternates.set('sc:296', { key: `yt:${YT_A}`, title: 'Subida a YouTube', artist: 'Forss', durationSec: 214, thumb: null }, 'duena');
        assert.deepEqual((await links(s, 'sc:296')).body.links, [{ platform: 'youtube', url: `https://www.youtube.com/watch?v=${YT_A}` }]);
        assert.ok(!asked.includes('296'));
    } finally {
        await s.close();
    }
});

test('API: las canciones de SoundCloud buscadas o importadas ya traen su página (y no entra en las listas)', async () => {
    const sc = (n, slug) => ({ key: `sc:${n}`, platform: 'soundcloud', title: `Pista ${n}`, artist: 'Forss', durationSec: 214, thumb: null, link: `https://soundcloud.com/forss/${slug}` });
    const asked = [];
    const importers = {
        soundcloudTrack: async () => sc(293, 'flickermood'),
        soundcloudSet: async () => ({ platform: 'soundcloud', title: 'Soulhack', thumb: null, truncated: false, tracks: [sc(290, 'uno'), sc(291, 'dos')] }),
        soundcloudLink: async id => { asked.push(id); return null; },
    };
    const s = await startServer({ importers });
    try {
        const found = (await s.call('GET', `/api/search?q=${encodeURIComponent('https://soundcloud.com/forss/flickermood')}`)).body.results;
        assert.deepEqual(found.map(t => [t.key, 'link' in t]), [['sc:293', false]], 'el resultado no lleva la página');
        assert.equal((await links(s, 'sc:293')).body.links[0].url, 'https://soundcloud.com/forss/flickermood');

        const list = (await s.call('POST', '/api/lists', { name: 'De SoundCloud' })).body.list;
        const preview = (await s.call('POST', '/api/import/preview', { listId: list.id, url: 'https://soundcloud.com/forss/sets/soulhack' })).body;
        await s.call('POST', `/api/lists/${list.id}/import`, { importId: preview.importId });
        const tracks = (await s.call('GET', `/api/lists/${list.id}`)).body.list.tracks;
        assert.deepEqual(tracks.map(t => [t.key, 'link' in t]), [['sc:290', false], ['sc:291', false]]);
        assert.equal((await links(s, 'sc:291')).body.links[0].url, 'https://soundcloud.com/forss/dos');
        assert.deepEqual(asked, [], 'no hizo falta buscar ninguna');
    } finally {
        await s.close();
    }
});
