import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { ALBUM_ID, ARTIST_ID, words } from './ytmusic.js';

// Artistas que sigues y sus novedades (§21, mockups/novedades-v1.html).
//   · FollowStore: lo de cada usuario (data/users/<id>/follows.json): a quién sigue y qué novedades
//     ha abierto ya (el punto de «nuevo» se quita al abrir el disco). Dejar de seguir no pasa por la
//     papelera: no se pierde nada y se vuelve a seguir con un toque (aprobado en la maqueta, 18-11).
//   · ReleaseWatch: común a todos (data/releases.json): lo que hay en la página de YouTube Music de
//     cada artista seguido, con la fecha de salida de lo reciente. Se mira al seguir a un artista y una
//     vez al día desde las 4 de la mañana; cada artista una sola vez aunque lo sigan varios.
//
// Qué es una novedad (decisión del usuario «A los que sigo» + la regla medida el 18-11):
//   · un disco, sencillo o EP que salió en los últimos N días (30 en Inicio, 90 en «Ver todas»); o
//   · uno que aparece nuevo en la página del artista en la vuelta diaria aunque su fecha sea vieja
//     (reedición, edición ampliada), si es de este año o del anterior: «apareció hace N días».

export const DAY_MS = 86_400_000;
export const NEW_DAYS = 30;              // Inicio
export const ALL_DAYS = 90;              // «Ver todas»
export const FOLLOW_MAX = 500;           // artistas que puede seguir un usuario
const SEEN_MAX = 3000;                   // novedades abiertas que se recuerdan por usuario
const GAP_MS = 3 * DAY_MS;               // un artista sin mirar más de esto: lo que aparezca no cuenta como recién salido
const CHECK_FROM_HOUR = 4;               // la vuelta diaria empieza a las 4 (hora del servidor)
const TICK_MS = 30 * 60_000;             // cada cuánto se mira si toca la vuelta
const PAUSE_MS = 2000;                   // entre artista y artista, para no pedir de golpe
const RETRY_MS = 2 * 3600_000;           // tras un fallo de YouTube Music con un artista, no se repite en 2 h

const iso = ms => new Date(ms).toISOString();
const pad = n => String(n).padStart(2, '0');
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const httpsOrNull = url => (typeof url === 'string' && url.startsWith('https://') ? url : null);
const squash = text => words(text).join('');
// Un mismo lanzamiento puede cambiar de id en YouTube Music: se reconoce por tipo, nombre y año
export const releaseKey = release => `${release.kind}|${squash(release.title)}|${release.year ?? ''}`;

// ------------------------------------------------------------------ lo de cada usuario

export class FollowStore {
    constructor(dir, { now = Date.now } = {}) {
        this.path = join(dir, 'follows.json');
        this.now = now;
        const data = readJson(this.path, {});
        this.artists = data.artists ?? {};      // id → { name, thumb, at }
        this.seen = data.seen ?? {};            // id de disco → cuándo se abrió
    }

    #save() { writeJsonAtomic(this.path, { artists: this.artists, seen: this.seen }); }

    /** Los artistas que sigue: [{ id, name, thumb, at }], del último que siguió al primero. */
    list() {
        return Object.entries(this.artists).map(([id, a]) => ({ id, ...a })).sort((a, b) => (a.at < b.at ? 1 : -1));
    }

    ids() { return Object.keys(this.artists); }

    has(id) { return Object.hasOwn(this.artists, id); }

    /** Seguir. Si ya lo seguía, solo se ponen al día el nombre y la foto. Devuelve null si ya sigue a demasiados. */
    follow({ id, name, thumb = null }) {
        if (!ARTIST_ID.test(String(id ?? ''))) throw new Error('Artista no válido');
        const old = this.artists[id];
        if (!old && Object.keys(this.artists).length >= FOLLOW_MAX) return null;
        this.artists[id] = { name: String(name ?? '').slice(0, 200) || old?.name || id, thumb: httpsOrNull(thumb) ?? old?.thumb ?? null, at: old?.at ?? iso(this.now()) };
        this.#save();
        return { id, ...this.artists[id] };
    }

    /** Dejar de seguir. Devuelve si lo seguía. */
    unfollow(id) {
        if (!this.has(id)) return false;
        delete this.artists[id];
        this.#save();
        return true;
    }

    isSeen(releaseId) { return Object.hasOwn(this.seen, releaseId); }

    /** Apunta que ha abierto este disco (quita el punto). Devuelve si es la primera vez. */
    markSeen(releaseId) {
        if (!ALBUM_ID.test(String(releaseId ?? '')) || this.isSeen(releaseId)) return false;
        this.seen[releaseId] = iso(this.now());
        const ids = Object.keys(this.seen);
        if (ids.length > SEEN_MAX) {
            for (const old of ids.sort((a, b) => (this.seen[a] < this.seen[b] ? -1 : 1)).slice(0, ids.length - SEEN_MAX)) delete this.seen[old];
        }
        this.#save();
        return true;
    }
}

