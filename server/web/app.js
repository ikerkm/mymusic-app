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
    view: { name: 'home' },      // home | search | lists | list (id) | history | auto (id = kind) | stats | artist / artistSongs / discography (id de artista) | album (id)
    session: null,               // la sesión tal como la da el servidor
    recent: [],
    history: [],
    list: null,
    auto: null,                  // «Para ti» en Inicio: resumen de las listas automáticas y de 7 días (GET /auto)
    autoList: null,              // la lista automática abierta (GET /auto/:kind)
    stats: { period: '7', data: null, busy: false, error: null },      // «Tus estadísticas»
    search: { query: '', results: null, artists: [], hint: null, busy: false, error: null },
    pages: new Map(),            // artista y disco (§18), ya leídos: «artist:<id>», «songs:<id>», «album:<id>» → datos del servidor
    queue: { open: false, entries: [], count: 0, limit: 30 },
    full: false,                 // reproductor a pantalla completa (pantalla estrecha)
    radio: false,                // la casilla «Radio» del usuario (se recuerda en el servidor)
    // Artistas que sigues y novedades (§21). null = el servidor no sabe (versión anterior); undefined = aún sin leer
    novedades: undefined,        // GET /novedades (30 días, Inicio)
    novedadesAll: null,          // GET /novedades?days=90 («Ver todas»)
    novedadesAllError: null,
    follows: undefined,          // GET /follows («Tus artistas»)
    suggestions: null,           // «Los que más escuchas»
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
    if (view?.id !== st.session?.id) failStreak = 0;      // otra sesión: los fallos seguidos empiezan de cero (§19)
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

