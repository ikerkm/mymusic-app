import { EventEmitter, once } from 'node:events';

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
    constructor({ maxBytes, trackMaxBytes, open, log = () => {} }) {
        this.maxBytes = maxBytes;
        this.trackMaxBytes = trackMaxBytes;
        this.open = open;
        this.log = log;
        this.items = new Map();
    }

    get bytes() {
        let sum = 0;
        for (const item of this.items.values()) sum += item.size;
        return sum;
    }

    // Devuelve el buffer de la canción; si no existe (o falló), lanza la extracción
    get(key, url) {
        const existing = this.items.get(key);
        if (existing && !existing.error) {
            existing.lastUsed = Date.now();
            return existing;
        }
        const buffer = new TrackBuffer(key);
        this.items.set(key, buffer);
        this.#fill(buffer, url);
        return buffer;
    }

    #drop(buffer) {
        if (this.items.get(buffer.key) === buffer) this.items.delete(buffer.key);
    }

    #fill(buffer, url) {
        const started = Date.now();
        let source;
        try {
            source = this.open(url);
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
                const error = new Error(stderr || 'yt-dlp no produjo audio');
                error.code = 'extract_failed';
                buffer.fail(error);
                this.#drop(buffer);
            } else if (code !== 0 && buffer.declared !== null && buffer.size < buffer.declared) {
                buffer.fail(new Error('La descarga se cortó a medias'));
                this.#drop(buffer);
            } else {
                buffer.finish();
                this.log(`[audio] ${buffer.key}: completa, ${(buffer.size / 1048576).toFixed(1)} MB en ${((Date.now() - started) / 1000).toFixed(1)} s`);
            }
            this.evict();
        });
    }

    // Suelta de la memoria las canciones completas que nadie está leyendo, de la más antigua a la más reciente
    evict() {
        let total = this.bytes;
        if (total <= this.maxBytes) return;
        const idle = [...this.items.values()]
            .filter(item => item.done && item.readers === 0)
            .sort((a, b) => a.lastUsed - b.lastUsed);
        for (const item of idle) {
            if (total <= this.maxBytes) break;
            this.items.delete(item.key);
            total -= item.size;
        }
    }
}
