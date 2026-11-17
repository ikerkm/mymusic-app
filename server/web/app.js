// MyMusic — panel web. Sin dependencias ni compilación: este archivo es lo que se sirve.
// Estructura de pantallas: mockups/web-v1.html. La lógica de la sesión es la misma que en la app
// de Android: el servidor lleva la lista y el orden; aquí solo se conoce anterior / actual / siguiente.

// ---------------------------------------------------------------- utilidades

const SVG_NS = 'http://www.w3.org/2000/svg';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const enc = encodeURIComponent;
const okThumb = url => typeof url === 'string' && url.startsWith('https://');

/** Crea un elemento. Los textos entran siempre como texto, nunca como HTML: los títulos vienen de fuera. */
function h(spec, props, ...children) {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value == null) continue;
        if (key.startsWith('on')) { if (value) el.addEventListener(key.slice(2), value); }
        else if (key === 'class') el.classList.add(...String(value || '').split(' ').filter(Boolean));
        else if (key === 'data') Object.assign(el.dataset, value);
        else if (key in el) el[key] = value;
        else if (value !== false) el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child);
    return el;
}

function icon(name, extra = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `ic ${extra}`.trim());
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}

function fmt(seconds) {
    const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
function fmtTotal(seconds) {
    const minutes = Math.round((seconds ?? 0) / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
const songs = n => (n === 1 ? '1 canción' : `${n} canciones`);

/** Carátula: la imagen si la hay; si no (o si falla), un degradado que depende de la canción. */
function cover(thumb, size, seed = '') {
    let sum = 0;
    for (const ch of String(seed)) sum = (sum + ch.charCodeAt(0)) % 7;
    const blank = () => h('div', { class: `cv ${size} ${sum ? `g${sum}` : ''}` });
    if (!okThumb(thumb)) return blank();
    const img = h('img', { class: `cv ${size}`, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', src: thumb });
    img.addEventListener('error', () => img.replaceWith(blank()), { once: true });
    return img;
}

/** Carátula de una lista. La de «me gusta» lleva un corazón en vez de la imagen de su primera canción. */
function listCover(list, size) {
    return list.likes ? h('div', { class: `cv like ${size}` }, icon('heart', 'liked')) : cover(list.thumb, size, list.id);
}

const PLATFORMS = { youtube: ['yt', 'YouTube'], spotify: ['sp', 'Spotify'], soundcloud: ['sc', 'SoundCloud'] };
function badge(platform) {
    const known = PLATFORMS[platform];
    return known ? h(`span.bd.${known[0]}`, null, known[1]) : null;
}

/** Lo que el servidor guarda de una canción (sin los adornos con los que la devuelve). */
const bare = t => ({ key: t.key, title: t.title, artist: t.artist ?? null, durationSec: t.durationSec ?? null, thumb: t.thumb ?? null, platform: t.platform });

// ---------------------------------------------------------------- pantalla estrecha (móvil)

// En el móvil la estructura es la de la app (mockups/app-v1.html): pestañas abajo, minirreproductor,
// reproductor a pantalla completa, filas que se tocan y menús como hojas. El punto de corte vive solo
// aquí: la hoja de estilos se guía por la clase «m» de <html>.
// (la segunda condición es un móvil tumbado; no alcanza a una tableta, ni siquiera con el teclado abierto)
const narrow = window.matchMedia('(max-width: 700px), (max-width: 950px) and (max-height: 500px) and (pointer: coarse)');
const mobile = () => narrow.matches;
document.documentElement.classList.toggle('m', mobile());

// Zona visible de verdad (en el iPhone el teclado tapa la parte de abajo sin cambiar el tamaño de la página)
const viewport = window.visualViewport;
function syncViewport() {
    document.documentElement.style.setProperty('--vvh', `${viewport.height}px`);
    document.documentElement.style.setProperty('--vvt', `${viewport.offsetTop}px`);
}
if (viewport) {
    viewport.addEventListener('resize', syncViewport);
    viewport.addEventListener('scroll', syncViewport);
    syncViewport();
}

/** Tras cerrar algo con el dedo, ese mismo toque no debe «caer» en lo que había debajo. */
function swallowClick() {
    const stop = event => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, true), 400);
}

/**
 * Reordenar con el dedo las filas hijas de `box`. Con `handle` (selector) se arrastra desde esa zona;
 * sin él, manteniendo pulsada la fila. Al soltar llama a onMove(desde, hasta) con las posiciones.
 */
function touchReorder(box, { handle = null, onMove }) {
    let drag = null;
    const rows = () => [...box.children];
    const clear = () => {
        if (!drag) return;
        clearTimeout(drag.timer);
        cancelAnimationFrame(drag.frame);
        drag.row.classList.remove('lift');
        drag.target?.classList.remove('drop', 'after');
        drag = null;
    };
    const aim = () => {
        const all = rows();
        const target = all.find(row => { const b = row.getBoundingClientRect(); return drag.y >= b.top && drag.y < b.bottom; }) ?? null;
        if (target !== drag.target) drag.target?.classList.remove('drop', 'after');
        drag.target = target === drag.row ? null : target;
        if (drag.target) {
            drag.target.classList.add('drop');
            drag.target.classList.toggle('after', all.indexOf(drag.target) > drag.from);
        }
    };
    const step = () => {        // cerca del borde, la lista se desplaza sola
        if (!drag?.active) return;
        const scroller = box.closest('.main, .drawer');
        if (scroller) {
            const b = scroller.getBoundingClientRect();
            if (drag.y < b.top + 70) scroller.scrollTop -= 9;
            else if (drag.y > b.bottom - 70) scroller.scrollTop += 9;
            aim();
        }
        drag.frame = requestAnimationFrame(step);
    };
    const start = () => {
        if (!drag) return;
        drag.active = true;
        drag.row.classList.add('lift');
        try { navigator.vibrate?.(12); } catch { /* sin vibración */ }
        step();
    };
    box.addEventListener('touchstart', event => {
        clear();
        if (event.touches.length !== 1) return;
        const row = rows().find(item => item.contains(event.target));
        if (!row) return;
        if (handle ? !event.target.closest(handle) : event.target.closest('button')) return;
        const touch = event.touches[0];
        drag = { row, from: rows().indexOf(row), target: null, x: touch.clientX, y: touch.clientY, active: false, timer: 0, frame: 0 };
        if (handle) start();
        else drag.timer = setTimeout(start, 450);
    }, { passive: true });
    box.addEventListener('touchmove', event => {
        if (!drag) return;
        const touch = event.touches[0];
        if (!drag.active) {
            if (Math.hypot(touch.clientX - drag.x, touch.clientY - drag.y) > 10) clear();      // está desplazando la lista
            return;
        }
        if (event.cancelable) event.preventDefault();
        drag.x = touch.clientX;
        drag.y = touch.clientY;
        aim();
    }, { passive: false });
    const finish = commit => () => {
        if (!drag) return;
        const { active, from, target } = drag;
        const to = target ? rows().indexOf(target) : -1;
        clear();
        if (!active) return;
        swallowClick();
        if (commit && to >= 0 && to !== from) onMove(from, to);
    };
    box.addEventListener('touchend', finish(true));
    box.addEventListener('touchcancel', finish(false));
    box.addEventListener('contextmenu', event => { if (drag) event.preventDefault(); });
}

// ---------------------------------------------------------------- servidor

class ApiError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

let onUnauthorized = () => {};

async function api(method, path, body, timeoutMs = 30000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
        const response = await fetch(`/api${path}`, {
            method,
            credentials: 'same-origin',
            // X-MyMusic: el servidor solo acepta cambios hechos con la cookie si vienen de esta página
            headers: { 'X-MyMusic': 'web', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: abort.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401 && path !== '/login') onUnauthorized();
            throw new ApiError(response.status, data.error ?? `http_${response.status}`);
        }
        return data;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(0, 'network');
    } finally {
        clearTimeout(timer);
    }
}

/** Ejecuta una acción del usuario; si falla, avisa en vez de dejar la pantalla a medias. */
async function run(action, message = 'No se pudo completar. Prueba otra vez.') {
    try {
        return await action();
    } catch (error) {
        if (error?.status !== 401) toast(message);
        return undefined;
    }
}

// ---------------------------------------------------------------- estado

const root = document.getElementById('root');
let ui = null;          // zonas de la pantalla, cuando se está dentro
const st = {
    user: null,
    version: '',
    lists: [],
    view: { name: 'home' },      // home | search | list (id) | history
    session: null,               // la sesión tal como la da el servidor
    recent: [],
    history: [],
    list: null,
    search: { query: '', results: null, hint: null, busy: false, error: null },
    queue: { open: false, entries: [], count: 0, limit: 30 },
    full: false,                 // reproductor a pantalla completa (pantalla estrecha)
    radio: false,                // la casilla «Radio» del usuario (se recuerda en el servidor)
};

// ---------------------------------------------------------------- reproductor

const audio = new Audio();
audio.preload = 'auto';
try {
    const saved = Number(localStorage.getItem('mm.volume'));
    if (localStorage.getItem('mm.volume') !== null && saved >= 0 && saved <= 1) audio.volume = saved;
} catch { /* sin almacenamiento: volumen por defecto */ }

// Lo que hay cargado en ESTE navegador (puede no coincidir con la sesión si la lleva otro dispositivo)
const pl = { key: null, track: null, loading: false, error: null, displaced: false, pendingSeek: 0 };

const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : pl.track?.durationSec ?? 0);

/** Pone en el reproductor la canción actual de la sesión, por el minuto que diga la sesión. */
function load(view, { play = true } = {}) {
    st.session = view;
    st.radio = view?.radio?.enabled ?? st.radio;
    const track = view?.window?.current?.track;
    if (!track) return;
    const at = (view.positionMs ?? 0) / 1000;
    pl.error = null;
    pl.displaced = false;
    if (pl.key !== track.key || audio.error) {
        pl.key = track.key;
        pl.track = track;
        pl.pendingSeek = at;
        pl.loading = true;
        audio.src = `/api/stream/${enc(track.key)}`;
    } else {
        pl.track = track;
        if (Math.abs(audio.currentTime - at) > 5) audio.currentTime = at;
    }
    if (play) audio.play().catch(() => {});
    mediaMetadata(track, view);
    document.title = `${track.title} · MyMusic`;
    updateBar();
    markPlaying();
    if (st.view.name === 'home') renderMain();
    if (st.queue.open) refreshQueue();
}

function stopPlayer() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    Object.assign(pl, { key: null, track: null, loading: false, error: null, displaced: false, pendingSeek: 0 });
    document.title = 'MyMusic';
}

async function gotoKey(key) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const { session } = await api('POST', '/session/goto', { key });
            load(session);
            return;
        } catch (error) {
            if (error.status === 409) return displacedNow();
            if (error.status !== 0 && error.status < 500) return;       // la sesión ya no es esa: no insistir
            await sleep(2000 * attempt);
        }
    }
    toast('No se pudo pasar de canción. Revisa la conexión.');
}

