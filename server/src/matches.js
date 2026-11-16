import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Coincidencias de las canciones que vienen de Spotify. Una canción de Spotify no suena desde
// Spotify: se busca en YouTube por título y artista, la primera vez que hace falta, y lo elegido
// queda guardado en data/matches.json. La coincidencia es de la canción, no de una lista concreta.
//
// Entrada: { title, artist, durationSec, yt: {key,title,artist,durationSec,thumb}|null, auto: bool }

const TOLERANCE_SEC = 30;

// «Dreams - 2004 Remaster» → «Dreams»: las coletillas de edición estorban al buscar. No se quita
// «Live», «Remix» ni «Acoustic»: esas sí son otra canción.
export function cleanTitle(title) {
    return String(title ?? '')
        .replace(/\s*[([][^)\]]*(remaster|mono|stereo|anniversary|deluxe|bonus|edition|version)[^)\]]*[)\]]/gi, '')
        .replace(/\s+-\s+[^-]*(remaster|mono|stereo|anniversary|deluxe|bonus track|single version|album version)[^-]*$/i, '')
        .trim();
}

const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null);

// «AC/DC» → «acdc», «Beyoncé» → «beyonce»
const plain = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ¿El canal de YouTube es del propio artista? («Queen Official», «NirvanaVEVO», «Fleetwood Mac»…)
export function sameArtist(channel, artist) {
    const first = plain(String(artist ?? '').split(',')[0]);
    return first.length >= 2 && plain(channel).includes(first);
}

/**
 * Qué candidato se queda como coincidencia. Entre los que duran parecido a la canción de Spotify:
 * primero los del canal del propio artista y, dentro de esos, el de duración más cercana (a igualdad,
 * el que YouTube puso antes). Si ninguno dura parecido, el primer resultado.
 *
 * Afinado el 2026-11-16 con canciones reales: la duración más cercana saca el audio del disco frente
 * al videoclip (que lleva introducción o final añadidos), y mirar el canal evita quedarse con un
 * vídeo con letra de un canal cualquiera cuando existe el oficial.
 */
export function pickMatch(candidates, artist) {
    const near = candidates.filter(c => c.durationDiff !== null && c.durationDiff <= TOLERANCE_SEC);
    const byDiff = list => [...list].sort((a, b) => a.durationDiff - b.durationDiff)[0];        // orden estable
    return byDiff(near.filter(c => sameArtist(c.artist, artist))) ?? byDiff(near) ?? candidates[0] ?? null;
}

export class MatchStore {
    /**
     * @param {(query: string, limit: number) => Promise<object[]>} search  buscador de YouTube (un doble en los tests)
     */
    constructor(dataDir, { search, now = Date.now, log = () => {} } = {}) {
        this.path = join(dataDir, 'matches.json');
        this.search = search;
        this.now = now;
        this.log = log;
        this.items = readJson(this.path, {});
        this.pending = new Map();        // búsquedas en curso, para no lanzar dos de la misma canción
    }

    #save() { writeJsonAtomic(this.path, this.items); }

    // Al importar: se apunta de cada canción lo necesario para poder buscarla después
    remember(tracks) {
        let changed = false;
        for (const track of tracks) {
            if (!track?.key?.startsWith('sp:') || this.items[track.key]) continue;
            this.items[track.key] = { title: track.title, artist: track.artist ?? null, durationSec: track.durationSec ?? null, yt: null, auto: true };
            changed = true;
        }
        if (changed) this.#save();
    }

    get(key) { return this.items[key] ?? null; }

    // Datos de presentación: la carátula de la coincidencia y si la eligió el servidor o el usuario
    decorate(track) {
        if (!track?.key?.startsWith('sp:')) return track;
        const entry = this.items[track.key];
        return {
            ...track,
            thumb: track.thumb ?? entry?.yt?.thumb ?? null,
            match: entry?.yt ? (entry.auto ? 'auto' : 'manual') : 'pending',
        };
    }

    #query(entry) {
        return [entry.artist, cleanTitle(entry.title)].filter(Boolean).join(' ');
    }

    // Candidatos de YouTube para una canción, con lo que se alejan de su duración
    async candidates(key, limit = 8) {
        const entry = this.items[key];
        if (!entry) return null;
        const results = await this.search(this.#query(entry), limit);
        return results.map(result => ({ ...result, durationDiff: diff(result.durationSec, entry.durationSec) }));
    }

    /** La coincidencia de una canción; si aún no tiene, la busca, elige con pickMatch() y la guarda. */
    resolve(key) {
        const entry = this.items[key];
        if (!entry) return Promise.resolve(null);
        if (entry.yt) return Promise.resolve(entry);
        if (this.pending.has(key)) return this.pending.get(key);
        const job = (async () => {
            try {
                let found = await this.candidates(key, 8);
                // El buscador de YouTube devuelve a veces una página vacía sin motivo: se pregunta otra vez
                if (found.length === 0) found = await this.candidates(key, 8);
                const pick = pickMatch(found, entry.artist);
                const close = pick?.durationDiff !== null && pick?.durationDiff <= TOLERANCE_SEC;
                if (!pick) {
                    this.log(`[coincidencia] ${key}: sin resultados para «${this.#query(entry)}»`);
                    return null;
                }
                const { durationDiff, ...yt } = pick;
                entry.yt = yt;
                entry.auto = true;
                entry.matchedAt = new Date(this.now()).toISOString();
                this.#save();
                this.log(`[coincidencia] ${key} «${entry.title}» → ${yt.key} «${yt.title}»${close ? '' : ' (ninguna con duración parecida)'}`);
                return entry;
            } finally {
                this.pending.delete(key);
            }
        })();
        this.pending.set(key, job);
        return job;
    }

    // El usuario elige a mano («Cambiar coincidencia»)
    choose(key, yt) {
        const entry = this.items[key];
        if (!entry || !yt?.key?.startsWith('yt:')) return null;
        entry.yt = { key: yt.key, platform: 'youtube', title: yt.title, artist: yt.artist ?? null, durationSec: yt.durationSec ?? null, thumb: yt.thumb ?? null };
        entry.auto = false;
        entry.matchedAt = new Date(this.now()).toISOString();
        this.#save();
        return entry;
    }
}
