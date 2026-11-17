import { createHash } from 'node:crypto';
import { LikeSet } from './likes.js';
import { cleanTrack } from './lists.js';
import { cleanTitle } from './matches.js';
import { NOISE, artistSig, plain } from './radio.js';

// Listas automáticas y «Tus estadísticas» (maqueta mockups/estadisticas-v1.html, aprobada el 17-11).
//
// Todo se calcula al pedirlo, con el historial entero del usuario (una línea por canción que pasó
// de 30 s), sus listas y sus contadores del consumo. Nada de esto se guarda: las listas automáticas
// son de solo lectura y «Guardar como lista» copia lo de ese momento a una lista normal.
//
// La misma canción cuenta como una sola aunque haya sonado por Spotify y por YouTube: se reconoce
// igual que en el «me gusta» (likes.js), por la clave de su audio o por título y artista.

export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;           // «Lo más escuchado» y «Hace tiempo que no suena» miran los últimos 30 días
const TOP_MIN_PLAYS = 2;
const LIMITS = { top: 50, forgotten: 50, radio: 100 };
const STATS_TOP = 10;

/** Las tres listas automáticas: su nombre y lo que se explica debajo del título. */
export const AUTO = {
    top: { name: 'Lo más escuchado', about: () => 'Lo que más veces ha sonado en los últimos 30 días, al menos 2 veces. Hasta 50.' },
    forgotten: {
        name: 'Hace tiempo que no suena',
        about: count => `${songs(count)} de tus listas que llevan más de 30 días sin sonar. Primero las que más tiempo llevan sin sonar; el resto se escoge cada día, y el mismo día no cambia.`,
    },
    radio: { name: 'Descubierto en la radio', about: () => 'Lo que te puso la radio (la de Inicio o la de una lista) y escuchaste más de 30 s. Lo último, arriba. Hasta 100.' },
};
export const AUTO_KINDS = Object.keys(AUTO);
export const isAutoKind = kind => typeof kind === 'string' && Object.hasOwn(AUTO, kind);

/** Periodos de «Tus estadísticas»: los últimos N días (hoy incluido), o todo. */
export const PERIODS = { 7: 7, 30: 30, all: null };
export const isPeriod = period => typeof period === 'string' && Object.hasOwn(PERIODS, period);

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pad = n => String(n).padStart(2, '0');
const songs = n => `${n} ${n === 1 ? 'canción' : 'canciones'}`;

/** Día local «AAAA-MM-DD», como los contadores del consumo. */
export const dayOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** «17 nov»: fecha corta en local. */
export const shortDate = ms => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
// Primer día de los últimos `days` días locales (hoy incluido); por calendario, para no tropezar con el cambio de hora
const startDay = (now, days) => { const d = new Date(now); return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime()); };

// «A, B» (así junta Spotify a los artistas de una canción): cuenta el primero. Para enseñarlo, sin
// la coletilla de los canales automáticos de YouTube («Artista - Topic»).
export const firstArtist = artist => String(artist ?? '').split(',')[0].replace(/\s+-\s+topic$/i, '').trim();

// Lo que puede ir detrás del guion sin ser la canción («- Remaster», «- Live», «- 2004 Remaster»)
const TAIL_NOISE = /\b(live|en vivo|en directo|radio edit|edit|remix|mix|acoustic|acustico|mono|stereo|demo|remastered|remaster|deluxe|bonus track)\b/g;
// El canal tal como se enseña: sin «VEVO» ni «Official» al final («UncleMurdaVEVO» → «UncleMurda»)
const channelName = channel => firstArtist(channel).replace(/\s*vevo$/i, '').replace(/\s+(official|oficial)$/i, '').trim();

/**
 * El artista de una canción para «Tus estadísticas». Spotify lo da limpio. En YouTube y SoundCloud
 * el campo es el canal, que no siempre es el artista: un canal de letras sube «Rick Astley - Never
 * Gonna Give You Up». Por orden: canal «X - Topic» → X; si el título nombra al canal → el canal; si
 * el título es «Artista - Canción» (y lo de detrás del guion no es «Remaster», «Live»…) → ese
 * artista; si no, el canal.
 */
