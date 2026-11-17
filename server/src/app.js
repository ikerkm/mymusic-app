import express from 'express';
import { once } from 'node:events';
import { sniffMime } from './audio.js';
import { sessionCookie } from './auth.js';
import { LikeSet } from './likes.js';
import { cleanTrack } from './lists.js';
import { RADIO_SEEDS, SongSet } from './radio.js';
import { parseKey, parseLink } from './sources.js';
import { Listening, artistOf, isAutoKind, isPeriod } from './stats.js';
import { note, who } from './usage.js';
import { explain } from './ytdlp.js';
import { ALBUM_ID, ARTIST_ID } from './ytmusic.js';
import { NO_MATCH, reasonOf } from './failures.js';
import { cleanTitle } from './matches.js';

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

// El panel solo carga código y estilos propios; de fuera, únicamente las carátulas (imágenes)
const WEB_CSP = "default-src 'self'; img-src 'self' https: data:; media-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// Enlaces de canciones que se admiten por llamada al importar un bloque, y cuántas se leen a la vez
const LINKS_PER_CALL = 100;
const LINKS_AT_ONCE = 4;

// Vídeo con el que se prueba la extracción: «Me at the zoo», el primero de YouTube (19 segundos, ahí desde 2005)
const PROBE_VIDEO = 'jNQXAC9IVRw';

const clientIp = req => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'desconocida');

/**
 * @param {object} deps
 * @param {import('./auth.js').Auth} deps.auth
 * @param {import('./audio.js').AudioCache} deps.cache
 * @param {(query: string) => Promise<object[]>} deps.search
 * @param {(url: string) => {stdout, meta, done, kill}} deps.open  para las pistas que no caben en memoria
 */