// Acaba una canción: el servidor dice cuál es la siguiente
function advance() {
    const session = st.session;
    if (!session || pl.displaced) return updateBar();
    const next = session.window?.next?.track;
    if (session.repeat === 'one' || (next && next.key === pl.key)) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
    }
    if (next) return void gotoKey(next.key);
    // Sin siguiente: puede que la radio la esté buscando o la acabe de añadir
    updateBar();
    waitForNext().then(track => track && gotoKey(track.key));
}

/** Pregunta al servidor si ya hay canción siguiente (la radio añade tandas); espera mientras la esté buscando. */
async function waitForNext() {
    for (let attempt = 0; attempt < 15; attempt++) {
        let session;
        try {
            session = (await api('GET', '/session')).session;
        } catch {
            return null;
        }
        if (!session || session.id !== st.session?.id || session.active === false || pl.displaced) return null;
        if (session.window?.current?.track?.key !== pl.key) return null;
        if (session.window?.next?.track) {
            st.session = session;
            return session.window.next.track;
        }
        if (session.radio?.status !== 'loading') return null;
        await sleep(2000);
    }
    return null;
}

function next() {
    if (pl.displaced || !pl.key) return void resume();
    const track = st.session?.window?.next?.track;
    if (!track) return void waitForNext().then(found => found && gotoKey(found.key));
    if (track.key === pl.key) {
        audio.currentTime = 0;
        return;
    }
    gotoKey(track.key);
}

function prev() {
    if (pl.displaced || !pl.key) return void resume();
    const track = st.session?.window?.prev?.track;
    if (audio.currentTime > 3 || !track || track.key === pl.key) {
        audio.currentTime = 0;
        return;
    }
    gotoKey(track.key);
}

/** «Continuar aquí»: este navegador pasa a llevar la sesión (si sonaba en otro dispositivo, allí se para). */
async function resume() {
    try {
        const { session } = await api('POST', '/session/claim');
        if (session) load(session);
    } catch (error) {
        if (error.status === 404) toast('No hay nada que continuar. Elige una lista o busca una canción.');
        else if (error.status !== 401) toast('No se pudo continuar.');
    }
}

async function togglePlay() {
    if (!audio.paused) return audio.pause();
    // Antes de sonar se mira quién lleva la sesión: si es otro dispositivo, se trae aquí por donde vaya
    let session = st.session;
    try {
        session = (await api('GET', '/session')).session;
    } catch (error) {
        if (error.status === 401) return;
    }
    if (!session) return toast('Elige una lista o busca una canción.');
    if (!pl.key || pl.displaced || session.active === false) return resume();
    st.session = session;
    audio.play().catch(() => {});
}

// Otro dispositivo del mismo usuario ha tomado la sesión: este se calla
function displacedNow() {
    if (pl.displaced) return;
    pl.displaced = true;
    audio.pause();
    toast('Se está escuchando en otro dispositivo.');
    refreshSession().then(() => st.view.name === 'home' && renderMain());
    updateBar();
}

async function report() {
    if (!pl.key || pl.displaced) return;
    const positionMs = Math.floor(audio.currentTime * 1000);
    if (positionMs <= 0) return;
    try {
        const result = await api('PUT', '/session/state', { key: pl.key, positionMs });
        // La sesión ha crecido (la radio añadió canciones): se vuelve a pedir para conocer la siguiente
        if (st.session && Number.isInteger(result?.count) && (result.count !== st.session.count || result.radio !== (st.session.radio?.status ?? 'idle'))) syncSession();
    } catch (error) {
        if (error.status === 409) displacedNow();
    }
}

// El corazón de la canción que suena, puesto al día con lo que dice el servidor (pudo cambiarse desde el móvil)
function freshLike(session) {
    const current = session?.window?.current?.track;
    if (pl.track && current?.key === pl.key && typeof current.liked === 'boolean') pl.track.liked = current.liked;
}

/** Trae la vista de la sesión sin tocar el audio: si otro dispositivo la lleva, este se calla; si ha cambiado, se refleja. */
async function syncSession() {
    if (!st.user || !pl.key || pl.displaced) return;
    let session;
    try {
        session = (await api('GET', '/session')).session;
    } catch {
        return;       // sin red un momento
    }
    if (session && session.active === false) return displacedNow();
    if (!session || session.id !== st.session?.id) return;
    if (session.window?.current?.track?.key !== pl.key) return;      // en pleno cambio de canción: manda lo de aquí
    st.session = session;
    st.radio = session.radio?.enabled ?? st.radio;
    syncRadioChecks();
    freshLike(session);
    updateBar();
    if (st.queue.open) refreshQueue();
}

audio.addEventListener('loadedmetadata', () => {
    const at = pl.pendingSeek;
    pl.pendingSeek = 0;
    if (at > 1 && at < duration() - 5) audio.currentTime = at;
    updateProgress();
});
audio.addEventListener('playing', () => { pl.loading = false; pl.error = null; updateBar(); });
audio.addEventListener('waiting', () => { pl.loading = true; updateBar(); });
audio.addEventListener('canplay', () => { pl.loading = false; updateBar(); });
audio.addEventListener('play', () => updateBar());
audio.addEventListener('pause', () => { report(); updateBar(); });
audio.addEventListener('ended', advance);
audio.addEventListener('timeupdate', () => updateProgress());
audio.addEventListener('durationchange', () => updateProgress());
audio.addEventListener('error', async () => {
    if (!pl.key) return;
    pl.loading = false;
    try {
        await api('GET', '/me');
    } catch (error) {
        if (error.status === 401) return;
    }
    pl.error = 'No se pudo reproducir esta canción.';
    updateBar();
});

// Mientras suena: el servidor sabe por dónde vamos, y se mira si otro dispositivo ha tomado la sesión
setInterval(() => { if (!audio.paused) report(); }, 20000);
setInterval(() => { if (!audio.paused) syncSession(); }, 15000);
window.addEventListener('pagehide', () => {
    if (!pl.key || pl.displaced || !(audio.currentTime > 0)) return;
    fetch('/api/session/state', {
        method: 'PUT', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-MyMusic': 'web' },
        body: JSON.stringify({ key: pl.key, positionMs: Math.floor(audio.currentTime * 1000) }),
    }).catch(() => {});
});

// Teclas multimedia del teclado y controles del sistema
function mediaMetadata(track, view) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title, artist: track.artist ?? '', album: view?.source?.name ?? '',
        artwork: okThumb(track.thumb) ? [{ src: track.thumb }] : [],
    });
}
if ('mediaSession' in navigator) {
    const handlers = {
        play: () => togglePlay(), pause: () => audio.pause(), previoustrack: () => prev(), nexttrack: () => next(),
        seekto: event => { if (event.seekTime != null) audio.currentTime = event.seekTime; },
    };
    for (const [action, handler] of Object.entries(handlers)) {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* acción no admitida */ }
    }
}

// ---------------------------------------------------------------- acciones de reproducción

async function playTrack(track) {
    const { session } = await api('POST', '/session', { track: bare(track) });
    load(session);
}

async function playList(listId, startKey = null, shuffle = false) {
    const { session } = await api('POST', '/session', { listId, startKey, shuffle });
    load(session);
}

async function enqueue(track, mode) {
    try {
        const { session } = await api('POST', '/session/queue', { track: bare(track), mode });
        st.session = session;
        toast(mode === 'next' ? 'Sonará a continuación' : 'Añadida a la cola');
        updateBar();
        refreshQueue();
    } catch (error) {
        if (error.status === 404) return playTrack(track);       // no había nada sonando: se reproduce
        throw error;
    }
}

async function toggleShuffle() {
    if (!st.session) return;
    st.session = (await api('PUT', '/session', { shuffle: !st.session.shuffle })).session;
    updateBar();
    refreshQueue();
}

async function cycleRepeat() {
    if (!st.session) return;
    const modes = ['off', 'all', 'one'];
    const repeat = modes[(modes.indexOf(st.session.repeat) + 1) % modes.length];
    st.session = (await api('PUT', '/session', { repeat })).session;
    updateBar();
}

// ---------------------------------------------------------------- radio (Fase 4)

// Canción que puso la radio y que el usuario aún no ha guardado en una lista
const fromRadio = track => Boolean(track?.radio && !track.saved);

/** Casilla «Radio»: al acabarse lo que suena, seguir con canciones parecidas. Es del usuario, no de la sesión. */
function radioCheck() {
    const input = h('input.radiochk', { type: 'checkbox', onchange: () => run(() => setRadio(input.checked), 'No se pudo cambiar la radio.').then(syncRadioChecks) });
    input.checked = st.radio;
    return h('label.check', { title: 'Al acabarse lo que suena, seguir con canciones parecidas que no tengas ya en la lista' }, input, h('span', null, 'Radio'));
}
function syncRadioChecks() {
    for (const input of document.querySelectorAll('input.radiochk')) input.checked = st.radio;
}
async function setRadio(enabled) {
    const { radio } = await api('PUT', '/radio', { enabled });
    st.radio = radio.enabled;
    if (st.session) st.session.radio = radio;
    syncRadioChecks();
    renderQueue();
    // Si ya se está al final de la lista, el servidor añade la tanda enseguida: se recoge al poco
    if (enabled) for (const ms of [3000, 9000]) setTimeout(syncSession, ms);
}

/** «Tu radio» (Inicio): una sesión de canciones parecidas a lo que escuchas. */
let radioStarting = false;
async function startHomeRadio() {
    if (radioStarting) return;
    radioStarting = true;
    if (st.view.name === 'home') renderMain();
    try {
        const { session } = await api('POST', '/session', { radio: 'home' }, 120000);
        radioStarting = false;
        load(session);
    } catch (error) {
        if (error.status !== 401) {
            toast({
                no_seeds: 'Todavía no hay de dónde partir: escucha algo o crea una lista primero.',
                radio_empty: 'No han salido canciones nuevas. Prueba más tarde.',
            }[error.code] ?? 'No se pudo empezar la radio. Prueba otra vez.');
        }
    } finally {
        radioStarting = false;
        if (st.view.name === 'home') renderMain();
    }
}

/** Guardar una canción que puso la radio: si se escucha una lista, va directa a ella; si no, se elige a cuál. */
async function keepRadioTrack(track) {
    const source = st.session?.source;
    if (source?.type !== 'list') return pickList(track);
    await addToList({ id: source.id, name: source.name }, track);
}
const keepTitle = () => (st.session?.source?.type === 'list' ? `Añadir a «${st.session.source.name}»` : 'Añadir a una lista');

// Guardada en una lista, deja de ser «de la radio» (el servidor lo apunta igual)
function markSaved(key) {
    const hit = track => { if (track?.key === key && track.radio) track.saved = true; };
    const win = st.session?.window;
    for (const entry of [win?.prev, win?.current, win?.next, ...st.queue.entries]) hit(entry?.track);
    hit(pl.track);
    updateBar();
    renderQueue();
}

