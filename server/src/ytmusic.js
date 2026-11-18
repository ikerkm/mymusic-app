import { youtubeThumb } from './sources.js';

// Página de artista y de disco (§18): los datos salen de YouTube Music, que no tiene API oficial; se
// leen con la librería youtubei.js. Medido el 17-11 (pruebas\medicion_artista_20261117\INFORME.md):
// acierta el artista en 18 de 18, cada canción de un disco trae ya su vídeo de YouTube (sin buscar
// coincidencias) y responde en menos de medio segundo. El audio sigue saliendo como siempre (yt-dlp).
//
// Aquí hay dos piezas:
//   · YtMusic: lo que usa el servidor. Guarda cada respuesta un día, junta peticiones iguales que
//     llegan a la vez, decide qué artistas se enseñan en Buscar y encuentra el de una canción.
//   · createYtMusicClient(): la que habla con YouTube Music y deja los datos en forma propia. Las
//     pruebas automáticas la sustituyen por un doble; la de verdad se prueba con scripts\ytmusic-check.mjs.

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 400;
export const ARTIST_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const ALBUM_ID = /^MPREb_[A-Za-z0-9_-]{5,40}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SONGS_MAX = 500;            // canciones de un artista que se leen como mucho («Ver todas»)
const ALBUM_TRACKS_MAX = 1000;    // canciones de un disco (las cajas enormes pasan de 200)
const DATE_TRACKS_MAX = 40;       // canciones de un disco que se miran para saber su fecha (§21)
const DATE_AT_ONCE = 4;           // vídeos que se preguntan a la vez para la fecha

/**
 * Fecha de salida de un disco (§21): la que más se repite entre las fechas de los vídeos de sus
 * canciones; si empatan, la más nueva. YouTube Music solo da el año. Medido el 18-11
 * (pruebas\medicion_novedades_20261118\INFORME.md): acierta en 31 de 31; la de la primera canción
 * falla en las reediciones y la de la canción más nueva, con los videoclips subidos después.
 * @param {string[]} dates fechas 'AAAA-MM-DD' (las que no lo son se ignoran)
 * @returns {string|null}
 */
