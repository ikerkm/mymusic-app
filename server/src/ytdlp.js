import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { config } from './config.js';
import { trackChild } from './usage.js';

// Punto de partida: utils/ytdlpWrapper.js del bot de Discord (commit a2a4e99). Copia independiente.
// Diferencias: no pasa por ffmpeg (el móvil reproduce el formato original) y pide a yt-dlp que
// anuncie el tamaño exacto del archivo antes de empezar a mandar el audio.

const META_TAG = 'MM_META';
// Opus en WebM si lo hay (lo normal en YouTube), si no AAC en M4A, si no lo que haya
const FORMAT = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best';

export function commonArgs() {
    const args = [];
    // Por defecto yt-dlp elige los clientes de YouTube: los fijados a mano se queman con el tiempo
    if (config.ytdlpPlayerClient) args.push('--extractor-args', `youtube:player_client=${config.ytdlpPlayerClient}`);
    // Runtime JS para los retos anti-bot, formato RUNTIME[:RUTA] (en el Flip: "node")
    if (config.ytdlpJsRuntime) args.push('--js-runtimes', config.ytdlpJsRuntime);
    if (config.ytdlpCookies) args.push('--cookies', config.ytdlpCookies);
    return args;
}

/**
 * Lanza yt-dlp para una URL y devuelve su salida de audio en bruto.
 * @returns {{ stdout: import('stream').Readable, meta: Promise<object|null>, done: Promise<{code:number|null, stderr:string}>, kill: () => void }}
 *   - meta: datos del formato elegido (ext, filesize exacto si se conoce…), o null si yt-dlp no los dio.
 *   - done: se resuelve cuando el proceso ha terminado y ya no llegarán más datos.
 */