// ---------------------------------------------------------------- «me gusta»

// El corazón mete la canción en la lista de «me gusta» del usuario (arriba del todo) o la saca. El
// servidor dice de cada canción si está (`liked`), aunque esté por otra vía (Spotify, otro vídeo).

/** Apunta el cambio en las canciones que ya hay en pantalla, sin esperar a volver a pedirlas. */
function markLiked(key, liked) {
    const hit = track => { if (track?.key === key) track.liked = liked; };
    const win = st.session?.window;
    for (const entry of [win?.prev, win?.current, win?.next, ...st.queue.entries]) hit(entry?.track);
    for (const track of [pl.track, ...(st.list?.tracks ?? []), ...(st.search.results ?? []), ...st.recent, ...st.history]) hit(track);
    updateBar();
}

async function setLike(track, liked) {
    const reply = await api('PUT', '/likes', { track: bare(track), liked });
    markLiked(track.key, reply.liked);
    const name = reply.list?.name ?? 'me gusta';
    toast(reply.liked ? (reply.added > 0 ? `Añadida a «${name}»` : `Ya estaba en «${name}»`) : `Quitada de «${name}»`);
    if (reply.liked) markSaved(track.key);
    await refreshLists();
    if (st.view.name === 'list' && st.view.id === reply.list?.id) loadList(reply.list.id);
    else if (st.view.name === 'lists' || st.view.name === 'home') renderMain();
}
const toggleLike = track => run(() => setLike(track, !track.liked), 'No se pudo cambiar el «me gusta». Prueba otra vez.');

/** Botón del corazón del reproductor: relleno si la canción que suena está en «me gusta». */
function likeButton() {
    return h('button.ib.like.hidden', { type: 'button', title: 'Me gusta', onclick: () => pl.track && toggleLike(pl.track) }, icon('heart'));
}
function syncLikeButton(button, track) {
    button.classList.toggle('hidden', !track);
    button.classList.toggle('on', Boolean(track?.liked));
    button.title = track?.liked ? 'Quitar de «me gusta»' : 'Me gusta';
    button.setAttribute('aria-pressed', String(Boolean(track?.liked)));
}

// ---------------------------------------------------------------- datos

async function refreshLists() {
    st.lists = (await api('GET', '/lists')).lists;
    renderSide();
}
async function refreshSession() {
    try {
        st.session = (await api('GET', '/session')).session;
        st.radio = st.session?.radio?.enabled ?? st.radio;
        syncRadioChecks();
        freshLike(st.session);
    } catch { /* se queda la que había */ }
    updateBar();
}
async function refreshRecent() {
    const { entries } = await api('GET', '/history?limit=8&distinct=1');
    st.recent = entries.map(entry => entry.track);
}
async function refreshQueue() {
    if (!st.queue.open) return renderQueue();
    if (st.session) {
        try {
            const page = await api('GET', `/session/queue?from=${st.session.index + 1}&limit=${st.queue.limit}`);
            st.queue.entries = page.entries;
            st.queue.count = page.count;
        } catch { /* se queda la que había */ }
    } else {
        st.queue.entries = [];
        st.queue.count = 0;
    }
    renderQueue();
}

// ---------------------------------------------------------------- avisos, menú y diálogos

let toastEl = null;
let toastTimer = 0;
function toast(text) {
    toastEl?.remove();
    clearTimeout(toastTimer);
    toastEl = h('div.toast', { role: 'status' }, text);
    document.body.append(toastEl);
    toastTimer = setTimeout(() => toastEl?.remove(), 2800);
}

let menuEl = null;
function closeMenu() {
    if (!menuEl) return false;
    menuEl.remove();
    menuEl = null;
    return true;
}
/**
 * Menú emergente junto al punto (x, y). `items`: { label, run, danger, icon } o 'sep'.
 * En pantalla estrecha es una hoja que sube desde abajo, encabezada por la canción (`track`) si la hay.
 */
function openMenu(x, y, items, track = null) {
    closeMenu();
    if (mobile()) {
        const sheet = h('div.sheet', { role: 'menu' },
            track && h('div.row', null, cover(track.thumb, 's40', track.key),
                h('div.t', null, h('b', null, track.title),
                    h('small', null, [track.artist, track.durationSec ? fmt(track.durationSec) : null].filter(Boolean).join(' · '), badge(track.platform)))),
            items.map(item => (item === 'sep' ? h('hr') : h('button.opt', {
                type: 'button', role: 'menuitem', class: item.danger ? 'danger' : '',
                onclick: () => { closeMenu(); run(item.run); },
            }, item.icon && icon(...item.icon.split(' ')), item.label))));
        menuEl = h('div.dim.sheetdim', { onpointerdown: event => { if (event.target === menuEl) { closeMenu(); swallowClick(); } } }, sheet);
        document.body.append(menuEl);
        return;
    }
    menuEl = h('div.menu', { role: 'menu' }, items.map(item => (item === 'sep' ? h('hr') : h('button', {
        type: 'button', role: 'menuitem', class: item.danger ? 'danger' : '',
        onclick: () => { closeMenu(); run(item.run); },
    }, item.label))));
    document.body.append(menuEl);
    const box = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
}
document.addEventListener('pointerdown', event => { if (menuEl && !menuEl.contains(event.target)) closeMenu(); }, true);
window.addEventListener('resize', closeMenu);

const modals = [];
/** Abre un diálogo. `build(close)` devuelve su contenido. */
function openModal(build) {
    const close = () => {
        const at = modals.indexOf(entry);
        if (at >= 0) modals.splice(at, 1);
        dim.remove();
    };
    const modal = h('div.modal', { role: 'dialog' });
    const dim = h('div.dim', { onpointerdown: event => {
        if (event.target !== dim) return;
        close();
        if (event.pointerType !== 'mouse') swallowClick();
    } }, modal);
    const entry = { close };
    modals.push(entry);
    modal.append(...[build(close, modal)].flat(Infinity).filter(Boolean));
    document.body.append(dim);
    // En el móvil, el foco en un campo saca el teclado: solo donde se viene a escribir (un nombre, un enlace)
    if (mobile()) modal.querySelector('input[type=text]')?.focus();
    else (modal.querySelector('input') ?? modal.querySelector('button'))?.focus();
    return close;
}
function closeAllOverlays() {
    closeMenu();
    while (modals.length) modals[modals.length - 1].close();
}

/** Pide un nombre (crear o renombrar una lista). Resuelve con el texto, o null si se cancela. */
function askName(title, initial = '') {
    return new Promise(resolve => {
        let done = false;
        const finish = (value, close) => { if (!done) { done = true; resolve(value); close(); } };
        openModal(close => {
            const input = h('input.in', { type: 'text', value: initial, maxLength: 80, placeholder: 'Nombre de la lista' });
            const accept = () => { const name = input.value.trim(); if (name) finish(name, close); };
            input.addEventListener('keydown', event => { if (event.key === 'Enter') accept(); });
            setTimeout(() => input.select(), 0);
            return [
                h('h2', null, title),
                h('label', null, 'Nombre'),
                input,
                h('div.acts', null,
                    h('button.btn', { type: 'button', onclick: () => finish(null, close) }, 'Cancelar'),
                    h('button.btn.pri', { type: 'button', onclick: accept }, 'Guardar')),
            ];
        });
    });
}

function confirmDialog(title, text, label) {
    return new Promise(resolve => {
        openModal(close => [
            h('h2', null, title),
            h('p.note', null, text),
            h('div.acts', null,
                h('button.btn', { type: 'button', onclick: () => { resolve(false); close(); } }, 'Cancelar'),
                h('button.btn.pri', { type: 'button', onclick: () => { resolve(true); close(); } }, label)),
        ]);
    });
}

// ---------------------------------------------------------------- menú de una canción

function trackMenu(track, { listId = null, play }) {
    const items = [
        { label: 'Reproducir', icon: 'play f', run: play },
        { label: 'Reproducir a continuación', icon: 'next f', run: () => enqueue(track, 'next') },
        { label: 'Añadir a la cola', icon: 'queue', run: () => enqueue(track, 'end') },
        'sep',
        { label: track.liked ? 'Quitar de «me gusta»' : 'Me gusta', icon: track.liked ? 'heart liked' : 'heart', run: () => setLike(track, !track.liked) },
        { label: 'Añadir a una lista…', icon: 'listadd', run: () => pickList(track) },
    ];
    if (track.key.startsWith('sp:')) items.push({ label: 'Cambiar coincidencia…', icon: 'swap', run: () => openMatch(track) });
    if (listId) {
        items.push('sep', {
            label: 'Quitar de la lista', icon: 'bin', danger: true,
            run: async () => {
                await api('DELETE', `/lists/${listId}/tracks/${enc(track.key)}`);
                toast('Quitada de la lista');
                await Promise.all([loadList(listId), refreshLists()]);
            },
        });
    }
    return items;
}

async function addToList(list, track) {
    const { added } = await api('POST', `/lists/${list.id}/tracks`, { track: bare(track) });
    toast(added > 0 ? `Añadida a «${list.name}»` : `Ya estaba en «${list.name}»`);
    markSaved(track.key);
    await refreshLists();
    if (st.view.name === 'list' && st.view.id === list.id) loadList(list.id);
}

function pickList(track) {
    openModal(close => [
        h('h2', null, 'Añadir a una lista'),
        h('p.note', null, track.title),
        h('div.picks', null,
            h('button.pick', { type: 'button', onclick: async () => {
                close();
                const name = await askName('Nueva lista');
                if (!name) return;
                run(async () => addToList((await api('POST', '/lists', { name })).list, track), 'No se pudo crear la lista.');
            } }, h('div.tx', null, h('b', { class: 'auto' }, '+ Nueva lista…'))),
            st.lists.map(list => h('button.pick', { type: 'button', onclick: () => { close(); run(() => addToList(list, track)); } },
                listCover(list, 's34'),
                h('div.tx', null, h('b', null, list.name), h('small', null, songs(list.count)))))),
        h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cancelar')),
    ]);
}

