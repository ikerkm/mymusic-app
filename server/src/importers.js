import { randomBytes } from 'node:crypto';
import spotifyUrlInfo from 'spotify-url-info';
import yts from 'yt-search';
import { youtubeThumb } from './sources.js';
import { fetchPlaylist } from './ytdlp.js';

// Lectores de listas y enlaces de fuera. Punto de partida: utils/spotifyHelper.js y
// ytdlpWrapper.fetchPlaylistInfo del bot (commit a2a4e99). Copia independiente.
//
// Spotify se lee de su página pública, igual que hace el bot: no hace falta cuenta ni clave, pero
// solo entrega las 100 primeras canciones de cada lista (comprobado el 2026-11-16).

export const SPOTIFY_LIMIT = 100;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const spotify = spotifyUrlInfo((...args) => fetch(...args));
const spotifyId = uri => String(uri ?? '').split(':').pop();
const seconds = ms => (Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null);

export const importers = {
    async youtubePlaylist(id) {
        const list = await fetchPlaylist(`https://www.youtube.com/playlist?list=${id}`);
        const tracks = list.entries
            // Los vídeos privados o retirados salen sin duración y con el título entre corchetes
            .filter(entry => YOUTUBE_ID.test(entry.id) && entry.title && !/^\[(private|deleted) video\]$/i.test(entry.title))
            .map(entry => ({
                key: `yt:${entry.id}`,
                platform: 'youtube',
                title: entry.title,
                artist: entry.uploader,
                durationSec: entry.duration ? Math.round(entry.duration) : null,
                thumb: youtubeThumb(entry.id),
            }));
        return { platform: 'youtube', title: list.title, thumb: tracks[0]?.thumb ?? null, tracks, truncated: false };
    },

    async spotifyPlaylist(id) {
        const data = await spotify.getData(`https://open.spotify.com/playlist/${id}`);
        const tracks = (data.trackList ?? [])
            .filter(item => item?.title && /^spotify:track:[A-Za-z0-9]{22}$/.test(item.uri ?? ''))
            .map(item => ({
                key: `sp:${spotifyId(item.uri)}`,
                platform: 'spotify',
                title: item.title,
                artist: item.subtitle || null,
                durationSec: seconds(item.duration),
                thumb: null,                    // Spotify no da carátula por canción aquí; se usa la de su coincidencia
            }));
        return {
            platform: 'spotify',
            title: String(data.name ?? data.title ?? 'Lista de Spotify'),
            thumb: data.coverArt?.sources?.[0]?.url ?? null,
            tracks,
            truncated: (data.trackList ?? []).length >= SPOTIFY_LIMIT,
        };
    },

    async spotifyTrack(id) {
        const data = await spotify.getData(`https://open.spotify.com/track/${id}`);
        const artists = (data.artists ?? []).map(a => a.name).filter(Boolean).join(', ');
        return {
            key: `sp:${id}`,
            platform: 'spotify',
            title: String(data.name ?? data.title ?? ''),
            artist: artists || data.subtitle || null,
            durationSec: seconds(data.duration ?? data.duration_ms),
            thumb: data.coverArt?.sources?.[0]?.url ?? data.visualIdentity?.image?.[0]?.url ?? null,
        };
    },

    async youtubeVideo(id) {
        const video = await yts({ videoId: id });
        if (!video?.title) return null;
        return {
            key: `yt:${id}`,
            platform: 'youtube',
            title: video.title,
            artist: video.author?.name ?? null,
            durationSec: Number.isFinite(video.seconds) ? video.seconds : null,
            thumb: video.thumbnail ?? youtubeThumb(id),
        };
    },
};

// Listas leídas a la espera de que el usuario confirme la importación. Viven en memoria unos minutos:
// así «Añadir N canciones» no tiene que volver a leer la lista de fuera.
export class PendingImports {
    constructor({ ttlMs = 10 * 60 * 1000, max = 20, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        this.now = now;
        this.items = new Map();
    }

    put(value) {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, item] of this.items) if (item.at < cutoff) this.items.delete(id);
        while (this.items.size >= this.max) this.items.delete(this.items.keys().next().value);
        const id = `i_${randomBytes(6).toString('hex')}`;
        this.items.set(id, { at: this.now(), value });
        return id;
    }

    get(id) {
        const item = this.items.get(id);
        return item && item.at >= this.now() - this.ttlMs ? item.value : null;
    }
}
