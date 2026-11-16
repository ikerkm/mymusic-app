import express from 'express';
import { once } from 'node:events';
import { sniffMime } from './audio.js';
import { ListStore, cleanTrack } from './lists.js';
import { parseKey, parseLink } from './sources.js';
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
export function createApp({ auth, cache, search, open, lists, sessions, history, appDist, matches, importers, pending, prefetchDelayMs = 8000, version = '0', log = () => {} }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '10kb' }));
    const requireAuth = auth.middleware();

    // Una canción de Spotify se presenta con la carátula de su coincidencia y con quién la eligió
    const show = track => (matches ? matches.decorate(track) : track);

    // De dónde sale el audio de una clave. Para una canción de Spotify es su coincidencia en YouTube,
    // que se busca aquí si aún no la tiene (por eso puede tardar unos segundos la primera vez).
    async function resolveAudio(key) {
        const source = parseKey(key);
        if (!source || source.platform !== 'spotify') return source;
        const entry = await matches?.resolve(source.key);
        return entry?.yt ? parseKey(entry.yt.key) : null;
    }
    // Lo mismo, pero sin buscar: solo si ya se conoce
    const audioKeyOf = key => {
        const source = parseKey(key);
        if (!source) return null;
        return source.platform === 'spotify' ? matches?.get(source.key)?.yt?.key ?? null : source.key;
    };

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
        const query = String(req.query.q ?? '').trim().slice(0, 300);
        if (!query) return res.status(400).json({ error: 'empty_query' });
        try {
            // Un enlace pegado en el buscador: una canción suelta se devuelve como resultado único;
            // una lista no se abre aquí (se importa desde dentro de una lista propia).
            const link = importers ? parseLink(query) : null;
            if (link?.kind === 'yt-video') {
                const track = await importers.youtubeVideo(link.id);
                return res.json({ results: track ? [track] : [] });
            }
            if (link?.kind === 'sp-track') {
                const track = cleanTrack(await importers.spotifyTrack(link.id));
                if (track) matches.remember([track]);
                return res.json({ results: track ? [show(track)] : [] });
            }
            if (link) return res.json({ results: [], hint: 'playlist' });
            if (/^https?:\/\//i.test(query)) return res.json({ results: [], hint: 'bad_link' });
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
        if (!parseKey(req.params.key)) return res.status(400).json({ error: 'bad_key' });
        let source;
        try {
            source = await resolveAudio(req.params.key);
        } catch (error) {
            log(`[stream] ${req.params.key}: no se pudo buscar su coincidencia: ${error.message.slice(0, 200)}`);
        }
        if (!source) return res.status(502).json({ error: 'no_match', message: 'No se ha encontrado esta canción en YouTube' });
        syncPins();      // si acaba de conocerse la coincidencia de la canción que suena, queda fijada

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

    // La canción que suena y la siguiente quedan fijadas en memoria, por la clave de su audio
    function syncPins() {
        const view = sessions?.view();
        cache.pinned = new Set([view?.window.current?.track.key, view?.window.next?.track.key].map(key => key && audioKeyOf(key)).filter(Boolean));
    }

    // ------------------------------------------------------------------ Fase 2: listas, sesión, historial
    const priv = express.Router();
    priv.use(requireAuth);
    const int = value => (/^\d+$/.test(String(value ?? '')) ? Number(value) : undefined);
    // Canción que manda la app, ya limpia. Si viene de Spotify se apunta para poder buscar su coincidencia.
    const trackFrom = input => {
        const track = cleanTrack(input);
        if (track?.platform === 'spotify') matches?.remember([track]);
        return track;
    };

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
        if (list) res.json({ list: { ...ListStore.summary(list), tracks: list.tracks.map(show) } });
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
        const track = trackFrom(req.body?.track);
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
        syncPins();
        const nextKey = sessions.view()?.window.next?.track.key ?? null;
        clearTimeout(prefetchTimer);
        if (!prefetch || !nextKey) return;
        prefetchTimer = setTimeout(async () => {
            if (sessions.view()?.window.next?.track.key !== nextKey) return;
            const source = await resolveAudio(nextKey).catch(() => null);
            if (!source || sessions.view()?.window.next?.track.key !== nextKey) return;
            syncPins();
            const known = cache.items.has(source.key);
            cache.get(source.key, source.url);
            if (!known) log(`[sesion] preparando la siguiente: ${nextKey === source.key ? source.key : `${nextKey} → ${source.key}`}`);
        }, prefetchDelayMs);
        prefetchTimer.unref();
    }
    syncAudio({ prefetch: false });      // al arrancar: fijar lo que hubiera, sin extraer nada

    const entryShown = entry => (entry ? { index: entry.index, track: show(entry.track) } : null);
    const viewShown = view => (view ? {
        ...view,
        window: { prev: entryShown(view.window.prev), current: entryShown(view.window.current), next: entryShown(view.window.next) },
    } : null);

    const reply = (res, view, error = 'no_session') => {
        if (!view) return res.status(sessions.active ? 400 : 404).json({ error: sessions.active ? error : 'no_session' });
        syncAudio();
        res.json({ session: viewShown(view) });
    };

    priv.get('/session', (req, res) => res.json({ session: viewShown(sessions.view()) }));

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
        const track = trackFrom(body.track);
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
        res.json({ ...queue, entries: queue.entries.map(entryShown) });
    });

    priv.post('/session/queue', (req, res) => {
        const track = trackFrom(req.body?.track);
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
        res.json({ entries: entries.map(entry => ({ ...entry, track: show(entry.track) })) });
    });

    // --- Fase 3: importar una playlist de fuera a una lista propia ---
    // Dos pasos, como en la maqueta: primero se lee la lista y se enseña qué trae; al confirmar se añade.
    priv.post('/import/preview', async (req, res) => {
        const list = lists.get(req.body?.listId);
        if (!list) return res.status(404).json({ error: 'list_not_found' });
        const link = parseLink(req.body?.url);
        if (!link) return res.status(400).json({ error: 'bad_link' });
        if (link.kind === 'yt-mix') return res.status(400).json({ error: 'mix_not_supported' });
        if (link.kind !== 'yt-playlist' && link.kind !== 'sp-playlist') return res.status(400).json({ error: 'not_a_playlist' });
        let found;
        try {
            found = link.kind === 'yt-playlist' ? await importers.youtubePlaylist(link.id) : await importers.spotifyPlaylist(link.id);
        } catch (error) {
            log(`[importar] ${link.kind} ${link.id}: ${String(error.message).slice(0, 200)}`);
            return res.status(502).json({ error: 'import_failed' });
        }
        const seen = new Set();
        const tracks = found.tracks.map(cleanTrack).filter(track => track && !seen.has(track.key) && seen.add(track.key));
        if (tracks.length === 0) return res.status(422).json({ error: 'empty_playlist' });
        const present = new Set(list.tracks.map(track => track.key));
        const fresh = tracks.filter(track => !present.has(track.key)).length;
        log(`[importar] «${found.title}» (${found.platform}): ${tracks.length} canciones, ${fresh} nuevas para «${list.name}»`);
        res.json({
            importId: pending.put({ listId: list.id, tracks }),
            platform: found.platform,
            title: found.title,
            thumb: found.thumb,
            count: tracks.length,
            newCount: fresh,
            already: tracks.length - fresh,
            truncated: Boolean(found.truncated),
        });
    });

    priv.post('/lists/:id/import', (req, res) => {
        const list = listOr404(req, res);
        if (!list) return;
        const ready = pending.get(req.body?.importId);
        if (!ready || ready.listId !== list.id) return res.status(410).json({ error: 'import_expired' });
        matches.remember(ready.tracks);
        const { added, list: updated } = lists.addTracks(list.id, ready.tracks);
        res.json({ added, list: ListStore.summary(updated) });
    });

    // --- Fase 3: coincidencia en YouTube de una canción de Spotify ---
    priv.get('/match/:key', async (req, res) => {
        const entry = matches.get(req.params.key);
        if (!entry) return res.status(404).json({ error: 'match_not_found' });
        try {
            res.json({ current: entry.yt, auto: entry.auto, candidates: await matches.candidates(req.params.key, 8) });
        } catch (error) {
            log(`[coincidencia] ${req.params.key}: ${String(error.message).slice(0, 200)}`);
            res.status(502).json({ error: 'search_failed' });
        }
    });

    priv.put('/match/:key', (req, res) => {
        const chosen = cleanTrack(req.body?.track);
        if (!chosen || chosen.platform !== 'youtube') return res.status(400).json({ error: 'bad_track' });
        const entry = matches.choose(req.params.key, chosen);
        if (!entry) return res.status(404).json({ error: 'match_not_found' });
        log(`[coincidencia] ${req.params.key} → ${chosen.key}, elegida a mano`);
        syncPins();
        res.json({ current: entry.yt, auto: false });
    });

    // --- Actualización de la app ---
    priv.get('/app/latest', (req, res) => {
        const latest = appDist?.latest();
        if (!latest) return res.status(404).json({ error: 'no_app' });
        const { path, ...info } = latest;
        res.json(info);
    });

    priv.get('/app/download', (req, res) => {
        const latest = appDist?.latest();
        if (!latest) return res.status(404).json({ error: 'no_app' });
        log(`[app] descarga de la versión ${latest.versionName} (${latest.versionCode}) desde ${req.device.device}`);
        res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Cache-Control': 'private, no-store' });
        res.sendFile(latest.path, { dotfiles: 'allow' }, error => {
            if (error && !res.headersSent) res.status(500).json({ error: 'download_failed' });
        });
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