/** Elegir a mano qué vídeo de YouTube suena para una canción de Spotify. */
function openMatch(track) {
    openModal((close, modal) => {
        const body = h('div.picks', null, h('p.note', null, 'Buscando en YouTube…'));
        api('GET', `/match/${enc(track.key)}`).then(info => {
            if (!modal.isConnected) return;
            if (!info.candidates?.length) return body.replaceChildren(h('p.note', null, 'No he encontrado nada parecido en YouTube.'));
            body.replaceChildren(...info.candidates.map(candidate => {
                const chosen = info.current?.key === candidate.key;
                const diff = candidate.durationDiff;
                const detail = [candidate.artist, candidate.durationSec ? fmt(candidate.durationSec) : null,
                    Number.isFinite(diff) && diff !== 0 ? `${diff > 0 ? '+' : '−'}${Math.abs(diff)} s` : null,
                    chosen ? (info.auto ? 'elegida automáticamente' : 'elegida por ti') : null].filter(Boolean).join(' · ');
                return h('button.pick', { type: 'button', class: chosen ? 'cur' : '', onclick: () => run(async () => {
                    await api('PUT', `/match/${enc(track.key)}`, { track: bare(candidate) });
                    close();
                    toast('Coincidencia cambiada');
                    if (st.view.name === 'list') loadList(st.view.id);
                }) }, cover(candidate.thumb, 's34', candidate.key), h('div.tx', null, h('b', null, candidate.title), h('small', null, detail)));
            }));
        }).catch(() => modal.isConnected && body.replaceChildren(h('p.err', null, 'No se pudo buscar. Prueba otra vez.')));
        return [
            h('h2', null, 'Cambiar coincidencia'),
            h('p.note', null, [track.title, track.artist].filter(Boolean).join(' — ')),
            body,
            h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cerrar')),
        ];
    });
}

// ---------------------------------------------------------------- importar (pantalla 5 de la maqueta)

const IMPORT_ERRORS = {
    bad_link: 'No reconozco ese enlace.',
    mix_not_supported: 'Las mezclas automáticas de YouTube no se pueden importar.',
    not_a_playlist: 'Ese enlace es de una canción, no de una lista. Pégalo en Buscar.',
    import_failed: 'No se pudo leer la lista. Comprueba que es pública y prueba otra vez.',
    empty_playlist: 'Esa lista está vacía.',
    import_expired: 'Ha pasado demasiado tiempo. Vuelve a pegar el enlace.',
    network: 'Sin conexión con el servidor, o la lista tarda demasiado en leerse.',
};

// Enlaces de canciones de Spotify dentro de un texto: lo que copia su programa de escritorio al
// seleccionar una lista entera (Ctrl+A, Ctrl+C). Es la forma de traer listas de más de 100.
const TRACK_LINK = /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})|spotify:track:([A-Za-z0-9]{22})/gi;
function trackIdsIn(text) {
    const ids = new Set();
    for (const match of String(text).matchAll(TRACK_LINK)) ids.add(match[1] ?? match[2]);
    return [...ids];
}
const WHOLE_LIST_TIP = 'Para traer entera una lista de Spotify de más de 100 canciones: ábrela en Spotify de escritorio, selecciona todas (Ctrl+A), copia (Ctrl+C) y pega aquí.';
const LINKS_PER_BATCH = 50;

function openImport(list) {
    openModal((close, modal) => {
        let preview = null;
        let reading = 0;
        const status = h('div', null, h('p.note', null, WHOLE_LIST_TIP));
        const add = h('button.btn.pri', { type: 'button', disabled: true }, 'Añadir canciones');
        const input = h('input.in', { type: 'text', placeholder: 'https://…', autocomplete: 'off', spellcheck: false });

        // Un bloque de enlaces de canciones: se lee por tandas, con el avance a la vista
        const readLinks = async ids => {
            const turn = ++reading;
            preview = null;
            add.disabled = true;
            add.textContent = 'Añadir canciones';
            const label = h('p.note');
            const fill = h('i');
            status.replaceChildren(label, h('div.bar', null, fill));
            const show = done => {
                label.textContent = `Leyendo canciones… ${done} de ${ids.length}`;
                fill.style.width = `${(done / ids.length) * 100}%`;
            };
            show(0);
            let result = null;
            let failed = 0;
            let cutAt = null;
            for (let at = 0; at < ids.length; at += LINKS_PER_BATCH) {
                const links = ids.slice(at, at + LINKS_PER_BATCH).map(id => `https://open.spotify.com/track/${id}`);
                let reply = null;
                for (let attempt = 1; attempt <= 2 && !reply; attempt++) {
                    try {
                        reply = await api('POST', '/import/links', { listId: list.id, links, importId: result?.importId }, 110000);
                    } catch (error) {
                        if (error.status === 401 || error.status === 404 || error.status === 410) break;
                        if (attempt === 1) await sleep(2000);
                    }
                    if (turn !== reading || !modal.isConnected) return;
                }
                if (!reply) {
                    cutAt = at;
                    break;
                }
                result = reply;
                failed += reply.batch?.failed ?? 0;
                show(Math.min(ids.length, at + LINKS_PER_BATCH));
            }
            if (!result || result.count === 0) {
                return status.replaceChildren(h('p.err', null, 'No se ha podido leer ninguna canción. Prueba otra vez.'));
            }
            preview = result;
            // Los avisos que no tocan valen false: se quitan antes de pintar
            status.replaceChildren(...[
                h('div.preview', null, cover(result.thumb, 's48', result.importId),
                    h('div.tx', null, h('b', null, 'Canciones pegadas'), h('div.mut', null, `${songs(result.count)} `, badge('spotify')))),
                h('div.counts', null,
                    h('span.new', null, h('b', null, String(result.newCount)), ' nuevas'),
                    h('span.mut', null, h('b', null, String(result.already)), ' ya están en tu lista')),
                cutAt !== null && h('p.err', null, `La lectura se ha cortado en la canción ${cutAt + 1} de ${ids.length}. Puedes añadir lo leído y volver a pegar el bloque: las que ya estén no se duplican.`),
                failed > 0 && h('p.err', null, `${failed === 1 ? '1 canción no se ha podido leer' : `${failed} canciones no se han podido leer`}. Vuelve a pegar el bloque para reintentarlas: las que ya estén no se duplican.`),
                h('p.note', null, 'Las canciones de Spotify se buscan en YouTube la primera vez que suenan.'),
            ].filter(Boolean));
            add.disabled = result.newCount === 0;
            add.textContent = result.newCount === 0 ? 'Nada nuevo que añadir' : `Añadir ${songs(result.newCount)}`;
        };

        const read = async () => {
            const url = input.value.trim();
            if (!url) return;
            const pasted = /\/playlist\//.test(url) ? [] : trackIdsIn(url);
            if (pasted.length > 0) return readLinks(pasted);
            const turn = ++reading;
            preview = null;
            add.disabled = true;
            add.textContent = 'Añadir canciones';
            status.replaceChildren(h('p.note', null, 'Leyendo la lista…'));
            try {
                // Una lista larga de SoundCloud puede pasar del minuto
                const result = await api('POST', '/import/preview', { listId: list.id, url }, 110000);
                if (turn !== reading || !modal.isConnected) return;
                preview = result;
                status.replaceChildren(
                    h('div.preview', null, cover(result.thumb, 's48', result.title),
                        h('div.tx', null, h('b', null, result.title || 'Lista'), h('div.mut', null, `${songs(result.count)} `, badge(result.platform)))),
                    h('div.counts', null,
                        h('span.new', null, h('b', null, String(result.newCount)), ' nuevas'),
                        h('span.mut', null, h('b', null, String(result.already)), ' ya están en tu lista')),
                    h('p.note', null, [
                        result.platform === 'spotify' ? 'Las canciones de Spotify se buscan en YouTube la primera vez que suenan.' : null,
                        result.truncated ? 'De esta lista solo se pueden leer las 100 primeras canciones.' : null,
                        result.truncated && result.platform === 'spotify' ? WHOLE_LIST_TIP : null,
                    ].filter(Boolean).join(' ')));
                add.disabled = result.newCount === 0;
                add.textContent = result.newCount === 0 ? 'Nada nuevo que añadir' : `Añadir ${songs(result.newCount)}`;
            } catch (error) {
                if (turn !== reading || !modal.isConnected) return;
                status.replaceChildren(h('p.err', null, IMPORT_ERRORS[error.code] ?? 'No se pudo leer la lista. Prueba otra vez.'));
            }
        };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') read(); });
        input.addEventListener('paste', event => {
            const text = event.clipboardData?.getData('text') ?? '';
            const ids = /\/playlist\//.test(text) ? [] : trackIdsIn(text);
            if (ids.length === 0) return void setTimeout(read, 0);
            // Un bloque de varias líneas no cabe en la casilla: se deja escrito cuántos enlaces son
            event.preventDefault();
            input.value = ids.length === 1 ? `https://open.spotify.com/track/${ids[0]}` : `${ids.length} enlaces de canciones de Spotify`;
            readLinks(ids);
        });
        add.addEventListener('click', async () => {
            if (!preview) return;
            add.disabled = true;
            try {
                const { added } = await api('POST', `/lists/${list.id}/import`, { importId: preview.importId });
                close();
                toast(`${songs(added)} ${added === 1 ? 'añadida' : 'añadidas'} a «${list.name}»`);
                await Promise.all([refreshLists(), st.view.name === 'list' && st.view.id === list.id ? loadList(list.id) : null]);
            } catch (error) {
                status.replaceChildren(h('p.err', null, IMPORT_ERRORS[error.code] ?? 'No se pudieron añadir. Prueba otra vez.'));
                add.disabled = false;
            }
        });
        return [
            h('h2', null, `Importar a «${list.name}»`),
            h('label', null, 'Enlace de una lista de Spotify, YouTube o SoundCloud'),
            input,
            status,
            h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), add),
        ];
    });
}

// ---------------------------------------------------------------- ajustes

const PASSWORD_ERRORS = {
    bad_password: 'La contraseña actual no es esa.',
    weak_password: 'La nueva necesita al menos 8 caracteres.',
    too_many_attempts: 'Demasiados intentos. Espera unos minutos.',
    network: 'Sin conexión con el servidor.',
};

const shortDate = iso => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};

/** «Probar extracción»: el servidor comprueba que el buscador responde y que YouTube entrega audio. */
function probeRow() {
    const out = h('div.probe');
    const seconds = ms => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
    const line = (name, part) => h('p', { class: part.ok ? 'ok' : 'err' },
        `${name}: ${part.ok ? 'responde' : 'no responde'} (${seconds(part.ms)})${part.ok || !part.message ? '' : ` — ${part.message}`}`);
    const button = h('button.btn', { type: 'button', onclick: async () => {
        button.disabled = true;
        button.textContent = 'Probando…';
        out.replaceChildren();
        try {
            const result = await api('POST', '/diagnostics/extract', undefined, 70000);
            out.replaceChildren(line('Buscador', result.search), line('YouTube', result.extract));
        } catch (error) {
            if (error.status !== 401) out.replaceChildren(h('p.err', null, error.code === 'busy' ? 'Ya hay una prueba en marcha.' : 'No se pudo hacer la prueba: el servidor no responde.'));
        }
        button.disabled = false;
        button.textContent = 'Probar';
    } }, 'Probar');
    return [h('div.rowline', null, h('div', null, h('b', null, 'Probar extracción'), h('small.sub', null, 'Comprueba que YouTube responde')), button), out];
}

