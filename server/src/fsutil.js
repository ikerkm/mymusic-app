import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Regla del proyecto: jamás borrar ni sobrescribir un original.
// - Escribir = archivo .tmp + renombrado atómico.
// - Quitar = mover a removed/ con la fecha en el nombre.

export function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

export function writeJsonAtomic(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');

// Mueve `path` a `<baseDir>/removed/<nombre>.<fecha>`. Devuelve la ruta nueva, o null si no existía.
export function retire(path, baseDir) {
    if (!existsSync(path)) return null;
    const removed = join(baseDir, 'removed');
    mkdirSync(removed, { recursive: true });
    let target = join(removed, `${basename(path)}.${stamp()}`);
    for (let n = 2; existsSync(target); n++) target = join(removed, `${basename(path)}.${stamp()}-${n}`);
    renameSync(path, target);
    return target;
}

export function mtimeMs(path) {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}
