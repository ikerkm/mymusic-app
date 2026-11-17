import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Radio (Fase 4): al acabarse lo que suena, seguir con canciones parecidas.
//
// Las parecidas salen de la «mezcla» automática que YouTube genera para un vídeo (lista RD<id>). La
// radio del bot de Discord usa siempre la misma semilla y se queda con las primeras de la mezcla,
// y por eso se vicia: mismo artista, mismas canciones. Aquí:
//   · cada tanda parte de VARIAS semillas elegidas al azar, y no repite semilla hasta pasar por todas;
//   · se sortea entre todas las candidatas, en vez de coger las primeras;
//   · como mucho una canción por artista en cada tanda, y pesan menos los que acaban de sonar;
//   · memoria larga por usuario: lo que la radio ya puso no vuelve en semanas;
//   · la misma canción en otro vídeo (oficial, con letra, remasterizada) cuenta como la misma;
//   · fuera los vídeos muy largos o muy cortos (recopilatorios, directos enteros, cortes);
//   · lo que pone la radio no sirve de semilla (salvo que el usuario lo guarde en una lista).

export const RADIO_BATCH = 5;            // canciones por tanda
export const RADIO_SEEDS = 3;            // semillas por tanda
const MIX_SIZE = 60;                     // candidatas que se piden a cada mezcla
const MIX_TTL_MS = 6 * 60 * 60 * 1000;   // una mezcla se recuerda este tiempo (YouTube la varía entre llamadas)
const MIX_CACHE_MAX = 300;
const MEMORY_MS = 30 * 24 * 60 * 60 * 1000;   // lo ya puesto por la radio no vuelve en este tiempo
const MEMORY_MAX = 1500;
const RECENT_ARTISTS = 15;               // artistas de las últimas N canciones de radio pesan menos
const MIN_SEC = 60;
const MAX_SEC = 600;
const MAX_ROUNDS = 3;                    // veces que se amplía con más semillas si no salen suficientes

export const plain = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Palabras que distinguen vídeos, no canciones
export const NOISE = /\b(official|oficial|video ?clip|video|music|audio|lyrics?|letra|con letra|hd|hq|4k|8k|remaster(ed|izado|izada)?|visuali[sz]er|mv|explicit|clean|version|full|original|high quality|upgrade)\b/g;

export const artistSig = text => plain(text)
    .replace(/\s+-\s+topic$/, '')
    .replace(/\b(vevo|official|oficial|music|records|tv|channel)\b/g, '')
    .replace(/vevo$/, '')
    .replace(/[^a-z0-9]+/g, '');

const titleSig = text => plain(text)
    .replace(/[([{【「『][^)\]}】」』]*[)\]}】」』]/g, ' ')     // lo que va entre paréntesis o corchetes
    .replace(/\b(feat|ft|featuring)\b\.?.*$/, ' ')
    .replace(NOISE, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Firma de una canción, para reconocerla aunque venga de otro vídeo o de otra plataforma.
 * YouTube suele titular «Artista - Canción (Official Video)»; Spotify trae el artista aparte y
 * coletillas como «Canción - Remastered 2011».
 * @returns {{title: string, artist: string}}
 */
export function songSig(track) {
    const raw = String(track?.title ?? '').replace(/[–—|:]/g, ' - ');
    const parts = raw.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    const given = artistSig(track?.artist);
    if (track?.platform === 'spotify' || parts.length < 2) {
        return { title: titleSig(parts[0] ?? raw), artist: given };
    }
    // «Artista - Canción»; si el primer tramo no dice nada (solo ruido), vale el canal
    const title = titleSig(parts[1]);
    const artist = artistSig(parts[0]);
    if (!title) return { title: titleSig(parts[0]), artist: given };
    return { title, artist: artist || given };
}

const compact = text => text.replace(/ /g, '');
const artistsMatch = (a, b) => !a || !b || a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b));

