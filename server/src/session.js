import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Sesión de escucha (§3.4 de la SPEC): el servidor lleva qué se está escuchando, en qué orden y por
// dónde va. La app solo conoce una ventana: anterior, actual y siguiente.
//
// En disco, dos archivos: session.json (el orden y los datos de las canciones; cambia poco) y
// session-state.json (posición; cambia cada pocos segundos mientras suena).

const REPEAT = new Set(['off', 'all', 'one']);
const PLAYED_AFTER_MS = 30_000;      // a partir de aquí una canción cuenta como escuchada

export class SessionStore {
    // Cuándo empezó a mandarse el audio de cada canción de esta sesión (para saber cuánto sonó al dejarla)
    #served = new Map();

    constructor(dataDir, { now = Date.now, random = Math.random } = {}) {
        this.dataDir = dataDir;
        this.now = now;
        this.random = random;
        this.session = readJson(join(dataDir, 'session.json'), null);
        this.state = this.session ? readJson(join(dataDir, 'session-state.json'), null) : null;
        if (this.session && (!this.state || this.state.id !== this.session.id)) {
            this.state = { id: this.session.id, index: 0, positionMs: 0, repeat: 'off', visit: 0, loggedVisit: -1 };
        }
    }

    #iso() { return new Date(this.now()).toISOString(); }
    #saveSession() { writeJsonAtomic(join(this.dataDir, 'session.json'), this.session); }
    #saveState() {
        this.state.updatedAt = this.#iso();
        writeJsonAtomic(join(this.dataDir, 'session-state.json'), this.state);
    }

    #shuffled(keys) {
        const out = [...keys];
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    get active() { return Boolean(this.session); }
    get count() { return this.session?.order.length ?? 0; }
    get currentKey() { return this.session?.order[this.state.index] ?? null; }

    // Posición de una canción en la sesión (las claves no se repiten), o null
    indexOf(key) {
        const index = this.session ? this.session.order.indexOf(key) : -1;
        return index >= 0 ? index : null;
    }

    #entry(index) {
        if (index === null || index < 0 || index >= this.count) return null;
        return { index, track: this.session.tracks[this.session.order[index]] };
    }

    #nextIndex() {
        const i = this.state.index;
        if (i + 1 < this.count) return i + 1;
        return this.state.repeat === 'all' && this.count > 0 ? 0 : null;
    }

    #prevIndex() {
        const i = this.state.index;
        if (i > 0) return i - 1;
        return this.state.repeat === 'all' && this.count > 0 ? this.count - 1 : null;
    }

    /**
     * Empieza una sesión nueva (sustituye a la anterior).
     * @param {object} o
     * @param {{type: string, id?: string, name: string}} o.source  de dónde sale: una lista, la búsqueda…
     * @param {object[]} o.tracks   canciones en su orden natural (sin repetir clave)
     * @param {string} [o.startKey] por cuál empezar
     */
    start({ source, tracks, startKey = null, shuffle = false, device = null }) {
        const byKey = {};
        const base = [];
        for (const track of tracks) {
            if (!track || byKey[track.key]) continue;
            byKey[track.key] = track;
            base.push(track.key);
        }
        if (base.length === 0) return null;
        const first = byKey[startKey] ? startKey : base[0];
        let order = base;
        let index = base.indexOf(first);
        if (shuffle) {
            // Aleatorio: si el usuario eligió canción, esa va primero; si no, también la primera sale al azar
            order = startKey && byKey[startKey]
                ? [first, ...this.#shuffled(base.filter(key => key !== first))]
                : this.#shuffled(base);
            index = 0;
        }
        const id = `s_${randomBytes(5).toString('hex')}`;
        this.session = { id, source, createdAt: this.#iso(), shuffle: Boolean(shuffle), base, order, tracks: byKey };
        this.state = { id, index, positionMs: 0, repeat: 'off', visit: 0, loggedVisit: -1, device, startedAt: this.now() };
        this.#served.clear();
        this.#saveSession();
        this.#saveState();
        return this.view();
    }

    // El dispositivo que lleva la sesión: el último que empezó a reproducir o pidió continuar
    claim(device) {
        if (!this.session) return null;
        this.state.device = device ?? null;
        this.#saveState();
        return this.view();
    }

    // Lo que ve la app: datos de la sesión y la ventana anterior / actual / siguiente
    view() {
        if (!this.session) return null;
        return {
            id: this.session.id,
            source: this.session.source,
            count: this.count,
            index: this.state.index,
            shuffle: this.session.shuffle,
            repeat: this.state.repeat,
            positionMs: this.state.positionMs,
            device: this.state.device ?? null,
            window: {
                prev: this.#entry(this.#prevIndex()),
                current: this.#entry(this.state.index),
                next: this.#entry(this.#nextIndex()),
            },
        };
    }

    goto(index) {
        if (!this.session || !Number.isInteger(index) || index < 0 || index >= this.count) return null;
        if (index !== this.state.index) {
            this.state.index = index;
            this.state.positionMs = 0;
            this.state.visit++;
            this.state.startedAt = this.now();
            delete this.state.reportedAt;
            this.#saveState();
        }
        return this.view();
    }

    /** El audio de `key` ha empezado a mandarse a un reproductor (se apunta la primera vez). */
    served(key) {
        if (this.session?.tracks[key] && !this.#served.has(key)) this.#served.set(key, this.now());
    }

    /**
     * La canción que suena ahora, si es de la radio (sin guardar) y aún no cuenta como escuchada, con
     * cuánto se ha oído: desde que se pasó a ella o desde que empezó a llegar su audio (lo que sea
     * más tarde), o desde el último informe de posición. Con una pausa por medio sale de más, así que
     * en la duda no cuenta como salto. `heardMs` null = no llegó a sonar. null si no es de la radio.
     */
    leaving() {
        if (!this.session) return null;
        const track = this.session.tracks[this.currentKey];
        if (!track?.radio || track.saved || this.state.loggedVisit === this.state.visit) return null;
        const served = this.#served.get(track.key);
        if (served === undefined) return { track, heardMs: null };
        const now = this.now();
        const start = Math.max(this.state.startedAt ?? 0, served);
        const reportedAt = this.state.reportedAt;
        const heardMs = Number.isFinite(reportedAt) && reportedAt >= start ? this.state.positionMs + (now - reportedAt) : now - start;
        return { track, heardMs: Math.max(0, heardMs) };
    }

    /**
     * La app informa de por dónde va. Devuelve la canción si acaba de pasar a contar como escuchada.
     */
    report({ index, positionMs }) {
        if (!this.session || index !== this.state.index || !Number.isFinite(positionMs) || positionMs < 0) return null;
        this.state.positionMs = Math.round(positionMs);
        this.state.reportedAt = this.now();
        let played = null;
        if (positionMs >= PLAYED_AFTER_MS && this.state.loggedVisit !== this.state.visit) {
            this.state.loggedVisit = this.state.visit;
            played = { track: this.session.tracks[this.currentKey], source: this.session.source };
        }
        this.#saveState();
        return { played };
    }

    setOptions({ shuffle, repeat }) {
        if (!this.session) return null;
        if (typeof repeat === 'string' && REPEAT.has(repeat)) this.state.repeat = repeat;
        if (typeof shuffle === 'boolean' && shuffle !== this.session.shuffle) {
            const current = this.currentKey;
            if (shuffle) {
                // La que suena se queda; el resto se baraja detrás. Lo que puso la radio sigue al final, en su orden.
                const rest = this.session.base.filter(key => key !== current);
                this.session.order = [current, ...this.#shuffled(rest.filter(key => !this.#pendingRadio(key))), ...rest.filter(key => this.#pendingRadio(key))];
                this.state.index = 0;
            } else {
                // Vuelve el orden natural, situados en la canción que suena
                this.session.order = [...this.session.base];
                this.state.index = this.session.order.indexOf(current);
            }
            this.session.shuffle = shuffle;
            this.#saveSession();
        }
        this.#saveState();
        return this.view();
    }

    // Canciones a partir de `from`, de `limit` en `limit` (la pantalla de cola las pide al bajar)
    queue(from, limit) {
        if (!this.session) return null;
        const start = Math.max(0, Number.isInteger(from) ? from : this.state.index);
        const size = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, 100));
        const entries = [];
        for (let i = start; i < Math.min(start + size, this.count); i++) entries.push(this.#entry(i));
        return { index: this.state.index, count: this.count, entries };
    }

    // «A continuación» (mode 'next') o «Añadir a la cola» (mode 'end'). Si ya estaba en la sesión, se recoloca.
    enqueue(track, mode) {
        if (!this.session || !track) return null;
        const current = this.currentKey;
        if (track.key === current) return this.view();
        const { order, base } = this.session;
        const without = list => list.filter(key => key !== track.key);
        const place = list => {
            const clean = without(list);
            if (mode === 'next') {
                clean.splice(clean.indexOf(current) + 1, 0, track.key);
            } else {
                // Al final de lo que ha pedido el usuario: por delante de lo que la radio tenga puesto después
                const from = clean.indexOf(current) + 1;
                const radioAt = clean.findIndex((key, i) => i >= from && this.#pendingRadio(key));
                clean.splice(radioAt < 0 ? clean.length : radioAt, 0, track.key);
            }
            return clean;
        };
        this.session.tracks[track.key] ??= track;
        this.session.order = place(order);
        this.session.base = this.session.shuffle ? place(base) : [...this.session.order];
        this.state.index = this.session.order.indexOf(current);
        this.#saveSession();
        this.#saveState();
        return this.view();
    }

    // --- Radio (Fase 4) ---
    // Canción puesta por la radio que el usuario no ha guardado en una lista
    #pendingRadio(key) {
        const track = this.session.tracks[key];
        return Boolean(track?.radio && !track.saved);
    }

    /** Cuántas canciones quedan por detrás de la que suena. */
    get remaining() { return this.session ? this.count - 1 - this.state.index : 0; }

    /** Añade al final una tanda de la radio (canciones con `radio: true`). Devuelve cuántas han entrado. */
    appendRadio(tracks) {
        if (!this.session) return 0;
        const keys = [];
        for (const track of tracks) {
            if (!track?.key || this.session.tracks[track.key]) continue;
            this.session.tracks[track.key] = { ...track, radio: true };
            keys.push(track.key);
        }
        if (keys.length) {
            // Listas nuevas: sin aleatorio, `order` y `base` son el mismo array y un push doble las duplicaría
            this.session.order = [...this.session.order, ...keys];
            this.session.base = this.session.shuffle ? [...this.session.base, ...keys] : [...this.session.order];
            this.#saveSession();
        }
        return keys.length;
    }

    /** El usuario ha guardado en una lista una canción que puso la radio: deja de ser «de la radio» a todos los efectos. */
    markSaved(key) {
        const track = this.session?.tracks[key];
        if (!track?.radio || track.saved) return false;
        track.saved = true;
        this.#saveSession();
        return true;
    }

    /** Canciones de la sesión, en orden. */
    allTracks() {
        return this.session ? this.session.order.map(key => this.session.tracks[key]) : [];
    }

    // Reordenar lo que viene después de la canción actual
    moveQueued(from, to) {
        if (!this.session || ![from, to].every(Number.isInteger)) return null;
        const first = this.state.index + 1;
        if (from < first || to < first || from >= this.count || to >= this.count) return null;
        const [key] = this.session.order.splice(from, 1);
        this.session.order.splice(to, 0, key);
        if (!this.session.shuffle) this.session.base = [...this.session.order];
        this.#saveSession();
        return this.view();
    }

    // Quitar de la cola una canción que aún no ha sonado (no la quita de su lista)
    removeQueued(index) {
        if (!this.session || !Number.isInteger(index) || index <= this.state.index || index >= this.count) return null;
        const [key] = this.session.order.splice(index, 1);
        this.session.base = this.session.base.filter(k => k !== key);
        delete this.session.tracks[key];
        this.#saveSession();
        return this.view();
    }
}

const HISTORY_FILE = /^history-\d{4}\.jsonl$/;

// Historial de lo escuchado: una línea JSON por canción, un archivo por año
export class HistoryStore {
    constructor(dataDir, { now = Date.now } = {}) {
        this.dataDir = dataDir;
        this.now = now;
    }

    // Lo ya leído de cada archivo, con su tamaño y fecha: si el archivo cambia, se vuelve a leer
    #read = new Map();

    #path(year) { return join(this.dataDir, `history-${year}.jsonl`); }

    append({ track, source }) {
        const at = new Date(this.now());
        mkdirSync(this.dataDir, { recursive: true });
        appendFileSync(this.#path(at.getUTCFullYear()), JSON.stringify({ at: at.toISOString(), source, track }) + '\n');
        this.#read.delete(`history-${at.getUTCFullYear()}.jsonl`);
    }

    /**
     * Todo el historial, de todos los años (history-*.jsonl), de lo más antiguo a lo más reciente
     * según el orden de los archivos. Se salta las líneas a medias y las que no traen fecha o
     * canción. Lo devuelto se comparte entre llamadas: no se modifica.
     */
    all() {
        let names;
        try { names = readdirSync(this.dataDir).filter(name => HISTORY_FILE.test(name)).sort(); } catch { return []; }
        const out = [];
        for (const name of names) {
            const path = join(this.dataDir, name);
            let stat;
            try { stat = statSync(path); } catch { continue; }
            let known = this.#read.get(name);
            if (!known || known.size !== stat.size || known.mtimeMs !== stat.mtimeMs) {
                let text;
                try { text = readFileSync(path, 'utf8'); } catch { continue; }
                const entries = [];
                for (const line of text.split('\n')) {
                    if (!line) continue;
                    let entry;
                    try { entry = JSON.parse(line); } catch { continue; }      // línea a medias: se salta
                    if (typeof entry?.at === 'string' && Number.isFinite(Date.parse(entry.at)) && typeof entry.track?.key === 'string') entries.push(entry);
                }
                known = { size: stat.size, mtimeMs: stat.mtimeMs, entries };
                this.#read.set(name, known);
            }
            for (const entry of known.entries) out.push(entry);
        }
        return out;
    }

    // Lo más reciente primero. Mira el año en curso y, si hace falta, el anterior.
    recent(limit = 30) {
        const year = new Date(this.now()).getUTCFullYear();
        const out = [];
        for (const y of [year, year - 1]) {
            let lines;
            try { lines = readFileSync(this.#path(y), 'utf8').split('\n'); } catch { continue; }
            for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
                if (!lines[i]) continue;
                try { out.push(JSON.parse(lines[i])); } catch { /* línea a medias: se salta */ }
            }
            if (out.length >= limit) break;
        }
        return out;
    }
}