export function artistOf(track) {
    const channel = String(track?.artist ?? '');
    if (track?.platform === 'spotify' || !channel.trim() || /\s+-\s+topic$/i.test(channel)) return firstArtist(channel);
    const title = cleanTitle(track.title).replace(/[–—|]/g, ' - ');
    const sig = artistSig(channel);
    if (sig.length >= 3 && artistSig(title).includes(sig)) return channelName(channel);
    const parts = title.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const rest = plain(parts.slice(1).join(' ')).replace(NOISE, ' ').replace(TAIL_NOISE, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, '');
        const head = firstArtist(parts[0].replace(/\s+(feat|ft|featuring)\b.*$/i, ''));
        if (rest && head && head.length <= 50) return head;
    }
    return channelName(channel);
}

// Barajado que solo depende de la semilla y de la canción: el mismo día sale igual aunque la lista
// crezca (la canción nueva cae en su sitio y las demás no se mueven); al día siguiente, otro.
const rank = (seed, key) => createHash('sha1').update(`${seed}|${key}`).digest().readUInt32BE(0);

/** A cada canción, el identificador de su grupo: la misma canción venga de donde venga. */
export class Identities {
    constructor(audioKeyOf = () => null) {
        this.set = new LikeSet([], audioKeyOf);
        this.byKey = new Map();          // clave → grupo (la clave de la primera versión que se vio)
    }

    of(track) {
        const known = this.byKey.get(track.key);
        if (known) return known;
        const hit = this.set.find(track);
        const id = hit ? this.byKey.get(hit) : track.key;
        this.set.add(track);
        this.byKey.set(track.key, id);
        return id;
    }
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const most = map => [...map.entries()].reduce((best, entry) => (!best || entry[1] > best[1] ? entry : best), null)?.[0] ?? null;

export class Listening {
    /**
     * @param {object} o
     * @param {{at: string, source: object, track: object}[]} o.history  todo el historial del usuario (HistoryStore.all()); no se modifica
     * @param {{id: string, name: string, tracks: object[]}[]} o.lists  sus listas enteras, en el orden de Listas («me gusta» la primera)
     * @param {(key: string) => string|null} o.audioKeyOf  de qué vídeo sale el audio de una clave (la coincidencia, si es de Spotify)
     * @param {Object<string, object>} o.usageDays  sus contadores del consumo por día local (Usage.daysOf)
     * @param {string} o.userId  para el barajado diario, que es de cada usuario
     * @param {(track: object) => string|null} o.thumbOf  carátula con la que se enseña una canción
     */
    constructor({ history = [], lists = [], audioKeyOf = () => null, usageDays = {}, userId = '', now = Date.now(), thumbOf = track => track.thumb ?? null } = {}) {
        this.history = history;
        this.lists = lists;
        this.audioKeyOf = audioKeyOf;
        this.usageDays = usageDays ?? {};
        this.userId = userId;
        this.now = now;
        this.thumbOf = thumbOf;
        this.built = null;
        this.cache = new Map();
    }

    // Se hace una vez: cada canción de las listas y cada escucha, con el grupo de su canción
    #index() {
        if (this.built) return this.built;
        const ids = new Identities(this.audioKeyOf);
        const inLists = new Map();       // grupo → { track, list } la primera vez que sale, en el orden de Listas
        const spotifyArtist = new Map(); // grupo → artista de su versión de Spotify (viene limpio, sin canales)
        const listNames = new Map();
        for (const list of this.lists) {
            listNames.set(list.id, list.name);
            for (const raw of Array.isArray(list.tracks) ? list.tracks : []) {
                const track = cleanTrack(raw);
                if (!track) continue;
                const id = ids.of(track);
                if (!inLists.has(id)) inLists.set(id, { track, list: { id: list.id, name: list.name } });
                if (track.platform === 'spotify' && track.artist && !spotifyArtist.has(id)) spotifyArtist.set(id, track.artist);
            }
        }
        const plays = [];
        const lastMs = new Map();        // grupo → última vez que sonó
        for (const entry of this.history) {
            const ms = Date.parse(entry?.at);
            const track = cleanTrack(entry?.track);
            if (!Number.isFinite(ms) || !track) continue;
            const id = ids.of(track);
            plays.push({ id, ms, at: entry.at, day: dayOf(ms), track, radio: entry.track.radio === true, source: entry.source ?? null });
            if (ms > (lastMs.get(id) ?? -Infinity)) lastMs.set(id, ms);
            if (track.platform === 'spotify' && track.artist && !spotifyArtist.has(id)) spotifyArtist.set(id, track.artist);
        }
        plays.sort((a, b) => a.ms - b.ms);          // el historial va en orden, pero no se da por hecho
        this.built = { inLists, spotifyArtist, listNames, plays, lastMs };
        return this.built;
    }