/** Papelera: lo quitado (listas y canciones) se puede devolver a su sitio. Nada se borra. */
function openTrash() {
    openModal(close => {
        const body = h('div.picks', null, h('p.note', null, 'Cargando…'));
        const restore = (payload, done) => run(async () => {
            const { list } = await api('POST', '/trash/restore', payload);
            toast(done(list));
            await Promise.all([fill(), refreshLists()]);
            if (st.view.name === 'list' && st.view.id === list.id) loadList(list.id);
            else if (st.view.name === 'home' || st.view.name === 'lists') renderMain();
        }, 'No se pudo restaurar.');
        // La lista de la canción ya no existe: se elige a cuál va
        const chooseList = item => {
            if (st.lists.length === 0) return toast('Crea antes una lista donde ponerla.');
            openModal(closePick => [
                h('h2', null, 'Restaurar en…'),
                h('p.note', null, item.track.title),
                h('div.picks', null, st.lists.map(list => h('button.pick', { type: 'button', onclick: () => {
                    closePick();
                    restore({ type: 'track', id: item.id, listId: list.id }, target => `Añadida a «${target.name}»`);
                } }, cover(list.thumb, 's34', list.id), h('div.tx', null, h('b', null, list.name), h('small', null, songs(list.count)))))),
                h('div.acts', null, h('button.btn', { type: 'button', onclick: closePick }, 'Cancelar')),
            ]);
        };
        async function fill() {
            let trash;
            try {
                trash = await api('GET', '/trash');
            } catch {
                return body.replaceChildren(h('p.err', null, 'No se pudo leer la papelera.'));
            }
            const rows = [
                ...trash.lists.map(item => h('div.pick', null, cover(item.thumb, 's34', item.id),
                    h('div.tx', null, h('b', null, item.name), h('small', null, ['Lista', songs(item.count), `quitada el ${shortDate(item.removedAt)}`].join(' · '))),
                    h('button.btn', { type: 'button', onclick: () => restore({ type: 'list', id: item.id }, list => `Lista «${list.name}» restaurada`) }, 'Restaurar'))),
                ...trash.tracks.map(item => h('div.pick', null, cover(item.track.thumb, 's34', item.track.key),
                    h('div.tx', null, h('b', null, item.track.title),
                        h('small', null, [item.track.artist, item.listName ? `de «${item.listName}»` : null, item.removedAt ? shortDate(item.removedAt) : null].filter(Boolean).join(' · '))),
                    item.listId
                        ? h('button.btn', { type: 'button', onclick: () => restore({ type: 'track', id: item.id }, list => `Devuelta a «${list.name}»`) }, 'Restaurar')
                        : h('button.btn', { type: 'button', title: 'Su lista ya no existe: elige otra', onclick: () => chooseList(item) }, 'Restaurar en…'))),
            ];
            body.replaceChildren(...(rows.length ? rows : [h('p.note', null, 'La papelera está vacía.')]));
        }
        fill();
        return [
            h('h2', null, 'Papelera'),
            h('p.note', null, 'Aquí queda lo que quitas: listas y canciones. Nada se borra, y se puede devolver a su sitio.'),
            body,
            h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cerrar')),
        ];
    });
}

function openSettings() {
    openModal(close => {
        const trashInfo = h('small.sub', null, 'Lo que has quitado, por si quieres recuperarlo');
        api('GET', '/trash').then(trash => {
            const n = trash.lists.length + trash.tracks.length;
            trashInfo.textContent = n === 0 ? 'Vacía' : n === 1 ? '1 elemento recuperable' : `${n} elementos recuperables`;
        }).catch(() => {});
        const field = (label, autocomplete) => {
            const input = h('input.in', { type: 'password', autocomplete });
            return [h('label', null, label), input, input];
        };
        const [l1, current] = field('Contraseña actual', 'current-password');
        const [l2, fresh] = field('Contraseña nueva (mínimo 8 caracteres)', 'new-password');
        const [l3, again] = field('Repítela', 'new-password');
        const message = h('div');
        const change = h('button.btn', { type: 'button', onclick: async () => {
            const problem = fresh.value.length < 8 ? 'La nueva necesita al menos 8 caracteres.' : fresh.value !== again.value ? 'Las dos nuevas no coinciden.' : null;
            if (problem) return message.replaceChildren(h('p.err', null, problem));
            change.disabled = true;
            try {
                await api('POST', '/password', { current: current.value, next: fresh.value });
                close();
                toast('Contraseña cambiada.');
            } catch (error) {
                message.replaceChildren(h('p.err', null, PASSWORD_ERRORS[error.code] ?? 'No se pudo cambiar.'));
                change.disabled = false;
            }
        } }, 'Cambiar contraseña');
        return [
            h('h2', null, 'Ajustes'),
            h('div.rowline', null, h('span.mut', null, 'Usuario'), h('b', null, st.user?.name ?? '')),
            h('div.rowline', null, h('span.mut', null, 'Servidor'), h('span', null, `${location.host} · ${st.version}`)),
            probeRow(),
            h('div.rowline', null, h('div', null, h('b', null, 'Papelera'), trashInfo),
                h('button.btn', { type: 'button', onclick: () => { close(); openTrash(); } }, 'Abrir')),
            h('div.sec', null, 'Cambiar contraseña'),
            l1, current, l2, fresh, l3, again,
            message,
            h('p.note', null, 'Tendrás que volver a entrar en tus otros dispositivos.'),
            h('div.acts', null,
                h('button.btn.danger', { type: 'button', onclick: () => { close(); logout(); } }, 'Cerrar sesión'),
                h('button.btn', { type: 'button', onclick: close }, 'Cerrar'),
                change),
        ];
    });
}

async function logout() {
    try {
        await api('POST', '/logout');
    } catch { /* si no hay red, la cookie caduca sola al no valer el token */ }
    showLogin();
}

// ---------------------------------------------------------------- estructura (barra lateral, zona central, reproductor)

function buildShell() {
    const side = h('aside.side');
    const main = h('main.main');
    const drawer = h('aside.drawer.hidden');
    const bar = buildBar();
    const mini = buildMini();
    const full = buildFull();
    const app = h('div.app', null, side, main, bar.el, mini.el);
    root.replaceChildren(app, full.el, drawer);
    ui = { app, side, main, drawer, bar, mini, full, shown: null };
}

// Pantalla estrecha: minirreproductor sobre las pestañas (tocarlo abre el reproductor)
function buildMini() {
    const m = { coverKey: undefined };
    m.cover = cover(null, 's36');
    m.title = h('b');
    m.sub = h('small');
    m.playIcon = h('span', null, icon('play', 'f'));
    m.play = h('button.ib', { type: 'button', title: 'Reproducir', onclick: event => { event.stopPropagation(); togglePlay(); } }, m.playIcon);
    m.next = h('button.ib', { type: 'button', title: 'Siguiente', onclick: event => { event.stopPropagation(); next(); } }, icon('next', 'f'));
    m.fill = h('i');
    m.el = h('div.mini.hidden', { title: 'Abrir el reproductor', onclick: openFull }, m.cover, h('div.t', null, m.title, m.sub), m.play, m.next, m.fill);
    return m;
}

// Pantalla estrecha: reproductor a pantalla completa (pantalla 8 de la maqueta de la app)
function buildFull() {
    const f = { coverKey: undefined, seeking: false };
    f.fromLabel = h('span');
    f.from = h('b');
    f.cover = cover(null, '');
    f.title = h('div.title');
    f.artist = h('div.artist');
    f.cur = h('span', null, '0:00');
    f.dur = h('span', null, '0:00');
    f.fill = h('i');
    f.seek = h('div.seek', { title: 'Mover' }, h('div', null, f.fill));
    f.shuffle = h('button.ib', { type: 'button', title: 'Aleatorio', onclick: () => run(toggleShuffle) }, icon('shuffle'));
    f.prev = h('button.ib', { type: 'button', title: 'Anterior', onclick: prev }, icon('prev', 'f'));
    f.playIcon = h('span', null, icon('play', 'f'));
    f.play = h('button.big', { type: 'button', title: 'Reproducir', onclick: () => togglePlay() }, f.playIcon);
    f.next = h('button.ib', { type: 'button', title: 'Siguiente', onclick: next }, icon('next', 'f'));
    f.repeat = h('button.ib', { type: 'button', title: 'Repetir', onclick: () => run(cycleRepeat) }, icon('repeat'));
    f.count = h('span.mut');
    f.like = likeButton();
    // «Reproducir» no entra en este menú: la canción ya suena, y pedirla suelta cortaría la lista
    const more = () => pl.track && openMenu(0, 0, trackMenu(pl.track, { play: () => {} }).slice(1), pl.track);
    f.el = h('div.full.hidden', { role: 'dialog' },
        h('div.top', null,
            h('button.ib', { type: 'button', title: 'Cerrar', onclick: closeFull }, icon('down')),
            h('div.mid', null, f.fromLabel, f.from),
            h('button.ib', { type: 'button', title: 'Más', onclick: more }, icon('more', 'f'))),
        h('div.art', null, f.cover),
        h('div.meta', null,
            h('div.tx', null, f.title, f.artist),
            f.like,
            h('button.ib', { type: 'button', title: 'Añadir a una lista', onclick: () => pl.track && (fromRadio(pl.track) ? run(() => keepRadioTrack(pl.track)) : pickList(pl.track)) }, icon('listadd'))),
        f.seek,
        h('div.times', null, f.cur, f.dur),
        h('div.fctl', null, f.shuffle, f.prev, f.play, f.next, f.repeat),
        h('div.foot', null, h('button.btn', { type: 'button', onclick: toggleQueue }, icon('queue', 'sm'), 'Cola'), radioCheck(), f.count));

    // La barra se arrastra con el dedo; el salto se hace al soltar
    let dragging = false;
    const ratio = event => { const box = f.seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)); };
    const show = r => { f.fill.style.width = `${r * 100}%`; f.cur.textContent = fmt(r * duration()); };
    const end = (event, apply) => {
        if (!dragging) return;
        dragging = false;
        f.seeking = false;
        if (apply) audio.currentTime = ratio(event) * duration();
        updateProgress();
    };
    f.seek.addEventListener('pointerdown', event => {
        if (!pl.key || !duration()) return;
        dragging = true;
        f.seeking = true;
        try { f.seek.setPointerCapture(event.pointerId); } catch { /* sin captura: vale igual */ }
        show(ratio(event));
    });
    f.seek.addEventListener('pointermove', event => { if (dragging) show(ratio(event)); });
    f.seek.addEventListener('pointerup', event => end(event, true));
    f.seek.addEventListener('pointercancel', event => end(event, false));
    return f;
}

function openFull() {
    if (!ui || !pl.track) return;
    st.full = true;
    ui.full.el.classList.remove('hidden');
    updateBar();
}
function closeFull() {
    st.full = false;
    ui?.full.el.classList.add('hidden');
}

