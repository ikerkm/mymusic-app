import yts from 'yt-search';

// Una canción se identifica por una clave «plataforma:id». El servidor construye la URL a partir de
// la clave: nunca extrae de una dirección arbitraria que le mande el cliente (no es un proxy abierto).

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseKey(key) {
    const [platform, id, ...rest] = String(key ?? '').split(':');
    if (rest.length) return null;
    if (platform === 'yt' && YOUTUBE_ID.test(id)) {
        return { key: `yt:${id}`, platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
    }
    return null;
}

// Punto de partida: MusicSearch.searchList del bot (utils/musicSearch.js, commit a2a4e99)
export async function searchYoutube(query, limit = 20) {
    const results = await yts(query);
    return (results?.videos ?? [])
        .filter(video => YOUTUBE_ID.test(video.videoId ?? ''))
        .slice(0, limit)
        .map(video => ({
            key: `yt:${video.videoId}`,
            platform: 'youtube',
            title: video.title,
            artist: video.author?.name ?? null,
            durationSec: Number.isFinite(video.seconds) ? video.seconds : null,
            thumb: video.thumbnail ?? null,
        }));
}
