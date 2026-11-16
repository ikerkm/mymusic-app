import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.js';

// Deja en la carpeta de datos del servidor de prueba un «instalable» publicado
function publish(dir, { versionCode = 7, versionName = '0.7.0', file = `mymusic-${versionCode}.apk`, bytes = Buffer.from('PK instalable de mentira') } = {}) {
    mkdirSync(join(dir, 'app'), { recursive: true });
    if (bytes) writeFileSync(join(dir, 'app', file), bytes);
    const sha256 = createHash('sha256').update(bytes ?? '').digest('hex');
    writeFileSync(join(dir, 'app', 'latest.json'), JSON.stringify({ versionCode, versionName, file, sha256, notes: 'Novedades' }));
    return { bytes, sha256 };
}

test('app: sin nada publicado responde 404', async () => {
    const s = await startServer();
    try {
        assert.equal((await s.call('GET', '/api/app/latest')).status, 404);
        assert.equal((await s.api('/api/app/download', { token: s.token })).status, 404);
    } finally { await s.close(); }
});

test('app: informa de la versión vigente y la entrega tal cual', async () => {
    const s = await startServer();
    try {
        const { bytes, sha256 } = publish(s.dir);
        const latest = await s.call('GET', '/api/app/latest');
        assert.equal(latest.status, 200);
        assert.deepEqual(
            [latest.body.versionCode, latest.body.versionName, latest.body.sha256, latest.body.size, latest.body.notes],
            [7, '0.7.0', sha256, bytes.length, 'Novedades'],
        );
        assert.equal(latest.body.path, undefined, 'la ruta en disco no sale del servidor');
        const res = await s.api('/api/app/download', { token: s.token });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    } finally { await s.close(); }
});

test('app: exige token y no sirve archivos con otro nombre', async () => {
    const s = await startServer();
    try {
        publish(s.dir);
        assert.equal((await s.api('/api/app/latest')).status, 401);
        assert.equal((await s.api('/api/app/download')).status, 401);
        publish(s.dir, { file: '../auth.json', bytes: null });
        assert.equal((await s.call('GET', '/api/app/latest')).status, 404, 'un latest.json que apunta fuera no vale');
        publish(s.dir, { versionCode: 9, bytes: null });
        assert.equal((await s.call('GET', '/api/app/latest')).status, 404, 'si falta el archivo, no se anuncia');
    } finally { await s.close(); }
});
