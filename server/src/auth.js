import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { mtimeMs, readJson, retire, writeJsonAtomic } from './fsutil.js';

const sha = text => createHash('sha256').update(text).digest('hex');

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX_PER_IP = 5;
const FAIL_MAX_GLOBAL = 40;

// Login propio de un solo usuario: una contraseña (se guarda solo su hash scrypt) y un token
// de larga duración por dispositivo (se guarda solo su sha256).
export class Auth {
    constructor(dataDir, { now = Date.now } = {}) {
        this.dir = dataDir;
        this.now = now;
        this.fails = new Map();          // ip -> [marcas de tiempo de intentos fallidos]
        this.cache = new Map();          // ruta -> { mtime, value }
    }

    get authPath() { return join(this.dir, 'auth.json'); }
    get tokensPath() { return join(this.dir, 'tokens.json'); }

    // Lee del disco solo si el archivo cambió (el script de contraseña corre en otro proceso)
    #load(path, fallback) {
        const mtime = mtimeMs(path);
        const hit = this.cache.get(path);
        if (hit && hit.mtime === mtime) return hit.value;
        const value = readJson(path, fallback);
        this.cache.set(path, { mtime, value });
        return value;
    }

    #save(path, value) {
        writeJsonAtomic(path, value);
        this.cache.delete(path);
    }

    hasPassword() {
        return Boolean(this.#load(this.authPath, null)?.hash);
    }

    // Contraseña nueva = las sesiones anteriores dejan de valer (auth.json y tokens.json van a removed/)
    setPassword(password) {
        if (typeof password !== 'string' || password.length < 8) {
            throw new Error('La contraseña necesita al menos 8 caracteres');
        }
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(password, salt, 64).toString('hex');
        retire(this.authPath, this.dir);
        retire(this.tokensPath, this.dir);
        this.cache.clear();
        this.#save(this.authPath, { salt, hash, updatedAt: new Date(this.now()).toISOString() });
    }

    checkPassword(password) {
        const stored = this.#load(this.authPath, null);
        if (!stored?.hash || typeof password !== 'string') return false;
        const given = scryptSync(password, stored.salt, 64);
        const ref = Buffer.from(stored.hash, 'hex');
        return given.length === ref.length && timingSafeEqual(given, ref);
    }

    // --- Límite de intentos de login (en memoria) ---

    #recent(key) {
        const since = this.now() - FAIL_WINDOW_MS;
        const list = (this.fails.get(key) ?? []).filter(t => t > since);
        this.fails.set(key, list);
        return list;
    }

    blocked(ip) {
        return this.#recent(ip).length >= FAIL_MAX_PER_IP || this.#recent('*').length >= FAIL_MAX_GLOBAL;
    }

    noteFail(ip) {
        this.#recent(ip).push(this.now());
        this.#recent('*').push(this.now());
    }

    // --- Tokens por dispositivo ---

    issueToken(device) {
        const token = randomBytes(32).toString('base64url');
        const list = [...this.#load(this.tokensPath, [])];
        list.push({
            id: randomBytes(6).toString('hex'),
            device: String(device ?? '').trim().slice(0, 60) || 'dispositivo',
            hash: sha(token),
            createdAt: new Date(this.now()).toISOString(),
        });
        this.#save(this.tokensPath, list);
        return token;
    }

    verify(token) {
        if (typeof token !== 'string' || token.length < 20) return null;
        const hash = sha(token);
        return this.#load(this.tokensPath, []).find(t => t.hash === hash) ?? null;
    }

    // Cerrar sesión: el token sale de la lista (queda copia de la lista anterior en removed/)
    revoke(token) {
        const hash = sha(String(token ?? ''));
        const list = this.#load(this.tokensPath, []);
        if (!list.some(t => t.hash === hash)) return false;
        const rest = list.filter(t => t.hash !== hash);
        retire(this.tokensPath, this.dir);
        this.cache.clear();
        this.#save(this.tokensPath, rest);
        return true;
    }

    // Middleware de Express: exige «Authorization: Bearer <token>»
    middleware() {
        return (req, res, next) => {
            const match = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
            const device = match && this.verify(match[1]);
            if (!device) return res.status(401).json({ error: 'unauthorized' });
            req.token = match[1];
            req.device = device;
            next();
        };
    }
}