/** Conjunto de canciones que se reconocen por clave o por firma (título y artista compatibles). */
export class SongSet {
    constructor() {
        this.keys = new Set();
        this.byTitle = new Map();
    }

    add(track) {
        if (!track) return this;
        if (track.key) this.keys.add(track.key);
        const sig = songSig(track);
        if (sig.title) {
            const title = compact(sig.title);
            const artists = this.byTitle.get(title) ?? [];
            artists.push(sig.artist);
            this.byTitle.set(title, artists);
        }
        return this;
    }

    addKey(key) {
        if (key) this.keys.add(key);
        return this;
    }

    has(track) {
        if (track.key && this.keys.has(track.key)) return true;
        const sig = songSig(track);
        if (!sig.title) return false;
        const title = compact(sig.title);
        if (this.byTitle.get(title)?.some(artist => artistsMatch(artist, sig.artist))) return true;
        // «Canción - Artista», al revés de lo habitual
        return Boolean(sig.artist && this.byTitle.get(sig.artist)?.some(artist => artist && artist === title));
    }
}

/**
 * Lo que la radio recuerda de un usuario (data/users/<id>/radio.json): si la tiene encendida, lo
 * que ya le ha puesto y qué semillas ha gastado en cada origen.
 */
export class RadioMemory {
    constructor(dataDir, { now = Date.now } = {}) {
        this.path = join(dataDir, 'radio.json');
        this.now = now;
        const saved = readJson(this.path, null) ?? {};
        this.enabled = saved.enabled === true;
        this.recent = Array.isArray(saved.recent) ? saved.recent : [];     // { key, title, artist, at } de más antigua a más reciente
        this.seeds = saved.seeds && typeof saved.seeds === 'object' ? saved.seeds : {};   // origen → claves ya usadas en esta vuelta
    }

    save() {
        writeJsonAtomic(this.path, { enabled: this.enabled, recent: this.recent, seeds: this.seeds });
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        this.save();
    }

    /** Lo puesto por la radio dentro del plazo de memoria. */
    fresh() {
        const since = this.now() - MEMORY_MS;
        return this.recent.filter(entry => Date.parse(entry.at) >= since);
    }

    note(tracks) {
        const at = new Date(this.now()).toISOString();
        for (const track of tracks) this.recent.push({ key: track.key, title: track.title, artist: track.artist ?? null, at });
        if (this.recent.length > MEMORY_MAX) this.recent = this.recent.slice(-MEMORY_MAX);
    }
}

const YT_KEY = /^yt:([A-Za-z0-9_-]{11})$/;
export const mixUrl = id => `https://www.youtube.com/watch?v=${id}&list=RD${id}`;

export class Radio {
    /**
     * @param {object} o
     * @param {(ytId: string, limit: number) => Promise<{id: string, title: string, duration: number|null, uploader: string|null}[]>} o.fetchMix
     */
    constructor({ fetchMix, now = Date.now, random = Math.random, log = () => {}, mixTimeoutMs = 25_000 }) {
        this.fetchMix = fetchMix;
        this.now = now;
        this.random = random;
        this.log = log;
        this.mixTimeoutMs = mixTimeoutMs;
        this.mixes = new Map();      // id de la semilla → { at, tracks }
        this.reading = new Map();    // id de la semilla → lectura en curso (para no pedir dos veces la misma)
    }

    #pick(list) { return list[Math.floor(this.random() * list.length)]; }

