import express from 'express';
import { once } from 'node:events';
import { sniffMime } from './audio.js';
import { ListStore, cleanTrack } from './lists.js';
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
export function createApp({ auth, cache, search, open, lists, sessions, history, prefetchDelayMs = 8000, version = '0', log = () => {} }) {
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

    // ------------------------------------------------------------------ Fase 2: listas, sesión, historial
    const priv = express.Router();
    priv.use(requireAuth);
    const int = value => (/^\d+$/.test(String(value ?? '')) ? Number(value) : undefined);

    // --- Listas ---
    const listOr404 = (req, res) => {
        const list = lists.get(req.params.id);
        if (!list) res.status(404).json({ error: 'list_not_found' });
        return list;
    };

    priv.get('/lists', (req, res) => res.json({ lists: lists.all() }));

    priv.post('/lists', (req, res) => {
        const list = lists.create(req.body?.name);
        if (!list) return res.status(400).json({ error: 'bad_name' });
        res.status(201).json({ list: ListStore.summary(list) });
    });

    priv.get('/lists/:id', (req, res) => {
        const list = listOr404(req, res);
        if (list) res.json({ list: { ...ListStore.summary(list), tracks: list.tracks } });
    });

    const renameList = (req, res) => {
        if (!listOr404(req, res)) return;
        const list = lists.rename(req.params.id, req.body?.name);
        if (!list) return res.status(400).json({ error: 'bad_name' });
        res.json({ list: ListStore.summary(list) });
    };
    priv.patch('/lists/:id', renameList);
    priv.put('/lists/:id', renameList);      // alias de PATCH, por lo mismo que en /session

    priv.delete('/lists/:id', (req, res) => {
        if (!listOr404(req, res)) return;
        lists.remove(req.params.id);
        res.json({ ok: true });
    });

    priv.post('/lists/:id/tracks', (req, res) => {
        if (!listOr404(req, res)) return;
        const track = cleanTrack(req.body?.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        const { added, list } = lists.addTracks(req.params.id, [track]);
        res.json({ added, list: ListStore.summary(list) });
    });

    priv.delete('/lists/:id/tracks/:key', (req, res) => {
        if (!listOr404(req, res)) return;
        const list = lists.removeTrack(req.params.id, req.params.key);
        if (!list) return res.status(404).json({ error: 'track_not_found' });
        res.json({ list: ListStore.summary(list) });
    });

    priv.post('/lists/:id/move', (req, res) => {
        if (!listOr404(req, res)) return;
        const list = lists.moveTrack(req.params.id, req.body?.key, req.body?.toIndex);
        if (!list) return res.status(400).json({ error: 'bad_move' });
        res.json({ list: ListStore.summary(list) });
    });

    // --- Sesión de escucha ---
    // Tras cada cambio: la canción actual y la siguiente quedan fijadas en memoria, y la siguiente se
    // prepara si el usuario se queda unos segundos en la actual.
    let prefetchTimer = null;
    function syncAudio({ prefetch = true } = {}) {
        const view = sessions.view();
        const nextKey = view?.window.next?.track.key ?? null;
        cache.pinned = new Set([view?.window.current?.track.key, nextKey].filter(Boolean));
        clearTimeout(prefetchTimer);
        if (!prefetch || !nextKey) return;
        prefetchTimer = setTimeout(() => {
            const source = parseKey(nextKey);
            if (!source || sessions.view()?.window.next?.track.key !== nextKey) return;
            const known = cache.items.has(source.key);
            cache.get(source.key, source.url);
            if (!known) log(`[sesion] preparando la siguiente: ${source.key}`);
        }, prefetchDelayMs);
        prefetchTimer.unref();
    }
    syncAudio({ prefetch: false });      // al arrancar: fijar lo que hubiera, sin extraer nada

    const reply = (res, view, error = 'no_session') => {
        if (!view) return res.status(sessions.active ? 400 : 404).json({ error: sessions.active ? error : 'no_session' });
        syncAudio();
        res.json({ session: view });
    };

    priv.get('/session', (req, res) => res.json({ session: sessions.view() }));

    priv.post('/session', (req, res) => {
        const body = req.body ?? {};
        if (body.listId !== undefined) {
            const list = lists.get(body.listId);
            if (!list) return res.status(404).json({ error: 'list_not_found' });
            if (list.tracks.length === 0) return res.status(400).json({ error: 'empty_list' });
            return reply(res, sessions.start({
                source: { type: 'list', id: list.id, name: list.name },
                tracks: list.tracks,
                startKey: typeof body.startKey === 'string' ? body.startKey : null,
                shuffle: body.shuffle === true,
            }));
        }
        const track = cleanTrack(body.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        reply(res, sessions.start({ source: { type: 'search', name: 'Búsqueda' }, tracks: [track] }));
    });

    // La canción se puede señalar por posición o por clave. La app usa la clave: las posiciones
    // se mueven cuando se toca la cola, las claves no.
    const indexFrom = body => (Number.isInteger(body?.index) ? body.index : sessions.indexOf(body?.key));

    priv.post('/session/goto', (req, res) => reply(res, sessions.goto(indexFrom(req.body)), 'bad_index'));

    const setOptions = (req, res) => reply(res, sessions.setOptions(req.body ?? {}));
    priv.patch('/session', setOptions);
    priv.put('/session', setOptions);        // alias: el cliente HTTP de Android no admite PATCH en todas las versiones

    priv.put('/session/state', (req, res) => {
        const result = sessions.report({ index: indexFrom(req.body), positionMs: Number(req.body?.positionMs) });
        if (result?.played) history.append(result.played);
        res.json({ ok: Boolean(result) });
    });

    priv.get('/session/queue', (req, res) => {
        const queue = sessions.queue(int(req.query.from), int(req.query.limit));
        if (!queue) return res.status(404).json({ error: 'no_session' });
        res.json(queue);
    });

    priv.post('/session/queue', (req, res) => {
        const track = cleanTrack(req.body?.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        // Sin sesión abierta, «a continuación» o «añadir a la cola» equivale a reproducir
        if (!sessions.active) return reply(res, sessions.start({ source: { type: 'search', name: 'Búsqueda' }, tracks: [track] }));
        reply(res, sessions.enqueue(track, req.body?.mode === 'next' ? 'next' : 'end'));
    });

    // Mover y quitar también se piden por clave. Por clave, una orden repetida no hace daño:
    // por posición, una segunda orden idéntica quitaría la canción que ha ocupado ese hueco.
    priv.post('/session/queue/move', (req, res) => {
        const from = Number.isInteger(req.body?.from) ? req.body.from : sessions.indexOf(req.body?.key);
        reply(res, sessions.moveQueued(from, req.body?.to), 'bad_move');
    });

    priv.delete('/session/queue/:ref', (req, res) => {
        const byIndex = int(req.params.ref);
        if (byIndex !== undefined) return reply(res, sessions.removeQueued(byIndex), 'bad_index');
        const index = sessions.indexOf(req.params.ref);
        // Si la canción ya no está en la cola (orden repetida), no pasa nada: se devuelve la sesión tal cual
        if (index === null) return reply(res, sessions.view());
        log(`[sesion] quitar de la cola: ${req.params.ref}`);
        reply(res, sessions.removeQueued(index), 'bad_index');
    });

    // --- Historial ---
    priv.get('/history', (req, res) => {
        const limit = Math.min(int(req.query.limit) ?? 30, 200);
        let entries = history.recent(req.query.distinct ? limit * 4 : limit);
        if (req.query.distinct) {
            const seen = new Set();
            entries = entries.filter(e => !seen.has(e.track.key) && seen.add(e.track.key)).slice(0, limit);
        }
        res.json({ entries });
    });

    app.use('/api', priv);
    app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
    app.use((req, res) => res.status(404).end());
    // Errores no previstos (p. ej. JSON mal formado): respuesta corta, sin trazas
    app.use((error, req, res, next) => {    // eslint-disable-line no-unused-vars
        if (res.headersSent) return res.destroy();
        res.status(error.status === 400 || error.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'bad_request' });
    });

    return app;
}
