import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mtimeMs, readJson, retire, writeJsonAtomic } from './fsutil.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const newId = prefix => `${prefix}_${randomBytes(5).toString('hex')}`;

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX_PER_IP = 5;
const FAIL_MAX_GLOBAL = 40;

// Nombre de usuario: de 2 a 30 letras, números, punto, guion o guion bajo. Sin distinguir mayúsculas.
export const COOKIE = 'mm_session';

/** El token que trae la cookie del panel web, o null. */
export function cookieToken(req) {
    const match = /(?:^|;\s*)mm_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return match ? decodeURIComponent(match[1]) : null;
}

/** Cabecera Set-Cookie de la sesión del panel web. Sin token, la borra. */
export function sessionCookie(req, token) {
    const local = ['localhost', '127.0.0.1'].includes(req.hostname);      // en pruebas no hay HTTPS
    const parts = [`${COOKIE}=${token ? encodeURIComponent(token) : ''}`, 'Path=/api', 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? 365 * 24 * 3600 : 0}`];
    if (!local) parts.push('Secure');
    return parts.join('; ');
}

const NAME = /^[\p{L}\p{N}_.-]{2,30}$/u;
const nameKey = name => String(name ?? '').trim().toLocaleLowerCase('es');

const hashPassword = password => {
    const salt = randomBytes(16).toString('hex');
    return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
};

const samePassword = (user, password) => {
    if (!user?.hash || typeof password !== 'string') return false;
    const given = scryptSync(password, user.salt, 64);
    const ref = Buffer.from(user.hash, 'hex');
    return given.length === ref.length && timingSafeEqual(given, ref);
};

/**
 * Cuentas y sesiones de dispositivo.
 * - data/users.json: los usuarios (de cada contraseña solo se guarda su hash scrypt). El primero es el dueño (admin).
 * - data/tokens.json: un token de larga duración por dispositivo (solo su sha256), ligado a un usuario.
 * Cada usuario tiene sus listas, su sesión de escucha y su historial (stores.js); aquí solo va quién es quién.
 */
export class Auth {
    /**
     * @param {string} dataDir
     * @param {object} o
     * @param {string} o.ownerName  nombre que recibe el dueño al pasar de la versión de un solo usuario
     */
    constructor(dataDir, { now = Date.now, ownerName = 'admin' } = {}) {
        this.dir = dataDir;
        this.now = now;
        this.fails = new Map();          // ip -> [marcas de tiempo de intentos fallidos]
        this.cache = new Map();          // ruta -> { mtime, value }
        this.#migrate(ownerName);
    }

    get usersPath() { return join(this.dir, 'users.json'); }
    get tokensPath() { return join(this.dir, 'tokens.json'); }
    #iso() { return new Date(this.now()).toISOString(); }

    // Lee del disco solo si el archivo cambió (los scripts de administración corren en otro proceso)
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

    // De la versión de un solo usuario (auth.json) a varias cuentas: aquella contraseña pasa a ser la
    // del dueño y sus sesiones abiertas siguen valiendo. auth.json queda en removed/.
    #migrate(ownerName) {
        const legacy = join(this.dir, 'auth.json');
        if (existsSync(this.usersPath) || !existsSync(legacy)) return;
        const old = readJson(legacy, null);
        if (!old?.hash) return;
        const owner = { id: newId('u'), name: ownerName, salt: old.salt, hash: old.hash, admin: true, createdAt: this.#iso(), passwordAt: old.updatedAt ?? this.#iso() };
        this.#save(this.usersPath, [owner]);
        const tokens = readJson(this.tokensPath, []);
        if (tokens.length) this.#save(this.tokensPath, tokens.map(token => ({ userId: owner.id, ...token })));
        retire(legacy, this.dir);
    }

    // --- Usuarios ---

    #users() { return this.#load(this.usersPath, []); }
    static publicUser(user) { return user ? { id: user.id, name: user.name, admin: Boolean(user.admin) } : null; }

    users() { return this.#users().map(Auth.publicUser); }
    hasUsers() { return this.#users().length > 0; }
    owner() { return Auth.publicUser(this.#users().find(user => user.admin) ?? this.#users()[0]); }
    getUser(id) { return Auth.publicUser(this.#users().find(user => user.id === id)); }
    findUser(name) { return Auth.publicUser(this.#users().find(user => nameKey(user.name) === nameKey(name))); }

    static checkName(name) {
        if (!NAME.test(String(name ?? '').trim())) throw new Error('El nombre de usuario lleva de 2 a 30 letras o números (también vale punto, guion y guion bajo)');
    }

    static checkPassword(password) {
        if (typeof password !== 'string' || password.length < 8) throw new Error('La contraseña necesita al menos 8 caracteres');
    }

    /** Da de alta un usuario. El primero que se crea es el dueño (admin). */
    createUser(name, password, { admin = false } = {}) {
        Auth.checkName(name);
        Auth.checkPassword(password);
        if (this.findUser(name)) throw new Error(`Ya existe el usuario «${String(name).trim()}»`);
        const users = [...this.#users()];
        const user = { id: newId('u'), name: String(name).trim(), ...hashPassword(password), admin: admin || users.length === 0, createdAt: this.#iso(), passwordAt: this.#iso() };
        users.push(user);
        this.#save(this.usersPath, users);
        return Auth.publicUser(user);
    }

    renameUser(id, name) {
        Auth.checkName(name);
        const other = this.findUser(name);
        if (other && other.id !== id) throw new Error(`Ya existe el usuario «${String(name).trim()}»`);
        const users = this.#users().map(user => (user.id === id ? { ...user, name: String(name).trim() } : user));
        if (!users.some(user => user.id === id)) return null;
        this.#save(this.usersPath, users);
        return this.getUser(id);
    }

    /**
     * Cambia la contraseña de un usuario. Sus otras sesiones dejan de valer; `keepToken` (el token del
     * dispositivo desde el que la cambia) se conserva para que no tenga que volver a entrar ahí.
     */
    setPassword(userId, password, { keepToken = null } = {}) {
        Auth.checkPassword(password);
        if (!this.getUser(userId)) return false;
        const users = this.#users().map(user => (user.id === userId ? { ...user, ...hashPassword(password), passwordAt: this.#iso() } : user));
        const keep = keepToken ? sha(keepToken) : null;
        const tokens = this.#load(this.tokensPath, []);
        const rest = tokens.filter(token => token.userId !== userId || token.hash === keep);
        retire(this.usersPath, this.dir);
        if (rest.length !== tokens.length) retire(this.tokensPath, this.dir);
        this.cache.clear();
        this.#save(this.usersPath, users);
        if (rest.length !== tokens.length) this.#save(this.tokensPath, rest);
        return true;
    }

    /**
     * Comprueba usuario y contraseña. Sin nombre se entiende el dueño: las versiones de la app
     * anteriores a las cuentas solo mandan la contraseña.
     */
    checkLogin(name, password) {
        const users = this.#users();
        const wanted = String(name ?? '').trim();
        const user = wanted ? users.find(u => nameKey(u.name) === nameKey(wanted)) : users.find(u => u.admin) ?? users[0];
        return samePassword(user, password) ? Auth.publicUser(user) : null;
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

    issueToken(userId, device) {
        const token = randomBytes(32).toString('base64url');
        const list = [...this.#load(this.tokensPath, [])];
        list.push({
            id: randomBytes(6).toString('hex'),
            userId,
            device: String(device ?? '').trim().slice(0, 60) || 'dispositivo',
            hash: sha(token),
            createdAt: this.#iso(),
        });
        this.#save(this.tokensPath, list);
        return token;
    }

    /** Datos del dispositivo (con su usuario) al que pertenece un token, o null. */
    verify(token) {
        if (typeof token !== 'string' || token.length < 20) return null;
        const hash = sha(token);
        const entry = this.#load(this.tokensPath, []).find(t => t.hash === hash);
        const user = entry && this.getUser(entry.userId);
        return user ? { ...entry, user } : null;
    }

    /** ¿Sigue existiendo ese dispositivo (por el id de su token) y es de ese usuario? */
    hasDevice(userId, deviceId) {
        return this.#load(this.tokensPath, []).some(token => token.id === deviceId && token.userId === userId);
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

    // Middleware de Express: exige «Authorization: Bearer <token>» y deja en la petición quién es
    /** Nombre con el que entró un dispositivo de ese usuario («Xiaomi POCOPHONE F1»), o null. */
    deviceName(userId, deviceId) {
        const entry = this.#load(this.tokensPath, []).find(token => token.id === deviceId && token.userId === userId);
        return entry?.device ?? null;
    }

    // La app manda su token en la cabecera Authorization. El panel web lo lleva en una cookie que
    // el JavaScript de la página no puede leer; con ella, todo lo que no sea leer tiene que traer
    // además la cabecera X-MyMusic, que una página ajena no puede poner.
    middleware() {
        return (req, res, next) => {
            const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
            const token = bearer ? bearer[1] : cookieToken(req);
            const device = token && this.verify(token);
            if (!device) return res.status(401).json({ error: 'unauthorized' });
            if (!bearer && !['GET', 'HEAD'].includes(req.method) && req.headers['x-mymusic'] !== 'web') {
                return res.status(403).json({ error: 'forbidden' });
            }
            req.token = token;
            req.viaCookie = !bearer;
            req.device = device;
            req.user = device.user;
            next();
        };
    }
}