// «Siguiente» pulsado por el usuario: los fallos seguidos empiezan de cero (el salto automático usa next)
function userNext() {
    failStreak = 0;
    next();
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
audio.addEventListener('playing', () => { pl.loading = false; pl.error = null; failStreak = 0; updateBar(); });
audio.addEventListener('waiting', () => { pl.loading = true; updateBar(); });
audio.addEventListener('canplay', () => { pl.loading = false; updateBar(); });
audio.addEventListener('play', () => updateBar());
audio.addEventListener('pause', () => { report(); updateBar(); });
audio.addEventListener('ended', advance);
audio.addEventListener('timeupdate', () => updateProgress());
audio.addEventListener('durationchange', () => updateProgress());
// Canciones que fallan (§19, mockups/fallos-v1.html): si el servidor no pudo sacar el audio (ya lo
// reintentó él), aviso con el motivo y, a los 2 s, la siguiente. Dos frenos: sin conexión con el
// servidor no salta (fallarían todas), y con 3 fallos seguidos se para.
const SKIP_AFTER_MS = 2000;
const MAX_FAILS = 3;
let failStreak = 0;
// «Tiene restricción de edad» → «tiene restricción de edad»; «YouTube rechazó…» se queda igual
const lowerFirst = text => (/[A-ZÁÉÍÓÚÑ]/.test(text.split(' ')[0].slice(1)) ? text : text.charAt(0).toLowerCase() + text.slice(1));
audio.addEventListener('error', async () => {
    if (!pl.key) return;
    const key = pl.key;
    const title = pl.track?.title ?? '';
    pl.loading = false;
    try {
        await api('GET', '/me');
    } catch (error) {
        if (error.status === 401) return;
        if (error.status === 0) {
            pl.error = 'Sin conexión con el servidor.';
            return updateBar();
        }
    }
    // El servidor apunta lo que no pudo sacar: si no hay nada reciente, es otra cosa (un corte de red a media canción)
    const failure = await api('GET', `/failures/${enc(key)}`).then(reply => reply.failure).catch(() => null);
    if (pl.key !== key) return;                  // mientras se preguntaba, ya suena otra
    const recent = failure && Date.now() - Date.parse(failure.lastAt) < 120_000;
    if (!recent) {
        pl.error = 'No se pudo reproducir esta canción.';
        return updateBar();
    }
    failStreak++;
    const why = failure.reason ? ` (${lowerFirst(failure.reason)})` : '';
    if (failStreak >= MAX_FAILS) {
        pl.error = `Han fallado ${MAX_FAILS} seguidas. Parece un problema de YouTube o del servidor, así que me paro aquí.`;
        toast(pl.error);
        return updateBar();
    }
    const hasNext = Boolean(st.session?.window?.next) && st.session?.active !== false;
    pl.error = `No se pudo reproducir${why}.${hasNext ? ' Paso a la siguiente.' : ''}`;
    updateBar();
    if (!hasNext) return;
    toast(`No se pudo reproducir «${title}»${why}. Paso a la siguiente.`);
    setTimeout(() => { if (pl.key === key && pl.error) next(); }, SKIP_AFTER_MS);
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

// Artista y disco (§18): suenan como una lista que no es tuya
async function playAlbum(id, startKey = null, shuffle = false) {
    const { session } = await api('POST', '/session', { album: id, startKey, shuffle }, 60000);
    load(session);
}
async function playArtist(id, startKey = null, shuffle = false) {
    const { session } = await api('POST', '/session', { artist: id, startKey, shuffle }, 60000);
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

/** «Radio» en la página de un artista (§18): una de sus más escuchadas y, detrás, parecidas. */
let artistRadioStarting = null;      // id del artista cuya radio se está buscando
async function startArtistRadio(id) {
    if (artistRadioStarting) return;
    artistRadioStarting = id;
    if (st.view.name === 'artist') renderMain();
    try {
        const { session } = await api('POST', '/session', { radio: 'artist', artistId: id }, 120000);
        artistRadioStarting = null;
        load(session);
    } catch (error) {
        if (error.status !== 401) toast(error.code === 'radio_empty' ? 'No han salido canciones nuevas. Prueba más tarde.' : 'No se pudo empezar la radio. Prueba otra vez.');
    } finally {
        artistRadioStarting = null;
        if (st.view.name === 'artist') renderMain();
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
    for (const track of [pl.track, ...(st.list?.tracks ?? []), ...(st.autoList?.tracks ?? []), ...(st.stats.data?.topTracks ?? []),
        ...(st.search.results ?? []), ...st.recent, ...st.history]) hit(track);
    for (const page of st.pages.values()) for (const track of [...(page.top ?? []), ...(page.tracks ?? [])]) hit(track);
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
    else if (st.view.name === 'auto') loadAuto(st.view.id).catch(() => {});      // «en <lista>» / «sin guardar» cambia
    else if (['lists', 'home', 'artist', 'artistSongs', 'album'].includes(st.view.name)) renderMain();
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
            }, item.icon && icon(...item.icon.split(' ')), item.label, item.note && h('small', null, item.note)))));
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

// En una lista automática (`auto`) van las de siempre menos «Quitar de la lista» y «Cambiar coincidencia»
function trackMenu(track, { listId = null, play, auto = false }) {
    const items = [
        { label: 'Reproducir', icon: 'play f', run: play },
        { label: 'Reproducir a continuación', icon: 'next f', run: () => enqueue(track, 'next') },
        { label: 'Añadir a la cola', icon: 'queue', run: () => enqueue(track, 'end') },
        'sep',
        { label: track.liked ? 'Quitar de «me gusta»' : 'Me gusta', icon: track.liked ? 'heart liked' : 'heart', run: () => setLike(track, !track.liked) },
        { label: 'Añadir a una lista…', icon: 'listadd', run: () => pickList(track) },
    ];
    // «Ir al artista» (§18): con varios artistas («A, B») se elige cuál
    if (track.artist) {
        const several = track.artist.includes(',');
        items.push({ label: several ? 'Ir al artista…' : 'Ir al artista', icon: 'user', note: several ? null : artistShown(track), run: () => goArtistOf(track) });
    }
    if (track.key.startsWith('sp:') && !auto) items.push({ label: 'Cambiar coincidencia…', icon: 'swap', run: () => openMatch(track) });
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
    else if (st.view.name === 'auto') loadAuto(st.view.id).catch(() => {});
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

// ---------------------------------------------------------------- «Ir al artista» (§18)

/**
 * El nombre que se enseña junto a «Ir al artista». En YouTube el campo es el canal, que no siempre es el
 * artista (un canal de letras): ahí solo se enseña si el título lo nombra o es un canal «X - Topic».
 */
function artistShown(track) {
    const name = String(track.artist ?? '').replace(/\s+-\s+topic$/i, '').replace(/\s*vevo$/i, '').replace(/\s+(official|oficial)$/i, '').trim();
    if (!name) return null;
    if (track.platform !== 'youtube' || /\s-\s+topic$/i.test(track.artist)) return name;
    return String(track.title ?? '').toLowerCase().includes(name.toLowerCase()) ? name : null;
}

/** Abre la página del artista de una canción. Lo busca el servidor en YouTube Music; con varios, se elige. */
async function goArtistOf(track) {
    closeFull();
    const { artists } = await api('GET', `/artists/of?${new URLSearchParams({ key: track.key, title: track.title ?? '', artist: track.artist ?? '' })}`);
    if (artists.length === 0) return toast('No he encontrado a este artista en YouTube Music.');
    if (artists.length === 1) return go({ name: 'artist', id: artists[0].id });
    openModal(close => [
        h('h2', null, 'Ir al artista'),
        h('p.note', null, track.title),
        h('div.picks', null, artists.map(artist => h('button.pick', { type: 'button', onclick: () => { close(); go({ name: 'artist', id: artist.id }); } },
            cover(artist.thumb, 's34 av', artist.id),
            h('div.tx', null, h('b', null, artist.name), h('small', null, listenersLine(artist, true)))))),
        h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cancelar')),
    ]);
}

// «4,1 M de oyentes al mes» (o «4,1 M al mes», corto); sin la cifra, «Artista»
const listenersLine = (artist, short = false) => (artist?.listeners ? `${artist.listeners}${short ? ' al mes' : ' de oyentes al mes'}` : 'Artista');

/** El nombre del artista que se puede tocar (reproductor, cabecera del disco). */
function artistLink(name, onclick) {
    return h('button.alink', { type: 'button', title: 'Ir al artista', onclick: event => { event.stopPropagation(); run(onclick, 'No se pudo abrir el artista. Prueba otra vez.'); } }, name);
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

// «hoy», «ayer» o «15 nov»
function whenShort(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(new Date()) - day(at)) / 86_400_000);
    return diff === 0 ? 'hoy' : diff === 1 ? 'ayer' : shortDate(iso);
}

/**
 * «Canciones que fallaron» (§19, pantallas 4-5 y 8 de mockups/fallos-v1.html): las que no se pudieron
 * reproducir, con el motivo. «Probar» la pone a sonar; «Otro enlace…» elige otro vídeo (para todos);
 * en los tres puntos, «Quitar de la lista» y «Descartar». Salen solas al volver a sonar bien.
 */
function openFailures() {
    openModal((close, modal) => {
        modal.classList.add('wide');           // pantalla 8: más ancha que las demás, para que se lea el motivo
        const body = h('div.picks', null, h('p.note', null, 'Cargando…'));
        async function fill() {
            let reply;
            try {
                reply = await api('GET', '/failures');
            } catch {
                return body.replaceChildren(h('p.err', null, 'No se pudieron leer.'));
            }
            if (reply.failures.length === 0) return body.replaceChildren(h('p.note', null, 'Ninguna: todo lo que has escuchado ha sonado.'));
            body.replaceChildren(...reply.failures.map(item => {
                const track = item.track;
                const why = [item.reason, item.count > 1 ? `${item.count} veces` : null, whenShort(item.lastAt)].filter(Boolean).join(' · ');
                const probe = () => { close(); run(() => playTrack(track), 'No se pudo reproducir. Prueba otra vez.'); };
                // En el escritorio, «Probar» y «Otro enlace…» van a la vista y los tres puntos traen el resto;
                // en el móvil (pantalla 5), la fila abre una hoja con las cuatro opciones
                const more = event => {
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    const options = [
                        mobile() && { label: 'Probar otra vez', icon: 'play f', run: probe },
                        mobile() && { label: 'Poner otro enlace…', icon: 'swap', run: () => openAlternate(item, fill) },
                        mobile() && 'sep',
                        item.list && { label: `Quitar de «${item.list.name}»`, icon: 'bin', danger: true, run: async () => {
                            await api('DELETE', `/lists/${item.list.id}/tracks/${enc(track.key)}`);
                            await api('DELETE', `/failures/${enc(item.key)}`).catch(() => {});
                            toast(`Quitada de «${item.list.name}»`);
                            await Promise.all([fill(), refreshLists()]);
                        } },
                        { label: 'Descartar', icon: 'close', run: async () => {
                            await api('DELETE', `/failures/${enc(item.key)}`);
                            toast('Ya no sale aquí');
                            await fill();
                        } },
                    ].filter(Boolean);
                    openMenu(box.right - 210, box.bottom + 4, options, track);
                };
                return h('div.pick.fail', { onclick: event => { if (mobile()) more(event); } }, cover(track.thumb, 's34', track.key),
                    h('div.tx', null, h('b', null, track.title),
                        h('small', null, [track.artist, track.platform === 'spotify' ? 'Spotify' : null, item.list ? `de «${item.list.name}»` : null].filter(Boolean).join(' · ')),
                        h('small.why', null, why)),
                    h('button.btn.sm', { type: 'button', onclick: probe }, 'Probar'),
                    h('button.btn.sm', { type: 'button', onclick: () => openAlternate(item, fill) }, 'Otro enlace…'),
                    h('button.ib', { type: 'button', title: 'Más', onclick: more }, icon('more', 'f')));
            }));
        }
        fill();
        return [
            h('h2', null, 'Canciones que fallaron'),
            h('p.note', null, 'Las que no se pudieron reproducir. Salen solas de aquí cuando vuelven a sonar bien.'),
            body,
            h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cerrar')),
        ];
    });
}

/** «Poner otro enlace» (pantalla 6): otros vídeos de la misma canción, o pegar un enlace. Vale para todos. */
function openAlternate(item, refresh) {
    openModal((close, modal) => {
        const body = h('div.picks', null, h('p.note', null, 'Buscando en YouTube…'));
        const done = async reply => {
            close();
            toast(`Ahora suena desde ${reply.current.title ? `«${reply.current.title}»` : 'ese vídeo'}`);
            await refresh?.();
        };
        const choose = candidate => run(async () => done(await api('PUT', `/failures/${enc(item.key)}/link`, { track: bare(candidate) })), 'No se pudo cambiar.');
        api('GET', `/failures/${enc(item.key)}/candidates`).then(info => {
            if (!modal.isConnected) return;
            if (!info.candidates?.length) return body.replaceChildren(h('p.note', null, 'No he encontrado otros vídeos de esta canción. Puedes pegar un enlace.'));
            body.replaceChildren(...info.candidates.map(candidate => {
                const failing = candidate.key === info.current;
                const diff = candidate.durationDiff;
                const detail = [candidate.artist, candidate.durationSec ? fmt(candidate.durationSec) : null,
                    Number.isFinite(diff) && diff !== 0 ? `${diff > 0 ? '+' : '−'}${Math.abs(diff)} s` : null].filter(Boolean).join(' · ');
                return h('button.pick', { type: 'button', class: failing ? 'failing' : '', onclick: () => choose(candidate) },
                    cover(candidate.thumb, 's34', candidate.key), h('div.tx', null, h('b', null, candidate.title), h('small', null, detail)),
                    failing && h('span.pill.badfail', null, 'falla'));
            }));
        }).catch(() => modal.isConnected && body.replaceChildren(h('p.err', null, 'No se pudo buscar. Prueba otra vez.')));
        const link = h('input.in', { type: 'text', placeholder: 'https://youtu.be/…', autocomplete: 'off', spellcheck: false });
        const message = h('div');
        const use = h('button.btn.pri', { type: 'button', onclick: async () => {
            const url = link.value.trim();
            if (!url) return;
            use.disabled = true;
            try {
                await done(await api('PUT', `/failures/${enc(item.key)}/link`, { url }, 60000));
            } catch (error) {
                use.disabled = false;
                if (error.status !== 401) message.replaceChildren(h('p.err', null, error.code === 'bad_link' ? 'Pega el enlace de un vídeo de YouTube.' : 'No se pudo leer ese enlace.'));
            }
        } }, 'Usar');
        link.addEventListener('keydown', event => { if (event.key === 'Enter') use.click(); });
        return [
            h('h2', null, 'Poner otro enlace'),
            h('p.note', null, [item.track.title, item.track.artist].filter(Boolean).join(' — ')),
            h('p.note', null, 'Suena desde el vídeo que elijas, en todas sus listas y para todos.'),
            body,
            h('div.sec', null, 'O pega un enlace de YouTube'),
            h('div.linkrow', null, link, use),
            message,
            h('div.acts', null, h('button.btn', { type: 'button', onclick: close }, 'Cerrar')),
        ];
    });
}

/**
 * Consumo (solo el dueño): lo que gasta cada usuario, cómo está la máquina y cuántos oyentes a la
 * vez caben según lo medido. Son cantidades: aquí no se ve qué escucha nadie.
 */
function openUsage() {
    const num = (value, digits = 0) => Number(value ?? 0).toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const size = bytes => (bytes >= 1073741824 ? `${num(bytes / 1073741824, 1)} GB` : `${num(bytes / 1048576, bytes > 0 && bytes < 10485760 ? 1 : 0)} MB`);
    const span = ms => {
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return `${seconds} s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
        return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} min`;
    };
    const cpu = row => (row.cpuProcs > 0 ? span(row.cpuMs) : 'sin dato');
    const when = iso => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const percent = share => `${num(share * 100, share < 0.1 ? 1 : 0)} %`;
    const PERIODS = [[1, 'Hoy'], [7, '7 días'], [30, '30 días']];
    const LIMITS = { slots: 'los turnos de extracción', memory: 'la memoria de audio', cpu: 'el procesador' };

    openModal((close, modal) => {
        modal.classList.add('wide');
        let days = 7;
        const tabs = h('div.seg');
        const body = h('div.usage', null, h('p.note', null, 'Cargando…'));
        const fact = (label, value, extra = null) => h('div.fact', null, h('small', null, label), h('b', null, value), extra && h('small.sub', null, extra));

        const people = report => {
            const rows = [...report.users, { name: 'Total', total: true, ...report.total }];
            const name = row => row.name ?? 'Cuenta que ya no existe';
            if (mobile()) {
                return h('div.picks', null, rows.map(row => h('div.pick.usecard', { class: row.total ? 'tot' : '' }, h('div.tx', null,
                    h('b', null, name(row)),
                    h('small', null, `Escuchado ${span(row.listenedMs)} · ${songs(row.plays)}`),
                    h('small', null, `Servido ${size(row.servedBytes)} · bajado ${size(row.extractBytes)} en ${num(row.extractions)} extracciones`),
                    h('small', null, `Procesador ${cpu(row)} · ${num(row.searches)} búsquedas · ${num(row.radioBatches)} de radio`)))));
            }
            // Si no cabe (muchos usuarios o cifras largas), la tabla se desplaza de lado dentro de la ventana
            return h('div.usewrap', null, h('table.usetable', null,
                h('thead', null, h('tr', null, ['Usuario', 'Escuchado', 'Canciones', 'Servido', 'Extracciones', 'Bajado', 'Procesador', 'Búsquedas', 'Radio'].map((title, i) => h(i ? 'th.r' : 'th', null, title)))),
                h('tbody', null, rows.map(row => h('tr', { class: row.total ? 'tot' : '' },
                    h('td', null, name(row)),
                    // Las fallidas, debajo y en pequeño: en la misma línea ensanchaban la columna y la tabla se salía de la ventana
                    [span(row.listenedMs), num(row.plays), size(row.servedBytes), [num(row.extractions), row.extractFails ? h('small.fails', null, `+${num(row.extractFails)} fallidas`) : null],
                        size(row.extractBytes), cpu(row), num(row.searches), num(row.radioBatches)].map(value => h('td.r', null, value)))))));
        };

        const fits = report => {
            const { basis, perListener: per, limits, bottleneck } = report.capacity;
            if (!per) return h('p.note', null, 'Todavía no hay nada escuchado en este periodo: no hay con qué hacer la cuenta.');
            const worst = limits[bottleneck];
            return [
                h('div.facts', null,
                    fact('Por turnos de extracción', `≈ ${num(limits.slots)} oyentes`, `${num(report.limits.slots)} a la vez; cada oyente ocupa el ${percent(per.slotShare)} de uno`),
                    fact('Por memoria de audio', `≈ ${num(limits.memory)} oyentes`, `${num(report.limits.cacheMB)} MB; cada oyente fija ${num(per.memoryMB, 1)} MB`),
                    fact('Por procesador', limits.cpu === null ? 'sin dato' : `≈ ${num(limits.cpu)} oyentes`,
                        limits.cpu === null ? 'este sistema no da el procesador de cada extracción' : `${num(report.limits.cores)} núcleos; cada oyente gasta el ${percent(per.cpuShare)} de uno`)),
                !basis.enough && h('p.note.warn', null, `Aún hay pocos datos en este periodo (${num(basis.listenHours, 1)} h escuchadas, ${num(basis.extractions)} extracciones): la cuenta de abajo no es de fiar todavía. Se afina con el uso.`),
                h('p.note.big', null, `${worst === 1 ? 'Con lo medido cabe 1 oyente' : `Con lo medido caben unos ${num(worst)} oyentes`} a la vez. El límite lo ponen ${LIMITS[bottleneck]}.`),
                h('p.note', null, `Cada oyente provoca ${num(per.extractionsPerHour, 1)} extracciones por hora de escucha, de ${num(per.extractMB, 1)} MB y ${num(per.extractSeconds, 1)} s cada una, y pide de media ${num(per.upKbps)} kbps de subida y ${num(per.downKbps)} kbps de bajada.`),
                h('p.note', null, 'Es una cuenta con medias, usando el 60 % de turnos y procesador para dejar holgura. No cuenta la subida de tu conexión ni lo que YouTube deje extraer desde una sola dirección.'),
            ];
        };

        const peak = (report, name, label, show) => {
            const top = report.peaks[name];
            return fact(label, top ? show(top.value) : 'sin dato', top && top.value > 0 ? when(top.at) : null);
        };

        async function fill() {
            tabs.replaceChildren(...PERIODS.map(([n, label]) => h('button.btn', { type: 'button', class: n === days ? 'pri' : '', onclick: () => { days = n; fill(); } }, label)));
            let report;
            try {
                report = await api('GET', `/usage?days=${days}`);
            } catch (error) {
                return body.replaceChildren(h('p.err', null, error.status === 403 ? 'Solo lo puede ver el dueño.' : 'No se pudo leer el consumo.'));
            }
            const now = report.now;
            body.replaceChildren(...[
                h('div.sec', null, 'Ahora'),
                h('div.facts', null,
                    fact('Oyentes a la vez', num(now.listeners)),
                    fact('Extracciones en marcha', num(now.running), now.waiting ? `${num(now.waiting)} esperando turno` : `de ${num(report.limits.slots)} a la vez`),
                    fact('Audio en memoria', `${num(now.cacheMB)} MB`, `de ${num(report.limits.cacheMB)} MB`),
                    fact('Memoria del servidor', `${num(now.rssMB)} MB`, `${size(now.freeMB * 1048576)} libres en la máquina`)),
                h('div.sec', null, days === 1 ? 'Por usuario · hoy' : `Por usuario · últimos ${days} días`),
                people(report),
                h('div.sec', null, 'Máximos del periodo'),
                report.samples === 0 ? h('p.note', null, 'Aún no hay muestras de la máquina en este periodo (se toma una por minuto mientras alguien escucha).') : h('div.facts', null,
                    peak(report, 'listeners', 'Oyentes a la vez', value => num(value)),
                    peak(report, 'running', 'Extracciones a la vez', value => num(value)),
                    peak(report, 'waiting', 'Esperando turno', value => num(value)),
                    peak(report, 'cacheMB', 'Audio en memoria', value => `${num(value)} MB`),
                    peak(report, 'rssMB', 'Memoria del servidor', value => `${num(value)} MB`),
                    peak(report, 'childCpu', 'Procesador de las extracciones', value => `${num(value)} % de un núcleo`),
                    peak(report, 'nodeCpu', 'Procesador del servidor', value => `${num(value)} % de un núcleo`)),
                h('div.sec', null, 'Cuántos caben'),
                fits(report),
            ].flat(Infinity).filter(Boolean));
        }
        fill();
        return [
            h('h2', null, 'Consumo'),
            h('p.note', null, 'Lo que gasta cada usuario y la máquina. Solo cantidades: aquí no se ve qué escucha nadie. Una canción que ya estaba en memoria porque la pidió otro solo le cuenta a quien la hizo extraer.'),
            tabs,
            body,
            h('div.acts', null, h('button.btn', { type: 'button', onclick: fill }, 'Actualizar'), h('button.btn', { type: 'button', onclick: close }, 'Cerrar')),
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
        // Canciones que fallaron (§19): con su contador
        const failInfo = h('small.sub', null, 'Las que no se pudieron reproducir');
        const failCount = h('span.count.hidden');
        api('GET', '/failures').then(({ count }) => {
            failInfo.textContent = count === 0 ? 'Ninguna' : count === 1 ? '1 por revisar' : `${count} por revisar`;
            failCount.textContent = String(count);
            failCount.classList.toggle('hidden', count === 0);
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
            h('div.rowline.failline', null, h('div', null, h('b', null, 'Canciones que fallaron'), failInfo), failCount,
                h('button.btn', { type: 'button', onclick: () => { close(); openFailures(); } }, 'Abrir')),
            // Solo el dueño: cuánto gasta cada usuario y cuántos caben
            st.user?.admin && h('div.rowline', null, h('div', null, h('b', null, 'Consumo'), h('small.sub', null, 'Lo que gasta cada usuario y la máquina')),
                h('button.btn', { type: 'button', onclick: () => { close(); openUsage(); } }, 'Ver')),
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
    // Al bajar en la página de un artista, su nombre aparece en la barra de arriba (pageTop con `reveal`)
    main.addEventListener('scroll', () => main.querySelector('.top.reveal')?.classList.toggle('show', main.scrollTop > 160), { passive: true });
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
    m.next = h('button.ib', { type: 'button', title: 'Siguiente', onclick: event => { event.stopPropagation(); userNext(); } }, icon('next', 'f'));
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
    f.next = h('button.ib', { type: 'button', title: 'Siguiente', onclick: userNext }, icon('next', 'f'));
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
    b.next = h('button.ib', { type: 'button', title: 'Siguiente', onclick: userNext }, icon('next', 'f'));
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
    // El nombre del artista se puede tocar (§18): abre su página
    const rest = track ? [fromRadio(track) ? 'Radio' : null, mine && session.count > 1 ? `de ${session.source?.name ?? ''}` : null, mine && session.count > 1 ? `${session.index + 1} de ${session.count}` : null].filter(Boolean).join(' · ') : '';
    if (pl.error || !track) b.sub.textContent = pl.error ?? 'Elige una lista o busca una canción';
    else b.sub.replaceChildren(...[track.artist ? artistLink(track.artist, () => goArtistOf(track)) : null, track.artist && rest ? ' · ' : null, rest].filter(Boolean));
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
    f.artist.replaceChildren(pl.error ?? (track?.artist ? artistLink(track.artist, () => goArtistOf(track)) : ''), ...[!pl.error && track ? badge(track.platform) : null, !pl.error && fromRadio(track) ? h('span.auto', null, 'Radio') : null].filter(Boolean));
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
        h('div.brand', null, h('img.brandimg', { src: 'icon-192.png', alt: '' }), 'MyMusic'),
        h('button.nav', { type: 'button', class: ['home', 'history', 'auto', 'stats', 'novedades'].includes(view.name) ? 'on' : '', onclick: () => go({ name: 'home' }) }, icon('home'), 'Inicio'),
        h('button.nav', { type: 'button', class: ['search', ...ARTIST_VIEWS].includes(view.name) ? 'on' : '', onclick: () => go({ name: 'search' }) }, icon('search'), 'Buscar'),
        // Artistas que sigues (§21): en el escritorio, aquí; en pantalla estrecha, la pestaña «Artistas» dentro de Listas
        st.novedades !== null && h('button.nav.only-d', { type: 'button', class: view.name === 'artists' ? 'on' : '', onclick: () => go({ name: 'artists' }) },
            icon('user'), 'Tus artistas', st.novedades?.unseen ? h('small.count', null, String(st.novedades.unseen)) : null),
        // En pantalla estrecha no hay barra lateral: las listas son la tercera pestaña
        h('button.nav.only-m', { type: 'button', class: ['lists', 'list', 'artists'].includes(view.name) ? 'on' : '', onclick: () => go({ name: 'lists' }) }, icon('lib'), 'Listas'),
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
 *   · auto (lista automática: menú sin quitar ni cambiar coincidencia) · cols [{head, cls, cell(track)}] (columnas de más) · cls
 *   · en pantalla estrecha: line(track) (segunda línea), side(track) (a la derecha) y plain (sin la duración)
 *   · noArtist (sin la columna Artista: dentro de un disco) · noCover (sin carátula en cada fila) · heart (corazón en
 *     cada fila: dentro de un disco, §18) · cover (en pantalla estrecha, número y carátula a la vez) · sub(track) (en
 *     pantalla estrecha, lo que dice la línea de debajo del título en vez del artista)
 */
function trackTable(tracks, o) {
    if (mobile()) return trackRows(tracks, o);
    const cols = o.cols ?? [];
    const head = o.head && h('thead', null, h('tr', null,
        o.number && h('th.n', null, '#'), h('th', null, 'Título'), !o.noArtist && h('th.a', null, 'Artista'),
        o.platform && h('th.p'), cols.map(col => h('th', { class: col.cls }, col.head)), h('th.r', null, 'Duración'), o.heart && h('th.m'), o.menu && h('th.m')));
    let dragging = null;
    const rows = tracks.map((track, index) => {
        const play = () => o.play(track);
        const menu = event => {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const byMouse = event.type === 'contextmenu';
            openMenu(byMouse ? event.clientX : box.right - 210, byMouse ? event.clientY : box.bottom + 4, trackMenu(track, { listId: o.listId, play, auto: o.auto }));
        };
        const row = h('tr', { data: { key: track.key }, class: track.key === pl.key ? 'on' : '', ondblclick: () => run(play, 'No se pudo reproducir. Prueba otra vez.'), oncontextmenu: menu },
            o.number && h('td.n', null, String(index + 1)),
            h('td', null, h('div.t', null, !o.noCover && cover(track.thumb, 's32', track.key), h('span', null, track.title))),
            !o.noArtist && h('td.a', null, track.artist ?? ''),
            o.platform && h('td.p', null, badge(track.platform), track.match === 'auto' ? h('span.auto', { title: 'Coincidencia en YouTube elegida automáticamente' }, '≈ automática') : null),
            cols.map(col => {
                const value = col.cell(track);
                return h('td', { class: col.cls, title: typeof value === 'string' ? value : null }, value);
            }),
            h('td.r', null, track.durationSec ? fmt(track.durationSec) : ''),
            o.heart && h('td.m', null, rowHeart(track)),
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
    return h('table', { class: o.cls }, head, h('tbody', null, rows));
}

/**
 * Las mismas canciones en pantalla estrecha: filas como las de la app. Tocar una la reproduce, los tres
 * puntos abren su menú y, donde se puede ordenar, se mantiene pulsada la fila para moverla.
 */
function trackRows(tracks, o) {
    const rows = tracks.map((track, index) => {
        const play = () => o.play(track);
        return h('div.row', { data: { key: track.key }, class: track.key === pl.key ? 'on' : '', onclick: () => run(play, 'No se pudo reproducir. Prueba otra vez.') },
            o.number && h('span.n', null, String(index + 1)),
            (!o.number || o.cover) && cover(track.thumb, 's40', track.key),
            h('div.t', null,
                h('b', null, track.title),
                h('small', null,
                    o.sub ? o.sub(track) : [track.artist, !o.plain && track.durationSec ? fmt(track.durationSec) : null].filter(Boolean).join(' · '),
                    o.badge && badge(track.platform),
                    o.platform && track.match === 'auto' ? h('span.auto', null, '≈ automática') : null),
                o.line && h('small', null, o.line(track))),
            o.side && o.side(track),
            o.heart && rowHeart(track),
            h('button.ib', { type: 'button', title: 'Más', onclick: event => {
                event.stopPropagation();
                openMenu(0, 0, trackMenu(track, { listId: o.listId, play, auto: o.auto }), track);
            } }, icon('more', 'f')));
    });
    const box = h('div.rows', null, rows);
    if (o.onMove) touchReorder(box, { onMove: (from, to) => o.onMove(tracks[from].key, to) });
    return box;
}

/** El corazón de una fila (dentro de un disco, §18): relleno si la canción está en «me gusta». */
function rowHeart(track) {
    const button = h('button.ib.like', { type: 'button', onclick: event => { event.stopPropagation(); toggleLike(track); } }, icon('heart'));
    syncLikeButton(button, track);
    return button;
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
    if (view.name === 'home') Promise.all([refreshLists(), refreshSession(), refreshRecent(), refreshAuto(), refreshNovedades()]).then(() => st.view === view && renderMain()).catch(() => {});
    if (view.name === 'lists') Promise.all([refreshLists(), refreshFollows()]).then(() => st.view === view && renderMain()).catch(() => {});
    if (view.name === 'artists') {
        refreshFollows().then(() => st.view === view && renderMain()).catch(() => {});
        refreshSuggestions().then(() => st.view === view && renderMain()).catch(() => {});
    }
    if (view.name === 'novedades') loadNovedadesAll();
    if (view.name === 'album') markNovedadSeen(view.id);
    if (view.name === 'list') loadList(view.id).catch(() => toast('No se pudo abrir la lista.'));
    if (view.name === 'history') loadHistory().catch(() => toast('No se pudo leer el historial.'));
    if (view.name === 'auto') loadAuto(view.id).catch(() => toast('No se pudo abrir la lista.'));
    if (view.name === 'stats') loadStats(st.stats.period);
    if (ARTIST_VIEWS.includes(view.name)) loadPage(view);
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
    const build = {
        home: viewHome, search: viewSearch, lists: viewLists, list: viewList, history: viewHistory, auto: viewAuto, stats: viewStats,
        artist: viewArtist, artistSongs: viewArtistSongs, discography: viewDiscography, album: viewAlbum,
        artists: viewFollows, novedades: viewNovedades,
    }[st.view.name] ?? viewHome;
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
        novedadesRow(),
        paraTi(),
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
    // La fila «Artistas» (§18): solo viene cuando lo escrito se parece a un artista
    const artists = s.artists?.length > 0 && [h('div.sec', null, 'Artistas'), artistStrip(s.artists, { listeners: true })];
    if (s.results.length === 0) return [artists, h('p.empty', null, 'Sin resultados.')];
    return [artists, artists && h('div.sec', null, 'Canciones'), trackTable(s.results, { head: true, menu: true, badge: true, play: playTrack })];
}
function renderSearchResults() {
    ui?.main.querySelector('.results')?.replaceChildren(...[searchResults()].flat(Infinity).filter(Boolean));
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
        Object.assign(s, { busy: false, results: reply.results ?? [], artists: reply.artists ?? [], hint: reply.hint ?? null });
    } catch (error) {
        Object.assign(s, { busy: false, results: null, artists: [], error: error.status === 401 ? null : 'No se pudo buscar. Prueba otra vez.' });
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
        followSeg('lists'),
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

// ---------------------------------------------------------------- artista y disco (§18, mockups/artista-disco-v1.html)

// Salen de YouTube Music por el servidor (que guarda cada página un día). Nada de esto es del usuario:
// no salen en Listas, no se renombran ni se ordenan. «Guardar como lista» copia el disco a una lista suya.
const ARTIST_VIEWS = ['artist', 'artistSongs', 'discography', 'album'];
const KIND_LABEL = { album: 'Álbum', single: 'Sencillo', ep: 'EP' };
const pageErrors = new Map();
const pageKey = view => `${view.name === 'album' ? 'album' : view.name === 'artistSongs' ? 'songs' : 'artist'}:${view.id}`;

async function loadPage(view) {
    const key = pageKey(view);
    if (st.pages.has(key)) return;
    pageErrors.delete(key);
    try {
        const path = view.name === 'album' ? `/album/${enc(view.id)}` : view.name === 'artistSongs' ? `/artist/${enc(view.id)}/songs` : `/artist/${enc(view.id)}`;
        const data = await api('GET', path, undefined, 60000);
        st.pages.set(key, data.album ?? data.list ?? data.artist);
        if (st.pages.size > 40) st.pages.delete(st.pages.keys().next().value);
    } catch (error) {
        if (error.status === 401) return;
        pageErrors.set(key, error.status === 404 ? 'YouTube Music no lo tiene.' : 'No se ha podido leer YouTube Music ahora mismo. Prueba otra vez en un rato.');
    }
    if (sameView(st.view, view)) renderMain();
}
const pageOf = view => ({ data: st.pages.get(pageKey(view)) ?? null, error: pageErrors.get(pageKey(view)) ?? null });
const pageWait = error => (error ? h('p.err', null, error) : h('p.empty', null, 'Cargando…'));

/**
 * Arriba: en el móvil, la flecha (y un título); en el escritorio, «‹ Volver» (o a quién se vuelve).
 * `reveal`: la barra se queda fija y el título solo aparece al bajar (el artista, pantalla 5 de la maqueta).
 */
function pageTop(label = 'Volver', title = null, { reveal = false } = {}) {
    return [
        h('div.top.only-m', { class: reveal ? 'reveal' : '' }, h('button.ib', { type: 'button', title: 'Volver', onclick: () => history.back() }, icon('back')), title ? h('span.ttl', null, title) : h('span.grow')),
        h('button.back.only-d', { type: 'button', onclick: () => history.back() }, icon('back', 'sm'), label),
    ];
}

// Debajo del título de una de sus canciones: con quién la canta (si no es solo él) y cuánto dura
function featLine(artistName, track) {
    const others = String(track.artist ?? '').split(',').map(name => name.trim()).filter(name => name && name.toLowerCase() !== String(artistName).toLowerCase());
    return [others.length ? `con ${others.join(', ')}` : null, track.durationSec ? fmt(track.durationSec) : null].filter(Boolean).join(' · ');
}

/** Artistas en fila (Buscar, «parecidos» en el móvil); `grid` = rejilla de tres (escritorio). */
function artistStrip(artists, { listeners = false, grid = false } = {}) {
    return h('div.acards', { class: grid ? 'grid' : '' }, artists.map(artist => h('button.acard', { type: 'button', title: artist.name, onclick: () => go({ name: 'artist', id: artist.id }) },
        cover(artist.thumb, 'av', artist.id), h('b', null, artist.name), listeners && h('small', null, listenersLine(artist, true)))));
}

const releaseLine = release => [release.kind === 'album' ? null : KIND_LABEL[release.kind], release.year].filter(Boolean).join(' · ');
function releaseCard(release) {
    return h('button.rel', { type: 'button', title: release.title, onclick: () => go({ name: 'album', id: release.id }) },
        cover(release.thumb, '', release.id), h('b', null, release.title), h('small', null, releaseLine(release)));
}
function releaseSection(title, releases, onAll) {
    if (!releases?.length) return null;
    return [
        h('div.sec', null, title, h('button', { type: 'button', onclick: onAll }, `Ver todos · ${releases.length}`)),
        h('div.releases', null, releases.slice(0, 12).map(releaseCard)),
    ];
}

// Pantallas 4-5 (móvil) y 8 (escritorio): el artista
function viewArtist() {
    const { data: a, error } = pageOf(st.view);
    if (!a) return [pageTop(), pageWait(error)];
    const busy = artistRadioStarting === a.id;
    return [
        pageTop('Volver', a.name, { reveal: true }),
        h('div.artisthead', null,
            cover(a.thumb, 'av', a.id),
            h('div.info', null,
                h('div.kind', null, 'Artista'),
                h('h3', null, a.name),
                h('div.mut', null, listenersLine(a)),
                followToggle(a, 'only-m'),
                h('div.acts', null,
                    h('button.btn.pri', { type: 'button', disabled: !a.songsCount, onclick: () => run(() => playArtist(a.id), 'No se pudo reproducir. Prueba otra vez.') }, icon('play', 'f sm'), 'Reproducir'),
                    h('button.btn', { type: 'button', title: 'Radio de este artista', disabled: busy || !a.songsCount, onclick: () => startArtistRadio(a.id) },
                        icon('radio', 'sm'), busy ? 'Buscando…' : [h('span.only-d', null, 'Radio de este artista'), h('span.only-m', null, 'Radio')]),
                    followToggle(a, 'only-d')))),
        h('div.artistcols', null,
            h('div', null,
                h('div.sec', null, 'Canciones más escuchadas', a.songsCount > 0 && h('button', { type: 'button', onclick: () => go({ name: 'artistSongs', id: a.id }) }, `Ver todas · ${a.songsCount}`)),
                a.top.length ? trackTable(a.top, { number: true, cover: true, menu: true, cls: 'toptracks', sub: track => featLine(a.name, track), play: track => playArtist(a.id, track.key) })
                    : h('p.empty', null, 'YouTube Music no tiene canciones suyas.')),
            a.related.length > 0 && h('div.only-d', null, h('div.sec', null, 'Artistas parecidos'), artistStrip(a.related.slice(0, 9), { grid: true }))),
        releaseSection('Álbumes', a.albums, () => go({ name: 'discography', id: a.id, tab: 'albums' })),
        releaseSection('Sencillos y EP', a.singles, () => go({ name: 'discography', id: a.id, tab: 'singles' })),
        a.related.length > 0 && h('div.only-m', null, h('div.sec', null, 'Artistas parecidos'), artistStrip(a.related)),
    ];
}

// «Ver todas»: la lista entera de sus canciones, de la más escuchada a la menos. Se ve como una lista y no se edita.
function viewArtistSongs() {
    const id = st.view.id;
    const { data: list, error } = pageOf(st.view);
    const artist = st.pages.get(`artist:${id}`);
    if (!list) return [pageTop(artist?.name ?? 'Volver'), pageWait(error)];
    const start = (key, shuffle) => run(() => playArtist(id, key, shuffle), 'No se pudo reproducir. Prueba otra vez.');
    return [
        pageTop(list.name),
        h('div.listhead', null,
            cover(artist?.thumb, 's110 av', id),
            h('div.info', null,
                h('div.kind', null, 'Canciones de'),
                h('h3', null, list.name),
                h('div.mut', null, [songs(list.count), list.durationSec ? fmtTotal(list.durationSec) : null].filter(Boolean).join(' · ')),
                h('div.acts', null,
                    h('button.btn.pri', { type: 'button', disabled: list.count === 0, onclick: () => start(null, false) }, icon('play', 'f sm'), 'Reproducir'),
                    h('button.btn', { type: 'button', title: 'Aleatorio', disabled: list.count === 0, onclick: () => start(null, true) }, icon('shuffle', 'sm'), h('span.only-d', null, 'Aleatorio'))))),
        trackTable(list.tracks, { head: true, number: true, cover: true, menu: true, sub: track => featLine(list.name, track), play: track => playArtist(id, track.key, false) }),
    ];
}

// Pantalla 6: toda la discografía, en dos pestañas
function viewDiscography() {
    const view = st.view;
    const { data: a, error } = pageOf(view);
    if (!a) return [pageTop(), pageWait(error)];
    const tab = view.tab === 'singles' ? 'singles' : 'albums';
    const tabs = h('div.pseg', { role: 'tablist' }, [['albums', `Álbumes · ${a.albums.length}`], ['singles', `Sencillos y EP · ${a.singles.length}`]].map(([value, label]) => h('button', {
        type: 'button', role: 'tab', class: value === tab ? 'on' : '', 'aria-selected': String(value === tab),
        onclick: () => { st.view = { ...view, tab: value }; try { history.replaceState({ view: st.view }, ''); } catch { /* sin historial */ } renderMain(); },
    }, label)));
    const releases = tab === 'singles' ? a.singles : a.albums;
    return [
        pageTop(a.name, a.name),
        h('h3.only-d', null, a.name),
        tabs,
        releases.length ? h('div.releases.all', null, releases.map(releaseCard)) : h('p.empty', null, 'No hay ninguno.'),
    ];
}

// Pantallas 7 (móvil) y 9 (escritorio): el disco
function viewAlbum() {
    const { data: d, error } = pageOf(st.view);
    if (!d) return [pageTop(), pageWait(error)];
    const start = (key, shuffle) => run(() => playAlbum(d.id, key, shuffle), 'No se pudo reproducir. Prueba otra vez.');
    const by = d.artists.map((artist, i) => [i > 0 ? ', ' : null, artist.id ? artistLink(artist.name, async () => go({ name: 'artist', id: artist.id })) : artist.name]);
    return [
        pageTop(d.artists[0]?.name ?? 'Volver'),
        h('div.listhead.albumhead', null,
            cover(d.thumb, 's150', d.id),
            h('div.info', null,
                // En el móvil, este bloque va junto a la carátula y los botones debajo, a lo ancho
                h('div.meta', null,
                    h('div.kind', null, [KIND_LABEL[d.kind] ?? 'Álbum', d.year].filter(Boolean).join(' · ')),
                    h('h3', null, d.title),
                    h('div.by', null, by, h('span.mut.only-d', null, ` · ${[songs(d.count), d.durationSec ? fmtTotal(d.durationSec) : null].filter(Boolean).join(' · ')}`)),
                    h('div.mut.only-m', null, [songs(d.count), d.durationSec ? fmtTotal(d.durationSec) : null].filter(Boolean).join(' · '))),
                h('div.acts', null,
                    h('button.btn.pri', { type: 'button', disabled: d.count === 0, onclick: () => start(null, false) }, icon('play', 'f sm'), 'Reproducir'),
                    h('button.btn', { type: 'button', title: 'Aleatorio', disabled: d.count === 0, onclick: () => start(null, true) }, icon('shuffle', 'sm'), h('span.only-d', null, 'Aleatorio')),
                    h('button.btn.save', { type: 'button', title: 'Guardar como lista', disabled: d.count === 0, onclick: () => saveAlbum(d) },
                        icon('listadd', 'sm'), h('span.only-d', null, 'Guardar como lista'), h('span.only-m', null, 'Guardar'))))),
        d.tracks.length === 0 ? h('p.empty', null, 'YouTube Music no da canciones de este disco.')
            : trackTable(d.tracks, {
                head: true, number: true, noArtist: true, noCover: true, heart: true, menu: true, cls: 'albumt',
                sub: track => (track.durationSec ? fmt(track.durationSec) : ''),
                play: track => playAlbum(d.id, track.key, false),
            }),
    ];
}

/** «Guardar como lista»: el disco pasa a una lista nueva tuya, con su nombre (se puede cambiar aquí). */
function saveAlbum(album) {
    openModal(close => {
        const input = h('input.in', { type: 'text', value: album.title.slice(0, 80), maxLength: 80, placeholder: 'Nombre de la lista' });
        const error = h('div');
        const save = h('button.btn.pri', { type: 'button' }, 'Guardar');
        const accept = async () => {
            const name = input.value.trim();
            if (!name || save.disabled) return;
            save.disabled = true;
            try {
                const { list: created } = await api('POST', `/album/${enc(album.id)}/save`, { name }, 60000);
                close();
                await refreshLists();
                go({ name: 'list', id: created.id });
            } catch (failure) {
                save.disabled = false;
                if (failure.status === 401) return;
                error.replaceChildren(h('p.err', null, 'No se pudo guardar. Prueba otra vez.'));
            }
        };
        save.addEventListener('click', accept);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') accept(); });
        setTimeout(() => input.select(), 0);
        return [
            h('h2', null, 'Guardar como lista'),
            h('p.note', null, `Copia ${album.count === 1 ? 'la canción' : `las ${album.count} canciones`} del disco a una lista nueva tuya.`),
            h('label', null, 'Nombre'),
            input,
            error,
            h('div.acts.split', null, h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), save),
        ];
    });
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

// ---------------------------------------------------------------- «Para ti»: listas automáticas y estadísticas (mockups/estadisticas-v1.html)

// Las listas automáticas son de solo lectura: el servidor las calcula al pedirlas, con el historial de
// cada cuenta. No salen en Listas, ni en la barra lateral, ni en «Añadir a una lista…»; no se renombran,
// no se quitan, no se importa en ellas ni se reordenan. «Guardar como lista» copia lo de ese momento.
const AUTO_LOOK = {
    top: { icon: 'trend', tone: 'au1', more: () => 'últimos 30 días' },
    forgotten: { icon: 'clock', tone: 'au2', more: () => 'cambia cada día' },
    radio: { icon: 'radio', tone: 'au3', more: auto => `${auto.unsaved ?? 0} sin guardar` },
};
const isAuto = kind => Object.hasOwn(AUTO_LOOK, kind);

/** Carátula de una lista automática: su icono sobre su color, no una foto. */
function autoCover(kind, size = '') {
    const look = AUTO_LOOK[kind] ?? AUTO_LOOK.top;
    return h('div', { class: `cv au ${look.tone} ${size}` }, icon(look.icon));
}

const times = n => (n === 1 ? '1 vez' : `${n} veces`);
const artistsCount = n => (n === 1 ? '1 artista' : `${n} artistas`);
const distinctSongs = n => (n === 1 ? '1 canción distinta' : `${n} canciones distintas`);

/** Tiempo escuchado, como «6 h 20 min». */
function fmtListened(ms) {
    const seconds = Math.floor((ms ?? 0) / 1000);
    if (seconds <= 0) return '0 min';
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
// «d mmm» con los meses de tres letras, los mismos del servidor (stats.js, el «· 17 nov» de «Guardar como lista»)
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dayMonth = date => `${date.getDate()} ${MONTHS[date.getMonth()]}`;
/** Una hora ISO (UTC) como «d mmm» en hora local. */
function localDay(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : dayMonth(date);
}
/** «hoy», «ayer» o «d mmm», en hora local (el servidor da la hora en UTC). */
function dayWhen(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(new Date()) - day(date)) / 86400000);
    return diff === 0 ? 'hoy' : diff === 1 ? 'ayer' : dayMonth(date);
}
/** Un día local AAAA-MM-DD (ya viene en hora local) como «d mmm». */
function dayLabel(ymd) {
    const [y, m, d] = String(ymd ?? '').split('-').map(Number);
    return y && m && d ? dayMonth(new Date(y, m - 1, d)) : '';
}

async function refreshAuto() {
    try {
        st.auto = await api('GET', '/auto');
    } catch (error) {
        if (error.status === 404) st.auto = null;       // un servidor anterior: sin «Para ti»
    }
}

/** Inicio, entre «Tu radio» y «Tus listas». Una lista automática sin canciones no sale. */
function paraTi() {
    if (!st.auto) return null;
    const lists = (st.auto.lists ?? []).filter(item => isAuto(item.kind) && item.count > 0);
    const week = st.auto.stats ?? {};
    const openAuto = kind => go({ name: 'auto', id: kind });
    const openStats = () => { st.stats.period = '7'; go({ name: 'stats' }); };
    // Pantalla estrecha (pantalla 1): las listas en fila, que se desliza de lado, y debajo la tarjeta de las estadísticas
    if (mobile()) {
        return h('div.parati', null,
            h('div.sec', null, 'Para ti'),
            lists.length > 0 && h('div.hs', null, lists.map(item => h('button.ac', { type: 'button', data: { kind: item.kind }, onclick: () => openAuto(item.kind) },
                autoCover(item.kind), h('b', null, item.name), h('small', null, songs(item.count))))),
            h('button.statcard', { type: 'button', onclick: openStats },
                h('div.stico', null, icon('chart')),
                h('div.tx', null, h('b', null, 'Tus estadísticas'), h('div', null, `7 días: ${fmtListened(week.listenedMs)} · ${songs(week.songs ?? 0)}`)),
                icon('chev', 'mut')));
    }
    // Escritorio (pantalla 7): cuatro tarjetas en la misma rejilla que las listas
    return h('div.parati', null,
        h('div.sec', null, 'Para ti'),
        h('div.cards', null,
            lists.map(item => h('button.card', { type: 'button', data: { kind: item.kind }, onclick: () => openAuto(item.kind) },
                autoCover(item.kind), h('b', null, item.name), h('small', null, `${songs(item.count)} · ${AUTO_LOOK[item.kind].more(item)}`))),
            h('button.card.st', { type: 'button', onclick: openStats },
                h('div', null,
                    h('small.sttl', null, icon('chart', 'sm'), 'Tus estadísticas'),
                    h('div.big', null, fmtListened(week.listenedMs)),
                    h('small', null, `${songs(week.songs ?? 0)} · ${artistsCount(week.artists ?? 0)}`)),
                h('small', null, 'Últimos 7 días · Ver más ›'))));
}

// ---------------------------------------------------------------- artistas que sigues y novedades (§21, mockups/novedades-v1.html)

// A quién sigue cada uno y qué ha abierto lo guarda el servidor; lo que saca cada artista lo mira él
// al seguirlo y una vez al día. Sin avisos: solo Inicio, «Tus artistas» y «Ver todas».
const followBusy = new Set();          // ids de artista con «Seguir» / «Dejar de seguir» en curso

/** Días desde un día AAAA-MM-DD (local) hasta hoy, o null. */
function dayDiff(ymd) {
    const [y, m, d] = String(ymd ?? '').split('-').map(Number);
    if (!y || !m || !d) return null;
    const now = new Date();
    return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86400000);
}
/** «hace 5 días», «ayer», «hoy»; una reedición: «apareció hace 3 días». */
function agoOf(item) {
    const n = dayDiff(item.when);
    const ago = n === null ? '' : n <= 0 ? 'hoy' : n === 1 ? 'ayer' : `hace ${n} días`;
    return item.appeared ? `apareció ${ago}` : ago;
}
const plays30 = n => `${n} ${n === 1 ? 'escucha' : 'escuchas'} en 30 días`;

async function refreshNovedades() {
    try {
        st.novedades = await api('GET', '/novedades');
    } catch (error) {
        if (error.status === 404) st.novedades = null;       // un servidor anterior: sin novedades
    }
    renderSide();
}
async function refreshFollows() {
    try {
        st.follows = await api('GET', '/follows');
        if (st.novedades) st.novedades.unseen = st.follows.unseen;
    } catch (error) {
        if (error.status === 404) st.follows = null;
    }
}
async function refreshSuggestions() {
    try {
        st.suggestions = (await api('GET', '/follows/suggestions', undefined, 20000)).artists ?? [];
    } catch {
        st.suggestions ??= [];
    }
}
async function loadNovedadesAll() {
    st.novedadesAllError = null;
    try {
        st.novedadesAll = await api('GET', `/novedades?days=90`);
    } catch (error) {
        if (error.status !== 401) st.novedadesAllError = 'No se han podido leer las novedades. Prueba otra vez en un rato.';
    }
    if (st.view.name === 'novedades') renderMain();
}

/** Al abrir un disco, su punto se quita también aquí (el servidor ya lo ha apuntado). */
function markNovedadSeen(id) {
    let changed = false;
    for (const data of [st.novedades, st.novedadesAll]) {
        for (const item of data?.releases ?? []) if (item.id === id && !item.seen) { item.seen = true; changed = true; }
    }
    for (const artist of st.follows?.artists ?? []) if (artist.latest?.id === id && artist.isNew) { artist.isNew = false; changed = true; }
    if (changed && st.novedades) {
        st.novedades.unseen = st.novedades.releases.filter(item => !item.seen).length;
        renderSide();
    }
}
function openNovedad(item) {
    if (!item.seen) {
        markNovedadSeen(item.id);
        api('POST', `/novedades/${enc(item.id)}/seen`).catch(() => {});
    }
    go({ name: 'album', id: item.id });
}

/** Seguir o dejar de seguir (sin papelera: no se pierde nada y se vuelve a seguir con un toque). */
async function setFollow(artist, on) {
    if (followBusy.has(artist.id)) return;
    followBusy.add(artist.id);
    renderMain();
    try {
        await api(on ? 'PUT' : 'DELETE', `/follows/${enc(artist.id)}`, undefined, 30000);
        const page = st.pages.get(`artist:${artist.id}`);
        if (page) page.following = on;
        if (on) st.suggestions = (st.suggestions ?? []).filter(item => item.id !== artist.id);
        toast(on ? `Sigues a ${artist.name}` : `Has dejado de seguir a ${artist.name}`);
        await Promise.all([refreshFollows(), refreshNovedades()]);
        // Las fechas de lo reciente llegan en unos segundos: entonces la fila de Inicio se llena
        if (on) setTimeout(() => Promise.all([refreshFollows(), refreshNovedades()]).then(() => ['home', 'artists'].includes(st.view.name) && renderMain()).catch(() => {}), 8000);
    } finally {
        followBusy.delete(artist.id);
        renderMain();
    }
}
/** El botón «Seguir» / «✓ Siguiendo» de la página del artista (no sale si el servidor no sabe seguir). */
function followToggle(artist, where) {
    if (typeof artist.following !== 'boolean') return null;
    return h('button.btn.out', {
        type: 'button', class: `${where} ${where === 'only-m' ? 'followm sm' : ''} ${artist.following ? 'on' : ''}`, disabled: followBusy.has(artist.id),
        onclick: () => run(() => setFollow(artist, !artist.following), artist.following ? 'No se pudo dejar de seguir. Prueba otra vez.' : 'No se pudo seguir. Prueba otra vez.'),
    }, artist.following ? [icon('check', 'sm'), 'Siguiendo'] : 'Seguir');
}
function followButton(artist, small = false) {
    return h('button.btn.out', {
        type: 'button', class: small ? 'sm' : '', disabled: followBusy.has(artist.id),
        onclick: event => { event.stopPropagation(); run(() => setFollow(artist, true), 'No se pudo seguir. Prueba otra vez.'); },
    }, 'Seguir');
}
const followMenu = artist => [
    { label: 'Radio de este artista', icon: 'radio', run: () => startArtistRadio(artist.id) },
    { label: 'Dejar de seguir', icon: 'user', run: () => setFollow(artist, false) },
];

/** Debajo del nombre en «Tus artistas»: lo nuevo sin abrir (en morado) o lo último que ha sacado. */
function followLine(artist) {
    const latest = artist.latest;
    if (!latest) return h('small', null, 'Sin discos en YouTube Music');
    if (artist.isNew) return h('small.nw', null, `Nuevo: ${latest.title} · ${agoOf(latest)}`);
    return h('small', null, `Último: ${latest.title}${latest.when ? ` · ${dayLabel(latest.when)}` : latest.year ? ` · ${latest.year}` : ''}`);
}

/** Tarjeta de una novedad. `full`: la de «Ver todas» (con tipo y fecha). */
function novedadCard(item, full = false) {
    const when = full && !item.appeared ? dayLabel(item.when) : agoOf(item);
    return h('button.rel.nov', { type: 'button', title: `${item.title} · ${item.artist.name}`, onclick: () => openNovedad(item) },
        cover(item.thumb, '', item.id), !item.seen && h('i.dot'),
        h('b', null, item.title),
        full ? h('small', null, [item.artist.name, KIND_LABEL[item.kind], when].filter(Boolean).join(' · '))
            : [h('small.only-d', null, `${item.artist.name} · ${when}`), h('small.only-m', null, item.artist.name), h('small.only-m', null, when)]);
}
function novedadRow(item) {
    return h('div.row', { onclick: () => openNovedad(item) },
        h('div.cvw', null, cover(item.thumb, 's48', item.id), !item.seen && h('i.dot')),
        h('div.t', null, h('b', null, item.title),
            h('small', null, [item.artist.name, KIND_LABEL[item.kind], item.appeared ? agoOf(item) : dayLabel(item.when)].filter(Boolean).join(' · '))));
}

/** Inicio, entre «Tu radio» y «Para ti»: lo de los últimos 30 días; sin seguir a nadie, la tarjeta para elegir. */
function novedadesRow() {
    const n = st.novedades;
    if (!n) return null;
    if (n.following === 0) {
        return h('div.hintcard', null,
            h('b', null, 'Novedades de tus artistas'),
            h('p', null, 'Sigue a tus artistas y aquí saldrá lo que saquen.'),
            h('button.btn.out.sm', { type: 'button', onclick: () => go({ name: 'artists' }) }, icon('user', 'sm'), 'Elegir artistas'));
    }
    if (!n.releases?.length) return null;
    return [
        h('div.sec', null, 'Novedades de tus artistas', h('button', { type: 'button', onclick: () => go({ name: 'novedades' }) }, 'Ver todas')),
        h('div.releases.novs', null, n.releases.slice(0, 12).map(item => novedadCard(item))),
    ];
}

/** En la pestaña Listas (pantalla estrecha): «Listas · N» y «Artistas · N». */
function followSeg(on) {
    if (st.follows === null) return null;
    return h('div.tabseg.only-m', null,
        h('button', { type: 'button', class: on === 'lists' ? 'on' : '', onclick: () => on !== 'lists' && go({ name: 'lists' }) }, `Listas · ${st.lists.length}`),
        h('button', { type: 'button', class: on === 'artists' ? 'on' : '', onclick: () => on !== 'artists' && go({ name: 'artists' }) }, `Artistas${st.follows ? ` · ${st.follows.artists.length}` : ''}`));
}

// Pantallas 3 (móvil: Listas → «Artistas») y 7 (escritorio: «Tus artistas»)
function viewFollows() {
    const f = st.follows;
    const suggestions = st.suggestions ?? [];
    const empty = h('p.empty', null, 'Aún no sigues a nadie. Toca «Seguir» en la página de un artista, o elige entre los que más escuchas.');
    if (mobile()) {
        return [
            h('div.top', null, h('h3', null, 'Listas')),
            followSeg('artists'),
            !f ? h('p.empty', null, f === null ? 'Este servidor aún no sabe seguir artistas.' : 'Cargando…')
                : f.artists.length === 0 ? empty
                    : h('div.rows', null, f.artists.map(artist => h('div.row', { onclick: () => go({ name: 'artist', id: artist.id }) },
                        h('div.cvw', null, cover(artist.thumb, 's48 av', artist.id), artist.isNew && h('i.dot')),
                        h('div.t', null, h('b', null, artist.name), followLine(artist)),
                        h('button.ib', { type: 'button', title: 'Más', onclick: event => { event.stopPropagation(); openMenu(0, 0, followMenu(artist)); } }, icon('more', 'f'))))),
            suggestions.length > 0 && [
                h('div.sec', null, 'Los que más escuchas'),
                h('div.rows', null, suggestions.map(artist => h('div.row', { onclick: () => go({ name: 'artist', id: artist.id }) },
                    cover(artist.thumb, 's40 av', artist.id),
                    h('div.t', null, h('b', null, artist.name), h('small', null, plays30(artist.plays))),
                    followButton(artist, true)))),
            ],
        ];
    }
    const menuAt = (event, artist) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY, followMenu(artist));
    };
    return [
        h('div.top', null, h('h3', null, 'Tus artistas')),
        f && h('div.mut', null, [f.artists.length === 1 ? '1 artista' : `${f.artists.length} artistas`, f.unseen ? `${f.unseen} ${f.unseen === 1 ? 'novedad' : 'novedades'} sin abrir` : null].filter(Boolean).join(' · ')),
        !f ? h('p.empty', null, f === null ? 'Este servidor aún no sabe seguir artistas.' : 'Cargando…')
            : f.artists.length === 0 ? empty
                : h('div.fgrid', null, f.artists.map(artist => h('div.fcard', { title: artist.name, onclick: () => go({ name: 'artist', id: artist.id }), oncontextmenu: event => menuAt(event, artist) },
                    h('div.cvw', null, cover(artist.thumb, 'av', artist.id), artist.isNew && h('i.dot')),
                    h('b', null, artist.name), followLine(artist),
                    h('button.ib.more', { type: 'button', title: 'Más', onclick: event => menuAt(event, artist) }, icon('more', 'f'))))),
        suggestions.length > 0 && [
            h('div.sec', null, 'Los que más escuchas'),
            h('div.fgrid.sug', null, suggestions.map(artist => h('div.fcard', { title: artist.name, onclick: () => go({ name: 'artist', id: artist.id }) },
                cover(artist.thumb, 'av', artist.id), h('b', null, artist.name), h('small', null, plays30(artist.plays)), followButton(artist)))),
        ],
    ];
}

// Pantalla 4: «Ver todas», lo de los últimos 3 meses por grupos
function viewNovedades() {
    const n = st.novedadesAll;
    const top = [pageTop('Volver', 'Novedades de tus artistas'), h('div.top.only-d', null, h('h3', null, 'Novedades de tus artistas'))];
    if (!n) return [top, st.novedadesAllError ? h('p.err', null, st.novedadesAllError) : h('p.empty', null, 'Cargando…')];
    if (!n.releases.length) return [top, h('p.empty', null, n.following === 0 ? 'Aún no sigues a nadie.' : 'Tus artistas no han sacado nada en los últimos 3 meses.')];
    const groups = [['Esta semana', 0, 6], ['Este mes', 7, 30], ['Hasta 3 meses', 31, Infinity]];
    return [top, groups.map(([label, from, to]) => {
        const items = n.releases.filter(item => { const d = dayDiff(item.when) ?? 0; return d >= from && d <= to; });
        if (!items.length) return null;
        return [h('div.sec', null, label), mobile() ? h('div.rows', null, items.map(novedadRow)) : h('div.releases.all.novs', null, items.map(item => novedadCard(item, true)))];
    })];
}

// Pantallas 2-4: una lista automática abierta (en el escritorio, como una lista con «Guardar como lista» en vez de «Importar»)
async function loadAuto(kind) {
    const { list } = await api('GET', `/auto/${enc(kind)}`);
    if (st.view.name !== 'auto' || st.view.id !== kind) return;
    st.autoList = list;
    renderMain();
}

async function playAuto(kind, startKey = null, shuffle = false) {
    const { session } = await api('POST', '/session', { auto: kind, startKey, shuffle });
    load(session);
}

/** Lo que dice cada fila, además de la canción: columnas en el escritorio; línea y marca en pantalla estrecha. */
function autoRowParts(kind) {
    if (kind === 'top') {
        return {
            cols: [{ head: 'Escuchas', cls: 'r w96', cell: track => times(track.plays ?? 0) }],
            side: track => h('span.cnt', null, times(track.plays ?? 0)),
        };
    }
    if (kind === 'forgotten') {
        const last = track => (track.lastPlayedAt ? `última vez ${localDay(track.lastPlayedAt)}` : 'sin escuchas');
        return {
            cols: [
                { head: 'Está en', cls: 'w140', cell: track => track.list?.name ?? '' },
                { head: 'Última vez', cls: 'w110', cell: track => (track.lastPlayedAt ? localDay(track.lastPlayedAt) : 'sin escuchas') },
            ],
            line: track => [track.list?.name ? `en ${track.list.name}` : null, last(track)].filter(Boolean).join(' · '),
        };
    }
    // radio: cuándo y qué radio la puso, y si está AHORA en alguna lista
    const when = track => [dayWhen(track.at), track.via].filter(Boolean).join(' · ');
    const saved = track => (track.savedIn
        ? h('span.pill.kept', { title: `Está en «${track.savedIn.name}»` }, `en ${track.savedIn.name}`)
        : h('span.pill.loose', null, 'sin guardar'));
    return {
        cols: [{ head: 'Cuándo', cls: 'w170', cell: when }, { head: 'En tus listas', cls: 'w110', cell: saved }],
        line: when,
        side: saved,
    };
}

function viewAuto() {
    const kind = st.view.id;
    const list = st.autoList?.kind === kind ? st.autoList : null;
    const summary = list ?? st.auto?.lists?.find(item => item.kind === kind) ?? null;
    const count = summary?.count ?? 0;
    const total = list ? list.tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0) : 0;
    const start = (key, shuffle) => run(() => playAuto(kind, key, shuffle), 'No se pudo reproducir. Prueba otra vez.');
    const parts = autoRowParts(kind);
    // Sin menú de lista (no se renombra ni se quita), sin «Importar» y sin arrastrar
    return [
        h('div.top.only-m', null,
            h('button.ib', { type: 'button', title: 'Volver a Inicio', onclick: () => go({ name: 'home' }) }, icon('back')),
            h('span.grow')),
        h('div.listhead.autohead', null,
            autoCover(kind, 's110'),
            h('div.info', null,
                h('div.kind', null, 'Lista automática'),
                h('h3', null, summary?.name ?? 'Cargando…'),
                h('div.mut', null, h('span.only-m', null, 'Automática · '), songs(count), total ? h('span.only-d', null, ` · ${fmtTotal(total)}`) : null),
                list?.description && h('p.why', null, list.description),
                h('div.acts', null,
                    h('button.btn.pri', { type: 'button', disabled: count === 0, onclick: () => start(null, false) }, icon('play', 'f sm'), 'Reproducir'),
                    h('button.btn', { type: 'button', title: 'Aleatorio', disabled: count === 0, onclick: () => start(null, true) }, icon('shuffle', 'sm'), h('span.only-d', null, 'Aleatorio')),
                    h('button.btn.save', { type: 'button', title: 'Guardar como lista', disabled: !list || list.count === 0, onclick: () => saveAuto(list) },
                        icon('listadd', 'sm'), h('span.only-d', null, 'Guardar como lista'), h('span.only-m', null, 'Guardar'))))),
        !list ? h('p.empty', null, 'Cargando…')
            : list.tracks.length === 0 ? h('p.empty', null, 'Todavía no hay canciones aquí: se irá llenando con lo que escuches.')
                : trackTable(list.tracks, {
                    head: true, number: mobile() ? kind === 'top' : true, platform: true, menu: true, auto: true, plain: true, cls: 'autot',
                    cols: parts.cols, line: parts.line, side: parts.side,
                    play: track => playAuto(kind, track.key, false),
                }),
    ];
}

/** «Guardar como lista» (pantalla 5): copia lo que hay ahora a una lista normal nueva, que ya no cambia sola. */
function saveAuto(list) {
    openModal(close => {
        const input = h('input.in', { type: 'text', value: list.saveName ?? list.name, maxLength: 80, placeholder: 'Nombre de la lista' });
        const error = h('div');
        const save = h('button.btn.pri', { type: 'button' }, 'Guardar');
        const accept = async () => {
            const name = input.value.trim();
            if (!name || save.disabled) return;
            save.disabled = true;
            try {
                const { list: created } = await api('POST', `/auto/${enc(list.kind)}/save`, { name });
                close();
                await refreshLists();
                go({ name: 'list', id: created.id });       // aparece en Listas y se abre
            } catch (failure) {
                save.disabled = false;
                if (failure.status === 401) return;
                error.replaceChildren(h('p.err', null, failure.code === 'empty_list' ? 'Ahora mismo no tiene canciones: no hay nada que guardar.' : 'No se pudo guardar. Prueba otra vez.'));
            }
        };
        save.addEventListener('click', accept);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') accept(); });
        setTimeout(() => input.select(), 0);
        return [
            h('h2', null, 'Guardar como lista'),
            h('p.note', null, `Copia ${list.count === 1 ? 'la canción' : `las ${list.count} canciones`} de ahora a una lista nueva. Esa lista ya no cambia sola: es tuya, como las demás.`),
            h('label', null, 'Nombre'),
            input,
            error,
            h('div.acts.split', null, h('button.btn', { type: 'button', onclick: close }, 'Cancelar'), save),
        ];
    });
}

// Pantallas 6 y 8: «Tus estadísticas». Periodos = los últimos N días, no semanas ni meses del calendario.
const STAT_PERIODS = [['7', '7 días'], ['30', '30 días'], ['all', 'Siempre']];

async function loadStats(period) {
    const s = st.stats;
    s.period = period;
    s.busy = true;
    if (st.view.name === 'stats') renderMain();
    try {
        const data = await api('GET', `/stats?period=${enc(period)}`);
        if (s.period !== period) return;
        s.data = data;
        s.error = null;
    } catch (error) {
        if (s.period !== period) return;
        s.error = error.status === 401 ? null : 'No se pudieron leer las estadísticas. Prueba otra vez.';
    }
    s.busy = false;
    if (st.view.name === 'stats') renderMain();
}

/** Tocar un artista: Buscar con su nombre (su propia página es otra idea, aparte). */
function searchArtist(name) {
    Object.assign(st.search, { query: name, results: null, hint: null, error: null });
    go({ name: 'search' });
    doSearch();
}

function viewStats() {
    const s = st.stats;
    const data = s.data;
    const wide = !mobile();
    const playStat = track => run(() => playTrack(track), 'No se pudo reproducir. Prueba otra vez.');
    const num = (value, label) => h('div.num', null, h('b', null, value), h('small', null, label));
    const tabs = h('div.pseg', { role: 'tablist' }, STAT_PERIODS.map(([value, label]) => h('button', {
        type: 'button', role: 'tab', class: value === s.period ? 'on' : '', 'aria-selected': String(value === s.period),
        onclick: () => { if (value !== s.period) loadStats(value); },
    }, label)));
    const none = h('p.empty', null, 'Nada escuchado en este periodo.');

    const tracksPart = () => {
        if (!data.topTracks?.length) return none.cloneNode(true);
        if (wide) {
            // Doble clic reproduce, como en las demás tablas del panel
            return h('table.stat', null, h('tbody', null, data.topTracks.map((track, index) => h('tr', {
                data: { key: track.key }, class: track.key === pl.key ? 'on' : '', title: 'Doble clic para reproducir', ondblclick: () => playStat(track),
            },
                h('td.n', null, String(index + 1)),
                h('td', null, h('div.t', null, cover(track.thumb, 's30', track.key), h('span', null, track.title))),
                h('td.a', null, track.artist ?? ''),
                h('td.r', null, String(track.plays))))));
        }
        return h('div.rows', null, data.topTracks.map((track, index) => h('div.row.stat', { data: { key: track.key }, class: track.key === pl.key ? 'on' : '', onclick: () => playStat(track) },
            h('span.n', null, String(index + 1)),
            cover(track.thumb, 's34', track.key),
            h('div.t', null, h('b', null, track.title), h('small', null, track.artist ?? '')),
            h('span.cnt', null, String(track.plays)))));
    };
    const artistsPart = () => {
        if (!data.topArtists?.length) return none.cloneNode(true);
        if (wide) {
            return h('table.stat.arts', null, h('tbody', null, data.topArtists.map((artist, index) => h('tr.go', { title: `Buscar «${artist.name}»`, onclick: () => searchArtist(artist.name) },
                h('td.n', null, String(index + 1)),
                h('td', null, h('div.t', null, cover(artist.thumb, 's30 av', artist.name), h('span', null, artist.name))),
                h('td.a', null, songs(artist.songs)),
                h('td.r', null, String(artist.plays))))));
        }
        return h('div.rows', null, data.topArtists.map((artist, index) => h('div.row.stat.art', { onclick: () => searchArtist(artist.name) },
            h('span.n', null, String(index + 1)),
            cover(artist.thumb, 's34 av', artist.name),
            h('div.t', null, h('b', null, artist.name), h('small', null, distinctSongs(artist.songs))),
            h('span.cnt', null, String(artist.plays)))));
    };

    return [
        h('div.top', null, h('button.ib', { type: 'button', title: 'Volver a Inicio', onclick: () => go({ name: 'home' }) }, icon('back')), h('h3', null, 'Tus estadísticas')),
        tabs,
        s.error && h('p.err', null, s.error),
        !data ? h('p.empty', null, s.error ? '' : 'Cargando…') : h('div.stats', { class: s.busy ? 'busy' : '', data: { period: data.period } },
            h('div.nums', null,
                num(fmtListened(data.listenedMs), 'escuchado'),
                num(String(data.songs ?? 0), wide ? 'canciones distintas' : 'canciones'),
                num(String(data.artists ?? 0), wide ? 'artistas distintos' : 'artistas')),
            h('p.since', null, data.listenedSince
                ? `El tiempo se mide desde el ${dayLabel(data.listenedSince)}; las escuchas, desde que hay historial.`
                : 'El tiempo escuchado aún no se ha medido; las escuchas cuentan desde que hay historial.'),
            h('div.two', null,
                h('div', null, h('div.sec', null, 'Canciones más escuchadas'), tracksPart()),
                h('div', null, h('div.sec', null, 'Artistas más escuchados'), artistsPart()))),
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
    Object.assign(st, { user: null, lists: [], session: null, recent: [], history: [], list: null, auto: null, autoList: null, view: { name: 'home' } });
    Object.assign(st.stats, { period: '7', data: null, busy: false, error: null });
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
        h('img.logo', { src: 'icon-192.png', alt: '' }),
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