// ------------------------------------------------------------------ común: lo que saca cada artista

export class ReleaseWatch {
    /**
     * @param {string} dataDir
     * @param {{ytmusic: import('./ytmusic.js').YtMusic, now?: () => number, pauseMs?: number, log?: Function}} options
     */
    constructor(dataDir, { ytmusic, now = Date.now, pauseMs = PAUSE_MS, log = () => {} }) {
        this.path = join(dataDir, 'releases.json');
        this.ytmusic = ytmusic;
        this.now = now;
        this.pauseMs = pauseMs;
        this.log = log;
        this.artists = readJson(this.path, {}).artists ?? {};      // id → { name, thumb, checkedAt, failedAt, releases }
        this.reading = new Map();                                  // id → vuelta en curso de ese artista
        this.timer = null;
        this.running = null;
    }

    #save() { writeJsonAtomic(this.path, { artists: this.artists }); }

    entry(id) { return this.artists[id] ?? null; }

    /** El año desde el que vale la pena saber la fecha exacta (lo que pueda caer en «Ver todas»). */
    #dateFromYear() { return new Date(this.now() - ALL_DAYS * DAY_MS).getFullYear(); }

    /**
     * Lee la página del artista y apunta lo que haya nuevo (sin fechas: van aparte, en dates()).
     * Lanza si YouTube Music falla; devuelve null si el artista ya no existe.
     */
    async refresh(id) {
        if (!ARTIST_ID.test(String(id ?? ''))) return null;
        const now = this.now();
        let page;
        try {
            page = await this.ytmusic.releases(id);
        } catch (error) {
            if (this.artists[id]) {
                this.artists[id].failedAt = iso(now);
                this.#save();
            }
            throw error;
        }
        if (!page) return null;
        const old = this.artists[id];
        // Primera vez, o mucho tiempo sin mirarlo: lo que hay no se toma como recién aparecido
        const seeding = !old?.checkedAt || now - Date.parse(old.checkedAt) > GAP_MS;
        const before = new Map((old?.releases ?? []).map(release => [release.key, release]));
        const onPage = new Set();
        const releases = [];
        for (const release of page.releases ?? []) {
            if (!ALBUM_ID.test(release.id ?? '')) continue;
            const key = releaseKey(release);
            if (onPage.has(key)) continue;
            onPage.add(key);
            const prev = before.get(key);
            releases.push(prev
                ? { ...prev, id: release.id, title: release.title, thumb: httpsOrNull(release.thumb) ?? prev.thumb }
                : { key, id: release.id, title: String(release.title ?? '').slice(0, 300), kind: release.kind, year: release.year ?? null, thumb: httpsOrNull(release.thumb), date: null, dateTried: null, seenAt: iso(now), fresh: !seeding });
        }
        // Lo que ya no sale en la página (lo empujan otros más nuevos) se guarda mientras pueda ser novedad
        for (const prev of before.values()) {
            if (!onPage.has(prev.key) && now - Date.parse(prev.seenAt) <= ALL_DAYS * DAY_MS) releases.push(prev);
        }
        // Su foto cuadrada sale de las búsquedas (la de su página es la cabecera, apaisada)
        let thumb = old?.thumb ?? this.ytmusic.knownArtist?.(id)?.thumb ?? null;
        if (!thumb && page.name) {
            await this.ytmusic.searchArtists(page.name).catch(() => []);
            thumb = this.ytmusic.knownArtist?.(id)?.thumb ?? null;
        }
        this.artists[id] = { name: page.name || old?.name || id, thumb, checkedAt: iso(now), failedAt: null, releases };
        this.#save();
        const fresh = releases.filter(release => release.fresh && !before.has(release.key));
        if (fresh.length) this.log(`[novedades] ${this.artists[id].name}: ${fresh.map(release => `«${release.title}»`).join(', ')}`);
        return this.artists[id];
    }

    /** Pone la fecha de salida a lo reciente que aún no la tiene. Devuelve cuántas ha puesto. */
    async dates(id) {
        const entry = this.artists[id];
        if (!entry) return 0;
        const fromYear = this.#dateFromYear();
        let found = 0;
        for (const release of entry.releases) {
            if (release.date || release.dateTried || !(release.year >= fromYear)) continue;
            let date = null;
            try {
                date = await this.ytmusic.releaseDate(release.id);
            } catch (error) {
                this.log(`[novedades] fecha de «${release.title}»: ${String(error?.message ?? error).slice(0, 160)}`);
                continue;                       // se intenta en la próxima vuelta
            }
            release.date = date;
            release.dateTried = date ? null : iso(this.now());
            if (date) found++;
            this.#save();
        }
        return found;
    }

