import { cleanTitle } from './matches.js';
import { NOISE, artistSig, plain } from './radio.js';

// «Me gusta»: saber si una canción ya está en la lista del corazón aunque venga de otra plataforma
// o de otro vídeo (la lista se importó de Spotify y lo que se busca viene de YouTube).
//
// Es más estricto que la radio (SongSet). Allí conviene pasarse, para que no repita. Aquí no: un
// «ya te gusta» equivocado haría que, al quitar el corazón, saliera de la lista OTRA canción. Por
// eso «Remix», «Live», «Acoustic»… cuentan como canciones distintas, y hacen falta los dos artistas.

const strictTitle = text => plain(text)
    .replace(/[([{][^)\]}]*\b(feat|ft|featuring)\b[^)\]}]*[)\]}]/g, ' ')      // «(feat. Alguien)»
    .replace(/\b(feat|ft|featuring)\b\.?.*$/, ' ')
    .replace(NOISE, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');

const artistsAgree = (a, b) => Boolean(a && b) && (a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b)));

/**
 * Formas de leer el título y el artista de una canción. Spotify los da por separado. En YouTube el
 * título suele ser «Artista - Canción (Official Video)», pero también «Canción - Artista», o solo
 * «Canción» en el canal del artista: se prueban las tres lecturas.
 * @returns {{title: string, artist: string}[]}
 */
export function likeSigs(track) {
    const raw = cleanTitle(track?.title).replace(/[–—|]/g, ' - ');
    const channel = artistSig(track?.artist);
    const sigs = [{ title: strictTitle(raw), artist: channel }];
    if (track?.platform !== 'spotify') {
        const parts = raw.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
        if (parts.length >= 2) {
            const rest = parts.slice(1).join(' ');
            sigs.unshift({ title: strictTitle(rest), artist: artistSig(parts[0]) });
            sigs.push({ title: strictTitle(parts[0]), artist: artistSig(rest) });
        }
    }
    return sigs.filter(sig => sig.title && sig.artist);
}

/** Las canciones de la lista de «me gusta» de un usuario, para preguntar si otra ya está entre ellas. */
export class LikeSet {
    /**
     * @param {object[]} tracks  canciones de la lista
     * @param {(key: string) => string|null} audioKeyOf  de qué vídeo sale el audio de una clave (la coincidencia, si es de Spotify)
     */
    constructor(tracks = [], audioKeyOf = () => null) {
        this.audioKeyOf = audioKeyOf;
        this.keys = new Map();          // clave propia o de su audio → clave de la canción en la lista
        this.byTitle = new Map();       // título → [{ artist, key }]
        for (const track of tracks) this.add(track);
    }

    add(track) {
        if (!track?.key) return;
        this.keys.set(track.key, track.key);
        const audio = this.audioKeyOf(track.key);
        if (audio && !this.keys.has(audio)) this.keys.set(audio, track.key);
        for (const sig of likeSigs(track)) {
            const entries = this.byTitle.get(sig.title) ?? [];
            entries.push({ artist: sig.artist, key: track.key });
            this.byTitle.set(sig.title, entries);
        }
    }

    /** Clave, dentro de la lista, de la canción que es la misma que `track`; null si no está. */
    find(track) {
        if (!track?.key) return null;
        const direct = this.keys.get(track.key) ?? this.keys.get(this.audioKeyOf(track.key));
        if (direct) return direct;
        for (const sig of likeSigs(track)) {
            const hit = this.byTitle.get(sig.title)?.find(entry => artistsAgree(entry.artist, sig.artist));
            if (hit) return hit.key;
        }
        return null;
    }

    has(track) { return this.find(track) !== null; }
}
