import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, retire, writeJsonAtomic } from './fsutil.js';
import { parseKey } from './sources.js';

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Datos de una canción que manda el cliente: solo campos conocidos, clave válida y carátula https
export function cleanTrack(input) {
    const source = parseKey(input?.key);
    const title = text(input?.title, 300);
    if (!source || !title) return null;
    const thumb = text(input.thumb, 500);
    const duration = Number(input.durationSec);
    return {
        key: source.key,
        platform: source.platform,
        title,
        artist: text(input.artist, 200) || null,
        durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        thumb: thumb.startsWith('https://') ? thumb : null,
    };
}

const FILE = /^l_[a-f0-9]{10}\.json$/;
const ID = /^l_[a-f0-9]{10}$/;
// Una lista en la papelera: «<id>.json.<AAAAMMDD>T<HHMMSS>» (fsutil.retire), con «-2», «-3»… si coincide el segundo
const TRASHED = /^((l_[a-f0-9]{10})\.json)\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-\d+)?$/;
const TRASH_TRACKS = 200;      // canciones quitadas que se enseñan como mucho (las más recientes)

// Listas del usuario: un archivo JSON por lista en data/lists/. Una lista guarda datos de canciones,
// nunca audio, y no repite canción. Lo que se quita va a data/removed/ (papelera), no se borra.
export class ListStore {
    constructor(dataDir, { now = Date.now } = {}) {
        this.dataDir = dataDir;
        this.dir = join(dataDir, 'lists');
        this.now = now;
    }

    #path(id) { return join(this.dir, `${id}.json`); }
    #iso() { return new Date(this.now()).toISOString(); }

    #save(list) {
        list.updatedAt = this.#iso();
        writeJsonAtomic(this.#path(list.id), list);
        return list;
    }

