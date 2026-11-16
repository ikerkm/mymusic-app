import yts from 'yt-search';

// Una canción se identifica por una clave «plataforma:id». El servidor construye la URL a partir de
// la clave: nunca extrae de una dirección arbitraria que le mande el cliente (no es un proxy abierto).

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_LIST = /^[A-Za-z0-9_-]{10,64}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// Claves: «yt:<id>» se extrae tal cual. «sp:<id>» es una canción que viene de Spotify: no tiene audio
// propio (url null) y suena por su coincidencia en YouTube, que se busca la primera vez (matches.js).
export function parseKey(key) {
    const [platform, id, ...rest] = String(key ?? '').split(':');
    if (rest.length) return null;
    if (platform === 'yt' && YOUTUBE_ID.test(id)) {
        return { key: `yt:${id}`, platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
    }
    if (platform === 'sp' && SPOTIFY_ID.test(id)) {
        return { key: `sp:${id}`, platform: 'spotify', url: null };
    }
    // SoundCloud: la clave es el número de la canción. Su audio llega como AAC en un contenedor sin
    // índice para saltar, así que se pasa a ADTS (aacToAdts) antes de servirlo.
    if (platform === 'sc' && SOUNDCLOUD_ID.test(id)) {
        return { key: `sc:${id}`, platform: 'soundcloud', url: `https://api.soundcloud.com/tracks/${id}`, aacToAdts: true };
    }
    return null;
}

const SOUNDCLOUD_ID = /^\d{1,20}$/;
const SOUNDCLOUD_NAME = /^[A-Za-z0-9_-]{1,100}$/;
// Primer tramo de la dirección que no es un usuario, y segundo que no es una canción
const SOUNDCLOUD_NOT_USER = new Set(['discover', 'search', 'stream', 'you', 'upload', 'charts', 'settings', 'messages', 'notifications', 'pages', 'popular', 'tags', 'people', 'feed', 'library', 'signin', 'logout', 'stations', 'pro', 'mobile', 'imprint', 'jobs', 'terms-of-use']);
const SOUNDCLOUD_NOT_TRACK = new Set(['sets', 'tracks', 'albums', 'likes', 'followers', 'following', 'reposts', 'popular-tracks', 'toptracks', 'comments']);

export const youtubeThumb = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/**
 * Reconoce un enlace pegado por el usuario. Solo se queda con el identificador: las direcciones que
 * luego se consultan las construye el servidor, nunca se usa la que viene de fuera.
 * @returns {{kind: 'yt-video'|'yt-playlist'|'yt-mix'|'sp-track'|'sp-playlist', id: string, alsoVideo?: string}|null}
 */
export function parseLink(text) {
    let url;
    try {
        url = new URL(String(text ?? '').trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    const parts = url.pathname.split('/').filter(Boolean);

    if (host === 'youtube.com' || host === 'youtu.be') {
        const list = url.searchParams.get('list');
        let video = host === 'youtu.be' ? parts[0] : url.searchParams.get('v');
        if (host === 'youtube.com' && (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed')) video = parts[1];
        const videoOk = YOUTUBE_ID.test(video ?? '');
        if (list && YOUTUBE_LIST.test(list)) {
            // Las listas RD… son mezclas automáticas de YouTube: no tienen fin ni son iguales para todos
            if (list.startsWith('RD')) return videoOk ? { kind: 'yt-video', id: video } : { kind: 'yt-mix', id: list };
            return { kind: 'yt-playlist', id: list, ...(videoOk ? { alsoVideo: video } : {}) };
        }
        return videoOk ? { kind: 'yt-video', id: video } : null;
    }

    if (host === 'open.spotify.com') {
        const rest = /^intl-[a-z]{2}$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
        const [type, id] = rest;
        if (!SPOTIFY_ID.test(id ?? '')) return null;
        if (type === 'track') return { kind: 'sp-track', id };
        if (type === 'playlist') return { kind: 'sp-playlist', id };
    }

    // SoundCloud: soundcloud.com/<usuario>/<canción> y soundcloud.com/<usuario>/sets/<lista>.
    // Los enlaces privados (con un tramo «s-…» al final) no se admiten.
    if (host === 'soundcloud.com') {
        const [user, second, third, ...extra] = parts;
        if (extra.length || !SOUNDCLOUD_NAME.test(user ?? '') || SOUNDCLOUD_NOT_USER.has(user.toLowerCase())) return null;
        if (second === 'sets') return SOUNDCLOUD_NAME.test(third ?? '') ? { kind: 'sc-playlist', user, slug: third } : null;
        if (third !== undefined || !SOUNDCLOUD_NAME.test(second ?? '') || SOUNDCLOUD_NOT_TRACK.has(second.toLowerCase())) return null;
        return { kind: 'sc-track', user, slug: second };
    }
    // Enlace corto que da la app de SoundCloud al compartir: hay que seguirlo para saber qué es
    if (url.hostname === 'on.soundcloud.com') {
        return /^[A-Za-z0-9]{4,40}$/.test(parts[0] ?? '') && parts.length === 1 ? { kind: 'sc-short', id: parts[0] } : null;
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