    // Una lectura de un artista: su página y después sus fechas. Si ya se está leyendo, se usa esa misma.
    #job(id) {
        let job = this.reading.get(id);
        if (!job) {
            const page = this.refresh(id);
            const done = page.then(entry => (entry ? this.dates(id) : 0)).then(() => this.artists[id] ?? null)
                .finally(() => this.reading.delete(id));
            // Quien espere solo una de las dos no deja la otra como error sin recoger
            page.catch(() => {});
            done.catch(() => {});
            job = { page, done };
            this.reading.set(id, job);
        }
        return job;
    }

    /** Página + fechas. */
    check(id) { return this.#job(id).done; }

    /** Solo hasta tener la página (las fechas siguen solas). Para «Seguir», que no debe esperar a las fechas. */
    page(id) { return this.#job(id).page; }

    /** ¿Es este disco de alguno de los artistas que se miran? (para quitar el punto al abrirlo) */
    knows(releaseId) {
        return Object.values(this.artists).some(entry => entry.releases?.some(release => release.id === releaseId));
    }

    /**
     * Novedades de unos artistas: lo que salió (o apareció) en los últimos `days` días, lo más nuevo
     * primero. Un lanzamiento de dos artistas seguidos sale una vez.
     * @returns {{release: object, artist: {id, name}, when: string, appeared: boolean}[]}
     */
    novedades(artistIds, { days = NEW_DAYS } = {}) {
        const now = this.now();
        const limit = days * DAY_MS;
        const thisYear = new Date(now).getFullYear();
        const out = new Map();
        for (const id of artistIds) {
            const entry = this.artists[id];
            for (const release of entry?.releases ?? []) {
                if (out.has(release.id)) continue;
                const dateMs = release.date ? Date.parse(`${release.date}T12:00:00Z`) : null;
                let item = null;
                if (dateMs !== null && now - dateMs <= limit) {
                    item = { when: release.date, appeared: false };
                } else if (release.fresh && (release.year ?? 0) >= thisYear - 1 && now - Date.parse(release.seenAt) <= limit) {
                    // Apareció en la vuelta diaria: con fecha vieja es una reedición; sin fecha aún, cuenta desde que apareció
                    item = { when: localDay(Date.parse(release.seenAt)), appeared: dateMs !== null };
                }
                if (item) out.set(release.id, { release, artist: { id, name: entry.name }, ...item });
            }
        }
        return [...out.values()].sort((a, b) => (a.when === b.when ? a.release.title.localeCompare(b.release.title, 'es') : a.when < b.when ? 1 : -1));
    }

    /** Lo último que ha sacado un artista (por fecha si se sabe; si no, por año), o null. */
    latestOf(id) {
        const releases = this.artists[id]?.releases ?? [];
        const sortKey = release => release.date ?? (release.year ? `${release.year}-01-01` : '');
        return releases.reduce((best, release) => (!best || sortKey(release) > sortKey(best) ? release : best), null);
    }

    // ------------------------------------------------------------------ vuelta diaria

    /** Artistas que tocan hoy: seguidos por alguien, sin mirar desde ayer y sin un fallo reciente. */
    due(artistIds) {
        const now = this.now();
        if (new Date(now).getHours() < CHECK_FROM_HOUR) return [];
        const today = localDay(now);
        return [...new Set(artistIds)].filter(id => {
            const entry = this.artists[id];
            if (entry?.failedAt && now - Date.parse(entry.failedAt) < RETRY_MS) return false;
            return !entry?.checkedAt || localDay(Date.parse(entry.checkedAt)) !== today;
        });
    }

    /** Una vuelta: mira, uno detrás de otro, los artistas que tocan. Devuelve { checked, failed, ms }. */
    async round(artistIds) {
        if (this.running) return this.running;
        this.running = (async () => {
            const started = Date.now();
            const due = this.due(artistIds);
            let checked = 0;
            let failed = 0;
            for (const id of due) {
                try {
                    await this.check(id);
                    checked++;
                } catch (error) {
                    failed++;
                    this.log(`[novedades] no se pudo mirar ${this.artists[id]?.name ?? id}: ${String(error?.message ?? error).slice(0, 160)}`);
                }
                if (this.pauseMs) await new Promise(resolve => setTimeout(resolve, this.pauseMs));
            }
            if (due.length) this.log(`[novedades] vuelta diaria: ${checked} artistas mirados, ${failed} con fallo, ${Math.round((Date.now() - started) / 1000)} s`);
            return { checked, failed, ms: Date.now() - started };
        })().finally(() => { this.running = null; });
        return this.running;
    }

    /** Arranca la vuelta diaria. `artistIds()` da los artistas que sigue alguien en ese momento. */
    start(artistIds, { tickMs = TICK_MS, firstMs = 60_000 } = {}) {
        const tick = () => this.round(artistIds()).catch(error => this.log(`[novedades] vuelta: ${String(error?.message ?? error).slice(0, 160)}`));
        this.first = setTimeout(tick, firstMs);
        this.first.unref?.();
        this.timer = setInterval(tick, tickMs);
        this.timer.unref?.();
    }

    stop() {
        clearTimeout(this.first);
        clearInterval(this.timer);
        this.timer = null;
    }
}
