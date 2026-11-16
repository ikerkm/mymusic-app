import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from './config.js';
import { Auth } from './auth.js';
import { AudioCache } from './audio.js';
import { createApp } from './app.js';
import { AppDist } from './appdist.js';
import { PendingImports, importers } from './importers.js';
import { MatchStore } from './matches.js';
import { searchYoutube } from './sources.js';
import { UserStores } from './stores.js';
import { openAudio } from './ytdlp.js';

dotenv.config({ path: join(config.root, '.env') });

const log = message => console.log(`${new Date().toISOString()} ${message}`);

// Al pasar de la versión de un solo usuario, la contraseña que había se convierte en la cuenta del
// dueño (MYMUSIC_OWNER_NAME) y sus listas, sesión e historial pasan a su carpeta.
const auth = new Auth(config.dataDir, { ownerName: config.ownerName });
const stores = new UserStores(config.dataDir);
const owner = auth.owner();
if (owner) {
    const moved = stores.adoptLegacy(owner.id);
    if (moved.length) log(`[mymusic] datos de la versión de un solo usuario asignados a «${owner.name}»: ${moved.join(', ')}`);
}

const cache = new AudioCache({
    maxBytes: config.cacheMaxBytes,
    trackMaxBytes: config.trackMaxBytes,
    maxConcurrent: config.maxExtractions,
    open: openAudio,
    log,
});
const app = createApp({
    auth,
    cache,
    search: searchYoutube,
    open: openAudio,
    stores,
    appDist: new AppDist(config.dataDir),
    matches: new MatchStore(config.dataDir, { search: searchYoutube, log }),
    importers,
    pending: new PendingImports(),
    prefetchDelayMs: config.prefetchDelayMs,
    version: config.version,
    log,
});

const server = app.listen(config.port, config.host, () => {
    log(`[mymusic] servidor ${config.version} en http://${config.host}:${config.port}`);
    const users = auth.users();
    if (users.length === 0) log('[mymusic] AVISO: no hay ningún usuario. Crea el primero: node scripts/users.mjs add <nombre>');
    else log(`[mymusic] usuarios: ${users.map(user => user.name + (user.admin ? ' (dueño)' : '')).join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        log(`[mymusic] ${signal}: cerrando`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
