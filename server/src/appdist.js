import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './fsutil.js';

// La app se actualiza desde el propio servidor: en data/app/ están los instalables publicados
// (mymusic-<versionCode>.apk) y latest.json, que dice cuál es el vigente. Los deja ahí el script
// android/scripts/publicar-app.sh; el servidor solo los lee, así que publicar no exige reiniciarlo.

const FILE = /^mymusic-\d+\.apk$/;

export class AppDist {
    constructor(dataDir) {
        this.dir = join(dataDir, 'app');
    }

    /** Datos del instalable vigente (con su ruta en disco), o null si no hay ninguno publicado. */
    latest() {
        const info = readJson(join(this.dir, 'latest.json'), null);
        if (!info || !Number.isInteger(info.versionCode) || !FILE.test(String(info.file))) return null;
        const path = join(this.dir, info.file);
        let size;
        try {
            size = statSync(path).size;
        } catch {
            return null;
        }
        return {
            versionCode: info.versionCode,
            versionName: String(info.versionName ?? ''),
            sha256: String(info.sha256 ?? ''),
            size,
            publishedAt: info.publishedAt ?? null,
            notes: info.notes ? String(info.notes) : null,
            path,
        };
    }
}