export function modeDate(dates) {
    const count = new Map();
    for (const date of dates ?? []) {
        const day = String(date ?? '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) count.set(day, (count.get(day) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? null;
}

// Palabras de un texto, sin tildes ni mayúsculas. Vale para cualquier alfabeto («米津玄師» es una palabra).
export const words = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const squash = text => words(text).join('');

/**
 * ¿El nombre de un artista se parece a lo buscado? Decide la fila «Artistas» de Buscar.
 *   · 'strong': el nombre está entero en la búsqueda y es al menos la mitad de ella («daft punk get
 *     lucky» → Daft Punk), lo buscado es el principio del nombre («rosal» → Rosalía), o son lo mismo
 *     sin espacios ni signos («acdc» → AC/DC).
 *   · 'weak': comparte alguna palabra de tres letras o más («halcyon drift» → Halcyon Days).
 */
export function nameMatch(query, name) {
    const q = words(query);
    const n = words(name);
    if (q.length === 0 || n.length === 0) return null;
    if (squash(query) === squash(name)) return 'strong';
    const inQuery = new Set(q);
    if (n.every(w => inQuery.has(w)) && n.length * 2 >= q.length) return 'strong';
    const typed = q.join('').length >= 3 && q.length <= n.length
        && q.every((w, i) => (i < q.length - 1 ? n[i] === w : n[i].startsWith(w)));
    if (typed) return 'strong';
    if (n.some(w => w.length >= 3 && inQuery.has(w))) return 'weak';
    return null;
}

/**
 * Los artistas que se enseñan en Buscar: ninguno si ninguno se parece de verdad a lo buscado (al buscar
 * una canción no estorban); si alguno sí, ese y los que comparten palabra, hasta `limit`, en el orden de
 * YouTube Music.
 */
export function pickArtists(query, results, limit = 3) {
    const rated = results.map(artist => ({ artist, match: nameMatch(query, artist.name) }));
    if (!rated.some(r => r.match === 'strong')) return [];
    return [...rated.filter(r => r.match === 'strong'), ...rated.filter(r => r.match === 'weak')]
        .slice(0, limit).map(r => r.artist);
}

// ¿Es el mismo artista? Para encontrar en YouTube Music el de una canción («Ir al artista»).
export function sameName(a, b) {
    const x = squash(a);
    const y = squash(b);
    if (!x || !y) return false;
    if (x === y) return true;
    // «Extremoduro (Oficial)» o «Kettle Drift Official» frente a «Extremoduro» / «Kettle Drift»
    const short = x.length < y.length ? x : y;
    const long = x.length < y.length ? y : x;
    return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 8;
}

// «65,2 M usuarios mensuales» → «65,2 M». YouTube Music lo da en el idioma pedido (español).
export function listenersOf(text) {
    const match = /([\d.,]+\s*(?:K|M|mil|B)?)\s+(?:de\s+)?(?:usuarios|oyentes)\s+mensuales/i.exec(String(text ?? ''));
    return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

// «Álbum • 2013», «Single • 2023», «EP • 1997» → tipo; si no lo dice, el de la estantería donde salió
export function kindOf(subtitle, fallback) {
    const text = String(subtitle ?? '');
    if (/\b(single|sencillo)\b/i.test(text)) return 'single';
    if (/\bEP\b/.test(text)) return 'ep';
    if (/(^|[^\p{L}])(álbum|album)([^\p{L}]|$)/iu.test(text)) return 'album';     // \b no vale con la «Á»
    return fallback;
}

export const yearOf = text => Number(/\b(19|20)\d{2}\b/.exec(String(text ?? ''))?.[0]) || null;

// Los lanzamientos repetidos con el mismo nombre, tipo y año se juntan en uno (pasa: «Human After All»
// sale cinco veces como sencillo de 2005). Las ediciones con otro nombre («Deluxe», un directo) se quedan.
export function dedupeReleases(releases) {
    const seen = new Set();
    return releases.filter(release => {
        const key = `${release.kind}|${squash(release.title)}|${release.year ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Carátulas de YouTube Music: la dirección lleva el tamaño («=w120-h120…») y se puede pedir más grande
export function bigThumb(url, size = 544) {
    const text = String(url ?? '');
    if (!text.startsWith('https://')) return null;
    return /^https:\/\/(lh\d+\.googleusercontent\.com|yt\d+\.googleusercontent\.com|yt\d+\.ggpht\.com)\//.test(text)
        ? text.replace(/=w\d+-h\d+[^/]*$/, `=w${size}-h${size}-l90-rj`)
        : text;
}

/**
 * Lo que usa el servidor. `client` es createYtMusicClient() o un doble con los mismos métodos:
 *   searchArtists(query) → [{ id, name, listeners, thumb }]
 *   artist(id) → { id, name, image, albums, singles, related, songs, songsCount } (o null si no existe)
 *   album(id) → { id, title, kind, year, thumb, artists: [{ id, name }], tracks } (o null)
 *   releases(id) → { id, name, releases: [{ id, title, kind, year, thumb }] } (o null): solo la página del
 *     artista, sin «Ver todos» ni sus canciones (novedades, §21)
 *   releaseDate(albumId) → 'AAAA-MM-DD' o null (§21)
 */
export class YtMusic {
    constructor({ client, now = Date.now, ttlMs = DAY_MS, timeoutMs = 20_000, log = () => {} }) {
        this.client = client;
        this.now = now;
        this.ttlMs = ttlMs;
        this.timeoutMs = timeoutMs;
        this.log = log;
        this.cache = new Map();       // clave → { at, value }
        this.reading = new Map();     // clave → petición en curso
        this.known = new Map();       // id de artista → { name, listeners, thumb } (de búsquedas y «parecidos»)
    }

    async #cached(key, read) {
        const hit = this.cache.get(key);
        if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
        if (this.reading.has(key)) return this.reading.get(key);
        let timer;
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('YouTube Music tarda demasiado')), this.timeoutMs); });
        const job = Promise.race([read(), late]).then(value => {
            this.cache.delete(key);
            this.cache.set(key, { at: this.now(), value });
            if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
            return value;
        }).finally(() => {
            clearTimeout(timer);
            this.reading.delete(key);
        });
        this.reading.set(key, job);
        return job;
    }

    #remember(artists) {
        for (const a of artists ?? []) {
            if (!ARTIST_ID.test(a?.id ?? '')) continue;
            const old = this.known.get(a.id) ?? {};
            this.known.set(a.id, { name: a.name ?? old.name, listeners: a.listeners ?? old.listeners ?? null, thumb: a.thumb ?? old.thumb ?? null });
        }
        if (this.known.size > 5000) this.known.delete(this.known.keys().next().value);
    }

    /** Todos los artistas que da YouTube Music para una búsqueda, en su orden. */
    async searchArtists(query) {
        const text = String(query ?? '').trim().slice(0, 200);
        if (!text) return [];
        const results = await this.#cached(`s:${words(text).join(' ')}`, () => this.client.searchArtists(text));
        this.#remember(results);
        return results;
    }

    /** La fila «Artistas» de Buscar (vacía si lo buscado no es un artista). */
    async artistsFor(query, limit = 3) {
        return pickArtists(query, await this.searchArtists(query), limit);
    }

    /** El artista de YouTube Music que corresponde a un nombre, o null si no hay uno que se llame así. */
    async findArtist(name) {
        const results = await this.searchArtists(name);
        return results.find(artist => sameName(artist.name, name)) ?? null;
    }

    /** Página de un artista, con sus oyentes y su foto cuadrada (salen de la búsqueda, no de la página). */
    async artist(id) {
        if (!ARTIST_ID.test(String(id ?? ''))) return null;
        const page = await this.#cached(`a:${id}`, () => this.client.artist(id));
        if (!page) return null;
        this.#remember(page.related);
        if (!this.known.has(id)) await this.searchArtists(page.name).catch(() => []);
        const known = this.known.get(id) ?? {};
        return { ...page, listeners: known.listeners ?? null, thumb: known.thumb ?? page.image ?? null };
    }

    async album(id) {
        if (!ALBUM_ID.test(String(id ?? ''))) return null;
        return this.#cached(`d:${id}`, () => this.client.album(id));
    }

    // --- Novedades (§21). Sin guardar: lo pide la vuelta diaria, que quiere lo de hoy.

    async #limited(read, ms) {
        let timer;
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('YouTube Music tarda demasiado')), ms); });
        try {
            return await Promise.race([read(), late]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Los discos, sencillos y EP de la página de un artista, del más nuevo al más viejo (solo la página). */
    async releases(id) {
        if (!ARTIST_ID.test(String(id ?? ''))) return null;
        const page = await this.#limited(() => this.client.releases(id), this.timeoutMs);
        if (page) this.#remember([{ id, name: page.name }]);
        return page;
    }

    /** Fecha de salida de un disco (la más repetida entre sus canciones), o null. Mira hasta 40 vídeos. */
    async releaseDate(albumId) {
        if (!ALBUM_ID.test(String(albumId ?? ''))) return null;
        return this.#limited(() => this.client.releaseDate(albumId), this.timeoutMs * 4);
    }

    /** Nombre y foto cuadrada de un artista si ya ha salido en una búsqueda, en «parecidos» o en su página. */
    knownArtist(id) {
        const known = this.known.get(id);
        return known?.name ? { id, name: known.name, thumb: known.thumb ?? null } : null;
    }
}

// --------------------------------------------------------------------- la de verdad (youtubei.js)

const text = node => (node === undefined || node === null ? '' : String(node.toString?.() ?? node)).trim();
const thumbsOf = item => {
    const raw = item?.thumbnail?.contents ?? item?.thumbnails ?? item?.thumbnail ?? [];
    return (Array.isArray(raw) ? raw : []).filter(t => t?.url);
};
// La carátula más grande (las de YouTube Music vienen de mayor a menor)
const largest = item => [...thumbsOf(item)].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;

function trackOf(item, { artists, thumb }) {
    const id = item?.id;
    if (!VIDEO_ID.test(id ?? '')) return null;
    const title = text(item.title).slice(0, 300);
    if (!title) return null;
    const own = (item.artists ?? []).map(a => a?.name).filter(Boolean);
    const seconds = item.duration?.seconds;
    return {
        key: `yt:${id}`,
        platform: 'youtube',
        title,
        artist: (own.length ? own : artists).join(', ').slice(0, 200) || null,
        durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
        thumb: thumb ?? bigThumb(largest(item)) ?? youtubeThumb(id),
    };
}

function releaseOf(item, fallbackKind) {
    if (!ALBUM_ID.test(item?.id ?? '')) return null;
    const subtitle = text(item.subtitle);
    return {
        id: item.id,
        title: text(item.title).slice(0, 300),
        kind: kindOf(subtitle, fallbackKind),
        year: Number(item.year) || yearOf(subtitle),
        thumb: bigThumb(largest(item)),
    };
}

/**
 * Cliente de YouTube Music con youtubei.js, en español y desde España. Si una llamada falla se vuelve
 * a crear la conexión en la siguiente (YouTube caduca sus datos de visitante).
 */
export function createYtMusicClient({ log = () => {} } = {}) {
    let session = null;
    const yt = () => {
        session ??= (async () => {
            const { Innertube, Log, YTNodes } = await import('youtubei.js');
            Log.setLevel(Log.Level.ERROR);         // sin avisos del analizador en el registro del servidor
            const innertube = await Innertube.create({ lang: 'es', location: 'ES', retrieve_player: false });
            return { innertube, YTNodes };
        })().catch(error => {
            session = null;
            throw error;
        });
        return session;
    };
    const guarded = fn => async (...args) => {
        try {
            return await fn(await yt(), ...args);
        } catch (error) {
            session = null;
            log(`[ytmusic] error: ${String(error?.message ?? error).slice(0, 200)}`);
            throw error;
        }
    };

    // Todas las filas de una lista de YouTube Music (la lista entera de un artista, o un disco enorme)
    async function playlistItems(innertube, listId, max) {
        let page = await innertube.music.getPlaylist(listId);
        const items = [...(page.items ?? [])];
        while (page.has_continuation && items.length < max) {
            page = await page.getContinuation();
            items.push(...(page.items ?? []));
        }
        return items.slice(0, max);
    }

    return {
        searchArtists: guarded(async ({ innertube }, query) => {
            const search = await innertube.music.search(query, { type: 'artist' });
            const shelf = (search.contents ?? []).find(c => c.type === 'MusicShelf');
            return (shelf?.contents ?? []).filter(item => ARTIST_ID.test(item?.id ?? '')).slice(0, 10).map(item => ({
                id: item.id,
                name: text(item.name ?? item.title).slice(0, 200),
                listeners: listenersOf(text(item.subtitle)),
                thumb: bigThumb(largest(item)),
            }));
        }),

        artist: guarded(async ({ innertube, YTNodes }, id) => {
            const page = await innertube.music.getArtist(id);
            const name = text(page.header?.title).slice(0, 200);
            if (!name) return null;
            let albumsShelf = null;
            let singlesShelf = null;
            let songsListId = null;
            const related = [];
            for (const section of page.sections ?? []) {
                const title = text(section.header?.title ?? section.title);
                const items = section.contents ?? [];
                if (section.type === 'MusicShelf' && !songsListId) {
                    songsListId = section.endpoint?.payload?.browseId ?? section.bottom_button?.endpoint?.payload?.browseId ?? null;
                } else if (/^álbumes|^albums/i.test(title)) albumsShelf = section;
                else if (/^singles|^sencillos/i.test(title)) singlesShelf = section;
                else if (items.length && items.every(item => ARTIST_ID.test(item?.id ?? ''))) {
                    for (const item of items) related.push({ id: item.id, name: text(item.title).slice(0, 200), listeners: listenersOf(text(item.subtitle)), thumb: bigThumb(largest(item)) });
                }
            }
            // «Ver todos» de álbumes y de sencillos, y la lista entera de canciones, a la vez
            const everything = async shelf => {
                if (!shelf) return [];
                const more = shelf.header?.more_content?.endpoint;
                if (!more) return shelf.contents ?? [];
                const full = await more.call(innertube.actions, { client: 'YTMUSIC', parse: true });
                const items = full.contents_memo?.getType(YTNodes.MusicTwoRowItem) ?? [];
                return items.length ? items : shelf.contents ?? [];
            };
            const [albumItems, singleItems, songItems] = await Promise.all([
                everything(albumsShelf),
                everything(singlesShelf),
                songsListId ? playlistItems(innertube, songsListId, SONGS_MAX) : Promise.resolve([]),
            ]);
            const songs = songItems.map(item => trackOf(item, { artists: [name] })).filter(Boolean);
            const banner = largest(page.header);
            return {
                id,
                name,
                image: banner?.startsWith('https://') ? banner : null,
                albums: dedupeReleases(albumItems.map(item => releaseOf(item, 'album')).filter(Boolean)),
                singles: dedupeReleases(singleItems.map(item => releaseOf(item, 'single')).filter(Boolean)),
                related: related.slice(0, 12),
                songs,
            };
        }),

        album: guarded(async ({ innertube }, id) => {
            const album = await innertube.music.getAlbum(id);
            const header = album.header;
            const title = text(header?.title).slice(0, 300);
            if (!title) return null;
            const artists = (header?.strapline_text_one?.runs ?? [])
                .map(run => ({ id: run.endpoint?.payload?.browseId ?? null, name: String(run.text ?? '').trim() }))
                .filter(a => a.name && !/^[\s,&·•y]+$/i.test(a.name))
                .map(a => ({ id: ARTIST_ID.test(a.id ?? '') ? a.id : null, name: a.name.slice(0, 200) }));
            const subtitle = text(header?.subtitle);
            const thumb = bigThumb(largest(header));
            let rows = album.contents ?? [];
            // Un disco de más de 200 canciones llega cortado: se lee entero como lista (OLAK5uy_…)
            if (rows.length >= 200 && album.url) {
                const listId = new URL(album.url).searchParams.get('list');
                if (listId) rows = await playlistItems(innertube, listId, ALBUM_TRACKS_MAX);
            }
            const names = artists.map(a => a.name);
            return {
                id,
                title,
                kind: kindOf(subtitle, 'album'),
                year: yearOf(subtitle),
                thumb,
                artists,
                tracks: rows.map(row => trackOf(row, { artists: names, thumb })).filter(Boolean),
            };
        }),

        // Novedades (§21): solo la página del artista. «Álbumes» y «Singles y EPs» vienen del más nuevo al
        // más viejo, así que lo nuevo siempre está en lo que se ve sin «Ver todos».
        releases: guarded(async ({ innertube }, id) => {
            const page = await innertube.music.getArtist(id);
            const name = text(page.header?.title).slice(0, 200);
            if (!name) return null;
            const releases = [];
            for (const section of page.sections ?? []) {
                const title = text(section.header?.title ?? section.title);
                const kind = /^álbumes|^albums/i.test(title) ? 'album' : /^singles|^sencillos/i.test(title) ? 'single' : null;
                if (kind) releases.push(...(section.contents ?? []).map(item => releaseOf(item, kind)).filter(Boolean));
            }
            return { id, name, releases: dedupeReleases(releases) };
        }),

        // La fecha de un disco: la que más se repite entre los vídeos de sus canciones (de 4 en 4)
        releaseDate: guarded(async ({ innertube }, albumId) => {
            const album = await innertube.music.getAlbum(albumId);
            const ids = (album.contents ?? []).map(row => row?.id).filter(id => VIDEO_ID.test(id ?? '')).slice(0, DATE_TRACKS_MAX);
            const dates = [];
            for (let i = 0; i < ids.length; i += DATE_AT_ONCE) {
                const read = await Promise.allSettled(ids.slice(i, i + DATE_AT_ONCE).map(videoId => innertube.getBasicInfo(videoId)));
                for (const result of read) if (result.status === 'fulfilled') dates.push(String(result.value?.basic_info?.publish_date ?? ''));
            }
            return modeDate(dates);
        }),
    };
}