    // Una mezcla puede tardar (medido: la primera tras un rato parado, hasta minuto y medio; las demás, 3 s).
    // No se espera más de `mixTimeoutMs`: la tanda sigue con las que hayan llegado. La lectura lenta no se
    // corta: cuando acabe queda recordada, y el siguiente intento la encuentra hecha.
    async #mix(ytId) {
        const known = this.mixes.get(ytId);
        if (known && this.now() - known.at < MIX_TTL_MS) return known.tracks;
        let reading = this.reading.get(ytId);
        if (!reading) {
            const started = Date.now();
            reading = this.#read(ytId).finally(() => {
                this.reading.delete(ytId);
                const took = Date.now() - started;
                if (took > 10_000) this.log(`[radio] la mezcla de ${ytId} ha tardado ${Math.round(took / 1000)} s`);
            });
            reading.catch(() => {});       // si nadie la espera ya, que su fallo no quede sin recoger
            this.reading.set(ytId, reading);
        }
        let timer;
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('La mezcla de YouTube tarda demasiado')), this.mixTimeoutMs); });
        try {
            return await Promise.race([reading, late]);
        } finally {
            clearTimeout(timer);
        }
    }

    async #read(ytId) {
        const entries = await this.fetchMix(ytId, MIX_SIZE);
        const tracks = [];
        for (const entry of entries ?? []) {
            if (!/^[A-Za-z0-9_-]{11}$/.test(entry?.id ?? '') || !entry.title || /^\[(private|deleted) video\]$/i.test(entry.title)) continue;
            tracks.push({
                key: `yt:${entry.id}`,
                platform: 'youtube',
                title: String(entry.title).slice(0, 300),
                artist: entry.uploader ? String(entry.uploader).slice(0, 200) : null,
                durationSec: entry.duration ? Math.round(entry.duration) : null,
                thumb: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
            });
        }
        this.mixes.set(ytId, { at: this.now(), tracks });
        if (this.mixes.size > MIX_CACHE_MAX) this.mixes.delete(this.mixes.keys().next().value);
        return tracks;
    }

    /**
     * Elige semillas del origen que aún no se han usado en esta vuelta; cuando se acaban, empieza otra.
     * @param {string[]} pool   claves de audio de YouTube (yt:<id>) de las que se puede partir
     */
    #takeSeeds(memory, scope, pool, count) {
        const used = new Set(memory.seeds[scope] ?? []);
        let free = pool.filter(key => !used.has(key));
        const taken = [];
        while (taken.length < count && pool.length > taken.length) {
            if (free.length === 0) {
                // Vuelta nueva: todas valen otra vez, menos las que acaban de salir en esta tanda
                used.clear();
                free = pool.filter(key => !taken.includes(key));
                if (free.length === 0) break;
            }
            const key = this.#pick(free);
            free = free.filter(k => k !== key);
            used.add(key);
            taken.push(key);
        }
        memory.seeds[scope] = [...used];
        return taken;
    }

    /**
     * Una tanda de canciones parecidas.
     * @param {object} o
     * @param {string} o.scope            de dónde es la radio («list:<id>», «home», «session:<id>»): cada origen rota sus semillas
     * @param {string[]} o.seedKeys       claves yt:<id> de las canciones de las que se parte
     * @param {string[]} [o.fallbackKeys] semillas de reserva si con las anteriores no salen suficientes (lo que la radio ya puso en esta sesión)
     * @param {SongSet} o.exclude         lo que no puede salir (la propia lista, lo que hay en cola…)
     * @param {RadioMemory} o.memory
     * @returns {Promise<{tracks: object[], seeds: string[]}>}
     */
    async batch({ scope, seedKeys, fallbackKeys = [], exclude, memory, count = RADIO_BATCH }) {
        const pool = [...new Set(seedKeys.filter(key => YT_KEY.test(key)))];
        const reserve = [...new Set(fallbackKeys.filter(key => YT_KEY.test(key) && !pool.includes(key)))];
        if (pool.length === 0 && reserve.length === 0) return { tracks: [], seeds: [] };
        // De la vuelta en curso solo cuentan las semillas que siguen en el origen; y no se guardan orígenes sin fin
        const inPool = new Set(pool);
        const lapSoFar = (memory.seeds[scope] ?? []).filter(key => inPool.has(key));
        delete memory.seeds[scope];
        memory.seeds[scope] = lapSoFar;
        for (const old of Object.keys(memory.seeds).slice(0, -40)) delete memory.seeds[old];

        const fresh = memory.fresh();
        const played = new SongSet();
        for (const entry of fresh) played.add(entry);
        const tired = new Set(fresh.slice(-RECENT_ARTISTS).map(entry => songSig(entry).artist).filter(Boolean));

        const candidates = new Map();     // clave → { track, hits }
        const seedsUsed = [];
        const seedArtists = new Set();
        let failures = 0;
        let lastError = null;

        const usable = () => [...candidates.values()].filter(c => !exclude.has(c.track) && !played.has(c.track));

        for (let round = 0; round < MAX_ROUNDS; round++) {
            let seeds = this.#takeSeeds(memory, scope, pool.filter(key => !seedsUsed.includes(key)), RADIO_SEEDS);
            if (seeds.length === 0) {
                // Sin más semillas propias: un salto, partiendo de lo que la radio ya puso en esta sesión
                const left = reserve.filter(key => !seedsUsed.includes(key));
                seeds = [];
                while (seeds.length < RADIO_SEEDS && left.length) seeds.push(...left.splice(Math.floor(this.random() * left.length), 1));
            }
            if (seeds.length === 0) break;
            seedsUsed.push(...seeds);

            const mixes = await Promise.allSettled(seeds.map(key => this.#mix(YT_KEY.exec(key)[1])));
            mixes.forEach((result, i) => {
                if (result.status !== 'fulfilled') {
                    failures++;
                    lastError = result.reason;
                    return;
                }
                const seedKey = seeds[i];
                for (const track of result.value) {
                    if (track.key === seedKey) {
                        seedArtists.add(songSig(track).artist);
                        continue;
                    }
                    if (track.durationSec !== null && (track.durationSec < MIN_SEC || track.durationSec > MAX_SEC)) continue;
                    const known = candidates.get(track.key);
                    if (known) known.hits++;
                    else candidates.set(track.key, { track, hits: 1 });
                }
            });
            if (usable().length >= count * 3) break;      // margen de sobra para sortear
        }

        if (seedsUsed.length > 0 && failures === seedsUsed.length) {
            throw lastError instanceof Error ? lastError : new Error('No se pudo leer ninguna mezcla');
        }

        // Sorteo ponderado sin repetir artista. Si no llega, segunda pasada permitiendo repetir artista.
        const chosen = [];
        const chosenSet = new SongSet();
        const artistsInBatch = new Set();
        for (const allowRepeat of [false, true]) {
            const left = usable().filter(c => !chosenSet.has(c.track));
            while (chosen.length < count && left.length) {
                const weights = left.map(c => {
                    const artist = songSig(c.track).artist;
                    if (!allowRepeat && artist && artistsInBatch.has(artist)) return 0;
                    let weight = 1 + 0.5 * (c.hits - 1);          // sale en varias mezclas: representa mejor al conjunto
                    if (artist && tired.has(artist)) weight *= 0.25;
                    if (artist && seedArtists.has(artist)) weight *= 0.5;
                    return weight;
                });
                const total = weights.reduce((sum, w) => sum + w, 0);
                if (total <= 0) break;
                let at = this.random() * total;
                let index = weights.findIndex(w => (at -= w) < 0);
                if (index < 0) index = weights.findLastIndex(w => w > 0);
                const [picked] = left.splice(index, 1);
                // Dos vídeos de la misma canción entre las candidatas: solo entra uno
                if (chosenSet.has(picked.track)) continue;
                chosenSet.add(picked.track);
                const artist = songSig(picked.track).artist;
                if (artist) artistsInBatch.add(artist);
                chosen.push(picked.track);
            }
            if (chosen.length >= count) break;
        }

        // Las semillas de esta tanda quedan gastadas en la vuelta en curso
        const lap = new Set(memory.seeds[scope] ?? []);
        for (const key of seedsUsed) if (inPool.has(key)) lap.add(key);
        memory.seeds[scope] = [...lap];
        memory.note(chosen);
        memory.save();
        return { tracks: chosen.map(track => ({ ...track, radio: true })), seeds: seedsUsed };
    }
}