function buildBar() {
    const b = { coverKey: undefined };
    b.cover = cover(null, 's46');
    b.title = h('b');
    b.sub = h('small');
    b.shuffle = h('button.ib', { type: 'button', title: 'Aleatorio', onclick: () => run(toggleShuffle) }, icon('shuffle'));
    b.prev = h('button.ib', { type: 'button', title: 'Anterior', onclick: prev }, icon('prev', 'f'));
    b.playIcon = h('span', null, icon('play', 'f'));
    b.play = h('button.big', { type: 'button', title: 'Reproducir', onclick: () => togglePlay() }, b.playIcon);
    b.next = h('button.ib', { type: 'button', title: 'Siguiente', onclick: next }, icon('next', 'f'));
    b.repeat = h('button.ib', { type: 'button', title: 'Repetir', onclick: () => run(cycleRepeat) }, icon('repeat'));
    b.cur = h('span', null, '0:00');
    b.dur = h('span', null, '0:00');
    b.fill = h('i');
    b.seek = h('div.tr', { title: 'Mover', onclick: event => {
        const total = duration();
        if (!pl.key || !total) return;
        const box = b.seek.getBoundingClientRect();
        audio.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * total;
        updateProgress();
    } }, h('div', null, b.fill));
    b.queue = h('button.ib', { type: 'button', title: 'Cola', onclick: toggleQueue }, icon('queue'));
    b.keep = h('button.ib.keep.hidden', { type: 'button', title: 'Añadir a una lista', onclick: () => pl.track && run(() => keepRadioTrack(pl.track)) }, icon('plus'));
    b.like = likeButton();
    b.volume = h('input.vol', { type: 'range', min: 0, max: 100, title: 'Volumen', oninput: event => {
        audio.volume = Number(event.target.value) / 100;
        try { localStorage.setItem('mm.volume', String(audio.volume)); } catch { /* sin almacenamiento */ }
    } });
    b.volume.value = String(Math.round(audio.volume * 100));
    b.el = h('footer.player', null,
        h('div.now', null, b.cover, h('div.tx', null, b.title, b.sub), b.like, b.keep),
        h('div.ctl', null,
            h('div.bts', null, b.shuffle, b.prev, b.play, b.next, b.repeat),
            h('div.prog', null, b.cur, b.seek, b.dur)),
        h('div.right', null, radioCheck(), b.queue, icon('vol'), b.volume));
    return b;
}

function updateBar() {
    const b = ui?.bar;
    if (!b) return;
    const track = pl.track;
    const session = st.session;
    const mine = track && session?.window?.current?.track?.key === track.key;
    if (b.coverKey !== (track?.key ?? null)) {
        b.coverKey = track?.key ?? null;
        const fresh = cover(track?.thumb, 's46', track?.key ?? 'x');
        b.cover.replaceWith(fresh);
        b.cover = fresh;
    }
    b.title.textContent = track ? track.title : 'Nada sonando';
    b.title.classList.toggle('mut', !track);
    b.sub.classList.toggle('bad', Boolean(pl.error));
    b.sub.textContent = pl.error ?? (!track
        ? 'Elige una lista o busca una canción'
        : [track.artist, fromRadio(track) ? 'Radio' : null, mine && session.count > 1 ? `de ${session.source?.name ?? ''}` : null, mine && session.count > 1 ? `${session.index + 1} de ${session.count}` : null]
            .filter(Boolean).join(' · '));
    b.keep.classList.toggle('hidden', !fromRadio(track));
    b.keep.title = keepTitle();
    syncLikeButton(b.like, track);
    syncLikeButton(ui.full.like, track);
    const playing = !audio.paused;
    b.playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 'f'));
    b.play.title = playing ? 'Pausar' : 'Reproducir';
    b.play.classList.toggle('loading', playing && pl.loading);
    b.shuffle.classList.toggle('on', Boolean(session?.shuffle));
    b.repeat.classList.toggle('on', Boolean(session) && session.repeat !== 'off');
    b.repeat.classList.toggle('rep1', session?.repeat === 'one');
    b.repeat.title = { off: 'Repetir: no', all: 'Repetir: toda la lista', one: 'Repetir: esta canción' }[session?.repeat ?? 'off'];
    for (const button of [b.shuffle, b.repeat, b.prev, b.next]) button.disabled = !session;
    b.queue.classList.toggle('on', st.queue.open);

    // Lo mismo en el minirreproductor y en el reproductor a pantalla completa (pantalla estrecha)
    const m = ui.mini;
    const f = ui.full;
    ui.app.classList.toggle('has-mini', Boolean(track));
    m.el.classList.toggle('hidden', !track);
    if (!track && st.full) closeFull();
    if (m.coverKey !== (track?.key ?? null)) {
        m.coverKey = track?.key ?? null;
        for (const [part, size] of [[m, 's36'], [f, '']]) {
            const fresh = cover(track?.thumb, size, track?.key ?? 'x');
            part.cover.replaceWith(fresh);
            part.cover = fresh;
        }
    }
    m.title.textContent = track?.title ?? '';
    m.sub.textContent = pl.error ?? track?.artist ?? '';
    m.sub.classList.toggle('bad', Boolean(pl.error));
    f.title.textContent = track?.title ?? '';
    f.artist.replaceChildren(pl.error ?? track?.artist ?? '', ...[!pl.error && track ? badge(track.platform) : null, !pl.error && fromRadio(track) ? h('span.auto', null, 'Radio') : null].filter(Boolean));
    f.artist.classList.toggle('bad', Boolean(pl.error));
    const fromList = mine && session.count > 1 && session.source?.name;
    f.fromLabel.textContent = fromList ? 'Sonando de' : 'Sonando';
    f.from.textContent = fromList || '';
    f.count.textContent = mine && session.count > 1 ? `${session.index + 1} de ${session.count}` : '';
    for (const part of [m, f]) {
        part.playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 'f'));
        part.play.title = playing ? 'Pausar' : 'Reproducir';
        part.play.classList.toggle('loading', playing && pl.loading);
    }
    f.shuffle.classList.toggle('on', Boolean(session?.shuffle));
    f.repeat.classList.toggle('on', Boolean(session) && session.repeat !== 'off');
    f.repeat.classList.toggle('rep1', session?.repeat === 'one');
    for (const button of [f.shuffle, f.repeat, f.prev, f.next]) button.disabled = !session;
    updateProgress();
}

function updateProgress() {
    const b = ui?.bar;
    if (!b) return;
    const total = duration();
    const at = pl.key ? (pl.pendingSeek > 0 ? pl.pendingSeek : audio.currentTime) : 0;
    const width = total > 0 ? `${Math.min(100, (at / total) * 100)}%` : '0%';
    b.cur.textContent = fmt(at);
    b.dur.textContent = fmt(total);
    b.fill.style.width = width;
    ui.mini.fill.style.width = width;
    const f = ui.full;
    f.dur.textContent = fmt(total);
    if (!f.seeking) {       // mientras se arrastra la barra, manda el dedo
        f.cur.textContent = fmt(at);
        f.fill.style.width = width;
    }
}

function markPlaying() {
    for (const row of document.querySelectorAll('tr[data-key], .row[data-key]')) row.classList.toggle('on', row.dataset.key === pl.key);
}

function renderSide() {
    if (!ui) return;
    const view = st.view;
    ui.side.replaceChildren(
        h('div.brand', null, h('b'), 'MyMusic'),
        h('button.nav', { type: 'button', class: view.name === 'home' || view.name === 'history' ? 'on' : '', onclick: () => go({ name: 'home' }) }, icon('home'), 'Inicio'),
        h('button.nav', { type: 'button', class: view.name === 'search' ? 'on' : '', onclick: () => go({ name: 'search' }) }, icon('search'), 'Buscar'),
        // En pantalla estrecha no hay barra lateral: las listas son la tercera pestaña
        h('button.nav.only-m', { type: 'button', class: view.name === 'lists' || view.name === 'list' ? 'on' : '', onclick: () => go({ name: 'lists' }) }, icon('lib'), 'Listas'),
        h('h4', null, 'Tus listas', h('button', { type: 'button', title: 'Nueva lista', onclick: () => run(createList, 'No se pudo crear la lista.') }, '+')),
        h('div.pls', null, st.lists.map(list => h('button.pl', {
            type: 'button', class: view.name === 'list' && view.id === list.id ? 'on' : '', onclick: () => go({ name: 'list', id: list.id }),
        }, list.likes && icon('heart', 'liked sm'), h('span', null, list.name), h('small', null, String(list.count))))),
        h('button.who', { type: 'button', onclick: openSettings }, h('b', null, (st.user?.name ?? '?').slice(0, 1)), `${st.user?.name ?? ''} · Ajustes`),
    );
}

async function createList() {
    const name = await askName('Nueva lista');
    if (!name) return;
    const { list } = await api('POST', '/lists', { name });
    await refreshLists();
    go({ name: 'list', id: list.id });
}

// ---------------------------------------------------------------- tablas de canciones

/**
 * @param {object[]} tracks
 * @param {object} o  head: títulos de columna · number · platform · badge · menu · play(track) · listId · onMove(key, toIndex)
 */
function trackTable(tracks, o) {
    if (mobile()) return trackRows(tracks, o);
    const head = o.head && h('thead', null, h('tr', null,
        o.number && h('th.n', null, '#'), h('th', null, 'Título'), h('th.a', null, 'Artista'),
        o.platform && h('th.p'), h('th.r', null, 'Duración'), o.menu && h('th.m')));
    let dragging = null;
    const rows = tracks.map((track, index) => {
        const play = () => o.play(track);
        const menu = event => {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const byMouse = event.type === 'contextmenu';
            openMenu(byMouse ? event.clientX : box.right - 210, byMouse ? event.clientY : box.bottom + 4, trackMenu(track, { listId: o.listId, play }));
        };
        const row = h('tr', { data: { key: track.key }, class: track.key === pl.key ? 'on' : '', ondblclick: () => run(play, 'No se pudo reproducir. Prueba otra vez.'), oncontextmenu: menu },
            o.number && h('td.n', null, String(index + 1)),
            h('td', null, h('div.t', null, cover(track.thumb, 's32', track.key), h('span', null, track.title))),
            h('td.a', null, track.artist ?? ''),
            o.platform && h('td.p', null, badge(track.platform), track.match === 'auto' ? h('span.auto', { title: 'Coincidencia en YouTube elegida automáticamente' }, '≈ automática') : null),
            h('td.r', null, track.durationSec ? fmt(track.durationSec) : ''),
            o.menu && h('td.m', null, h('button.ib', { type: 'button', title: 'Más', onclick: menu }, icon('more', 'f'))));
        if (o.onMove) {
            row.draggable = true;
            row.addEventListener('dragstart', event => {
                dragging = track.key;
                row.classList.add('dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', track.title);
            });
            row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); });
            row.addEventListener('dragover', event => { if (dragging && dragging !== track.key) { event.preventDefault(); row.classList.add('drop'); } });
            row.addEventListener('dragleave', () => row.classList.remove('drop'));
            row.addEventListener('drop', event => {
                event.preventDefault();
                row.classList.remove('drop');
                if (dragging && dragging !== track.key) o.onMove(dragging, index);
            });
        }
        return row;
    });
    return h('table', null, head, h('tbody', null, rows));
}

