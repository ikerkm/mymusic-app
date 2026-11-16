import express from 'express';
import { once } from 'node:events';
import { sniffMime } from './audio.js';
import { parseKey } from './sources.js';
import { explain } from './ytdlp.js';

// Tramo pedido por el cliente. null = sin cabecera Range; 'invalid' = no se puede servir.
export function parseRange(header, total) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
    let start;
    let end;
    if (match[1] === '') {                       // «bytes=-N»: los últimos N
        const last = Number(match[2]);
        if (last === 0) return 'invalid';
        start = Math.max(0, total - last);
        end = total - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
    }
    if (start >= total || start > end) return 'invalid';
    return [start, end];
}

const clientIp = req => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'desconocida');

/**
 * @param {object} deps
 * @param {import('./auth.js').Auth} deps.auth
 * @param {import('./audio.js').AudioCache} deps.cache
 * @param {(query: string) => Promise<object[]>} deps.search
 * @param {(url: string) => {stdout, meta, done, kill}} deps.open  para las pistas que no caben en memoria
 */
export function createApp({ auth, cache, search, open, version = '0', log = () => {} }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '10kb' }));
    const requireAuth = auth.middleware();

    app.get('/api/health', (req, res) => res.json({ ok: true }));

    app.post('/api/login', (req, res) => {
        const ip = clientIp(req);
        if (auth.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
        if (!auth.hasPassword()) return res.status(503).json({ error: 'no_password_set' });
        if (!auth.checkPassword(req.body?.password)) {
            auth.noteFail(ip);
            log(`[login] intento fallido desde ${ip}`);
            return res.status(401).json({ error: 'bad_password' });
        }
        const token = auth.issueToken(req.body?.device);
        log(`[login] sesión nueva: ${String(req.body?.device ?? 'dispositivo').slice(0, 60)}`);
        res.json({ token });
    });

    app.post('/api/logout', requireAuth, (req, res) => {
        auth.revoke(req.token);
        res.json({ ok: true });
    });

    app.get('/api/me', requireAuth, (req, res) => {
        res.json({ ok: true, version, device: req.device.device, since: req.device.createdAt });
    });

    app.get('/api/search', requireAuth, async (req, res) => {
        const query = String(req.query.q ?? '').trim().slice(0, 200);
        if (!query) return res.status(400).json({ error: 'empty_query' });
        try {
            res.json({ results: await search(query) });
        } catch (error) {
            log(`[search] error: ${error.message}`);
            res.status(502).json({ error: 'search_failed' });
        }
    });

    // Pista que no cabe en memoria: tubería directa, sin poder saltar
    function pipeDirect(req, res, url) {
        const source = open(url);
        res.on('close', () => source.kill());
        let started = false;
        source.stdout.on('data', chunk => {
            if (!started) {
                started = true;
                res.status(200).set({ 'Content-Type': sniffMime(chunk), 'Accept-Ranges': 'none', 'Cache-Control': 'private, no-store' });
            }
            if (!res.write(chunk)) {
                source.stdout.pause();
                res.once('drain', () => source.stdout.resume());
            }
        });
        source.done.then(({ stderr }) => {
            if (started) return res.end();
            res.status(502).json({ error: 'extract_failed', message: explain(stderr) });
        });
    }

    app.get('/api/stream/:key', requireAuth, async (req, res) => {
        const source = parseKey(req.params.key);
        if (!source) return res.status(400).json({ error: 'bad_key' });

        const abort = new AbortController();
        res.on('close', () => abort.abort());

        let buffer;
        try {
            buffer = cache.get(source.key, source.url);
            await buffer.waitHeader(abort.signal);
        } catch (error) {
            if (abort.signal.aborted) return;
            if (error.code === 'too_big') return pipeDirect(req, res, source.url);
            log(`[stream] ${source.key}: ${error.message.slice(0, 300)}`);
            return res.status(502).json({ error: 'extract_failed', message: explain(error.message) });
        }

        const total = buffer.total;
        const range = parseRange(req.headers.range, total);
        if (range === 'invalid') {
            return res.status(416).set('Content-Range', `bytes */${total}`).end();
        }
        const [start, end] = range ?? [0, total - 1];
        res.status(range ? 206 : 200).set({
            'Content-Type': buffer.mime,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
        });
        if (range) res.set('Content-Range', `bytes ${start}-${end}/${total}`);

        buffer.readers++;
        try {
            for await (const chunk of buffer.read(start, end, abort.signal)) {
                if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
            }
            res.end();
        } catch {
            // Cliente desconectado o descarga rota: se corta la conexión y el reproductor reintenta
            res.destroy();
        } finally {
            buffer.readers--;
            buffer.lastUsed = Date.now();
            cache.evict();
        }
    });

    app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
    app.use((req, res) => res.status(404).end());
    // Errores no previstos (p. ej. JSON mal formado): respuesta corta, sin trazas
    app.use((error, req, res, next) => {    // eslint-disable-line no-unused-vars
        if (res.headersSent) return res.destroy();
        res.status(error.status === 400 || error.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'bad_request' });
    });

    return app;
}
