import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