/**
 * Las mismas canciones en pantalla estrecha: filas como las de la app. Tocar una la reproduce, los tres
 * puntos abren su menú y, donde se puede ordenar, se mantiene pulsada la fila para moverla.
 */
function trackRows(tracks, o) {
    const rows = tracks.map((track, index) => {
        const play = () => o.play(track);
        return h('div.row', { data: { key: track.key }, class: track.key === pl.key ? 'on' : '', onclick: () => run(play, 'No se pudo reproducir. Prueba otra vez.') },
            o.number ? h('span.n', null, String(index + 1)) : cover(track.thumb, 's40', track.key),
            h('div.t', null,
                h('b', null, track.title),
                h('small', null,
                    [track.artist, track.durationSec ? fmt(track.durationSec) : null].filter(Boolean).join(' · '),
                    o.badge && badge(track.platform),
                    o.platform && track.match === 'auto' ? h('span.auto', null, '≈ automática') : null)),
            h('button.ib', { type: 'button', title: 'Más', onclick: event => {
                event.stopPropagation();
                openMenu(0, 0, trackMenu(track, { listId: o.listId, play }), track);
            } }, icon('more', 'f')));
    });
    const box = h('div.rows', null, rows);
    if (o.onMove) touchReorder(box, { onMove: (from, to) => o.onMove(tracks[from].key, to) });
    return box;
}

// ---------------------------------------------------------------- pantallas

function sameView(a, b) {
    return a?.name === b?.name && (a?.id ?? null) === (b?.id ?? null);
}

/** Cambia de pantalla. Cada cambio queda en el historial del navegador, para que «atrás» vuelva a la anterior. */
function go(view, { push = true } = {}) {
    closeAllOverlays();
    if (push && !sameView(view, st.view)) {
        try { history.pushState({ view }, ''); } catch { /* sin historial: no pasa nada */ }
    }
    st.view = view;
    renderSide();
    renderMain();
    if (view.name === 'home') Promise.all([refreshLists(), refreshSession(), refreshRecent()]).then(() => st.view === view && renderMain()).catch(() => {});
    if (view.name === 'lists') refreshLists().then(() => st.view === view && renderMain()).catch(() => {});
    if (view.name === 'list') loadList(view.id).catch(() => toast('No se pudo abrir la lista.'));
    if (view.name === 'history') loadHistory().catch(() => toast('No se pudo leer el historial.'));
}

// «Atrás» del navegador (en el móvil, el gesto o el botón): cierra lo que haya abierto encima y, si no hay nada, vuelve a la pantalla anterior
window.addEventListener('popstate', event => {
    if (!ui) return;
    const queueOver = st.queue.open && mobile();
    if (menuEl || modals.length || queueOver || st.full) {
        if (!closeMenu()) {
            if (modals.length) modals[modals.length - 1].close();
            else if (queueOver) toggleQueue();
            else closeFull();
        }
        try { history.pushState({ view: st.view }, ''); } catch { /* sin historial */ }
        return;
    }
    go(event.state?.view ?? { name: 'home' }, { push: false });
});

// Al girar el móvil o cambiar el ancho de la ventana se pasa de una estructura a la otra
narrow.addEventListener?.('change', () => {
    document.documentElement.classList.toggle('m', mobile());
    if (!ui) return;
    closeAllOverlays();
    if (!mobile()) closeFull();
    renderSide();
    ui.shown = null;
    ui.main.replaceChildren();
    renderMain();
    renderQueue();
    updateBar();
});

function renderMain() {
    if (!ui) return;
    const id = `${st.view.name}:${st.view.id ?? ''}`;
    const scroll = ui.shown === id ? ui.main.scrollTop : 0;
    ui.shown = id;
    const build = { home: viewHome, search: viewSearch, lists: viewLists, list: viewList, history: viewHistory }[st.view.name] ?? viewHome;
    if (st.view.name === 'search' && ui.main.querySelector('.searchbox')) return renderSearchResults();     // sin tocar lo que se está escribiendo
    ui.main.replaceChildren(...build().flat(Infinity).filter(Boolean));
    ui.main.scrollTop = scroll;
    if (st.view.name === 'search') ui.main.querySelector('input')?.focus();
}

// Pantalla 2: Inicio
function viewHome() {
    const session = st.session;
    const current = session?.window?.current;
    const offer = current && (!pl.key || pl.displaced || session.active === false);
    return [
        h('div.top', null, h('h3', null, 'Inicio'), h('button.ib.only-m', { type: 'button', title: 'Ajustes', onclick: openSettings }, icon('set'))),
        offer && h('div.banner', null,
            cover(current.track.thumb, 's44', current.track.key),
            h('div.tx', null,
                h('b', null, `Continuar: ${session.source?.name ?? current.track.title}`),
                h('div.mut', null, [`Canción ${current.index + 1} de ${session.count}`, fmt((session.positionMs ?? 0) / 1000),
                    session.active === false && session.deviceName ? `estaba sonando en ${session.deviceName}` : null].filter(Boolean).join(' · '))),
            h('button.btn.pri', { type: 'button', title: 'Continuar aquí', onclick: resume }, icon('play', 'f sm'), h('span.lbl', null, 'Continuar aquí'))),
        (st.lists.length > 0 || st.recent.length > 0) && h('div.banner.radio', null,
            h('div.radtile', null, icon('radio')),
            h('div.tx', null, h('b', null, 'Tu radio'), h('div.mut', null, radioStarting ? 'Buscando canciones parecidas…'
                : [h('span.only-d', null, 'Canciones parecidas a lo que escuchas, sin repetir las tuyas'), h('span.only-m', null, 'Parecidas a lo que escuchas')])),
            h('button.btn', { type: 'button', title: 'Escuchar tu radio', disabled: radioStarting, onclick: startHomeRadio }, icon('play', 'f sm'), h('span.lbl', null, radioStarting ? 'Buscando…' : 'Escuchar'))),
        st.lists.length > 0 && [
            h('div.sec', null, 'Tus listas'),
            h('div.cards', null, st.lists.map(list => h('button.card', { type: 'button', onclick: () => go({ name: 'list', id: list.id }) },
                listCover(list, ''), h('b', null, list.name), h('small', null, songs(list.count))))),
        ],
        st.recent.length > 0 && [
            h('div.sec', null, 'Escuchado hace poco', h('button', { type: 'button', onclick: () => go({ name: 'history' }) }, 'Ver todo')),
            trackTable(st.recent, { play: playTrack }),
        ],
        !offer && st.lists.length === 0 && st.recent.length === 0 && h('p.empty', null, 'Aquí verás lo último que escuchaste y tus listas. Empieza por Buscar, o crea una lista con el «+».'),
    ];
}