    static summary(list) {
        return {
            id: list.id,
            name: list.name,
            count: list.tracks.length,
            durationSec: list.tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0),
            thumb: list.tracks.find(t => t.thumb)?.thumb ?? null,
            updatedAt: list.updatedAt,
        };
    }

    all() {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir)
            .filter(file => FILE.test(file))
            .map(file => readJson(join(this.dir, file), null))
            .filter(Boolean)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map(ListStore.summary);
    }

    get(id) {
        return ID.test(String(id)) ? readJson(this.#path(id), null) : null;
    }

    create(name) {
        const clean = text(name, 80);
        if (!clean) return null;
        mkdirSync(this.dir, { recursive: true });
        const id = `l_${randomBytes(5).toString('hex')}`;
        return this.#save({ id, name: clean, createdAt: this.#iso(), updatedAt: null, tracks: [] });
    }

    rename(id, name) {
        const list = this.get(id);
        const clean = text(name, 80);
        if (!list || !clean) return null;
        list.name = clean;
        return this.#save(list);
    }

    // A la papelera: data/removed/<id>.json.<fecha>
    remove(id) {
        const list = this.get(id);
        if (!list) return false;
        retire(this.#path(id), this.dataDir);
        return true;
    }

    // Añade canciones al final, saltando las que ya están. Devuelve cuántas entraron.
    addTracks(id, tracks) {
        const list = this.get(id);
        if (!list) return null;
        const present = new Set(list.tracks.map(t => t.key));
        let added = 0;
        for (const track of tracks) {
            if (!track || present.has(track.key)) continue;
            present.add(track.key);
            list.tracks.push({ ...track, addedAt: this.#iso() });
            added++;
        }
        if (added) this.#save(list);
        return { added, list };
    }

    // Quita una canción; queda apuntada en data/removed/tracks.jsonl para poder recuperarla
    removeTrack(id, key) {
        const list = this.get(id);
        const index = list ? list.tracks.findIndex(t => t.key === key) : -1;
        if (index < 0) return null;
        const [track] = list.tracks.splice(index, 1);
        const removed = join(this.dataDir, 'removed');
        mkdirSync(removed, { recursive: true });
        appendFileSync(join(removed, 'tracks.jsonl'), JSON.stringify({ removedAt: this.#iso(), listId: list.id, listName: list.name, index, track }) + '\n');
        return this.#save(list);
    }

    // --- Papelera (Fase 4) ---
    // Lo quitado sigue en removed/: las listas, como archivo «<id>.json.<fecha>»; las canciones, una
    // línea por canción en tracks.jsonl. Restaurar no borra nada de ahí: la lista vuelve a su sitio
    // (se mueve el archivo) y lo restaurado se apunta en restored.jsonl para no volver a enseñarlo.
    #removedDir() { return join(this.dataDir, 'removed'); }

    #lines(name) {
        let text;
        try { text = readFileSync(join(this.#removedDir(), name), 'utf8'); } catch { return []; }
        return text.split('\n').map((line, index) => {
            if (!line) return null;
            try { return { index, value: JSON.parse(line) }; } catch { return null; }
        }).filter(Boolean);
    }

    /** Lo recuperable, lo más reciente primero. */
    trash() {
        const dir = this.#removedDir();
        const lists = [];
        for (const file of existsSync(dir) ? readdirSync(dir) : []) {
            const match = TRASHED.exec(file);
            if (!match) continue;
            const list = readJson(join(dir, file), null);
            if (!list || !Array.isArray(list.tracks)) continue;
            const [, , , y, mo, d, h, mi, s] = match;
            lists.push({ id: file, name: String(list.name ?? 'Lista'), count: list.tracks.length, thumb: list.tracks.find(t => t.thumb)?.thumb ?? null, removedAt: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z` });
        }
        lists.sort((a, b) => b.removedAt.localeCompare(a.removedAt));

        const restored = new Set(this.#lines('restored.jsonl').map(line => line.value.id));
        const alive = new Map(this.all().map(list => [list.id, list.name]));
        const tracks = this.#lines('tracks.jsonl')
            .filter(line => line.value?.track?.key && !restored.has(`t${line.index}`))
            .map(line => ({
                id: `t${line.index}`,
                removedAt: line.value.removedAt ?? null,
                listId: alive.has(line.value.listId) ? line.value.listId : null,      // null = su lista ya no existe
                listName: alive.get(line.value.listId) ?? line.value.listName ?? null,
                track: line.value.track,
            }))
            .reverse()
            .slice(0, TRASH_TRACKS);
        return { lists, tracks };
    }

    /** Devuelve una lista de la papelera a su sitio. */
    restoreList(fileId) {
        const match = TRASHED.exec(String(fileId));
        const from = match ? join(this.#removedDir(), match[0]) : null;
        if (!from || !existsSync(from)) return { error: 'not_found' };
        const to = this.#path(match[2]);
        if (existsSync(to)) return { error: 'already_exists' };
        mkdirSync(this.dir, { recursive: true });
        renameSync(from, to);
        return { list: this.get(match[2]) };
    }

    /** Devuelve una canción quitada a su lista (al final), o a `targetId` si se indica otra. */
    restoreTrack(lineId, targetId = null) {
        const line = this.#lines('tracks.jsonl').find(l => `t${l.index}` === lineId);
        if (!line?.value?.track?.key) return { error: 'not_found' };
        if (this.#lines('restored.jsonl').some(l => l.value.id === lineId)) return { error: 'not_found' };
        const listId = targetId ?? line.value.listId;
        if (!this.get(listId)) return { error: 'list_gone' };
        const { addedAt, ...track } = line.value.track;      // eslint-disable-line no-unused-vars
        const { added, list } = this.addTracks(listId, [track]);
        appendFileSync(join(this.#removedDir(), 'restored.jsonl'), JSON.stringify({ id: lineId, restoredAt: this.#iso(), listId }) + '\n');
        return { added, list };
    }

    moveTrack(id, key, toIndex) {
        const list = this.get(id);
        const from = list ? list.tracks.findIndex(t => t.key === key) : -1;
        if (from < 0 || !Number.isInteger(toIndex)) return null;
        const to = Math.max(0, Math.min(toIndex, list.tracks.length - 1));
        if (to !== from) {
            const [track] = list.tracks.splice(from, 1);
            list.tracks.splice(to, 0, track);
            this.#save(list);
        }
        return list;
    }
}
