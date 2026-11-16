import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from './config.js';
import { Auth } from './auth.js';
import { AudioCache } from './audio.js';
import { createApp } from './app.js';
import { AppDist } from './appdist.js';
import { PendingImports, importers } from './importers.js';
import { ListStore } from './lists.js';
import { MatchStore } from './matches.js';
import { HistoryStore, SessionStore } from './session.js';
import { searchYoutube } from './sources.js';
import { openAudio } from './ytdlp.js';

dotenv.config({ path: join(config.root, '.env') });

const log = message => console.log(`${new Date().toISOString()} ${message}`);

const auth = new Auth(config.dataDir);
const cache = new AudioCache({
    maxBytes: config.cacheMaxBytes,
    trackMaxBytes: config.trackMaxBytes,
    open: openAudio,
    log,
});
const app = createApp({
    auth,
    cache,
    search: searchYoutube,
    open: openAudio,
    lists: new ListStore(config.dataDir),
    sessions: new SessionStore(config.dataDir),
    history: new HistoryStore(config.dataDir),
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
    if (!auth.hasPassword()) log('[mymusic] AVISO: no hay contraseña. Ejecuta: node scripts/set-password.mjs');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        log(`[mymusic] ${signal}: cerrando`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
