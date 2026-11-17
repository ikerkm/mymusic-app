#!/usr/bin/env node
// Prueba del panel web en un navegador de verdad (Edge o Chrome sin ventana), contra un servidor
// de PRUEBAS. Nunca contra el del Flip: abre sesiones, crea listas y toma la sesión de escucha.
//
//   node scripts/web-check.mjs http://127.0.0.1:3101 <usuario> <carpeta para las capturas>
//   (la contraseña se lee de la variable MYMUSIC_CHECK_PASSWORD)
//
// No usa dependencias: habla con el navegador por su protocolo de depuración.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [base, user, shots] = process.argv.slice(2);
const password = process.env.MYMUSIC_CHECK_PASSWORD;
if (!base || !user || !shots || !password) {
    console.error('Uso: MYMUSIC_CHECK_PASSWORD=… node scripts/web-check.mjs <url> <usuario> <carpeta de capturas>');
    process.exit(2);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(base)) {
    console.error('Esta prueba solo se lanza contra un servidor de pruebas local.');
    process.exit(2);
}
mkdirSync(shots, { recursive: true });

const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = candidates.find(existsSync);
if (!exe) {
    console.error('No encuentro Edge ni Chrome.');
    process.exit(2);
}
const port = 9300 + Math.floor(Math.random() * 400);
const profile = join(tmpdir(), `mymusic-webcheck-${Date.now()}`);
const browser = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FALLO'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function connect() {
    for (let i = 0; i < 50; i++) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const page = targets.find(t => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* aún arrancando */ }
        await sleep(200);
    }
    throw new Error('El navegador no arranca');
}

