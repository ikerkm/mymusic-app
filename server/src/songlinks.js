import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { parseKey } from './sources.js';

// Copiar y compartir el enlace de una canción (§22). El enlace es el de lo que suena:
//   · YouTube: su vídeo (o su «otro enlace» de §19, si lo tiene).
//   · SoundCloud: su página pública (soundcloud.com/usuario/canción), o su «otro enlace» si lo tiene.
//   · Spotify: el de Spotify y, además, el del vídeo de YouTube desde el que suena.
// De SoundCloud solo se guarda el número de la canción, así que su página se busca con yt-dlp la
// primera vez y se apunta aquí, común a todos los usuarios. Las que se importan o se buscan ya la traen.

const SOUNDCLOUD_PAGE = /^https:\/\/soundcloud\.com\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_-]{1,200}$/;

/** La página pública de una canción de SoundCloud, limpia (sin «?…»), o null si no lo parece. */
export function soundcloudPage(url) {
    if (typeof url !== 'string') return null;
    const clean = url.trim().split(/[?#]/)[0].replace(/\/+$/, '');
    return SOUNDCLOUD_PAGE.test(clean) ? clean : null;
}

export const youtubeUrl = id => `https://www.youtube.com/watch?v=${id}`;
export const spotifyUrl = id => `https://open.spotify.com/track/${id}`;
const idOf = key => String(key).split(':')[1];

export class SongLinkStore {
    constructor(dataDir) {
        this.path = join(dataDir, 'songlinks.json');
        this.items = readJson(this.path, { items: {} }).items ?? {};
    }

    /** La página de SoundCloud apuntada para `key`, o null. */
    get(key) { return this.items[key] ?? null; }

    /** Apunta la página de una canción de SoundCloud. Devuelve true si cambió algo. */
    remember(key, url) {
        const page = soundcloudPage(url);
        if (!page || !String(key).startsWith('sc:') || !parseKey(key) || this.items[key] === page) return false;
        this.items[key] = page;
        writeJsonAtomic(this.path, { items: this.items });
        return true;
    }

    /** Apunta de una vez las páginas que traen las canciones de SoundCloud recién leídas (campo `link`). */
    rememberTracks(tracks) {
        let changed = false;
        for (const track of tracks ?? []) {
            const page = soundcloudPage(track?.link);
            if (!page || !String(track.key).startsWith('sc:') || !parseKey(track.key) || this.items[track.key] === page) continue;
            this.items[track.key] = page;
            changed = true;
        }
        if (changed) writeJsonAtomic(this.path, { items: this.items });
        return changed;
    }
}

/**
 * Los enlaces de una canción, en el orden en que se enseñan.
 * @param {string} key  clave ya validada con parseKey
 * @param {object} o
 * @param {{get(key): {key: string}|null}|null} o.alternates  «otro enlace» de §19
 * @param {{resolve(key): Promise<{yt?: {key: string}}|null>}|null} o.matches  coincidencias de Spotify
 * @param {SongLinkStore} o.store
 * @param {(id: string) => Promise<string|null>} o.soundcloudLink  busca la página de una canción de SoundCloud
 * @returns {Promise<{platform: 'youtube'|'spotify'|'soundcloud', url: string}[]>}
 */
export async function linksFor(key, { alternates = null, matches = null, store, soundcloudLink }) {
    const source = parseKey(key);
    if (!source) return [];
    const alternate = alternates?.get(source.key)?.key ?? null;
    const youtube = ytKey => ({ platform: 'youtube', url: youtubeUrl(idOf(ytKey)) });
    if (source.platform === 'spotify') {
        const links = [{ platform: 'spotify', url: spotifyUrl(idOf(source.key)) }];
        const sounds = alternate ?? (await matches?.resolve(source.key).catch(() => null))?.yt?.key ?? null;
        if (sounds) links.push(youtube(sounds));
        return links;
    }
    if (alternate) return [youtube(alternate)];
    if (source.platform === 'youtube') return [youtube(source.key)];
    // SoundCloud
    let page = store?.get(source.key) ?? null;
    if (!page) {
        page = soundcloudPage(await soundcloudLink(idOf(source.key)));
        if (page) store?.remember(source.key, page);
    }
    return page ? [{ platform: 'soundcloud', url: page }] : [];
}
