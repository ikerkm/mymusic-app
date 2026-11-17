import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter, once } from 'node:events';
import { note, noteRunning } from './usage.js';

// El audio de cada canción vive en memoria RAM mientras se usa (D9 de la SPEC): nada toca el disco.
// Un TrackBuffer se va llenando con lo que manda yt-dlp y sirve cualquier tramo ya recibido,
// lo que permite mover la barra de progreso sin volver a extraer.

// Tipo de contenido por los primeros bytes (no dependemos de lo que diga yt-dlp)
export function sniffMime(head) {
    const ascii = (from, to) => head.toString('latin1', from, to);
    if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'audio/webm';
    if (head.length >= 8 && ascii(4, 8) === 'ftyp') return 'audio/mp4';
    if (head.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
    if (head.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'audio/aac';   // ADTS
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';  // MP3
    if (head.length >= 1 && head[0] === 0x47) return 'video/mp2t';
    return 'application/octet-stream';
}

export class TrackBuffer {
    constructor(key) {
        this.key = key;
        this.chunks = [];
        this.starts = [];        // posición de inicio de cada trozo
        this.size = 0;           // bytes recibidos hasta ahora
        this.total = null;       // tamaño total exacto: el anunciado por yt-dlp o, al terminar, el real
        this.declared = null;
        this.mime = null;
        this.meta = null;
        this.done = false;
        this.error = null;
        this.readers = 0;
        this.lastUsed = Date.now();
        this.ev = new EventEmitter();
        this.ev.setMaxListeners(0);
    }

    #tick() { this.ev.emit('tick'); }
    #wait(signal) { return once(this.ev, 'tick', { signal }); }

    // Tamaño exacto anunciado antes de empezar la descarga
    declare(bytes) {
        if (this.done || !Number.isInteger(bytes) || bytes <= 0) return;
        this.declared = bytes;
        this.total = bytes;
        this.#tick();
    }

    append(chunk) {
        if (this.done || chunk.length === 0) return;
        this.starts.push(this.size);
        this.chunks.push(chunk);
        this.size += chunk.length;
        if (!this.mime && this.size >= 12) this.mime = sniffMime(Buffer.concat(this.chunks).subarray(0, 16));
        this.#tick();
    }

    finish() {
        if (this.done) return;
        if (this.size === 0) return this.fail(new Error('yt-dlp no produjo audio'));
        this.done = true;
        this.total = this.size;
        if (!this.mime) this.mime = sniffMime(Buffer.concat(this.chunks).subarray(0, 16));
        this.#tick();
    }

    fail(error) {
        if (this.done) return;
        this.done = true;
        this.error = error;
        this.#tick();
    }

    // Se resuelve cuando ya se pueden mandar cabeceras: tipo y tamaño total conocidos.
    // Si yt-dlp no anunció el tamaño, espera a tener la canción entera.
    async waitHeader(signal) {
        for (;;) {
            if (this.error) throw this.error;
            if (this.total !== null && this.mime !== null) return;
            await this.#wait(signal);
        }
    }

    // Trozos del tramo [start, end] (ambos incluidos), esperando a los que aún no han llegado
    async *read(start, end, signal) {
        let pos = start;
        let i = 0;
        while (pos <= end) {
            while (i < this.chunks.length && this.starts[i] + this.chunks[i].length <= pos) i++;
            if (i < this.chunks.length) {
                const chunk = this.chunks[i];
                const offset = pos - this.starts[i];
                const take = Math.min(chunk.length - offset, end - pos + 1);
                yield chunk.subarray(offset, offset + take);
                pos += take;
                continue;
            }
            if (this.done) throw this.error ?? new Error('La descarga terminó antes del tamaño anunciado');
            await this.#wait(signal);
        }
    }
}

export class AudioCache {
    /**
     * @param {object} o
     * @param {number} o.maxBytes       tope de memoria para todas las canciones
     * @param {number} o.trackMaxBytes  tope por canción; por encima falla con code 'too_big'
     * @param {(url: string) => {stdout, meta, done, kill}} o.open  fuente de audio (yt-dlp, o un doble en los tests)
     */
    constructor({ maxBytes, trackMaxBytes, open, attempts = 2, maxConcurrent = 3, log = () => {} }) {
        this.maxBytes = maxBytes;
        this.trackMaxBytes = trackMaxBytes;
        this.open = open;
        // Cada extracción ocupa un núcleo unos segundos. Con varios usuarios, las que pasen de este
        // número esperan su turno en vez de arrancar todas a la vez.
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.waiting = [];
        // YouTube rechaza alguna extracción a ratos y la siguiente sale bien (visto en el bot y aquí):
        // si yt-dlp no da audio, se vuelve a intentar antes de dar la canción por fallida.
        this.attempts = attempts;
        this.log = log;
        this.items = new Map();
        // Claves que no se sueltan de la memoria aunque nadie las esté leyendo en este instante:
        // la canción que suena (el reproductor puede reconectar a mitad) y la siguiente, ya preparada.
        this.pinned = new Set();
    }

    get bytes() {
        let sum = 0;
        for (const item of this.items.values()) sum += item.size;
        return sum;
    }

    // Devuelve el buffer de la canción; si no existe (o falló), lanza la extracción
    get(key, url, options = {}) {
        const existing = this.items.get(key);
        if (existing && !existing.error) {
            existing.lastUsed = Date.now();
            return existing;
        }
        const buffer = new TrackBuffer(key);
        this.items.set(key, buffer);
        this.#schedule(buffer, url, options);
        return buffer;
    }

    // Arranca la extracción si hay hueco; si no, la deja en cola. El hueco se libera cuando la
    // canción termina, bien o mal, con sus reintentos incluidos.
    #schedule(buffer, url, options) {
        // La extracción se apunta a quien la pidió, también si le toca esperar turno y arranca más
        // tarde, desde el trabajo de otro: por eso se ata aquí al contexto de quien la encarga.
        const start = AsyncLocalStorage.bind(() => {
            this.running++;
            noteRunning(this.running, this.waiting.length);
            const release = () => {
                if (!buffer.done) return;
                buffer.ev.off('tick', release);
                this.running--;
                this.waiting.shift()?.();
            };
            buffer.ev.on('tick', release);
            this.#fill(buffer, url, options);
            release();          // por si ha fallado en el acto
        });
        if (this.running < this.maxConcurrent) return start();
        this.waiting.push(start);
        noteRunning(this.running, this.waiting.length);
    }

    #drop(buffer) {
        if (this.items.get(buffer.key) === buffer) this.items.delete(buffer.key);
    }

    #fill(buffer, url, options = {}, attempt = 1) {
        const started = Date.now();
        let source;
        try {
            source = this.open(url, options);
        } catch (error) {
            buffer.fail(error);
            this.#drop(buffer);
            return;
        }
        const tooBig = () => {
            const error = new Error('Pista demasiado grande para servirla desde memoria');
            error.code = 'too_big';
            source.kill();
            buffer.fail(error);
            this.#drop(buffer);
        };

        source.meta.then(meta => {
            buffer.meta = meta;
            if (!Number.isInteger(meta?.filesize)) return;
            if (meta.filesize > this.trackMaxBytes) return tooBig();
            buffer.declare(meta.filesize);
        }).catch(() => {});

        source.stdout.on('data', chunk => {
            if (buffer.size === 0) this.log(`[audio] ${buffer.key}: primer byte a los ${((Date.now() - started) / 1000).toFixed(1)} s`);
            buffer.append(chunk);
            if (buffer.size > this.trackMaxBytes) tooBig();
        });
        source.stdout.on('error', () => {});

        source.done.then(({ code, stderr }) => {
            if (buffer.done) return;
            if (buffer.size === 0) {
                const reason = String(stderr).split('\n').filter(Boolean).pop()?.slice(0, 200) ?? 'sin mensaje';
                const after = `a los ${((Date.now() - started) / 1000).toFixed(1)} s (código ${code})`;
                if (attempt < this.attempts) {
                    // Quien esté esperando esta canción sigue esperando: no se entera del primer fallo
                    this.log(`[audio] ${buffer.key}: intento ${attempt} fallido ${after}: ${reason} — se reintenta`);
                    note({ extractMs: Date.now() - started });      // el tiempo del intento fallido también ocupó un turno
                    return this.#fill(buffer, url, options, attempt + 1);
                }
                const error = new Error(stderr || 'yt-dlp no produjo audio');
                error.code = 'extract_failed';
                buffer.fail(error);
                this.#drop(buffer);
                this.log(`[audio] ${buffer.key}: FALLÓ ${after}: ${reason}`);
                note({ extractFails: 1, extractMs: Date.now() - started });
            } else if (code !== 0 && buffer.declared !== null && buffer.size < buffer.declared) {
                buffer.fail(new Error('La descarga se cortó a medias'));
                this.#drop(buffer);
                this.log(`[audio] ${buffer.key}: descarga cortada a medias (${buffer.size} de ${buffer.declared} bytes, código ${code})`);
                note({ extractFails: 1, extractBytes: buffer.size, extractMs: Date.now() - started });
            } else {
                buffer.finish();
                this.log(`[audio] ${buffer.key}: completa, ${(buffer.size / 1048576).toFixed(1)} MB en ${((Date.now() - started) / 1000).toFixed(1)} s`);
                note({ extractions: 1, extractBytes: buffer.size, extractMs: Date.now() - started });
            }
            this.evict();
        });
    }

    // Suelta de la memoria las canciones completas que nadie está leyendo, de la más antigua a la más reciente
    evict() {
        let total = this.bytes;
        if (total <= this.maxBytes) return;
        const idle = [...this.items.values()]
            .filter(item => item.done && item.readers === 0 && !this.pinned.has(item.key))
            .sort((a, b) => a.lastUsed - b.lastUsed);
        for (const item of idle) {
            if (total <= this.maxBytes) break;
            this.items.delete(item.key);
            total -= item.size;
        }
    }
}