const ws = new WebSocket(await connect());
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const waiting = new Map();
const problems = [];
ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
        problems.push(`excepción: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        problems.push(`consola: ${message.params.entry.text} ${message.params.entry.url ?? ''}`);
    }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
});
/** Ejecuta código en la página y devuelve su resultado. */
async function js(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
}
async function until(expression, ms = 15000, step = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await js(expression).catch(() => null);
        if (value) return value;
        await sleep(step);
    }
    return null;
}
async function shot(name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}
/** El <audio> del panel no está en la página: se observa envolviendo sus métodos antes de cargar. */
const SPY = `(() => {
    const original = window.Audio;
    window.__audios = [];
    window.Audio = function (...args) { const a = new original(...args); window.__audios.push(a); return a; };
    window.Audio.prototype = original.prototype;
})()`;
const A = 'window.__audios[0]';
const text = sel => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '')`;
const clickText = (sel, label) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`;
const dblclickRow = index => `(() => { const row = document.querySelectorAll('.main tbody tr')[${index}]; if (!row) return false; row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return row.dataset.key; })()`;
const typeInto = (sel, value) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const press = (sel, key) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`;

// Un segundo «dispositivo» del mismo usuario, para probar el relevo de la sesión
const other = { token: null };
const asOther = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

const listName = `zz prueba web ${Date.now() % 100000}`;
try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // 1. Entrar
    await send('Page.navigate', { url: `${base}/` });
    check('aparece la pantalla de entrar', await until(`!!document.querySelector('.login input[name=username]')`));
    await shot('1_entrar');
    await js(typeInto('.login input[name=username]', user));
    await js(typeInto('.login input[name=password]', 'una-clave-que-no-es'));
    await js(`document.querySelector('.login form').requestSubmit()`);
    check('con la contraseña mala avisa y no entra', await until(`${text('.login .err')}.includes('incorrectos')`), await js(text('.login .err')));
    await js(typeInto('.login input[name=password]', password));
    await js(`document.querySelector('.login form').requestSubmit()`);
    check('con la buena entra y se ve Inicio', await until(`${text('.main h3')} === 'Inicio'`));
    check('la cookie no es visible para el JavaScript de la página', (await js('document.cookie')) === '', await js('document.cookie'));
    check('abajo a la izquierda está el usuario', (await js(text('.who'))).includes(user), await js(text('.who')));
    await sleep(800);
    await shot('2_inicio');

    // 2. Crear una lista, buscar y añadir canciones
    await js(`document.querySelector('.side h4 button').click()`);
    await until(`!!document.querySelector('.modal input')`);
    await js(typeInto('.modal input', listName));
    await js(clickText('.modal .btn', 'Guardar'));
    check('se crea una lista y se abre', await until(`${text('.listhead h3')} === ${JSON.stringify(listName)}`));
    check('la lista vacía lo dice', await until(`${text('.main .empty')}.includes('vacía')`, 8000));

    await js(clickText('.side .nav', 'Buscar'));
    await until(`!!document.querySelector('.searchbox input')`);
    await js(typeInto('.searchbox input', process.env.MYMUSIC_CHECK_QUERY ?? 'rick astley never gonna give you up'));
    await js(press('.searchbox input', 'Enter'));
    const found = await until(`document.querySelectorAll('.main tbody tr').length`, 60000);
    check('buscar devuelve resultados', found > 0, `${found} resultados`);
    await shot('3_buscar');
    // Por si una pasada anterior se cortó a medias: las dos canciones de la prueba empiezan sin «me gusta»
    await js(`Promise.all([...document.querySelectorAll('.main tbody tr')].slice(0, 2).map(row => fetch('/api/likes', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-MyMusic': 'web' },
        body: JSON.stringify({ track: { key: row.dataset.key, title: 'limpieza de la prueba' }, liked: false }),
    }))).then(() => true)`);

    // Menú de los tres puntos → Añadir a una lista (las dos primeras canciones)
    for (const index of [0, 1]) {
        await js(`document.querySelectorAll('.main tbody tr')[${index}].querySelector('.ib').click()`);
        await until(`!!document.querySelector('.menu')`);
        if (index === 0) await shot('4_menu_de_cancion');
        await js(clickText('.menu button', 'Añadir a una lista'));
        await until(`!!document.querySelector('.modal .pick')`);
        await js(clickText('.modal .pick', listName));
        await until(`${text('.toast')}.includes('Añadida')`, 8000);
        await sleep(400);
    }
    await js(clickText('.side .pl', listName));
    const inList = await until(`document.querySelectorAll('.main tbody tr').length === 2 && 2`, 10000);
    check('las dos canciones están en la lista', inList === 2);

    // Reordenar arrastrando la segunda fila sobre la primera, y que el servidor lo guarde
    const keysOf = `[...document.querySelectorAll('.main tbody tr')].map(row => row.dataset.key).join(' ')`;
    const before = await js(keysOf);
    await js(`(() => {
        const rows = document.querySelectorAll('.main tbody tr');
        const data = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
        fire(rows[1], 'dragstart'); fire(rows[0], 'dragover'); fire(rows[0], 'drop'); fire(rows[1], 'dragend');
    })()`);
    const after = await until(`${keysOf} !== ${JSON.stringify(before)} && ${keysOf}`, 8000);
    check('arrastrar una fila reordena la lista', after === before.split(' ').reverse().join(' '), `${before} → ${after}`);

    // Cambiar el nombre de la lista y dejarlo como estaba
    for (const name of [`${listName} bis`, listName]) {
        await js(`document.querySelector('.listhead .btn.icon').click()`);
        await until(`!!document.querySelector('.menu')`);
        await js(clickText('.menu button', 'Cambiar el nombre'));
        await until(`!!document.querySelector('.modal input')`);
        await js(typeInto('.modal input', name));
        await js(clickText('.modal .btn', 'Guardar'));
        check(`cambiar el nombre a «${name.slice(-12)}»`, await until(`${text('.listhead h3')} === ${JSON.stringify(name)} && [...document.querySelectorAll('.side .pl')].some(e => e.textContent.startsWith(${JSON.stringify(name)}))`, 8000));
    }

    // 3. Reproducir la lista
    await js(clickText('.listhead .btn', 'Reproducir'));
    const playing = await until(`${A} && !${A}.paused && ${A}.currentTime > 1 && ${A}.currentTime`, 90000, 500);
    check('suena (el audio avanza)', Boolean(playing), `segundo ${Number(playing).toFixed(1)}; ${await js(`${A}.currentSrc`)}`);
    const first = await js(text('.player .now b'));
    check('la barra muestra la canción y la lista', (await js(text('.player .now small'))).includes(listName), `${first} · ${await js(text('.player .now small'))}`);
    check('la fila que suena queda marcada', await js(`document.querySelectorAll('.main tbody tr.on').length === 1`));
    const total = await js(`${A}.duration`);
    check('el navegador conoce la duración', Number.isFinite(total) && total > 30, `${total} s`);
    await sleep(1500);
    await shot('5_lista_sonando');

    // Saltar dentro de la canción (clic a mitad de la barra)
    await js(`(() => { const bar = document.querySelector('.prog .tr'); const box = bar.getBoundingClientRect(); bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + box.width * 0.5, clientY: box.top + 2 })); })()`);
    const jumped = await until(`${A}.currentTime > ${Math.floor(total * 0.45)} && !${A}.seeking && ${A}.readyState >= 3 && ${A}.currentTime`, 60000, 500);
    check('saltar a mitad de canción funciona', Boolean(jumped), `segundo ${Number(jumped || 0).toFixed(0)} de ${Math.round(total)}`);

    // Pausa y reanudar
    await js(`document.querySelector('.player .big').click()`);
    check('pausa', await until(`${A}.paused`, 5000));
    await js(`document.querySelector('.player .big').click()`);
    check('reanuda', await until(`!${A}.paused`, 10000));

    // Repetir (no → lista → canción → no) y aleatorio (sí → no)
    const repeat = `document.querySelector('.player [title^="Repetir"]')`;
    await js(`${repeat}.click()`);
    check('repetir: toda la lista', await until(`${repeat}.classList.contains('on') && !${repeat}.classList.contains('rep1')`, 5000));
    await js(`${repeat}.click()`);
    check('repetir: esta canción', await until(`${repeat}.classList.contains('rep1')`, 5000));
    await js(`${repeat}.click()`);
    check('repetir: no', await until(`!${repeat}.classList.contains('on')`, 5000));
    const shuffle = `document.querySelector('.player [title=Aleatorio]')`;
    await js(`${shuffle}.click()`);
    check('aleatorio: sí', await until(`${shuffle}.classList.contains('on')`, 5000));
    await js(`${shuffle}.click()`);
    check('aleatorio: no', await until(`!${shuffle}.classList.contains('on')`, 5000));

    // Cola
    await js(`document.querySelector('.player .right .ib').click()`);
    const queued = await until(`document.querySelectorAll('.drawer .qrow').length`, 8000);
    check('la cola muestra la que suena y la siguiente', queued === 2, `${queued} filas`);
    await shot('6_cola');
    // Quitar la siguiente de la cola y volver a ponerla con «Añadir a la cola» desde la lista
    await js(`document.querySelector('.drawer .qrow:not(.cur) .x').click()`);
    check('quitar una canción de la cola', await until(`document.querySelectorAll('.drawer .qrow').length === 1`, 8000));
    await js(`document.querySelectorAll('.main tbody tr')[1].querySelector('.ib').click()`);
    await until(`!!document.querySelector('.menu')`);
    await js(clickText('.menu button', 'Añadir a la cola'));
    check('«Añadir a la cola» la devuelve', await until(`document.querySelectorAll('.drawer .qrow').length === 2`, 8000));

    // Siguiente
    await js(`document.querySelector('.player [title=Siguiente]').click()`);
    const second = await until(`${text('.player .now b')} !== ${JSON.stringify(first)} && !${A}.paused && ${A}.currentTime > 1 && ${text('.player .now b')}`, 90000, 500);
    check('«siguiente» pasa a la segunda canción y suena', Boolean(second), String(second));

    // 3b. «Me gusta»: el corazón de la barra mete la canción que suena en la lista del corazón, arriba del todo
    const heart = `document.querySelector('.player .now .like')`;
    const heartOn = `${heart}.classList.contains('on')`;
    const likesPl = `[...document.querySelectorAll('.side .pl')].find(e => e.querySelector('.ic')?.getClientRects().length > 0)`;
    const likesCount = `(Number(${likesPl}?.querySelector('small').textContent) || 0)`;
    const playingKey = await js(`document.querySelector('.main tbody tr.on').dataset.key`);
    check('la barra tiene el corazón, vacío', await js(`!!${heart} && !${heart}.classList.contains('hidden') && !${heartOn}`));
    const likedBefore = await js(likesCount);
    await js(`${heart}.click()`);
    check('el corazón de la barra se rellena y avisa', await until(`${heartOn} && ${text('.toast')}.includes('Añadida a')`, 8000), await js(text('.toast')));
    check('la lista del corazón sale la primera, con su corazón, y cuenta una más', await until(`!!${likesPl} && document.querySelector('.side .pl') === ${likesPl} && ${likesCount} === ${likedBefore + 1}`, 8000), `${likedBefore} → ${await js(likesCount)}`);
    await shot('6b_me_gusta_barra');
    await js(`${likesPl}.click()`);
    check('dentro, la carátula es el corazón y la canción recién marcada está arriba', await until(`document.querySelector('.listhead .cv.like .ic')?.getClientRects().length > 0 && document.querySelector('.main tbody tr')?.dataset.key === ${JSON.stringify(playingKey)}`, 8000));
    await shot('6c_me_gusta_lista');
    // Su menú ofrece quitarla; al quitarla sale de la lista y el corazón de la barra se vacía
    await js(`document.querySelector('.main tbody tr .ib').click()`);
    await until(`!!document.querySelector('.menu')`);
    check('el menú de una canción marcada ofrece quitarla', await js(clickText('.menu button', 'Quitar de «me gusta»')));
    check('quitarla la saca de la lista y vacía el corazón', await until(`!${heartOn} && document.querySelector('.main tbody tr')?.dataset.key !== ${JSON.stringify(playingKey)} && ${likesCount} === ${likedBefore}`, 8000), await js(text('.toast')));
    // Desde el menú de la otra canción de la lista de prueba (la que no suena): marcar y quitar
    await js(clickText('.side .pl', listName));
    await until(`${text('.listhead h3')} === ${JSON.stringify(listName)} && document.querySelectorAll('.main tbody tr').length === 2`, 8000);
    for (const [label, done] of [['Me gusta', 'Añadida a'], ['Quitar de «me gusta»', 'Quitada de']]) {
        await js(`[...document.querySelectorAll('.main tbody tr')].find(row => !row.classList.contains('on')).querySelector('.ib').click()`);
        await until(`!!document.querySelector('.menu')`);
        const offered = await js(clickText('.menu button', label));
        check(`menú de una canción: «${label}»`, offered && Boolean(await until(`${text('.toast')}.includes(${JSON.stringify(done)})`, 8000)), await js(text('.toast')));
        await sleep(600);
    }
    check('la lista del corazón queda como estaba', await js(likesCount) === likedBefore, `${await js(likesCount)} canciones`);

    // 4. Relevo: otro dispositivo del mismo usuario toma la sesión
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password, device: 'Móvil de prueba' }) });
    other.token = (await login.json()).token;
    const claimed = await asOther('POST', '/api/session/claim');
    check('otro dispositivo pide continuar', claimed.status === 200 && claimed.body.session?.active === true);
    await asOther('PUT', '/api/session/state', { index: claimed.body.session.index, positionMs: 20000 });
    const stopped = await until(`${A}.paused`, 30000, 500);
    check('el navegador se para solo y avisa', Boolean(stopped), await js(text('.toast')));
    await js(clickText('.side .nav', 'Inicio'));
    const banner = await until(`${text('.banner')}.includes('Móvil de prueba') && ${text('.banner')}`, 10000);
    check('Inicio ofrece continuar y dice dónde sonaba', Boolean(banner), String(banner));
    await shot('7_continuar_aqui');
    await js(clickText('.banner .btn', 'Continuar aquí'));
    const back = await until(`!${A}.paused && ${A}.currentTime > 19 && ${A}.currentTime`, 60000, 500);
    check('«Continuar aquí» recupera la sesión por el minuto del otro', Boolean(back), `segundo ${Number(back || 0).toFixed(0)}`);
    check('el otro dispositivo deja de llevarla', (await asOther('GET', '/api/session')).body.session?.active === false);

    // Historial completo, desde «Ver todo»
    await js(clickText('.main .sec button', 'Ver todo'));
    const listened = await until(`${text('.main h3')} === 'Historial' && document.querySelectorAll('.main tbody tr').length`, 8000);
    check('el historial muestra lo escuchado', listened > 0, `${listened} entradas`);

    // 5. Importar: el diálogo se abre y un enlace malo se explica (leer una lista real depende de fuera)
    await js(clickText('.side .pl', listName));
    await until(`!!document.querySelector('.listhead')`);
    await js(clickText('.listhead .btn', 'Importar'));
    await until(`!!document.querySelector('.modal input')`);
    await js(typeInto('.modal input', 'https://example.com/no-es-una-lista'));
    await js(press('.modal input', 'Enter'));
    check('importar: un enlace que no vale se explica', await until(`${text('.modal .err')}.includes('No reconozco')`, 10000), await js(text('.modal .err')));
    await shot('8_importar');

    // Pegar un bloque de enlaces de canciones de Spotify (lo que copia su programa con Ctrl+A, Ctrl+C):
    // así se traen listas de más de 100. Lee de Spotify de verdad, como buscar lee de YouTube.
    const block = ['0ofHAoxe9vBkTCp2UQIavz', '0RO9W1xJoUEpq5MEelddFb', '57JVGBtBLCfHw2muk5416J'].map(id => `https://open.spotify.com/track/${id}`).join('\r\n');
    await js(`(() => {
        const input = document.querySelector('.modal input');
        const data = new DataTransfer();
        data.setData('text/plain', ${JSON.stringify(block)});
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    const offered = await until(`${text('.modal .btn.pri')}.startsWith('Añadir 3') && ${text('.modal')}`, 30000);
    check('pegar tres enlaces de canciones: las lee y ofrece añadirlas', Boolean(offered), await js(text('.modal .counts')));
    check('el resumen no pinta «false» ni «undefined»', !/false|undefined|null/.test(String(offered)), String(offered).slice(0, 160));
    await shot('8b_importar_enlaces');
    await js(`document.querySelector('.modal .btn.pri').click()`);
    check('las añade a la lista', await until(`document.querySelectorAll('.main tbody tr').length === 5`, 10000), await js(text('.toast')));
    // Pegar el mismo bloque otra vez no duplica nada
    await js(clickText('.listhead .btn', 'Importar'));
    await until(`!!document.querySelector('.modal input')`);
    await js(`(() => {
        const input = document.querySelector('.modal input');
        const data = new DataTransfer();
        data.setData('text/plain', ${JSON.stringify(block)});
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    check('pegarlas otra vez no duplica: nada nuevo que añadir', await until(`${text('.modal .btn.pri')} === 'Nada nuevo que añadir' && document.querySelector('.modal .btn.pri').disabled`, 30000), await js(text('.modal .counts')));
    await js(clickText('.modal .btn', 'Cancelar'));

    // 6. Ajustes
    await js(`document.querySelector('.who').click()`);
    check('Ajustes muestra el usuario', await until(`${text('.modal')}.includes(${JSON.stringify(user)}) && ${text('.modal h2')} === 'Ajustes'`, 5000));
    await shot('9_ajustes');
    await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);

    // 6b. Fase 4 — «Probar extracción» (lee de YouTube de verdad, como buscar)
    await js(`document.querySelector('.who').click()`);
    await until(`${text('.modal h2')} === 'Ajustes'`, 5000);
    await js(clickText('.modal .btn', 'Probar'));
    const probed = await until(`document.querySelectorAll('.modal .probe p').length === 2 && ${text('.modal .probe')}`, 90000, 500);
    check('Ajustes: «Probar extracción» dice que el buscador y YouTube responden', Boolean(probed) && await js(`document.querySelectorAll('.modal .probe p.ok').length === 2`), String(probed));
    await shot('9b_probar_extraccion');
    await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);

    // Papelera: quitar una canción de la lista, verla en la papelera y devolverla
    const goneTitle = await js(`document.querySelectorAll('.main tbody tr')[4].querySelector('.t span').textContent`);
    await js(`document.querySelectorAll('.main tbody tr')[4].querySelector('.ib').click()`);
    await until(`!!document.querySelector('.menu')`);
    await js(clickText('.menu button', 'Quitar de la lista'));
    await until(`document.querySelectorAll('.main tbody tr').length === 4`, 8000);
    await js(`document.querySelector('.who').click()`);
    await until(`${text('.modal h2')} === 'Ajustes'`, 5000);
    const trashLabel = await until(`/recuperable/.test(${text('.modal')})`, 8000);
    await js(clickText('.modal .btn', 'Abrir'));
    const inTrash = await until(`${text('.modal h2')} === 'Papelera' && [...document.querySelectorAll('.modal .pick')].some(e => e.textContent.includes(${JSON.stringify(goneTitle)}))`, 8000);
    check('Papelera: Ajustes dice cuánto hay y la canción quitada aparece para recuperarla', Boolean(trashLabel) && Boolean(inTrash), goneTitle);
    await shot('9c_papelera');
    await js(`[...document.querySelectorAll('.modal .pick')].find(e => e.textContent.includes(${JSON.stringify(goneTitle)})).querySelector('.btn').click()`);
    check('Papelera: «Restaurar» la devuelve a su lista', await until(`${text('.toast')}.includes('Devuelta a') && document.querySelectorAll('.main tbody tr').length === 5`, 10000), await js(text('.toast')));
    await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);

    // Radio: la casilla se marca en la lista y queda marcada en todas partes (lista, cola y barra)
    const checks = `[...document.querySelectorAll('input.radiochk')]`;
    await js(`document.querySelector('.listhead input.radiochk').click()`);
    check('Radio: marcar la casilla en la lista la marca en todas partes y se recuerda en el servidor',
        await until(`${checks}.length >= 3 && ${checks}.every(e => e.checked)`, 8000) && (await asOther('GET', '/api/radio')).body.radio?.enabled === true);
    // Se reproduce desde la penúltima: al quedar una sola por detrás, la radio añade una tanda (lee mezclas de YouTube de verdad)
    await js(dblclickRow(3));
    const radioRows = await until(`document.querySelectorAll('.drawer .qrow .auto').length >= 3 && document.querySelectorAll('.drawer .qrow .auto').length`, 240000, 1000);
    check('Radio: al quedar una canción, la cola recibe canciones parecidas marcadas «Radio»', radioRows === 5, `${radioRows} de la radio · ${await js(text('.drawer .radnote'))}`);
    const clash = await js(`(() => {
        const mine = new Set([...document.querySelectorAll('.main tbody tr .t span')].map(e => e.textContent));
        return [...document.querySelectorAll('.drawer .qrow')].filter(row => row.querySelector('.auto') && mine.has(row.querySelector('b').textContent)).length;
    })()`);
    check('Radio: ninguna de las que pone está ya en la lista', clash === 0, [...new Set(await js(`[...document.querySelectorAll('.drawer .qrow')].filter(row => row.querySelector('.auto')).map(row => row.querySelector('b').textContent.slice(0, 40))`))].join(' | '));
    const keptTitle = await js(`document.querySelector('.drawer .qrow .add').closest('.qrow').querySelector('b').textContent`);
    await js(`document.querySelector('.drawer .qrow .add').click()`);
    check('Radio: el «+» guarda la canción en la lista que suena y deja de ser «de la radio»',
        await until(`${text('.toast')}.includes('Añadida a') && document.querySelectorAll('.main tbody tr').length === 6 && document.querySelectorAll('.drawer .qrow .auto').length === ${Number(radioRows) - 1}`, 10000),
        `${keptTitle} · ${await js(text('.toast'))}`);
    await shot('9d_radio_en_la_cola');
    await js(`document.querySelector('.drawer input.radiochk').click()`);
    check('Radio: desmarcarla la apaga en todas partes',
        await until(`${checks}.every(e => !e.checked) && !document.querySelector('.drawer .radnote')`, 8000) && (await asOther('GET', '/api/radio')).body.radio?.enabled === false);

    // «Tu radio» en Inicio: una sesión hecha de canciones parecidas a lo que escucha
    await js(clickText('.side .nav', 'Inicio'));
    await until(`!!document.querySelector('.banner.radio .btn')`, 8000);
    await js(`document.querySelector('.banner.radio .btn').click()`);
    const homeRadio = await until(`${text('.player .now small')}.includes('Tu radio') && !${A}.paused && ${A}.currentTime > 1 && ${text('.player .now b')}`, 240000, 1000);
    check('«Tu radio» (Inicio) empieza una sesión de canciones parecidas y suena', Boolean(homeRadio), `${homeRadio} · ${await js(text('.player .now small'))}`);
    await shot('9e_tu_radio');
    await js(clickText('.side .pl', listName));
    await until(`${text('.listhead h3')} === ${JSON.stringify(listName)}`, 8000);

    // 7. Limpieza: la lista de prueba, a la papelera
    await js(`document.querySelector('.listhead .btn.icon').click()`);
    await until(`!!document.querySelector('.menu')`);
    await js(clickText('.menu button', 'Enviar a la papelera'));
    await until(`!!document.querySelector('.modal')`);
    await js(clickText('.modal .btn.pri', 'Enviar a la papelera'));
    check('la lista de prueba va a la papelera y se vuelve a Inicio', await until(`${text('.main h3')} === 'Inicio' && ![...document.querySelectorAll('.side .pl')].some(e => e.textContent.includes(${JSON.stringify(listName)}))`, 10000));

    // 8. Cerrar sesión
    await js(`document.querySelector('.who').click()`);
    await until(`!!document.querySelector('.modal')`);
    await js(clickText('.modal .btn', 'Cerrar sesión'));
    check('cerrar sesión vuelve a la pantalla de entrar', await until(`!!document.querySelector('.login input[name=username]')`, 8000));
    await js('location.reload()');
    await sleep(1500);
    check('al recargar sigue fuera', await until(`!!document.querySelector('.login input[name=username]')`, 8000));

    // 9. Pantalla estrecha (móvil): la estructura de la app, con el dedo
    const M = 'móvil: ';
    const center = expr => js(`(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    const touch = (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
    const tapAt = async (x, y) => { await touch('touchStart', x, y); await sleep(60); await touch('touchEnd'); await sleep(120); };
    const tap = async expr => { const at = await center(expr); if (!at) throw new Error(`no encuentro ${expr}`); await tapAt(...at); };
    const q = sel => `document.querySelector(${JSON.stringify(sel)})`;
    const byText = (sel, label) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}))`;
    const fits = `document.documentElement.scrollWidth <= window.innerWidth && (!document.querySelector('.main') || document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth)`;
    const mKeys = `[...document.querySelectorAll('.main .row[data-key]')].map(row => row.dataset.key).join(' ')`;
    const mList = `${listName} m`;
    const shown = sel => `(document.querySelector(${JSON.stringify(sel)})?.getClientRects().length > 0)`;       // vale también para lo que va «fixed»

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url: `${base}/` });
    await until(`!!document.querySelector('.login input[name=username]')`);
    await shot('m01_entrar');
    await js(typeInto('.login input[name=username]', user));
    await js(typeInto('.login input[name=password]', password));
    await js(`document.querySelector('.login form').requestSubmit()`);
    check(`${M}entra y abajo hay tres pestañas`, await until(`document.documentElement.classList.contains('m') && ${text('.main h3')} === 'Inicio' && [...document.querySelectorAll('.side .nav')].filter(e => e.offsetParent).length === 3`));
    check(`${M}no hay barra lateral ni barra de escritorio`, await js(`!document.querySelector('.who').offsetParent && !document.querySelector('.player').offsetParent`));
    await shot('m02_inicio');

    await tap(byText('.side .nav', 'Listas'));
    check(`${M}la pestaña Listas`, await until(`${text('.main h3')} === 'Listas' && !!document.querySelector('.fab')`));
    await tap(q('.fab'));
    await until(`!!document.querySelector('.modal input')`);
    await shot('m03_nueva_lista');
    await js(typeInto('.modal input', mList));
    await js(clickText('.modal .btn', 'Guardar'));
    check(`${M}«Nueva lista» la crea y la abre`, await until(`${text('.listhead h3')} === ${JSON.stringify(mList)}`));

    await tap(byText('.side .nav', 'Buscar'));
    await until(`!!document.querySelector('.searchbox input')`);
    await js(typeInto('.searchbox input', process.env.MYMUSIC_CHECK_QUERY ?? 'rick astley never gonna give you up'));
    await js(press('.searchbox input', 'Enter'));
    const mFound = await until(`document.querySelectorAll('.main .row[data-key]').length`, 60000);
    check(`${M}buscar pinta filas (no tabla) y caben en la pantalla`, mFound > 0 && await js(`!document.querySelector('.main table') && ${fits}`), `${mFound} filas`);
    await shot('m04_buscar');

    // Los tres puntos abren una hoja; tocar fuera la cierra SIN que el toque caiga en la fila de debajo
    await tap(`document.querySelectorAll('.main .row[data-key]')[0].querySelector('.ib')`);
    check(`${M}los tres puntos abren una hoja con la canción`, await until(`!!document.querySelector('.sheet .opt') && !!document.querySelector('.sheet .row b')`));
    await shot('m05_hoja_de_cancion');
    await tapAt(195, 150);
    await sleep(600);
    check(`${M}tocar fuera cierra la hoja y no reproduce lo de debajo`, await js(`!document.querySelector('.sheet') && !${A}.currentSrc && !document.querySelector('.mini').offsetParent`));
    for (const index of [0, 1]) {
        await tap(`document.querySelectorAll('.main .row[data-key]')[${index}].querySelector('.ib')`);
        await until(`!!document.querySelector('.sheet .opt')`);
        await tap(byText('.sheet .opt', 'Añadir a una lista'));
        await until(`!!document.querySelector('.modal .pick')`);
        if (index === 0) await shot('m06_hoja_de_listas');
        await js(clickText('.modal .pick', mList));
        await until(`${text('.toast')}.includes('Añadida')`, 8000);
        await sleep(500);
    }

    await tap(byText('.side .nav', 'Listas'));
    await until(`${text('.main h3')} === 'Listas' && !!${byText('.main .row', mList)}`, 8000);
    await shot('m07_listas');
    await tap(`${byText('.main .row', mList)}.querySelector('.t')`);
    check(`${M}la lista se abre con sus dos canciones`, await until(`${text('.listhead h3')} === ${JSON.stringify(mList)} && document.querySelectorAll('.main .row[data-key]').length === 2`, 10000));
    check(`${M}la cabecera de la lista cabe en la pantalla`, await js(fits));

    // Mantener pulsada la segunda fila y subirla sobre la primera
    const mBefore = await js(mKeys);
    const [fromX, fromY] = await center(`document.querySelectorAll('.main .row[data-key]')[1].querySelector('.t')`);
    const [, toY] = await center(`document.querySelectorAll('.main .row[data-key]')[0].querySelector('.t')`);
    await touch('touchStart', fromX, fromY);
    await sleep(700);
    const lifted = await js(`!!document.querySelector('.main .row.lift')`);
    for (let step = 1; step <= 6; step++) { await touch('touchMove', fromX, fromY + ((toY - fromY) * step) / 6); await sleep(40); }
    await touch('touchEnd');
    const mAfter = await until(`${mKeys} !== ${JSON.stringify(mBefore)} && ${mKeys}`, 8000);
    check(`${M}mantener pulsada una fila y arrastrarla reordena`, lifted && Boolean(mAfter) && mAfter === mBefore.split(' ').reverse().join(' '), `${mBefore} → ${mAfter}`);
    await sleep(600);
    check(`${M}soltar la fila no reproduce nada`, await js(`!${A}.currentSrc`));

    // Tocar una fila la reproduce y aparece el minirreproductor
    await tap(`document.querySelectorAll('.main .row[data-key]')[0].querySelector('.t')`);
    check(`${M}tocar una fila la reproduce`, await until(`!${A}.paused && ${A}.currentTime > 1`, 90000, 500), `segundo ${(await js(`${A}.currentTime`)).toFixed(1)}`);
    check(`${M}aparece el minirreproductor con la canción`, await js(`!!document.querySelector('.mini').offsetParent && ${text('.mini b')}.length > 0 && document.querySelector('.main .row.on') !== null`), await js(text('.mini b')));
    await shot('m08_lista_sonando');

    await tap(q('.mini .t'));
    check(`${M}tocar el minirreproductor abre el reproductor`, await until(`!!${shown('.full')} && ${text('.full .title')} === ${text('.mini b')}`, 5000), await js(text('.full .mid')));
    await until(`${A}.duration > 0`, 15000);
    await sleep(400);
    await shot('m09_reproductor');
    const mBar = await js(`(() => { const b = document.querySelector('.full .seek').getBoundingClientRect(); return [b.left, b.top + b.height / 2, b.width]; })()`);
    await touch('touchStart', mBar[0] + mBar[2] * 0.2, mBar[1]);
    for (const part of [0.3, 0.4, 0.5]) { await touch('touchMove', mBar[0] + mBar[2] * part, mBar[1]); await sleep(40); }
    await touch('touchEnd');
    const mHalf = await js(`${A}.duration / 2`);
    check(`${M}arrastrar la barra salta a ese punto`, await until(`Math.abs(${A}.currentTime - ${mHalf}) < 12`, 15000), `segundo ${Math.round(await js(`${A}.currentTime`))} de ${Math.round(mHalf * 2)}`);
    await tap(q('.full .big'));
    check(`${M}pausa desde el reproductor`, await until(`${A}.paused`, 5000));
    await tap(q('.full .big'));
    check(`${M}y reanuda`, await until(`!${A}.paused`, 10000));

    // «Me gusta»: el corazón va junto al título, a la izquierda del botón de añadir a una lista (mockups/me-gusta-v1.html)
    const mHeart = `document.querySelector('.full .meta .like')`;
    check(`${M}el reproductor tiene el corazón, vacío, antes del botón de añadir a una lista`, await js(`!!${mHeart} && ${mHeart}.getClientRects().length > 0 && ${mHeart}.nextElementSibling?.title === 'Añadir a una lista' && !${mHeart}.classList.contains('on')`));
    await tap(mHeart);
    check(`${M}tocar el corazón lo rellena y avisa`, await until(`${mHeart}.classList.contains('on') && ${text('.toast')}.includes('Añadida a')`, 8000), await js(text('.toast')));
    await sleep(300);
    await shot('m09b_reproductor_me_gusta');

    await tap(q('.full .foot .btn'));
    check(`${M}la cola se abre a pantalla completa con la siguiente`, await until(`!!${shown('.drawer')} && document.querySelectorAll('.drawer .qrow').length === 2 && document.querySelector('.drawer').getBoundingClientRect().width >= window.innerWidth`, 8000));
    await shot('m10_cola');
    check(`${M}la casilla «Radio» está en la cola y en el reproductor, y cabe`, await js(`!!document.querySelector('.drawer .head input.radiochk') && !!document.querySelector('.full .foot input.radiochk') && document.querySelector('.drawer .head').scrollWidth <= document.querySelector('.drawer .head').clientWidth + 1`));
    await js('history.back()');
    check(`${M}«atrás» cierra la cola y deja el reproductor`, await until(`!${shown('.drawer')} && !!${shown('.full')}`, 5000));
    await js('history.back()');
    check(`${M}«atrás» cierra el reproductor y sigue en la lista`, await until(`!${shown('.full')} && ${text('.listhead h3')} === ${JSON.stringify(mList)}`, 5000));
    await js('history.back()');
    check(`${M}«atrás» vuelve a la pantalla anterior (Listas)`, await until(`${text('.main h3')} === 'Listas'`, 5000));

    // «Me gusta»: la lista del corazón va la primera, con el corazón por carátula; dentro, la recién marcada arriba
    check(`${M}la lista del corazón sale la primera, con el corazón por carátula`, await until(`document.querySelector('.main .rows .row')?.querySelector('.cv.like .ic')?.getClientRects().length > 0`, 8000));
    await shot('m10b_listas_me_gusta');
    await tap(`document.querySelector('.main .rows .row .t')`);
    check(`${M}dentro, la canción recién marcada está arriba`, await until(`document.querySelector('.listhead .cv.like .ic')?.getClientRects().length > 0 && document.querySelector('.main .row[data-key]')?.classList.contains('on')`, 8000));
    await tap(`document.querySelector('.main .row[data-key] .ib')`);
    await until(`!!document.querySelector('.sheet .opt')`);
    await shot('m10c_hoja_me_gusta');
    const mUnlike = await js(`!!${byText('.sheet .opt', 'Quitar de «me gusta»')}`);
    if (mUnlike) await tap(byText('.sheet .opt', 'Quitar de «me gusta»'));
    check(`${M}la hoja de una canción marcada ofrece quitarla, y sale de la lista`, mUnlike && Boolean(await until(`${text('.toast')}.includes('Quitada de') && !document.querySelector('.main .row[data-key].on')`, 8000)), await js(text('.toast')));
    await js('history.back()');
    await until(`${text('.main h3')} === 'Listas'`, 5000);

    // Girar a una ventana ancha y volver: cambia de estructura sin romperse y sin cortar la música
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    check(`${M}al ensanchar pasa a la estructura de escritorio`, await until(`!document.documentElement.classList.contains('m') && !!document.querySelector('.player').offsetParent && !document.querySelector('.mini').offsetParent`, 5000));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    check(`${M}y al estrechar vuelve, con la música sonando`, await until(`document.documentElement.classList.contains('m') && !!document.querySelector('.mini').offsetParent && !${A}.paused`, 5000));

    await tap(byText('.side .nav', 'Inicio'));
    await until(`${text('.main h3')} === 'Inicio'`);
    await sleep(800);
    check(`${M}Inicio cabe en la pantalla`, await js(fits));
    await shot('m11_inicio_sonando');
    await tap(q('.main .top .ib'));
    check(`${M}Ajustes se abre desde Inicio`, await until(`${text('.modal h2')} === 'Ajustes' && ${text('.modal')}.includes(${JSON.stringify(user)})`, 5000));
    await shot('m12_ajustes');
    await js(clickText('.modal .btn', 'Abrir'));
    check(`${M}la papelera se abre como hoja y cabe en la pantalla`, await until(`${text('.modal h2')} === 'Papelera' && document.querySelectorAll('.modal .pick').length > 0`, 8000)
        && await js(`document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth + 1 && ${fits}`));
    await shot('m13_papelera');
    await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);

    // Limpieza: la lista de prueba a la papelera, desde la pestaña Listas
    await tap(byText('.side .nav', 'Listas'));
    await until(`!!${byText('.main .row', mList)}`, 8000);
    await tap(`${byText('.main .row', mList)}.querySelector('.ib')`);
    await until(`!!document.querySelector('.sheet .opt')`);
    await tap(byText('.sheet .opt', 'Enviar a la papelera'));
    await until(`!!document.querySelector('.modal .btn.pri')`);
    await js(clickText('.modal .btn.pri', 'Enviar a la papelera'));
    check(`${M}la lista de prueba va a la papelera y se queda en Listas`, await until(`${text('.main h3')} === 'Listas' && !${byText('.main .row', mList)}`, 10000));
    await tap(byText('.side .nav', 'Inicio'));
    await until(`${text('.main h3')} === 'Inicio'`);
    await tap(q('.main .top .ib'));
    await until(`!!document.querySelector('.modal')`);
    await js(clickText('.modal .btn', 'Cerrar sesión'));
    check(`${M}cerrar sesión vuelve a la pantalla de entrar`, await until(`!!document.querySelector('.login input[name=username]')`, 8000));

    // Respuestas que la propia prueba provoca y el navegador apunta en la consola: no son fallos
    const expected = [/status of 401 .*\/api\/(me|login)/, /status of 409 .*\/api\/session\//, /status of 400 .*\/api\/import\/preview/];
    const real = problems.filter(problem => !expected.some(pattern => pattern.test(problem)));
    check('sin errores de JavaScript ni de carga en la consola', real.length === 0, real.slice(0, 5).join(' | '));
} catch (error) {
    failed++;
    console.log(`FALLO la prueba se ha interrumpido — ${error.message}`);
    await shot('error').catch(() => {});
    if (problems.length) console.log(`      consola: ${problems.slice(0, 5).join(' | ')}`);
} finally {
    if (other.token) await asOther('POST', '/api/logout').catch(() => {});
    ws.close();
    browser.kill();
}
console.log(failed === 0 ? '\nTodo bien.' : `\n${failed} comprobaciones en rojo.`);
process.exit(failed === 0 ? 0 : 1);