    /**
     * Escuchas por canción desde `fromDay` (null = todas), de la más escuchada a la menos (a
     * igualdad, la que sonó más tarde). Cada una con la versión que sonó la última vez y su artista.
     */
    #tally(fromDay) {
        const { plays, spotifyArtist } = this.#index();
        const byId = new Map();
        for (const play of plays) {
            if (fromDay && play.day < fromDay) continue;
            let song = byId.get(play.id);
            if (!song) byId.set(play.id, (song = { id: play.id, plays: 0, lastMs: -Infinity, track: null, names: new Map() }));
            song.plays++;
            if (play.ms >= song.lastMs) {
                song.lastMs = play.ms;
                song.track = play.track;
            }
            const name = artistOf(play.track);
            if (name) bump(song.names, name);
        }
        const out = [...byId.values()];
        for (const song of out) {
            // El artista de la canción: el de su versión de Spotify si la hay; si no, el que más ha salido en sus escuchas
            song.artist = firstArtist(spotifyArtist.get(song.id)) || most(song.names);
        }
        return out.sort((a, b) => b.plays - a.plays || b.lastMs - a.lastMs);
    }

    /**
     * Una lista automática, o null si no existe ese tipo.
     * @returns {{kind, name, description, count, saveName, rows: {track: object}[], unsaved?: number}|null}
     */
    auto(kind) {
        if (!isAutoKind(kind)) return null;
        if (this.cache.has(kind)) return this.cache.get(kind);
        const rows = { top: () => this.#top(), forgotten: () => this.#forgotten(), radio: () => this.#radio() }[kind]();
        const { name, about } = AUTO[kind];
        const result = { kind, name, description: about(rows.length), count: rows.length, saveName: `${name} · ${shortDate(this.now)}`, rows };
        if (kind === 'radio') result.unsaved = rows.filter(row => !row.savedIn).length;
        this.cache.set(kind, result);
        return result;
    }

    // «Lo más escuchado»: al menos 2 escuchas en los últimos 30 días
    #top() {
        return this.#tally(startDay(this.now, WINDOW_DAYS))
            .filter(song => song.plays >= TOP_MIN_PLAYS)
            .slice(0, LIMITS.top)
            .map(song => ({ track: song.track, plays: song.plays }));
    }

    // «Hace tiempo que no suena»: canciones de las listas sin sonar en los últimos 30 días
    #forgotten() {
        const { inLists, plays, lastMs } = this.#index();
        const from = startDay(this.now, WINDOW_DAYS);
        const recent = new Set(plays.filter(play => play.day >= from).map(play => play.id));
        const known = [];
        const never = [];
        for (const [id, { track, list }] of inLists) {
            if (recent.has(id)) continue;
            const last = lastMs.get(id);
            if (last === undefined) never.push({ track, list, lastMs: null });
            else known.push({ track, list, lastMs: last });
        }
        known.sort((a, b) => a.lastMs - b.lastMs);
        const seed = `${this.userId}:${dayOf(this.now)}`;
        never.sort((a, b) => rank(seed, a.track.key) - rank(seed, b.track.key) || a.track.key.localeCompare(b.track.key));
        return [...known, ...never].slice(0, LIMITS.forgotten).map(({ track, list, lastMs: ms }) => ({
            track, list, lastPlayedAt: ms === null ? null : new Date(ms).toISOString(),
        }));
    }

    // Qué radio puso una canción: «Tu radio» (Inicio) o la de una lista (con el nombre que tiene ahora)
    #via(source) {
        if (source?.type === 'radio') return 'Tu radio';
        if (source?.type === 'list') return `radio de ${this.#index().listNames.get(source.id) ?? source.name ?? 'una lista'}`;
        if (source?.type === 'auto' && source.name) return `radio de ${source.name}`;
        return 'radio de una búsqueda';      // la radio de una canción suelta
    }

    // «Descubierto en la radio»: lo que puso la radio y sonó más de 30 s, lo último arriba
    #radio() {
        const { plays, inLists } = this.#index();
        const seen = new Set();
        const rows = [];
        for (let i = plays.length - 1; i >= 0 && rows.length < LIMITS.radio; i--) {
            const play = plays[i];
            if (!play.radio || seen.has(play.id)) continue;
            seen.add(play.id);
            // Si está AHORA en alguna de sus listas (cómo está hoy, no cuando sonó)
            rows.push({ track: play.track, at: play.at, via: this.#via(play.source), savedIn: inLists.get(play.id)?.list ?? null });
        }
        return rows;
    }

    /**
     * «Tus estadísticas» de un periodo ('7', '30' o 'all').
     * @returns {{period, days, from, to, listenedMs, listenedSince, historySince, plays, songs, artists, topTracks: {track, plays}[], topArtists: {name, plays, songs, thumb}[]}}
     */
    stats(period = '7') {
        const days = PERIODS[isPeriod(period) ? period : '7'];
        const from = days ? startDay(this.now, days) : null;
        const today = dayOf(this.now);
        const tally = this.#tally(from);

        const artists = new Map();       // firma del artista → { plays, songs, formas con que sale, canciones }
        for (const song of tally) {
            if (!song.artist) continue;
            const sig = artistSig(song.artist);
            if (!sig) continue;
            let artist = artists.get(sig);
            if (!artist) artists.set(sig, (artist = { plays: 0, songs: 0, lastMs: -Infinity, names: new Map(), tracks: [] }));
            artist.plays += song.plays;
            artist.songs++;
            artist.lastMs = Math.max(artist.lastMs, song.lastMs);
            bump(artist.names, song.artist, song.plays);
            artist.tracks.push(song.track);           // ya van de la más escuchada a la menos
        }
        const topArtists = [...artists.values()]
            .sort((a, b) => b.plays - a.plays || b.songs - a.songs || b.lastMs - a.lastMs)
            .slice(0, STATS_TOP)
            .map(artist => ({
                name: most(artist.names),
                plays: artist.plays,
                songs: artist.songs,
                // La carátula de su canción más escuchada (si esa no tiene, la de la siguiente que tenga)
                thumb: artist.tracks.map(track => this.thumbOf(track)).find(Boolean) ?? null,
            }));

        let listenedMs = 0;
        for (const [day, counters] of Object.entries(this.usageDays)) {
            if ((!from || day >= from) && day <= today) listenedMs += Number(counters?.listenedMs) || 0;
        }
        const { plays } = this.#index();
        return {
            period: days ? String(days) : 'all',
            days,
            from,
            to: today,
            listenedMs,
            listenedSince: Object.keys(this.usageDays).sort()[0] ?? null,
            historySince: plays[0]?.at ?? null,
            plays: tally.reduce((sum, song) => sum + song.plays, 0),
            songs: tally.length,
            artists: artists.size,
            topTracks: tally.slice(0, STATS_TOP).map(song => ({ track: song.track, plays: song.plays })),
            topArtists,
        };
    }

    /** Para Inicio («Para ti»): las tres listas con cuántas canciones tienen y el resumen de los últimos 7 días. */
    summary() {
        const lists = AUTO_KINDS.map(kind => {
            const { name, count, unsaved } = this.auto(kind);
            return kind === 'radio' ? { kind, name, count, unsaved } : { kind, name, count };
        });
        const { listenedMs, songs: songCount, artists, plays } = this.stats('7');
        return { lists, stats: { period: '7', listenedMs, songs: songCount, artists, plays } };
    }
}

