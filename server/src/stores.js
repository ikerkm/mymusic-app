import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ListStore } from './lists.js';
import { RadioMemory } from './radio.js';
import { HistoryStore, SessionStore } from './session.js';

// Lo de cada usuario vive en su carpeta, data/users/<id>/: sus listas, su sesión de escucha, su
// historial y su papelera. Entre usuarios no se comparte nada de eso. Sí son comunes la memoria de
// audio y las coincidencias de Spotify.

const USER_ID = /^u_[a-f0-9]{10}$/;

export class UserStores {
    constructor(dataDir, { now = Date.now } = {}) {
        this.dataDir = dataDir;
        this.now = now;
        this.cache = new Map();
    }

    dir(userId) {
        if (!USER_ID.test(String(userId))) throw new Error('Identificador de usuario no válido');
        return join(this.dataDir, 'users', userId);
    }

    /** Almacenes de un usuario: { lists, sessions, history, radio }. */
    for(userId) {
        let stores = this.cache.get(userId);
        if (!stores) {
            const dir = this.dir(userId);
            mkdirSync(dir, { recursive: true });
            stores = {
                lists: new ListStore(dir, { now: this.now }),
                sessions: new SessionStore(dir, { now: this.now }),
                history: new HistoryStore(dir, { now: this.now }),
                radio: new RadioMemory(dir, { now: this.now }),
            };
            this.cache.set(userId, stores);
        }
        return stores;
    }

    /** Los almacenes ya abiertos (usuarios que han hecho algo desde que arrancó el servidor). */
    loaded() { return [...this.cache.values()]; }

    /**
     * Paso de «un solo usuario» a «varios»: las listas, la sesión y el historial que había en la raíz
     * de data/ pasan a ser del dueño. Solo se mueven (no se copia ni se borra nada) y solo si el
     * dueño aún no tiene nada propio con ese nombre. Devuelve lo que ha movido.
     */
    adoptLegacy(ownerId) {
        const target = this.dir(ownerId);
        const legacy = ['lists', 'session.json', 'session-state.json'];
        if (existsSync(this.dataDir)) legacy.push(...readdirSync(this.dataDir).filter(name => /^history-\d{4}\.jsonl$/.test(name)));
        const moved = [];
        for (const name of legacy) {
            const from = join(this.dataDir, name);
            const to = join(target, name);
            if (!existsSync(from) || existsSync(to)) continue;
            mkdirSync(target, { recursive: true });
            renameSync(from, to);
            moved.push(name);
        }
        if (moved.length) this.cache.delete(ownerId);
        return moved;
    }
}
