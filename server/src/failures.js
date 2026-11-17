import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Canciones que fallan (§19, mockups/fallos-v1.html).
//   · FailureStore: las de cada usuario («Canciones que fallaron», en Ajustes). Se apunta cuando el
//     servidor no consigue sacar el audio de una canción que pide su reproductor; sale sola cuando
//     vuelve a sonar bien, al ponerle otro enlace o al descartarla.
//   · AlternateStore: el «otro enlace» de una canción de YouTube o SoundCloud, común a todos los
//     usuarios (decisión del usuario: un vídeo roto falla igual a cualquiera, como las coincidencias
//     de Spotify, que son comunes). La canción sigue en sus listas con su nombre y su clave; solo
//     cambia de dónde sale el audio. En una canción de Spotify el otro enlace es su coincidencia.

const MAX = 200;                    // fallos que se recuerdan por usuario (los más viejos se olvidan)
const AGAIN_MS = 60_000;            // un fallo repetido en menos de esto (reintentos del reproductor) no suma otra vez

/**
 * El motivo de un fallo, en claro. `message` es el error de yt-dlp (o el del servidor).
 * @returns {{code: string, text: string}}
 */
export function reasonOf(message) {
    const text = String(message ?? '');
    if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(text)) return { code: 'age', text: 'Tiene restricción de edad' };
    if (/not a bot|Sign in to confirm/i.test(text)) return { code: 'bot', text: 'YouTube pide confirmar que no eres un bot' };
    if (/Video unavailable|Private video|has been removed|is not available|This video is unavailable|account .* terminated/i.test(text)) {
        return { code: 'unavailable', text: 'El vídeo ya no está disponible' };
    }
    if (/HTTP Error 403|Forbidden/i.test(text)) return { code: 'forbidden', text: 'YouTube rechazó la descarga' };
    if (/se cortó a medias/i.test(text)) return { code: 'cut', text: 'La descarga se cortó a medias' };
    const last = text.split('\n').map(line => line.trim()).filter(Boolean).pop();
    return { code: 'other', text: last ? last.replace(/^ERROR:\s*/, '').slice(0, 200) : 'No se pudo sacar el audio' };
}

export const NO_MATCH = { code: 'nomatch', text: 'No se ha encontrado en YouTube' };

const trackOf = track => ({
    key: track.key,
    platform: track.platform ?? null,
    title: String(track.title ?? '').slice(0, 300) || track.key,
    artist: track.artist ?? null,
    durationSec: Number.isFinite(track.durationSec) ? track.durationSec : null,
    thumb: typeof track.thumb === 'string' && track.thumb.startsWith('https://') ? track.thumb : null,
});

export class FailureStore {
    constructor(dir, { now = Date.now } = {}) {
        this.path = join(dir, 'failures.json');
        this.now = now;
        this.items = readJson(this.path, { items: {} }).items ?? {};
    }

    #save() { writeJsonAtomic(this.path, { items: this.items }); }

    /**
     * Apunta que `track` no se pudo reproducir. `list`: la lista de la que sonaba ({id, name}), si sonaba de una.
     * @returns {object} el fallo tal como queda
     */
    note(track, reason, { list = null } = {}) {
        const at = this.now();
        const old = this.items[track.key];
        const again = old && at - Date.parse(old.lastAt) < AGAIN_MS;
        this.items[track.key] = {
            track: trackOf({ ...old?.track, ...track }),
            code: reason.code,
            reason: reason.text,
            count: (old?.count ?? 0) + (again ? 0 : 1),
            firstAt: old?.firstAt ?? new Date(at).toISOString(),
            lastAt: new Date(at).toISOString(),
            list: list ? { id: list.id, name: list.name } : old?.list ?? null,
        };
        const keys = Object.keys(this.items);
        if (keys.length > MAX) {
            const oldest = keys.sort((a, b) => Date.parse(this.items[a].lastAt) - Date.parse(this.items[b].lastAt)).slice(0, keys.length - MAX);
            for (const key of oldest) delete this.items[key];
        }
        this.#save();
        return this.items[track.key];
    }

    /** Ha vuelto a sonar bien (o se descarta): sale del apartado. Devuelve si estaba. */
    remove(key) {
        if (!this.items[key]) return false;
        delete this.items[key];
        this.#save();
        return true;
    }

    get(key) { return this.items[key] ? { key, ...this.items[key] } : null; }

    /** La más reciente primero. */
    all() {
        return Object.entries(this.items)
            .map(([key, item]) => ({ key, ...item }))
            .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
    }

    get count() { return Object.keys(this.items).length; }
}

export class AlternateStore {
    constructor(dataDir, { now = Date.now } = {}) {
        this.path = join(dataDir, 'alternates.json');
        this.now = now;
        this.items = readJson(this.path, { items: {} }).items ?? {};
    }

    #save() { writeJsonAtomic(this.path, { items: this.items }); }

    /** El vídeo de YouTube desde el que suena `key`, o null si suena desde el suyo. */
    get(key) { return this.items[key]?.yt ?? null; }

    /** `yt`: el vídeo elegido. Elegir el propio de la canción quita el otro enlace. */
    set(key, yt, by) {
        if (yt.key === key) {
            if (!this.items[key]) return null;
            delete this.items[key];
        } else {
            this.items[key] = { yt: trackOf({ ...yt, platform: 'youtube' }), by: by ?? null, at: new Date(this.now()).toISOString() };
        }
        this.#save();
        return this.items[key]?.yt ?? null;
    }
}