// Pantalla 4: Buscar
function viewSearch() {
    const input = h('input', { type: 'search', placeholder: 'Canción, artista o enlace', value: st.search.query, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', enterkeyhint: 'search', spellcheck: false,
        oninput: event => { st.search.query = event.target.value; },
        onkeydown: event => { if (event.key === 'Enter') doSearch(); } });
    input.addEventListener('paste', () => setTimeout(() => { st.search.query = input.value; if (/^https?:\/\//i.test(input.value.trim())) doSearch(); }, 0));
    return [
        h('h3', null, 'Buscar'),
        h('label.in.searchbox', null, icon('search'), input),
        h('p.hint', null, 'Escribe y pulsa Intro, o pega el enlace de una canción de YouTube, Spotify o SoundCloud.'),
        h('div.results', null, searchResults()),
    ];
}
function searchResults() {
    const s = st.search;
    if (s.busy) return h('p.empty', null, 'Buscando…');
    if (s.error) return h('p.err', null, s.error);
    if (s.hint === 'playlist') return h('p.empty', null, 'Ese enlace es de una lista. Ábrela desde una lista tuya con «Importar».');
    if (s.hint === 'bad_link') return h('p.empty', null, 'No reconozco ese enlace.');
    if (!s.results) return null;
    if (s.results.length === 0) return h('p.empty', null, 'Sin resultados.');
    return trackTable(s.results, { head: true, menu: true, badge: true, play: playTrack });
}
function renderSearchResults() {
    ui?.main.querySelector('.results')?.replaceChildren(...[searchResults()].filter(Boolean));
}
async function doSearch() {
    const query = st.search.query.trim();
    if (!query) return;
    const s = st.search;
    Object.assign(s, { busy: true, error: null, hint: null });
    if (mobile()) document.activeElement?.blur?.();       // se guarda el teclado para que se vean los resultados
    renderSearchResults();
    try {
        const reply = await api('GET', `/search?q=${enc(query)}`, undefined, 60000);
        if (st.search.query.trim() !== query) return;
        Object.assign(s, { busy: false, results: reply.results ?? [], hint: reply.hint ?? null });
    } catch (error) {
        Object.assign(s, { busy: false, results: null, error: error.status === 401 ? null : 'No se pudo buscar. Prueba otra vez.' });
    }
    if (st.view.name === 'search') renderSearchResults();
}

// Pantalla 3: dentro de una lista
async function loadList(id) {
    const { list } = await api('GET', `/lists/${id}`);
    if (st.view.name !== 'list' || st.view.id !== id) return;
    st.list = list;
    renderMain();
}
/** Opciones de una lista: cambiarle el nombre o mandarla a la papelera. */
function listMenu(summary) {
    return [
        { label: 'Cambiar el nombre', run: async () => {
            const name = await askName('Cambiar el nombre', summary.name);
            if (!name || name === summary.name) return;
            await api('PUT', `/lists/${summary.id}`, { name });
            await Promise.all([refreshLists(), st.view.name === 'list' ? loadList(summary.id) : null]);
            if (st.view.name === 'lists') renderMain();
        } },
        { label: 'Enviar a la papelera', danger: true, run: async () => {
            if (!await confirmDialog(`¿Enviar «${summary.name}» a la papelera?`, 'La lista deja de verse aquí y en el móvil. No se borra: queda guardada en la papelera del servidor.', 'Enviar a la papelera')) return;
            await api('DELETE', `/lists/${summary.id}`);
            toast('Lista enviada a la papelera');
            await refreshLists();
            go({ name: mobile() ? 'lists' : 'home' });
        } },
    ];
}

// Pestaña «Listas» (pantalla estrecha; en el escritorio las listas están en la barra lateral). Pantalla 5 de la maqueta de la app
function viewLists() {
    return [
        h('div.top', null, h('h3', null, 'Listas')),
        st.lists.length === 0 ? h('p.empty', null, 'Todavía no tienes listas. Crea la primera con «Nueva lista».')
            : h('div.rows', null, st.lists.map(list => h('div.row', { onclick: () => go({ name: 'list', id: list.id }) },
                listCover(list, 's48'),
                h('div.t', null, h('b', null, list.name),
                    h('small', null, [songs(list.count), list.durationSec ? fmtTotal(list.durationSec) : null].filter(Boolean).join(' · '))),
                h('button.ib', { type: 'button', title: 'Más', onclick: event => { event.stopPropagation(); openMenu(0, 0, listMenu(list)); } }, icon('more', 'f'))))),
        h('div.fabspace'),
        h('button.fab', { type: 'button', onclick: () => run(createList, 'No se pudo crear la lista.') }, icon('plus'), 'Nueva lista'),
    ];
}

function viewList() {
    const list = st.list?.id === st.view.id ? st.list : null;
    const summary = list ?? st.lists.find(item => item.id === st.view.id);
    if (!summary) return [h('p.empty', null, 'Cargando…')];
    const start = (key, shuffle) => run(() => playList(summary.id, key, shuffle), 'No se pudo reproducir. Prueba otra vez.');
    const more = event => {
        const box = event.currentTarget.getBoundingClientRect();
        openMenu(box.left, box.bottom + 4, listMenu(summary));
    };
    return [
        h('div.top.only-m', null,
            h('button.ib', { type: 'button', title: 'Volver a Listas', onclick: () => go({ name: 'lists' }) }, icon('back')),
            h('span.grow'),
            h('button.ib', { type: 'button', title: 'Más', onclick: more }, icon('more', 'f'))),
        h('div.listhead', null,
            listCover(summary, 's110'),
            h('div.info', null,
                h('div.kind', null, 'Lista'),
                h('h3', null, summary.name),
                h('div.mut', null, [songs(summary.count), summary.durationSec ? fmtTotal(summary.durationSec) : null].filter(Boolean).join(' · ')),
                h('div.acts', null,
                    h('button.btn.pri', { type: 'button', disabled: summary.count === 0, onclick: () => start(null, false) }, icon('play', 'f sm'), 'Reproducir'),
                    h('button.btn', { type: 'button', title: 'Aleatorio', disabled: summary.count === 0, onclick: () => start(null, true) }, icon('shuffle', 'sm'), h('span.only-d', null, 'Aleatorio')),
                    h('button.btn', { type: 'button', onclick: () => openImport(summary) }, icon('import', 'sm'), 'Importar'),
                    radioCheck(),
                    h('button.btn.icon.only-d', { type: 'button', title: 'Más', onclick: more }, icon('more', 'f'))))),
        !list ? h('p.empty', null, 'Cargando…')
            : list.tracks.length === 0 ? h('p.empty', null, 'Esta lista está vacía. Añade canciones desde Buscar o con «Importar».')
                : trackTable(list.tracks, {
                    head: true, number: true, platform: true, menu: true, listId: list.id,
                    play: track => playList(list.id, track.key, false),
                    onMove: (key, toIndex) => run(async () => {
                        await api('POST', `/lists/${list.id}/move`, { key, toIndex });
                        await loadList(list.id);
                    }),
                }),
    ];
}

// Historial completo (desde «Ver todo» en Inicio)
async function loadHistory() {
    const { entries } = await api('GET', '/history?limit=200');
    st.history = entries.map(entry => entry.track);
    if (st.view.name === 'history') renderMain();
}
function viewHistory() {
    return [
        h('div.top', null, h('button.ib.only-m', { type: 'button', title: 'Volver a Inicio', onclick: () => go({ name: 'home' }) }, icon('back')), h('h3', null, 'Historial')),
        st.history.length === 0 ? h('p.empty', null, 'Todavía no hay nada escuchado.') : trackTable(st.history, { head: true, menu: true, play: playTrack }),
    ];
}

// ---------------------------------------------------------------- cola (panel lateral de la pantalla 4)

function toggleQueue() {
    st.queue.open = !st.queue.open;
    st.queue.limit = 30;
    ui.app.classList.toggle('with-queue', st.queue.open);
    ui.drawer.classList.toggle('hidden', !st.queue.open);
    updateBar();
    refreshQueue();
}

function renderQueue() {
    if (!ui || !st.queue.open) return;
    const session = st.session;
    const current = session?.window?.current;
    let dragging = null;
    const change = action => run(async () => {
        st.session = (await action()).session;
        updateBar();
        await refreshQueue();
    });
    const touch = mobile();     // en pantalla estrecha: tocar una fila salta a ella y se reordena arrastrando el asa
    // Lo que puso la radio lleva su marca y un «+» para guardarlo (en la lista que suena, si suena una)
    const sub = track => h('small', null, track.artist ?? '', fromRadio(track) && h('span.auto', null, 'Radio'));
    const keep = track => fromRadio(track) && h('button.ib.add', { type: 'button', title: keepTitle(), onclick: event => {
        event.stopPropagation();
        run(() => keepRadioTrack(track));
    } }, icon('plus'));
    const rows = st.queue.entries.map(entry => {
        const row = h('div.qrow', { draggable: !touch, ondblclick: () => !touch && gotoKey(entry.track.key), onclick: () => touch && gotoKey(entry.track.key) },
            cover(entry.track.thumb, 's34', entry.track.key),
            h('div.tx', null, h('b', null, entry.track.title), sub(entry.track)),
            keep(entry.track),
            h('span.grip', { title: 'Arrastra para reordenar' }, icon('drag')),
            h('button.ib.x', { type: 'button', title: 'Quitar de la cola', onclick: event => {
                event.stopPropagation();
                change(() => api('DELETE', `/session/queue/${enc(entry.track.key)}`));
            } }, icon('close')));
        if (touch) return row;
        row.addEventListener('dragstart', event => {
            dragging = entry;
            row.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', entry.track.title);
        });
        row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); });
        row.addEventListener('dragover', event => { if (dragging && dragging !== entry) { event.preventDefault(); row.classList.add('drop'); } });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', event => {
            event.preventDefault();
            row.classList.remove('drop');
            const moved = dragging;
            if (moved && moved !== entry) change(() => api('POST', '/session/queue/move', { key: moved.track.key, to: entry.index }));
        });
        return row;
    });
    const shownUpTo = (session?.index ?? 0) + st.queue.entries.length + 1;
    const list = h('div.qrows', null, rows);
    if (touch) {
        const entries = st.queue.entries;
        touchReorder(list, { handle: '.grip', onMove: (from, to) => change(() => api('POST', '/session/queue/move', { key: entries[from].track.key, to: entries[to].index })) });
    }
    const parts = [
        touch
            ? h('div.head', null, h('button.ib', { type: 'button', title: 'Cerrar', onclick: toggleQueue }, icon('down')), h('span.mid', null, 'Cola'), radioCheck())
            : h('div.head', null, h('span.grow', null, 'Cola'), radioCheck(), h('button.ib', { type: 'button', title: 'Cerrar', onclick: toggleQueue }, icon('close'))),
        !current ? h('p.empty', null, 'No hay nada en la cola.') : [
            h('div.sec', null, 'Sonando'),
            h('div.qrow.cur', null, cover(current.track.thumb, 's34', current.track.key),
                h('div.tx', null, h('b', null, current.track.title), sub(current.track)),
                keep(current.track)),
            h('div.sec', null, `A continuación · ${session.source?.name ?? ''}`),
            rows.length === 0 ? h('p.empty', null, 'No hay más canciones después de esta.') : list,
            shownUpTo < st.queue.count && h('button.btn', { type: 'button', onclick: () => { st.queue.limit += 30; refreshQueue(); } }, 'Ver más'),
            (st.radio || session.source?.type === 'radio') && session.repeat === 'off' && h('p.note.radnote', null, {
                loading: 'Radio: buscando canciones parecidas…',
                error: 'Radio: YouTube no ha respondido. Se volverá a intentar.',
                empty: 'Radio: no han salido canciones nuevas.',
            }[session.radio?.status] ?? 'Radio: al acabarse, seguirá con canciones parecidas.'),
        ],
    ];
    ui.drawer.replaceChildren(...parts.flat(Infinity).filter(Boolean));
}

// ---------------------------------------------------------------- entrar (pantalla 1) y arranque

function deviceLabel() {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    const system = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return ['Navegador', browser, system && `(${system})`].filter(Boolean).join(' ');
}

const LOGIN_ERRORS = {
    bad_password: 'Usuario o contraseña incorrectos.',
    too_many_attempts: 'Demasiados intentos. Espera unos minutos.',
    no_password_set: 'El servidor todavía no tiene usuarios.',
    network: 'Sin conexión con el servidor.',
};

function showLogin(message = null) {
    closeAllOverlays();
    stopPlayer();
    ui = null;
    Object.assign(st, { user: null, lists: [], session: null, recent: [], history: [], list: null, view: { name: 'home' } });
    Object.assign(st.search, { query: '', results: null, hint: null, busy: false, error: null });
    st.queue.open = false;
    st.full = false;
    st.radio = false;
    const user = h('input.in', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: false, maxLength: 30 });
    const password = h('input.in', { type: 'password', name: 'password', autocomplete: 'current-password' });
    const error = h('div', null, message && h('p.err', null, message));
    const submit = h('button.btn.pri.wide', { type: 'submit' }, 'Entrar');
    const form = h('form.box', { onsubmit: async event => {
        event.preventDefault();
        if (!user.value.trim() || !password.value) return;
        submit.disabled = true;
        try {
            await api('POST', '/login', { user: user.value.trim(), password: password.value, device: deviceLabel(), web: true });
            await boot();
        } catch (failure) {
            error.replaceChildren(h('p.err', null, LOGIN_ERRORS[failure.code] ?? 'No se pudo entrar.'));
            submit.disabled = false;
        }
    } },
        h('div.logo'),
        h('h1', null, 'MyMusic'),
        h('div.mut', null, 'Tu música, desde tu servidor'),
        h('label', null, 'Usuario'), user,
        h('label', null, 'Contraseña'), password,
        error,
        submit,
        h('p.note', null, 'El navegador recuerda la sesión en este equipo.'));
    root.replaceChildren(h('div.login', null, form));
    user.focus();
}

let leaving = false;
onUnauthorized = () => {
    if (leaving || !ui) return;
    leaving = true;
    showLogin('La sesión ha caducado. Vuelve a entrar.');
    leaving = false;
};

async function boot() {
    let me;
    try {
        me = await api('GET', '/me');
    } catch (error) {
        return showLogin(error.status === 401 ? null : 'Sin conexión con el servidor. Recarga la página para reintentar.');
    }
    st.user = me.user;
    st.version = me.version ?? '';
    try {
        st.radio = (await api('GET', '/radio')).radio.enabled;
    } catch { /* un servidor anterior a la radio: la casilla queda sin marcar */ }
    buildShell();
    updateBar();
    go({ name: 'home' });
}

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        if (!closeMenu() && modals.length) modals[modals.length - 1].close();
        return;
    }
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName));
    if (event.code === 'Space' && ui && !typing && modals.length === 0) {
        event.preventDefault();
        togglePlay();
    }
});

boot();
