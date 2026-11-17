import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const num = (v, def) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);

// Todo se lee en cada acceso, nunca en una constante de módulo: los import de ES se evalúan
// antes de que index.js cargue el .env (lección del bot, 2026-09-18).
export const config = {
    get root() { return ROOT; },
    get version() { return '0.9.0'; },
    get webDir() { return join(ROOT, 'web'); },
    get dataDir() { return process.env.MYMUSIC_DATA || join(ROOT, 'data'); },
    get host() { return process.env.MYMUSIC_HOST || '127.0.0.1'; },
    get port() { return num(process.env.MYMUSIC_PORT, 3100); },
    // Tope de audio en memoria (todas las canciones) y tope por canción, en bytes
    get cacheMaxBytes() { return num(process.env.MYMUSIC_CACHE_MB, 300) * 1024 * 1024; },
    get trackMaxBytes() { return num(process.env.MYMUSIC_TRACK_MAX_MB, 150) * 1024 * 1024; },
    // Cuánto esperar en una canción antes de preparar la siguiente (evita extraer de más al saltar deprisa)
    get prefetchDelayMs() { return num(process.env.MYMUSIC_PREFETCH_DELAY_MS, 8000); },
    get ytdlpPython() { return process.env.YTDLP_PYTHON || (process.platform === 'win32' ? 'py' : 'python3'); },
    get ytdlpJsRuntime() { return process.env.YTDLP_JS_RUNTIME || ''; },
    get ytdlpPlayerClient() { return process.env.YTDLP_PLAYER_CLIENT || ''; },
    get ytdlpCookies() { return process.env.YTDLP_COOKIES || ''; },
    // Solo se usa para reenvolver el audio de SoundCloud (sin recodificar)
    get ffmpegPath() { return process.env.FFMPEG_PATH || 'ffmpeg'; },
    // Nombre de la cuenta del dueño al pasar de la versión de un solo usuario (después se cambia con scripts/users.mjs)
    get ownerName() { return process.env.MYMUSIC_OWNER_NAME || 'admin'; },
    // Cuántas canciones se extraen a la vez como mucho; las demás esperan su turno
    get maxExtractions() { return num(process.env.MYMUSIC_MAX_EXTRACTIONS, 3); },
    // Núcleos que puede usar el servidor, para la cuenta de cuántos oyentes caben (0 = los que vea Node)
    get cores() { return num(process.env.MYMUSIC_CORES, 0); },
};