export function createApp({ auth, cache, search, open, stores, appDist, matches, importers, pending, radio = null, usage = null, ytmusic = null, alternates = null, webDir = null, prefetchDelayMs = 8000, probeTimeoutMs = 45_000, artistsWaitMs = 4000, version = '0', log = () => {} }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '10kb' }));
    const requireAuth = auth.middleware();
    // Consumo: lo que se haga a partir de aquí (extraer, buscar, leer mezclas) se apunta a este usuario,
    // también lo que siga corriendo cuando la petición ya ha respondido
    const asUser = (req, res, next) => (usage ? who.run({ userId: req.user.id, usage }, next) : next());

    // Una canción de Spotify se presenta con la carátula de su coincidencia y con quién la eligió
    const show = track => (matches ? matches.decorate(track) : track);

    // De dónde sale el audio de una clave. Para una canción de Spotify es su coincidencia en YouTube,
    // que se busca aquí si aún no la tiene (por eso puede tardar unos segundos la primera vez).
    // Con «otro enlace» (§19), una canción de YouTube o SoundCloud suena desde el vídeo elegido.
    async function resolveAudio(key) {
        const alternate = alternates?.get(key);
        if (alternate) return parseKey(alternate.key);
        const source = parseKey(key);
        if (!source || source.platform !== 'spotify') return source;
        const entry = await matches?.resolve(source.key);
        return entry?.yt ? parseKey(entry.yt.key) : null;
    }
    // Los enlaces cortos de SoundCloud (on.soundcloud.com/…) hay que seguirlos para saber si son canción o lista
    const followShort = async link => (link?.kind === 'sc-short' ? importers.soundcloudShort(link.id) : link);

    // Lo mismo, pero sin buscar: solo si ya se conoce
    const audioKeyOf = key => {
        const alternate = alternates?.get(key);
        if (alternate) return alternate.key;
        const source = parseKey(key);
        if (!source) return null;
        return source.platform === 'spotify' ? matches?.get(source.key)?.yt?.key ?? null : source.key;
    };

    // «Me gusta»: las canciones de la lista del corazón de un usuario
    const likesOf = ctx => {
        const id = ctx.lists.likesId();
        return new LikeSet(id ? ctx.lists.get(id)?.tracks ?? [] : [], audioKeyOf);
    };
    // Cómo se enseña una canción a un usuario: como `show`, más `liked` (si está en su «me gusta»).
    // La lista del corazón solo se lee si llega a hacer falta.
    const showFor = ctx => {
        let likes = null;
        return track => {
            likes ??= likesOf(ctx);
            return { ...show(track), liked: likes.has(track) };
        };
    };

    // Artista de YouTube Music tal como se enseña en una fila («Artistas» de Buscar, «parecidos», «Ir al artista»)
    const artistCard = artist => ({ id: artist.id, name: artist.name, listeners: artist.listeners ?? null, thumb: artist.thumb ?? null });

    // La fila «Artistas» de Buscar (§18). Si YouTube Music tarda o falla, la búsqueda sale sin ella.
    async function artistsRow(query) {
        if (!ytmusic) return [];
        let timer;
        const late = new Promise(resolve => { timer = setTimeout(() => resolve([]), artistsWaitMs); });
        try {
            return await Promise.race([
                ytmusic.artistsFor(query).catch(error => {
                    log(`[ytmusic] artistas de «${query.slice(0, 60)}»: ${String(error?.message ?? error).slice(0, 200)}`);
                    return [];
                }),
                late,
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    app.get('/api/health', (req, res) => res.json({ ok: true }));

    // Entrar con usuario y contraseña. Sin usuario se entiende el dueño: es lo que mandan las
    // versiones de la app anteriores a las cuentas. El error es el mismo falle el nombre o la
    // contraseña, para no revelar qué usuarios existen.
    app.post('/api/login', (req, res) => {
        const ip = clientIp(req);
        if (auth.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
        if (!auth.hasUsers()) return res.status(503).json({ error: 'no_password_set' });
        const user = auth.checkLogin(req.body?.user, req.body?.password);
        if (!user) {
            auth.noteFail(ip);
            log(`[login] intento fallido desde ${ip}`);
            return res.status(401).json({ error: 'bad_password' });
        }
        const token = auth.issueToken(user.id, req.body?.device);
        log(`[login] sesión nueva de ${user.name}: ${String(req.body?.device ?? 'dispositivo').slice(0, 60)}`);
        // El panel web no recibe el token: viaja en una cookie que su JavaScript no puede leer
        if (req.body?.web === true) {
            res.setHeader('Set-Cookie', sessionCookie(req, token));
            return res.json({ user: { name: user.name, admin: user.admin } });
        }
        res.json({ token, user: { name: user.name, admin: user.admin } });
    });

    app.post('/api/logout', requireAuth, (req, res) => {
        auth.revoke(req.token);
        if (req.viaCookie) res.setHeader('Set-Cookie', sessionCookie(req, null));
        res.json({ ok: true });
    });

    app.get('/api/me', requireAuth, (req, res) => {
        res.json({ ok: true, version, user: { name: req.user.name, admin: req.user.admin }, device: req.device.device, since: req.device.createdAt });
    });

    // Cambiar la propia contraseña. Este dispositivo sigue dentro; los demás del mismo usuario tienen que volver a entrar.
    app.post('/api/password', requireAuth, (req, res) => {
        const ip = clientIp(req);
        if (auth.blocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
        if (!auth.checkLogin(req.user.name, req.body?.current)) {
            auth.noteFail(ip);
            return res.status(401).json({ error: 'bad_password' });
        }
        const next = req.body?.next;
        if (typeof next !== 'string' || next.length < 8) return res.status(400).json({ error: 'weak_password' });
        auth.setPassword(req.user.id, next, { keepToken: req.token });
        log(`[login] ${req.user.name} ha cambiado su contraseña`);
        res.json({ ok: true });
    });

    app.get('/api/search', requireAuth, asUser, async (req, res) => {
        const query = String(req.query.q ?? '').trim().slice(0, 300);
        if (!query) return res.status(400).json({ error: 'empty_query' });
        note({ searches: 1 });
        const shown = showFor(stores.for(req.user.id));
        try {
            // Un enlace pegado en el buscador: una canción suelta se devuelve como resultado único;
            // una lista no se abre aquí (se importa desde dentro de una lista propia).
            const link = importers ? await followShort(parseLink(query)) : null;
            if (link?.kind === 'sc-track') {
                const track = cleanTrack(await importers.soundcloudTrack(link));
                return res.json({ results: track ? [shown(track)] : [] });
            }
            if (link?.kind === 'yt-video') {
                const track = await importers.youtubeVideo(link.id);
                return res.json({ results: track ? [shown(track)] : [] });
            }
            if (link?.kind === 'sp-track') {
                const track = cleanTrack(await importers.spotifyTrack(link.id));
                if (track) matches.remember([track]);
                return res.json({ results: track ? [shown(track)] : [] });
            }
            if (link) return res.json({ results: [], hint: 'playlist' });
            if (/^https?:\/\//i.test(query)) return res.json({ results: [], hint: 'bad_link' });
            // El buscador de YouTube devuelve a veces una página vacía sin motivo (pasa también en las
            // coincidencias, matches.js): se pregunta otra vez antes de decir «Sin resultados»
            const searchOnceMore = async () => {
                const found = await search(query);
                return found.length > 0 ? found : search(query);
            };
            const [results, artists] = await Promise.all([searchOnceMore(), artistsRow(query)]);
            res.json({ results: results.map(shown), artists: artists.map(artistCard) });
        } catch (error) {
            log(`[search] error: ${error.message}`);
            res.status(502).json({ error: 'search_failed' });
        }
    });

    // Pista que no cabe en memoria: tubería directa, sin poder saltar
    function pipeDirect(req, res, source) {
        const stream = open(source.url, { aacToAdts: source.aacToAdts });
        const began = Date.now();
        let bytes = 0;
        res.on('close', () => {
            stream.kill();
            // Lo que pasa en tubería directa se baja y se sirve a la vez: cuenta como las dos cosas
            if (bytes > 0) note({ extractions: 1, extractBytes: bytes, extractMs: Date.now() - began, servedBytes: bytes });
        });
        let started = false;
        stream.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (!started) {
                started = true;
                clearFailure(req, req.params.key);
                res.status(200).set({ 'Content-Type': sniffMime(chunk), 'Accept-Ranges': 'none', 'Cache-Control': 'private, no-store' });
            }
            if (!res.write(chunk)) {
                stream.stdout.pause();
                res.once('drain', () => stream.stdout.resume());
            }
        });
        stream.done.then(({ stderr }) => {
            if (started) return res.end();
            const reason = reasonOf(stderr);
            noteFailure(req, req.params.key, reason);
            res.status(502).json({ error: 'extract_failed', message: reason.text, reason: reason.text, code: reason.code });
        });
    }

    // --- Canciones que fallaron (§19) ---
    // Lo que el reproductor de un usuario pidió y no se pudo sacar queda apuntado para él, con la
    // canción tal como estaba en su sesión y la lista de la que sonaba.
    function noteFailure(req, key, reason) {
        try {
            const ctx = stores.for(req.user.id);
            const session = ctx.sessions.session;
            const fromSession = session?.tracks?.[key] ?? null;
            const spotify = key.startsWith('sp:') ? matches?.get(key) : null;
            const track = fromSession ?? (spotify ? { key, platform: 'spotify', title: spotify.title, artist: spotify.artist, durationSec: spotify.durationSec } : { key, platform: parseKey(key)?.platform });
            const list = session?.source?.type === 'list' && fromSession ? { id: session.source.id, name: session.source.name } : null;
            const item = ctx.failures.note(track, reason, { list });
            log(`[fallos] ${req.user.name}: «${item.track.title}» no se pudo reproducir (${reason.text}; ${item.count} ${item.count === 1 ? 'vez' : 'veces'})`);
        } catch (error) {
            log(`[fallos] no se pudo apuntar ${key}: ${String(error?.message ?? error).slice(0, 200)}`);
        }
    }
    // Ha vuelto a sonar bien: sale del apartado
    function clearFailure(req, key) {
        const { failures } = stores.for(req.user.id);
        if (failures.get(key) && failures.remove(key)) log(`[fallos] ${req.user.name}: ${key} ya suena bien`);
    }

    app.get('/api/stream/:key', requireAuth, asUser, async (req, res) => {
        if (!parseKey(req.params.key)) return res.status(400).json({ error: 'bad_key' });
        let source;
        try {
            source = await resolveAudio(req.params.key);
        } catch (error) {
            log(`[stream] ${req.params.key}: no se pudo buscar su coincidencia: ${error.message.slice(0, 200)}`);
        }
        if (!source) {
            noteFailure(req, req.params.key, NO_MATCH);
            return res.status(502).json({ error: 'no_match', message: 'No se ha encontrado esta canción en YouTube', reason: NO_MATCH.text, code: NO_MATCH.code });
        }
        syncPins();      // si acaba de conocerse la coincidencia de la canción que suena, queda fijada

        const abort = new AbortController();
        res.on('close', () => abort.abort());

        let buffer;
        try {
            buffer = cache.get(source.key, source.url, { aacToAdts: source.aacToAdts });
            await buffer.waitHeader(abort.signal);
        } catch (error) {
            if (abort.signal.aborted) return;
            if (error.code === 'too_big') return pipeDirect(req, res, source);
            log(`[stream] ${source.key}: ${error.message.slice(0, 300)}`);
            // El motivo en claro viaja en la respuesta: la app y el panel lo enseñan al pasar a la siguiente
            const reason = reasonOf(error.message);
            noteFailure(req, req.params.key, reason);
            return res.status(502).json({ error: 'extract_failed', message: reason.text, reason: reason.text, code: reason.code });
        }
        // Empieza a sonar: la radio lo necesita para saber cuánto se oyó una canción al saltarla
        stores.for(req.user.id).sessions.served(req.params.key);
        clearFailure(req, req.params.key);

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
        let sent = 0;
        try {
            for await (const chunk of buffer.read(start, end, abort.signal)) {
                sent += chunk.length;
                if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
            }
            res.end();
        } catch {
            // Cliente desconectado o descarga rota: se corta la conexión y el reproductor reintenta
            res.destroy();
        } finally {
            note({ servedBytes: sent });
            buffer.readers--;
            buffer.lastUsed = Date.now();
            cache.evict();
        }
    });

    // La canción que suena y la siguiente quedan fijadas en memoria, por la clave de su audio
    // (de todos los usuarios que tienen una sesión abierta)
    function syncPins() {
        const keys = [];
        for (const { sessions } of stores.loaded()) {
            const view = sessions.view();
            keys.push(view?.window.current?.track.key, view?.window.next?.track.key);
        }
        cache.pinned = new Set(keys.map(key => key && audioKeyOf(key)).filter(Boolean));
    }

    // ------------------------------------------------------------------ Fase 2: listas, sesión, historial
    const priv = express.Router();
    priv.use(requireAuth);
    priv.use(asUser);
    // Cada petición trabaja con las listas, la sesión y el historial de su usuario
    priv.use((req, res, next) => {
        req.ctx = stores.for(req.user.id);
        next();
    });
    const int = value => (/^\d+$/.test(String(value ?? '')) ? Number(value) : undefined);
    // Canción que manda la app, ya limpia. Si viene de Spotify se apunta para poder buscar su coincidencia.
    const trackFrom = input => {
        const track = cleanTrack(input);
        if (track?.platform === 'spotify') matches?.remember([track]);
        return track;
    };

    // --- Listas ---
    const listOr404 = (req, res) => {
        const list = req.ctx.lists.get(req.params.id);
        if (!list) res.status(404).json({ error: 'list_not_found' });
        return list;
    };

    priv.get('/lists', (req, res) => res.json({ lists: req.ctx.lists.all() }));

    priv.post('/lists', (req, res) => {
        const list = req.ctx.lists.create(req.body?.name);
        if (!list) return res.status(400).json({ error: 'bad_name' });
        res.status(201).json({ list: req.ctx.lists.summaryOf(list) });
    });

    priv.get('/lists/:id', (req, res) => {
        const list = listOr404(req, res);
        if (list) res.json({ list: { ...req.ctx.lists.summaryOf(list), tracks: list.tracks.map(showFor(req.ctx)) } });
    });

    const renameList = (req, res) => {
        if (!listOr404(req, res)) return;
        const list = req.ctx.lists.rename(req.params.id, req.body?.name);
        if (!list) return res.status(400).json({ error: 'bad_name' });
        res.json({ list: req.ctx.lists.summaryOf(list) });
    };
    priv.patch('/lists/:id', renameList);
    priv.put('/lists/:id', renameList);      // alias de PATCH, por lo mismo que en /session

    priv.delete('/lists/:id', (req, res) => {
        if (!listOr404(req, res)) return;
        req.ctx.lists.remove(req.params.id);
        res.json({ ok: true });
    });

    priv.post('/lists/:id/tracks', (req, res) => {
        if (!listOr404(req, res)) return;
        const track = trackFrom(req.body?.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        const { added, list } = req.ctx.lists.addTracks(req.params.id, [track]);
        // Si era una canción que puso la radio, al guardarla deja de ser «de la radio»
        req.ctx.sessions.markSaved(track.key);
        res.json({ added, list: req.ctx.lists.summaryOf(list) });
    });

    priv.delete('/lists/:id/tracks/:key', (req, res) => {
        if (!listOr404(req, res)) return;
        const list = req.ctx.lists.removeTrack(req.params.id, req.params.key);
        if (!list) return res.status(404).json({ error: 'track_not_found' });
        res.json({ list: req.ctx.lists.summaryOf(list) });
    });

    priv.post('/lists/:id/move', (req, res) => {
        if (!listOr404(req, res)) return;
        const list = req.ctx.lists.moveTrack(req.params.id, req.body?.key, req.body?.toIndex);
        if (!list) return res.status(400).json({ error: 'bad_move' });
        res.json({ list: req.ctx.lists.summaryOf(list) });
    });

    // --- Listas automáticas y «Tus estadísticas» ---
    // Se calculan en cada petición con el historial entero del usuario, sus listas y su consumo
    // (stats.js). Son de solo lectura: no salen en /lists y no se renombran, ni se importa en ellas.
    const listeningOf = req => new Listening({
        history: req.ctx.history.all(),
        lists: req.ctx.lists.full(),
        audioKeyOf,
        usageDays: usage?.daysOf(req.user.id) ?? {},
        userId: req.user.id,
        thumbOf: track => show(track).thumb ?? null,
    });
    // Cada canción, como en las demás pantallas (`liked`, carátula de la coincidencia) y con los datos de su fila
    const rowsShown = (req, rows) => {
        const shown = showFor(req.ctx);
        return rows.map(({ track, ...row }) => ({ ...shown(track), ...row }));
    };

    priv.get('/auto', (req, res) => res.json(listeningOf(req).summary()));

    priv.get('/auto/:kind', (req, res) => {
        const auto = listeningOf(req).auto(req.params.kind);
        if (!auto) return res.status(404).json({ error: 'auto_not_found' });
        const { rows, ...summary } = auto;
        res.json({ list: { ...summary, tracks: rowsShown(req, rows) } });
    });

    // «Guardar como lista»: copia lo que hay ahora a una lista normal nueva, que ya no cambia sola
    priv.post('/auto/:kind/save', (req, res) => {
        const auto = listeningOf(req).auto(req.params.kind);
        if (!auto) return res.status(404).json({ error: 'auto_not_found' });
        const name = req.body?.name === undefined ? auto.saveName : req.body.name;
        if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'bad_name' });
        if (auto.count === 0) return res.status(400).json({ error: 'empty_list' });
        const tracks = auto.rows.map(row => row.track);
        matches?.remember(tracks);
        const created = req.ctx.lists.create(name);
        const { list } = req.ctx.lists.addTracks(created.id, tracks);
        log(`[listas] ${req.user.name} guarda «${auto.name}» como «${list.name}» (${list.tracks.length} canciones)`);
        res.status(201).json({ list: req.ctx.lists.summaryOf(list) });
    });

    priv.get('/stats', (req, res) => {
        const period = req.query.period === undefined ? '7' : String(req.query.period);
        if (!isPeriod(period)) return res.status(400).json({ error: 'bad_period' });
        const stats = listeningOf(req).stats(period);
        res.json({ ...stats, topTracks: rowsShown(req, stats.topTracks) });
    });

    // --- Artista y disco (§18) ---
    // Salen de YouTube Music (ytmusic.js), que guarda cada página un día. Nada de esto es del usuario:
    // un artista o un disco no son listas suyas; «Guardar como lista» copia el disco a una lista nueva.
    const needYtm = (req, res, next) => (ytmusic ? next() : res.status(404).json({ error: 'not_found' }));
    const ytmFailed = (res, error, what) => {
        log(`[ytmusic] ${what}: ${String(error?.message ?? error).slice(0, 200)}`);
        res.status(502).json({ error: 'ytmusic_failed' });
    };
    const totalSec = tracks => tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);

    priv.get('/artist/:id', needYtm, async (req, res) => {
        if (!ARTIST_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
        try {
            const page = await ytmusic.artist(req.params.id);
            if (!page) return res.status(404).json({ error: 'artist_not_found' });
            const { songs, related, ...rest } = page;
            // Sus 5 más escuchadas son las primeras de su lista entera («Ver todas»), que va de más a menos escuchada
            res.json({ artist: { ...rest, related: related.map(artistCard), songsCount: songs.length, top: songs.slice(0, 5).map(showFor(req.ctx)) } });
        } catch (error) {
            ytmFailed(res, error, `artista ${req.params.id}`);
        }
    });

    // «Ver todas»: la lista entera de sus canciones, de la más escuchada a la menos. Se ve como una lista y no se edita.
    priv.get('/artist/:id/songs', needYtm, async (req, res) => {
        if (!ARTIST_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
        try {
            const page = await ytmusic.artist(req.params.id);
            if (!page) return res.status(404).json({ error: 'artist_not_found' });
            res.json({ list: { id: page.id, name: page.name, count: page.songs.length, durationSec: totalSec(page.songs), tracks: page.songs.map(showFor(req.ctx)) } });
        } catch (error) {
            ytmFailed(res, error, `canciones del artista ${req.params.id}`);
        }
    });

    priv.get('/album/:id', needYtm, async (req, res) => {
        if (!ALBUM_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
        try {
            const album = await ytmusic.album(req.params.id);
            if (!album) return res.status(404).json({ error: 'album_not_found' });
            res.json({ album: { ...album, count: album.tracks.length, durationSec: totalSec(album.tracks), tracks: album.tracks.map(showFor(req.ctx)) } });
        } catch (error) {
            ytmFailed(res, error, `disco ${req.params.id}`);
        }
    });

    // «Guardar como lista»: el disco pasa a una lista nueva del usuario, con su nombre, que ya no cambia sola
    priv.post('/album/:id/save', needYtm, async (req, res) => {
        if (!ALBUM_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
        const wanted = req.body?.name;
        if (wanted !== undefined && (typeof wanted !== 'string' || !wanted.trim())) return res.status(400).json({ error: 'bad_name' });
        try {
            const album = await ytmusic.album(req.params.id);
            if (!album) return res.status(404).json({ error: 'album_not_found' });
            if (album.tracks.length === 0) return res.status(400).json({ error: 'empty_list' });
            const created = req.ctx.lists.create(wanted ?? album.title);
            if (!created) return res.status(400).json({ error: 'bad_name' });
            const { list } = req.ctx.lists.addTracks(created.id, album.tracks);
            log(`[listas] ${req.user.name} guarda el disco «${album.title}» como «${list.name}» (${list.tracks.length} canciones)`);
            res.status(201).json({ list: req.ctx.lists.summaryOf(list) });
        } catch (error) {
            ytmFailed(res, error, `guardar el disco ${req.params.id}`);
        }
    });

    /**
     * «Ir al artista»: los artistas de YouTube Music de una canción. Spotify junta varios con comas
     * («A, B»), y las de los discos de YouTube Music también; en YouTube el campo es el canal, y se usa
     * la misma regla que «Tus estadísticas» (un canal de letras no cuenta como artista). Solo vuelven
     * los que se llaman como el de la canción: si no hay ninguno, la lista sale vacía.
     */
    priv.get('/artists/of', needYtm, async (req, res) => {
        const source = parseKey(String(req.query.key ?? ''));
        const raw = String(req.query.artist ?? '').trim().slice(0, 200);
        const title = String(req.query.title ?? '').slice(0, 300);
        if (!source || !raw) return res.status(400).json({ error: 'bad_track' });
        const parts = raw.includes(',') ? raw.split(',').map(part => part.trim()).filter(Boolean) : [raw];
        const names = [...new Set(parts.map(part => artistOf({ platform: source.platform, title, artist: part })).filter(Boolean))].slice(0, 4);
        const found = await Promise.allSettled(names.map(name => ytmusic.findArtist(name)));
        if (found.length && found.every(result => result.status === 'rejected')) return ytmFailed(res, found[0].reason, `artista de «${title.slice(0, 60)}»`);
        const seen = new Set();
        const artists = found.map(result => (result.status === 'fulfilled' ? result.value : null))
            .filter(artist => artist && !seen.has(artist.id) && seen.add(artist.id));
        res.json({ names, artists: artists.map(artistCard) });
    });

    // --- Sesión de escucha ---
    // Tras cada cambio: la canción actual y la siguiente quedan fijadas en memoria, y la siguiente se
    // prepara si el usuario se queda unos segundos en la actual.
    const prefetchTimers = new Map();        // un temporizador por usuario
    function syncAudio(userId) {
        syncPins();
        const { sessions } = stores.for(userId);
        const nextKey = sessions.view()?.window.next?.track.key ?? null;
        clearTimeout(prefetchTimers.get(userId));
        if (!nextKey) return;
        const timer = setTimeout(async () => {
            if (sessions.view()?.window.next?.track.key !== nextKey) return;
            const source = await resolveAudio(nextKey).catch(() => null);
            if (!source || sessions.view()?.window.next?.track.key !== nextKey) return;
            syncPins();
            const known = cache.items.has(source.key);
            cache.get(source.key, source.url, { aacToAdts: source.aacToAdts });
            if (!known) log(`[sesion] preparando la siguiente: ${nextKey === source.key ? source.key : `${nextKey} → ${source.key}`}`);
        }, prefetchDelayMs);
        timer.unref();
        prefetchTimers.set(userId, timer);
    }

    // --- Radio (Fase 4): seguir con canciones parecidas cuando se acaba lo que suena ---
    // Con la opción «Radio» marcada (o en una sesión de «Tu radio»), cuando queda como mucho una
    // canción por detrás de la que suena se añade una tanda. De dónde salen las parecidas:
    //   · sesión de una lista → de canciones de esa lista, y nunca canciones que ya estén en ella;
    //   · «Tu radio» (Inicio) → de lo que el usuario ha elegido últimamente y de sus listas;
    //   · canción suelta, búsqueda o lista automática → de lo que el usuario ha puesto en esa sesión.
    const RADIO_RETRY_MS = 30_000;
    const radioRuns = new Map();             // por usuario: { busy, status, sessionId, count, at }
    const radioState = userId => {
        const { radio: memory, sessions } = stores.for(userId);
        const run = radioRuns.get(userId);
        return { enabled: memory.enabled, status: run && sessions.view()?.id === run.sessionId ? run.status : 'idle' };
    };

    // Claves de YouTube de las que puede partir la radio. Las canciones de SoundCloud no valen
    // (no tienen mezcla); las de Spotify valen por su coincidencia.
    async function seedKeysOf(tracks) {
        const keys = tracks.map(track => audioKeyOf(track.key)).filter(key => key?.startsWith('yt:'));
        if (keys.length >= RADIO_SEEDS) return keys;
        // Lista de Spotify que aún no ha sonado: se busca la coincidencia de unas pocas, que hacen de semilla
        const unknown = tracks.filter(track => track.key.startsWith('sp:') && !audioKeyOf(track.key)).sort(() => Math.random() - 0.5);
        for (const track of unknown.slice(0, RADIO_SEEDS - keys.length)) {
            const source = await resolveAudio(track.key).catch(() => null);
            if (source?.key.startsWith('yt:')) keys.push(source.key);
        }
        return keys;
    }

    // De qué radio es una sesión. Cada una rota sus semillas y aprende de sus saltos por separado:
    // un salto en la radio de «rock» no le quita nada a «Tu radio» ni a la de otra lista.
    // La radio de un artista (§18) es «artist:<id>», igual que la opción «Radio» en sus canciones:
    // las dos son la radio de ese artista y aprenden de los mismos saltos.
    const artistRadioId = source => (source?.type === 'radio' && /^artist:UC[A-Za-z0-9_-]{22}$/.test(source.id ?? '') ? source.id.slice(7) : null);
    function radioScope(source) {
        if (source?.type === 'list' && source.id) return `list:${source.id}`;
        if (source?.type === 'radio') return artistRadioId(source) ? source.id : 'home';
        if (['auto', 'album', 'artist'].includes(source?.type) && source.id) return `${source.type}:${source.id}`;
        return 'loose';
    }

    // Dejar antes de 15 s una canción que puso la radio = saltarla (decisión del usuario, 17-11)
    const SKIP_MS = 15_000;
    function noteSkip(req, source, { track, heardMs }) {
        if (heardMs === null || heardMs >= SKIP_MS) return;      // no llegó a sonar, o ya se escuchó un rato
        const scope = radioScope(source);
        const result = req.ctx.radio.skip(scope, track);
        if (!result) return;
        const blocked = result.blocked ? `; ${result.blocked.name} queda fuera de esa radio hasta el ${result.blocked.until.slice(0, 10)}` : '';
        log(`[radio] ${req.user.name} salta «${track.title}» a los ${Math.round(heardMs / 1000)} s (${scope})${blocked}`);
    }

    /**
     * Una tanda para el usuario. `home` = para empezar «Tu radio»; `artist` = para empezar la radio de
     * ese artista (su página de YouTube Music); si no, para seguir la sesión abierta.
     */
    async function radioBatch(ctx, { home = false, artist = null } = {}) {
        const { sessions, lists, history, radio: memory } = ctx;
        const exclude = new SongSet();
        const known = track => {
            exclude.add(track);
            exclude.addKey(audioKeyOf(track.key));
        };
        const inSession = sessions.allTracks();
        inSession.forEach(known);
        const source = home ? { type: 'radio' } : artist ? { type: 'radio', id: `artist:${artist.id}` } : sessions.view()?.source;
        const list = source?.type === 'list' ? lists.get(source.id) : null;
        const artistId = artistRadioId(source);
        let scope;
        let seedTracks;
        if (list) {
            scope = `list:${list.id}`;
            seedTracks = list.tracks;
            list.tracks.forEach(known);
        } else if (artistId) {
            // La radio de un artista parte de sus 20 canciones más escuchadas (y de lo que el usuario
            // haya puesto en la sesión). Sus canciones pueden salir: la mezcla trae suyas y de parecidos.
            scope = `artist:${artistId}`;
            const page = artist ?? await ytmusic?.artist(artistId).catch(() => null);
            seedTracks = [...(page?.songs.slice(0, 20) ?? []), ...inSession.filter(track => !track.radio || track.saved)];
        } else if (source?.type === 'radio') {
            scope = 'home';
            const seen = new Set();
            seedTracks = [];
            const take = track => {
                known(track);
                if (!seen.has(track.key)) {
                    seen.add(track.key);
                    seedTracks.push(track);
                }
            };
            // Lo último que ha elegido él (no lo que le puso la radio) y todo lo que tiene en sus listas
            for (const entry of history.recent(300)) {
                if (seen.size >= 60) break;
                if (entry.track?.key && !(entry.track.radio && !entry.track.saved)) take(entry.track);
            }
            for (const summary of lists.all()) (lists.get(summary.id)?.tracks ?? []).forEach(take);
        } else {
            scope = radioScope(source);
            seedTracks = inSession.filter(track => !track.radio || track.saved);
        }
        const seedKeys = await seedKeysOf(seedTracks);
        const fallbackKeys = home ? [] : inSession.filter(track => track.radio && !track.saved).map(track => track.key);
        const { tracks } = await radio.batch({ scope, seedKeys, fallbackKeys, exclude, memory });
        note({ radioBatches: 1 });
        return { tracks, seeds: seedKeys.length, scope };
    }

    function maybeRadio(userId) {
        if (!radio) return;
        const ctx = stores.for(userId);
        const { sessions } = ctx;
        const view = sessions.view();
        if (!view || !(ctx.radio.enabled || view.source?.type === 'radio')) return;
        if (view.repeat !== 'off' || sessions.remaining > 1) return;
        const last = radioRuns.get(userId);
        if (last?.busy) return;
        // Si el último intento para este mismo punto no dio nada, se espera antes de volver a probar
        if (last && last.sessionId === view.id && last.count === view.count && last.status !== 'idle' && Date.now() - last.at < RADIO_RETRY_MS) return;
        const run = { busy: true, status: 'loading', sessionId: view.id, count: view.count, at: Date.now() };
        radioRuns.set(userId, run);
        radioBatch(ctx).then(({ tracks, scope }) => {
            run.busy = false;
            run.at = Date.now();
            if (sessions.view()?.id !== run.sessionId) {       // la sesión cambió mientras se buscaba
                run.status = 'idle';
                return;
            }
            const added = sessions.appendRadio(tracks);
            run.status = added ? 'idle' : 'empty';
            log(`[radio] ${scope}: ${added ? `${added} canciones añadidas` : 'no ha salido ninguna canción nueva'}`);
            if (added) syncAudio(userId);
        }).catch(error => {
            run.busy = false;
            run.at = Date.now();
            run.status = 'error';
            log(`[radio] error: ${String(error?.message ?? error).slice(0, 200)}`);
        });
    }

    // Una sesión por usuario, compartida entre sus dispositivos (D35), pero solo uno la lleva a la
    // vez: el último que empezó a reproducir o pidió continuar. `active` le dice a cada dispositivo
    // si es él; a los demás, avanzar o informar de su posición se les rechaza (409).
    const entryShown = shown => entry => (entry ? { index: entry.index, track: shown(entry.track) } : null);
    const viewShown = (req, view, entry = entryShown(showFor(req.ctx))) => (view ? {
        ...view,
        device: undefined,
        active: !view.device || view.device === req.device.id,
        radio: radioState(req.user.id),
        // Si la lleva otro dispositivo del usuario, cuál («estaba sonando en tu Pocophone»)
        deviceName: view.device && view.device !== req.device.id ? auth.deviceName(req.user.id, view.device) : null,
        window: { prev: entry(view.window.prev), current: entry(view.window.current), next: entry(view.window.next) },
    } : null);
    const otherDevice = req => {
        const holder = req.ctx.sessions.view()?.device;
        if (!holder || holder === req.device.id) return false;
        // Si el dispositivo que la llevaba ya no existe (cerró sesión, cambió la contraseña), la sesión
        // queda libre y se la queda quien pregunta. Así no se bloquea una app que no sabe pedirla.
        if (auth.hasDevice(req.user.id, holder)) return true;
        req.ctx.sessions.claim(req.device.id);
        return false;
    };

    const reply = (req, res, view, error = 'no_session') => {
        if (!view) return res.status(req.ctx.sessions.active ? 400 : 404).json({ error: req.ctx.sessions.active ? error : 'no_session' });
        syncAudio(req.user.id);
        maybeRadio(req.user.id);
        res.json({ session: viewShown(req, view) });
    };

    priv.get('/session', (req, res) => res.json({ session: viewShown(req, req.ctx.sessions.view()) }));

    priv.post('/session', async (req, res) => {
        const body = req.body ?? {};
        // «Tu radio» (Inicio): una sesión hecha solo de canciones parecidas a lo que escucha
        if (body.radio === 'home') {
            if (!radio) return res.status(404).json({ error: 'not_found' });
            // Hasta tres intentos seguidos: una mezcla lenta sigue leyéndose por detrás y el siguiente la encuentra hecha
            let first = null;
            for (let attempt = 1; attempt <= 3 && !first; attempt++) {
                try {
                    first = await radioBatch(req.ctx, { home: true });
                } catch (error) {
                    log(`[radio] «Tu radio», intento ${attempt}: ${String(error?.message ?? error).slice(0, 200)}`);
                }
            }
            if (!first) return res.status(502).json({ error: 'radio_failed' });
            if (first.tracks.length === 0) return res.status(422).json({ error: first.seeds ? 'radio_empty' : 'no_seeds' });
            log(`[radio] «Tu radio» de ${req.user.name}: empieza con ${first.tracks.length} canciones`);
            return reply(req, res, req.ctx.sessions.start({ source: { type: 'radio', name: 'Tu radio' }, tracks: first.tracks, device: req.device.id }));
        }
        // La radio de un artista (§18): empieza con una de sus 5 más escuchadas y sigue con parecidas
        // (suyas y de otros artistas), que aprenden de los saltos aparte de las demás radios
        if (body.radio === 'artist') {
            if (!radio || !ytmusic) return res.status(404).json({ error: 'not_found' });
            if (!ARTIST_ID.test(String(body.artistId ?? ''))) return res.status(400).json({ error: 'bad_id' });
            let page;
            try {
                page = await ytmusic.artist(body.artistId);
            } catch (error) {
                return ytmFailed(res, error, `radio del artista ${body.artistId}`);
            }
            if (!page) return res.status(404).json({ error: 'artist_not_found' });
            if (page.songs.length === 0) return res.status(422).json({ error: 'no_seeds' });
            let first = null;
            for (let attempt = 1; attempt <= 3 && !first; attempt++) {
                try {
                    first = await radioBatch(req.ctx, { artist: page });
                } catch (error) {
                    log(`[radio] radio de ${page.name}, intento ${attempt}: ${String(error?.message ?? error).slice(0, 200)}`);
                }
            }
            if (!first) return res.status(502).json({ error: 'radio_failed' });
            const opener = page.songs[Math.floor(Math.random() * Math.min(5, page.songs.length))];
            const openerSet = new SongSet();
            openerSet.add(opener);
            const tracks = [opener, ...first.tracks.filter(track => !openerSet.has(track))];
            log(`[radio] radio de ${page.name} para ${req.user.name}: empieza con ${tracks.length} canciones`);
            return reply(req, res, req.ctx.sessions.start({ source: { type: 'radio', id: `artist:${page.id}`, name: `Radio de ${page.name}` }, tracks, device: req.device.id }));
        }
        // Una lista automática: se calcula ahora y suena como una lista (con la radio, de lo que haya en la sesión)
        if (body.auto !== undefined) {
            const auto = isAutoKind(body.auto) ? listeningOf(req).auto(body.auto) : null;
            if (!auto) return res.status(404).json({ error: 'auto_not_found' });
            if (auto.count === 0) return res.status(400).json({ error: 'empty_list' });
            const tracks = auto.rows.map(row => row.track);
            matches?.remember(tracks);
            return reply(req, res, req.ctx.sessions.start({
                source: { type: 'auto', id: auto.kind, name: auto.name },
                tracks,
                startKey: typeof body.startKey === 'string' ? body.startKey : null,
                shuffle: body.shuffle === true,
                device: req.device.id,
            }));
        }
        // Un disco, o todas las canciones de un artista (§18): suenan como una lista que no es suya
        if (body.album !== undefined || body.artist !== undefined) {
            if (!ytmusic) return res.status(404).json({ error: 'not_found' });
            const isAlbum = body.album !== undefined;
            const id = String(isAlbum ? body.album : body.artist);
            if (!(isAlbum ? ALBUM_ID : ARTIST_ID).test(id)) return res.status(400).json({ error: 'bad_id' });
            let found;
            try {
                found = isAlbum ? await ytmusic.album(id) : await ytmusic.artist(id);
            } catch (error) {
                return ytmFailed(res, error, `${isAlbum ? 'disco' : 'artista'} ${id}`);
            }
            if (!found) return res.status(404).json({ error: isAlbum ? 'album_not_found' : 'artist_not_found' });
            const tracks = isAlbum ? found.tracks : found.songs;
            if (tracks.length === 0) return res.status(400).json({ error: 'empty_list' });
            return reply(req, res, req.ctx.sessions.start({
                source: isAlbum ? { type: 'album', id: found.id, name: found.title } : { type: 'artist', id: found.id, name: found.name },
                tracks,
                startKey: typeof body.startKey === 'string' ? body.startKey : null,
                shuffle: body.shuffle === true,
                device: req.device.id,
            }));
        }
        if (body.listId !== undefined) {
            const list = req.ctx.lists.get(body.listId);
            if (!list) return res.status(404).json({ error: 'list_not_found' });
            if (list.tracks.length === 0) return res.status(400).json({ error: 'empty_list' });
            return reply(req, res, req.ctx.sessions.start({
                source: { type: 'list', id: list.id, name: list.name },
                tracks: list.tracks,
                startKey: typeof body.startKey === 'string' ? body.startKey : null,
                shuffle: body.shuffle === true,
                device: req.device.id,
            }));
        }
        const track = trackFrom(body.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        reply(req, res, req.ctx.sessions.start({ source: { type: 'search', name: 'Búsqueda' }, tracks: [track], device: req.device.id }));
    });

    // «Continuar» en este dispositivo: pasa a ser él quien lleva la sesión
    priv.post('/session/claim', (req, res) => reply(req, res, req.ctx.sessions.claim(req.device.id)));

    // La canción se puede señalar por posición o por clave. La app usa la clave: las posiciones
    // se mueven cuando se toca la cola, las claves no.
    const indexFrom = req => (Number.isInteger(req.body?.index) ? req.body.index : req.ctx.sessions.indexOf(req.body?.key));

    priv.post('/session/goto', (req, res) => {
        if (otherDevice(req)) return res.status(409).json({ error: 'other_device' });
        const { sessions } = req.ctx;
        const index = indexFrom(req);
        // Si se deja una canción de la radio sin apenas oírla, la radio lo aprende
        const leaving = Number.isInteger(index) && sessions.state && index !== sessions.state.index ? sessions.leaving() : null;
        const source = sessions.session?.source;
        const view = sessions.goto(index);
        if (view && leaving) noteSkip(req, source, leaving);
        reply(req, res, view, 'bad_index');
    });

    const setOptions = (req, res) => reply(req, res, req.ctx.sessions.setOptions(req.body ?? {}));
    priv.patch('/session', setOptions);
    priv.put('/session', setOptions);        // alias: el cliente HTTP de Android no admite PATCH en todas las versiones

    priv.put('/session/state', (req, res) => {
        if (otherDevice(req)) return res.status(409).json({ error: 'other_device' });
        const result = req.ctx.sessions.report({ index: indexFrom(req), positionMs: Number(req.body?.positionMs) });
        if (result?.played) req.ctx.history.append(result.played);
        if (result && usage) {
            // Consumo: tiempo escuchado (lo que avanza la canción entre informes) y canciones que cuentan como escuchadas
            usage.listened(req.user.id, req.ctx.sessions.view()?.window.current?.track.key, Number(req.body?.positionMs));
            if (result.played) note({ plays: 1 });
        }
        // `count` avisa al cliente de que la sesión ha crecido (la radio añadió canciones) y debe volver a pedirla
        maybeRadio(req.user.id);
        res.json({ ok: Boolean(result), count: req.ctx.sessions.count, radio: radioState(req.user.id).status });
    });

    priv.get('/session/queue', (req, res) => {
        const queue = req.ctx.sessions.queue(int(req.query.from), int(req.query.limit));
        if (!queue) return res.status(404).json({ error: 'no_session' });
        res.json({ ...queue, entries: queue.entries.map(entryShown(showFor(req.ctx))) });
    });

    priv.post('/session/queue', (req, res) => {
        const track = trackFrom(req.body?.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        // Sin sesión abierta, «a continuación» o «añadir a la cola» equivale a reproducir
        if (!req.ctx.sessions.active) return reply(req, res, req.ctx.sessions.start({ source: { type: 'search', name: 'Búsqueda' }, tracks: [track], device: req.device.id }));
        reply(req, res, req.ctx.sessions.enqueue(track, req.body?.mode === 'next' ? 'next' : 'end'));
    });

    // Mover y quitar también se piden por clave. Por clave, una orden repetida no hace daño:
    // por posición, una segunda orden idéntica quitaría la canción que ha ocupado ese hueco.
    priv.post('/session/queue/move', (req, res) => {
        const from = Number.isInteger(req.body?.from) ? req.body.from : req.ctx.sessions.indexOf(req.body?.key);
        reply(req, res, req.ctx.sessions.moveQueued(from, req.body?.to), 'bad_move');
    });

    priv.delete('/session/queue/:ref', (req, res) => {
        const byIndex = int(req.params.ref);
        if (byIndex !== undefined) return reply(req, res, req.ctx.sessions.removeQueued(byIndex), 'bad_index');
        const index = req.ctx.sessions.indexOf(req.params.ref);
        // Si la canción ya no está en la cola (orden repetida), no pasa nada: se devuelve la sesión tal cual
        if (index === null) return reply(req, res, req.ctx.sessions.view());
        log(`[sesion] quitar de la cola: ${req.params.ref}`);
        reply(req, res, req.ctx.sessions.removeQueued(index), 'bad_index');
    });

    // La opción «Radio» es del usuario, no de la sesión: se recuerda de una sesión a otra
    priv.get('/radio', (req, res) => res.json({ radio: radioState(req.user.id) }));
    priv.put('/radio', (req, res) => {
        if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'bad_request' });
        req.ctx.radio.setEnabled(req.body.enabled);
        maybeRadio(req.user.id);
        res.json({ radio: radioState(req.user.id) });
    });

    // --- Historial ---
    priv.get('/history', (req, res) => {
        const limit = Math.min(int(req.query.limit) ?? 30, 200);
        let entries = req.ctx.history.recent(req.query.distinct ? limit * 4 : limit);
        if (req.query.distinct) {
            const seen = new Set();
            entries = entries.filter(e => !seen.has(e.track.key) && seen.add(e.track.key)).slice(0, limit);
        }
        const shown = showFor(req.ctx);
        res.json({ entries: entries.map(entry => ({ ...entry, track: shown(entry.track) })) });
    });

    // --- «Me gusta» ---
    // El corazón mete la canción en la lista de «me gusta» del usuario, arriba del todo, o la saca
    // (a la papelera, como cualquier canción quitada). La lista es una lista normal: la primera vez
    // se adopta una que ya se llame así («likes», «me gusta»…) y, si no hay, se crea.
    priv.put('/likes', (req, res) => {
        const track = trackFrom(req.body?.track);
        if (!track) return res.status(400).json({ error: 'bad_track' });
        if (typeof req.body?.liked !== 'boolean') return res.status(400).json({ error: 'bad_request' });
        const { lists, sessions } = req.ctx;
        if (req.body.liked) {
            const id = lists.likesId({ create: true });
            // La misma canción por otra vía (de Spotify, o en otro vídeo) ya cuenta: no se duplica
            const { added, list } = likesOf(req.ctx).has(track) ? { added: 0, list: lists.get(id) } : lists.addTracks(id, [track], { top: true });
            // Si era una canción que puso la radio, al guardarla deja de ser «de la radio»
            sessions.markSaved(track.key);
            return res.json({ liked: true, added, list: lists.summaryOf(list) });
        }
        const id = lists.likesId();
        let removed = 0;
        // Si está más de una vez (por Spotify y por YouTube), salen todas
        for (let key; id && removed < 10 && (key = likesOf(req.ctx).find(track)); removed++) lists.removeTrack(id, key);
        res.json({ liked: false, removed, list: id ? lists.summaryOf(lists.get(id)) : null });
    });

    // --- Fase 3: importar una playlist de fuera a una lista propia ---
    // Dos pasos, como en la maqueta: primero se lee la lista y se enseña qué trae; al confirmar se añade.
    priv.post('/import/preview', async (req, res) => {
        const list = req.ctx.lists.get(req.body?.listId);
        if (!list) return res.status(404).json({ error: 'list_not_found' });
        const link = await followShort(parseLink(req.body?.url)).catch(() => null);
        if (!link) return res.status(400).json({ error: 'bad_link' });
        if (link.kind === 'yt-mix') return res.status(400).json({ error: 'mix_not_supported' });
        const readers = {
            'yt-playlist': () => importers.youtubePlaylist(link.id),
            'sp-playlist': () => importers.spotifyPlaylist(link.id),
            'sc-playlist': () => importers.soundcloudSet(link),
        };
        if (!readers[link.kind]) return res.status(400).json({ error: 'not_a_playlist' });
        let found;
        try {
            found = await readers[link.kind]();
        } catch (error) {
            log(`[importar] ${link.kind} ${link.id ?? `${link.user}/${link.slug}`}: ${String(error.message).slice(0, 200)}`);
            return res.status(502).json({ error: 'import_failed' });
        }
        const seen = new Set();
        const tracks = found.tracks.map(cleanTrack).filter(track => track && !seen.has(track.key) && seen.add(track.key));
        if (tracks.length === 0) return res.status(422).json({ error: 'empty_playlist' });
        const present = new Set(list.tracks.map(track => track.key));
        const fresh = tracks.filter(track => !present.has(track.key)).length;
        log(`[importar] «${found.title}» (${found.platform}): ${tracks.length} canciones, ${fresh} nuevas para «${list.name}»`);
        res.json({
            importId: pending.put({ userId: req.user.id, listId: list.id, tracks }),
            platform: found.platform,
            title: found.title,
            thumb: found.thumb,
            count: tracks.length,
            newCount: fresh,
            already: tracks.length - fresh,
            truncated: Boolean(found.truncated),
        });
    });

    // Importar un bloque de enlaces de canciones de Spotify: lo que copia su programa al seleccionar
    // una lista entera (su página pública solo enseña 100). Cada canción se lee de su propia página.
    // El panel lo manda por tandas; todas se suman a la misma importación pendiente, que se confirma
    // con /lists/:id/import como cualquier otra.
    const spotifyTrackId = text => {
        if (typeof text !== 'string' || text.length > 300) return null;
        const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(text.trim());
        if (uri) return uri[1];
        const link = parseLink(text.trim());
        return link?.kind === 'sp-track' ? link.id : null;
    };

    priv.post('/import/links', async (req, res) => {
        const list = req.ctx.lists.get(req.body?.listId);
        if (!list) return res.status(404).json({ error: 'list_not_found' });
        const links = req.body?.links;
        if (!Array.isArray(links) || links.length === 0 || links.length > LINKS_PER_CALL) return res.status(400).json({ error: 'bad_request' });
        let importId = req.body?.importId;
        let ready = null;
        if (importId !== undefined) {
            ready = pending.get(importId);
            if (!ready || !ready.links || ready.listId !== list.id || ready.userId !== req.user.id) return res.status(410).json({ error: 'import_expired' });
        }

        const ids = links.map(spotifyTrackId);
        const ignored = ids.filter(id => !id).length;
        const known = new Set((ready?.tracks ?? []).map(track => track.key));
        const todo = [...new Set(ids.filter(Boolean))].filter(id => !known.has(`sp:${id}`));

        // De cuatro en cuatro (medido: unas 14 canciones por segundo sin que Spotify se queje)
        const read = new Array(todo.length).fill(null);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(LINKS_AT_ONCE, todo.length) }, async () => {
            while (next < todo.length) {
                const at = next++;
                for (let attempt = 1; attempt <= 2 && !read[at]; attempt++) {
                    try {
                        const track = cleanTrack(await importers.spotifyTrack(todo[at]));
                        if (track?.title) read[at] = track;
                    } catch { /* se reintenta una vez; si vuelve a fallar, cuenta como no leída */ }
                }
            }
        }));
        const fresh = read.filter(Boolean);
        const tracks = [...(ready?.tracks ?? []), ...fresh];
        const value = { userId: req.user.id, listId: list.id, tracks, links: true };
        if (ready) pending.update(importId, value);
        else importId = pending.put(value);

        const present = new Set(list.tracks.map(track => track.key));
        const newCount = tracks.filter(track => !present.has(track.key)).length;
        const failed = todo.length - fresh.length;
        log(`[importar] enlaces de Spotify: ${fresh.length} leídas${failed ? `, ${failed} sin leer` : ''}${ignored ? `, ${ignored} que no eran canciones` : ''}; van ${tracks.length} (${newCount} nuevas) para «${list.name}»`);
        res.json({
            importId,
            platform: 'spotify',
            title: 'Canciones pegadas',
            thumb: tracks[0]?.thumb ?? null,
            count: tracks.length,
            newCount,
            already: tracks.length - newCount,
            truncated: false,
            batch: { read: fresh.length, failed, ignored },
        });
    });

    priv.post('/lists/:id/import', (req, res) => {
        const list = listOr404(req, res);
        if (!list) return;
        const ready = pending.get(req.body?.importId);
        if (!ready || ready.listId !== list.id || ready.userId !== req.user.id) return res.status(410).json({ error: 'import_expired' });
        matches.remember(ready.tracks);
        const { added, list: updated } = req.ctx.lists.addTracks(list.id, ready.tracks);
        res.json({ added, list: req.ctx.lists.summaryOf(updated) });
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

    // --- Canciones que fallaron (§19, mockups/fallos-v1.html) ---
    // Las de cada usuario, la más reciente primero. Salen solas al volver a sonar bien (clearFailure),
    // al ponerles otro enlace o al descartarlas.
    const failureShown = req => {
        const shown = showFor(req.ctx);
        return item => ({ ...item, track: shown(item.track) });
    };
    const failureOr404 = (req, res) => {
        const failure = req.ctx.failures.get(req.params.key);
        if (!failure) res.status(404).json({ error: 'failure_not_found' });
        return failure;
    };

    priv.get('/failures', (req, res) => {
        const items = req.ctx.failures.all();
        res.json({ count: items.length, failures: items.map(failureShown(req)) });
    });

    priv.get('/failures/:key', (req, res) => {
        const failure = failureOr404(req, res);
        if (failure) res.json({ failure: failureShown(req)(failure) });
    });

    // «Descartar»: deja de salir aquí, sin tocar nada más
    priv.delete('/failures/:key', (req, res) => {
        if (!failureOr404(req, res)) return;
        req.ctx.failures.remove(req.params.key);
        res.json({ ok: true, count: req.ctx.failures.count });
    });

    // «Poner otro enlace»: otros vídeos de YouTube de la misma canción, con lo que se alejan de su duración.
    // En una de Spotify son los candidatos de su coincidencia.
    priv.get('/failures/:key/candidates', async (req, res) => {
        const failure = failureOr404(req, res);
        if (!failure) return;
        const { track } = failure;
        try {
            if (track.key.startsWith('sp:')) {
                matches?.remember([track]);
                const candidates = await matches.candidates(track.key, 8);
                return res.json({ current: matches.get(track.key)?.yt?.key ?? null, candidates: candidates ?? [] });
            }
            const query = [artistOf(track), cleanTitle(track.title)].filter(Boolean).join(' ');
            const results = await search(query);
            const diff = result => (Number.isFinite(result.durationSec) && Number.isFinite(track.durationSec) ? result.durationSec - track.durationSec : null);
            res.json({ current: audioKeyOf(track.key), candidates: results.slice(0, 8).map(result => ({ ...result, durationDiff: diff(result) })) });
        } catch (error) {
            log(`[fallos] candidatos de ${track.key}: ${String(error?.message ?? error).slice(0, 200)}`);
            res.status(502).json({ error: 'search_failed' });
        }
    });

    // Elegir el vídeo (`track`) o pegar un enlace (`url`). Vale para todos los usuarios: en una canción de
    // YouTube o SoundCloud queda como su otro enlace; en una de Spotify, como su coincidencia.
    priv.put('/failures/:key/link', async (req, res) => {
        const failure = failureOr404(req, res);
        if (!failure) return;
        const { key } = failure;
        if (!key.startsWith('sp:') && !alternates) return res.status(404).json({ error: 'not_found' });
        let chosen = null;
        if (typeof req.body?.url === 'string') {
            const link = parseLink(req.body.url.trim());
            if (link?.kind !== 'yt-video') return res.status(400).json({ error: 'bad_link' });
            try {
                chosen = cleanTrack(await importers.youtubeVideo(link.id));
            } catch (error) {
                log(`[fallos] enlace ${link.id}: ${String(error?.message ?? error).slice(0, 200)}`);
                return res.status(502).json({ error: 'link_failed' });
            }
            if (!chosen) return res.status(400).json({ error: 'bad_link' });
        } else {
            chosen = cleanTrack(req.body?.track);
        }
        if (!chosen || chosen.platform !== 'youtube') return res.status(400).json({ error: 'bad_track' });
        if (key.startsWith('sp:')) {
            matches.remember([failure.track]);
            matches.choose(key, chosen);
        } else {
            alternates.set(key, chosen, req.user.name);
        }
        req.ctx.failures.remove(key);
        syncPins();
        log(`[fallos] ${req.user.name}: «${failure.track.title}» suena ahora desde ${chosen.key}`);
        res.json({ ok: true, current: chosen, count: req.ctx.failures.count });
    });

    // --- Fase 4: papelera ---
    // Lo quitado (listas y canciones) se puede ver y devolver a su sitio. No hay «vaciar»: nada se borra.
    priv.get('/trash', (req, res) => {
        const { lists, tracks } = req.ctx.lists.trash();
        res.json({ lists, tracks: tracks.map(item => ({ ...item, track: show(item.track) })) });
    });

    priv.post('/trash/restore', (req, res) => {
        const { type, id, listId } = req.body ?? {};
        let result = { error: 'bad_request' };
        if (type === 'list') result = req.ctx.lists.restoreList(id);
        else if (type === 'track' && typeof id === 'string') result = req.ctx.lists.restoreTrack(id, typeof listId === 'string' ? listId : null);
        if (result.error) return res.status({ not_found: 404, bad_request: 400 }[result.error] ?? 409).json({ error: result.error });
        log(`[papelera] ${req.user.name} restaura ${type === 'list' ? 'la lista' : 'una canción en'} «${result.list.name}»`);
        res.json({ ok: true, added: result.added ?? null, list: req.ctx.lists.summaryOf(result.list) });
    });

    // --- Consumo: lo que gasta cada usuario y la máquina. Solo lo ve el dueño. ---
    priv.get('/usage', (req, res) => {
        if (!usage) return res.status(404).json({ error: 'not_found' });
        if (!req.user.admin) return res.status(403).json({ error: 'forbidden' });
        const days = Math.min(Math.max(int(req.query.days) ?? 7, 1), 92);
        res.json(usage.report({ days, users: auth.users() }));
    });

    // --- Fase 4: «Probar extracción» (Ajustes) ---
    // Comprueba, sin pasar por la memoria de audio, que el buscador responde y que YouTube entrega audio.
    let probing = false;
    priv.post('/diagnostics/extract', async (req, res) => {
        if (probing) return res.status(429).json({ error: 'busy' });
        probing = true;
        try {
            const result = { search: null, extract: null };
            let started = Date.now();
            try {
                const found = await search('me at the zoo');
                result.search = { ok: found.length > 0, ms: Date.now() - started };
            } catch {
                result.search = { ok: false, ms: Date.now() - started };
            }
            started = Date.now();
            result.extract = await new Promise(resolve => {
                const stream = open(`https://www.youtube.com/watch?v=${PROBE_VIDEO}`, {});
                let settled = false;
                let timer = null;
                const finish = outcome => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    stream.kill();
                    resolve({ ...outcome, ms: Date.now() - started });
                };
                timer = setTimeout(() => finish({ ok: false, message: 'YouTube no ha respondido a tiempo' }), probeTimeoutMs);
                stream.stdout.once('data', () => finish({ ok: true }));
                stream.done.then(({ stderr }) => finish({ ok: false, message: explain(stderr) }));
            });
            result.ok = result.search.ok && result.extract.ok;
            log(`[probar] buscador ${result.search.ok ? 'bien' : 'MAL'} (${result.search.ms} ms), extracción ${result.extract.ok ? 'bien' : 'MAL'} (${result.extract.ms} ms)`);
            res.json(result);
        } finally {
            probing = false;
        }
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

    // --- Panel web: las páginas son archivos tal cual, sin compilar ---
    if (webDir) {
        app.use(express.static(webDir, {
            index: 'index.html',
            setHeaders: res => {
                res.setHeader('Cache-Control', 'no-cache');        // siempre la versión desplegada, comprobando si cambió
                res.setHeader('Content-Security-Policy', WEB_CSP);
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Referrer-Policy', 'no-referrer');
            },
        }));
    }
    app.use((req, res) => res.status(404).end());
    // Errores no previstos (p. ej. JSON mal formado): respuesta corta, sin trazas
    app.use((error, req, res, next) => {    // eslint-disable-line no-unused-vars
        if (res.headersSent) return res.destroy();
        res.status(error.status === 400 || error.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'bad_request' });
    });

    return app;
}