export function openAudio(url, { aacToAdts = false } = {}) {
    const args = [
        '-m', 'yt_dlp',
        '-f', FORMAT,
        '--no-playlist',
        '--no-warnings',
        // Con «-o -» lo impreso sale por stderr, así que no se mezcla con el audio (comprobado en el Flip)
        '--print', `before_dl:${META_TAG} %(.{ext,filesize,duration,acodec,abr,format_id,protocol})j`,
        '--no-simulate',
        '-o', '-',
        ...commonArgs(),
        url,
    ];
    const child = spawn(config.ytdlpPython, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(child);       // su tiempo de procesador se apunta a quien pidió la canción

    let stderr = '';
    let resolveMeta;
    const meta = new Promise(resolve => { resolveMeta = resolve; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {
        stderr += text;
        const match = new RegExp(`${META_TAG} (\\{.*\\})\\s*$`, 'm').exec(stderr);
        if (match) {
            try { resolveMeta(JSON.parse(match[1])); } catch { /* línea a medias: llegará entera en el siguiente trozo */ }
        }
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });

    const done = new Promise(resolve => {
        child.on('error', error => {
            resolveMeta(null);
            resolve({ code: -1, stderr: `No se pudo lanzar yt-dlp: ${error.message}` });
        });
        // «close» llega cuando el proceso ha salido Y sus tuberías están cerradas: no quedan datos por leer
        child.on('close', code => {
            resolveMeta(null);
            resolve({ code, stderr: stderr.replace(new RegExp(`^${META_TAG} .*$`, 'm'), '').trim() });
        });
    });

    if (!aacToAdts) {
        return {
            stdout: child.stdout,
            meta,
            done,
            // SIGKILL: un proceso bloqueado escribiendo no atiende a SIGTERM (lección del bot, 2026-11-14)
            kill: () => { if (child.exitCode === null) child.kill('SIGKILL'); },
        };
    }

    // SoundCloud entrega AAC troceado (HLS); unido tal cual es un MP4 fragmentado sin índice, en el
    // que no se puede saltar. Se le cambia solo el envoltorio, a ADTS, con ffmpeg (sin recodificar:
    // casi no gasta CPU). Si la canción viniera en otro códec (MP3, Opus), pasa tal cual.
    const out = new PassThrough();
    let ffmpeg = null;
    child.stdout.pause();                       // nada sale hasta saber qué códec trae
    meta.then(info => {
        if (!String(info?.acodec ?? '').startsWith('mp4a')) return child.stdout.pipe(out);
        ffmpeg = spawn(config.ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'copy', '-f', 'adts', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        trackChild(ffmpeg);
        ffmpeg.on('error', () => out.destroy());
        ffmpeg.stdin.on('error', () => {});     // si ffmpeg muere antes, yt-dlp recibe EPIPE: no es un fallo aparte
        child.stdout.pipe(ffmpeg.stdin);
        ffmpeg.stdout.pipe(out);
    });
    const drained = new Promise(resolve => out.once('end', resolve).once('close', resolve));
    return {
        stdout: out,
        meta: meta.then(info => (info ? { ...info, filesize: undefined } : info)),       // el tamaño cambia al reenvolver
        done: Promise.all([done, drained]).then(([result]) => result),
        kill: () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
            out.destroy();
        },
    };
}

/**
 * Datos de una dirección (una canción, o una lista con los datos completos de sus canciones) sin descargar audio.
 * Se usa para SoundCloud, donde la lectura «rápida» de una lista no trae ni títulos.
 */
export function fetchInfo(url, { playlist = false, limit = 100 } = {}) {
    return new Promise((resolve, reject) => {
        const args = [
            '-m', 'yt_dlp',
            '--dump-single-json',
            ...(playlist ? ['--yes-playlist', '--playlist-end', String(limit)] : ['--no-playlist']),
            '--no-warnings',
            ...commonArgs(),
            url,
        ];
        const child = spawn(config.ytdlpPython, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        trackChild(child);
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8').on('data', text => { out += text; });
        child.stderr.setEncoding('utf8').on('data', text => { err = (err + text).slice(-4000); });
        child.on('error', error => reject(new Error(`No se pudo lanzar yt-dlp: ${error.message}`)));
        child.on('close', () => {
            try {
                resolve(JSON.parse(out));
            } catch {
                reject(new Error(explain(err)));
            }
        });
    });
}

/**
 * Lee una playlist sin extraer el audio de sus vídeos (solo sus datos), como hace el bot.
 * @returns {Promise<{title: string, entries: {id: string, title: string, duration: number|null, uploader: string|null}[]}>}
 */
export function fetchPlaylist(url, { limit = 2000 } = {}) {
    return new Promise((resolve, reject) => {
        const args = [
            '-m', 'yt_dlp',
            '--dump-single-json',
            '--yes-playlist',
            '--flat-playlist',
            '--playlist-end', String(limit),
            '--no-warnings',
            ...commonArgs(),
            url,
        ];
        const child = spawn(config.ytdlpPython, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        trackChild(child);
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8').on('data', text => { out += text; });
        child.stderr.setEncoding('utf8').on('data', text => { err = (err + text).slice(-4000); });
        child.on('error', error => reject(new Error(`No se pudo lanzar yt-dlp: ${error.message}`)));
        child.on('close', () => {
            // Se intenta leer aunque haya errores parciales (vídeos privados o retirados dentro de la lista)
            try {
                const info = JSON.parse(out);
                const entries = (info.entries ?? []).filter(Boolean).map(entry => ({
                    id: String(entry.id ?? ''),
                    title: String(entry.title ?? ''),
                    duration: Number.isFinite(entry.duration) ? entry.duration : null,
                    uploader: entry.uploader ?? entry.channel ?? null,
                }));
                resolve({ title: String(info.title ?? 'Lista'), entries });
            } catch {
                reject(new Error(explain(err)));
            }
        });
    });
}

// Mensaje llano a partir del stderr de yt-dlp
export function explain(stderr) {
    const text = String(stderr ?? '');
    if (/Sign in to confirm/i.test(text)) return 'YouTube pide confirmar que no eres un bot';
    if (/Video unavailable|Private video|removed/i.test(text)) return 'El vídeo no está disponible';
    if (/No se pudo lanzar/.test(text)) return text;
    const last = text.split('\n').map(l => l.trim()).filter(Boolean).pop();
    return last ? last.slice(0, 300) : 'yt-dlp no produjo audio';
}
