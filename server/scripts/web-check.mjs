#!/usr/bin/env node
// Prueba del panel web en un navegador de verdad (Edge o Chrome sin ventana), contra un servidor
// de PRUEBAS. Nunca contra el del Flip: abre sesiones, crea listas y toma la sesión de escucha.
//
//   node scripts/web-check.mjs http://127.0.0.1:3101 <usuario> <carpeta para las capturas>
//   (la contraseña se lee de la variable MYMUSIC_CHECK_PASSWORD)
//   Con MYMUSIC_CHECK_ADMIN y MYMUSIC_CHECK_ADMIN_PASSWORD (la cuenta del dueño) prueba además la
//   pantalla «Consumo», que solo ve él. <usuario> conviene que NO sea el dueño: así se comprueba que no la ve.
//   «Para ti» (listas automáticas y «Tus estadísticas», sección 11) se prueba con la cuenta del dueño si
//   se da, y si no con <usuario>: hace falta historial. Con dos cuentas distintas se comprueba además que
//   cada una ve solo lo suyo.
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
/**
 * El <audio> del panel no está en la página: se observa envolviendo sus métodos antes de cargar.
 * También se envuelve fetch: con window.__fetchHook = { path, edit(datos) } la prueba puede cambiar
 * una respuesta del servidor (p. ej. simular una lista automática vacía) sin tocar los datos.
 */
const SPY = `(() => {
    const original = window.Audio;
    window.__audios = [];
    window.Audio = function (...args) { const a = new original(...args); window.__audios.push(a); return a; };
    window.Audio.prototype = original.prototype;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const response = await realFetch(input, init);
        const hook = window.__fetchHook;
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (!hook || !url.endsWith(hook.path) || !response.ok) return response;
        const data = hook.edit(await response.clone().json());
        return new Response(JSON.stringify(data), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    };
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
    // «Consumo» es solo del dueño: a los demás ni se les enseña ni se les da
    const isAdmin = await js(`fetch('/api/me', { credentials: 'same-origin' }).then(r => r.json()).then(me => me.user.admin === true)`);
    const usageRow = await js(`[...document.querySelectorAll('.modal .rowline b')].some(e => e.textContent === 'Consumo')`);
    const usageStatus = await js(`fetch('/api/usage', { credentials: 'same-origin' }).then(r => r.status)`);
    check(isAdmin ? 'Consumo: el dueño lo tiene en Ajustes' : 'Consumo: quien no es el dueño no lo ve en Ajustes ni puede pedirlo', usageRow === isAdmin && usageStatus === (isAdmin ? 200 : 403), `fila ${usageRow}, respuesta ${usageStatus}`);
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

    // 10. Consumo (solo el dueño): lo que gasta cada usuario, la máquina y cuántos caben
    const admin = process.env.MYMUSIC_CHECK_ADMIN;
    const adminPassword = process.env.MYMUSIC_CHECK_ADMIN_PASSWORD;
    if (admin && adminPassword) {
        const C = 'consumo: ';
        const openUsage = async () => {
            await js(`(document.querySelector('.who').offsetParent ? document.querySelector('.who') : document.querySelector('.main .top .ib')).click()`);
            await until(`${text('.modal h2')} === 'Ajustes'`, 5000);
            await js(`[...document.querySelectorAll('.modal .rowline')].find(e => e.querySelector('b')?.textContent === 'Consumo').querySelector('.btn').click()`);
            return until(`${text('.modal h2')} === 'Consumo' && document.querySelectorAll('.modal .fact').length >= 4`, 8000);
        };
        const fitsModal = `document.querySelector('.modal').scrollWidth <= document.querySelector('.modal').clientWidth + 1`;
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: `${base}/` });
        await until(`!!document.querySelector('.login input[name=username]')`);
        await js(typeInto('.login input[name=username]', admin));
        await js(typeInto('.login input[name=password]', adminPassword));
        await js(`document.querySelector('.login form').requestSubmit()`);
        check(`${C}el dueño entra`, await until(`${text('.main h3')} === 'Inicio' && ${text('.who')}.includes(${JSON.stringify(admin)})`, 10000));
        check(`${C}se abre desde Ajustes, con la máquina de ahora`, Boolean(await openUsage()));
        const names = await until(`document.querySelectorAll('.modal .usetable tbody tr').length >= 2 && [...document.querySelectorAll('.modal .usetable tbody tr td:first-child')].map(e => e.textContent).join('|')`, 8000);
        check(`${C}la tabla trae cada usuario y el total`, String(names).includes(user) && String(names).includes(admin) && String(names).endsWith('Total'), String(names));
        const heard = await js(`(() => { const row = [...document.querySelectorAll('.modal .usetable tbody tr')].find(r => r.cells[0].textContent === ${JSON.stringify(user)}); return row ? [...row.cells].map(c => c.textContent).join(' | ') : ''; })()`);
        check(`${C}lo que ha gastado «${user}» en esta misma prueba está apuntado`, / [1-9]\d* (s|min|h)/.test(heard) && !/\| 0 MB \| 0 \|/.test(heard), heard);
        check(`${C}dice cuántos caben y con qué límite`, await until(`/Con lo medido cabe(n unos)? \\d+ oyentes? a la vez/.test(${text('.modal .usage')})`, 5000), await js(`document.querySelector('.modal .note.big')?.textContent ?? ''`));
        check(`${C}cabe en el diálogo`, await js(fitsModal));
        await shot('c1_consumo');
        await js(clickText('.modal .seg .btn', 'Hoy'));
        check(`${C}«Hoy» cambia el periodo`, await until(`${text('.modal .usage')}.includes('Por usuario · hoy') && !!document.querySelector('.modal .seg .btn.pri')?.textContent.startsWith('Hoy')`, 8000));
        await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);

        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await until(`document.documentElement.classList.contains('m')`, 5000);
        check(`${C}en pantalla estrecha sale en tarjetas y cabe`, Boolean(await openUsage()) && Boolean(await until(`document.querySelectorAll('.modal .usecard').length >= 2 && !document.querySelector('.modal .usetable')`, 8000)) && await js(`${fitsModal} && ${fits}`));
        await shot('c2_consumo_movil');
        await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);
        await tap(q('.main .top .ib'));
        await until(`!!document.querySelector('.modal')`);
        await js(clickText('.modal .btn', 'Cerrar sesión'));
        await until(`!!document.querySelector('.login input[name=username]')`, 8000);
    }

    // 11. «Para ti»: listas automáticas y «Tus estadísticas» (mockups/estadisticas-v1.html, pantallas 1-8)
    {
        const P = 'para ti: ';
        const [rich, richPassword] = admin && adminPassword ? [admin, adminPassword] : [user, password];
        const songsTxt = n => (n === 1 ? '1 canción' : `${n} canciones`);
        const artistsTxt = n => (n === 1 ? '1 artista' : `${n} artistas`);
        const listened = ms => {
            const seconds = Math.floor((ms ?? 0) / 1000);
            if (seconds <= 0) return '0 min';
            if (seconds < 60) return `${seconds} s`;
            const minutes = Math.floor(seconds / 60);
            return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
        };
        const apiGet = path => js(`fetch(${JSON.stringify(`/api${path}`)}, { credentials: 'same-origin' }).then(r => r.json())`);
        // «d mmm» con los meses de tres letras del servidor (stats.js), en la hora local del navegador
        const MONTHS = `['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']`;
        const dayLabel = ymd => js(`(() => { const [y, m, d] = ${JSON.stringify(String(ymd ?? ''))}.split('-').map(Number); return y ? d + ' ' + ${MONTHS}[m - 1] : ''; })()`);
        const shortDay = iso => js(`(() => { const d = new Date(${JSON.stringify(iso)}); return d.getDate() + ' ' + ${MONTHS}[d.getMonth()]; })()`);
        const loginAs = async (name, pass) => {
            await send('Page.navigate', { url: `${base}/` });
            await until(`!!document.querySelector('.login input[name=username]')`);
            await js(typeInto('.login input[name=username]', name));
            await js(typeInto('.login input[name=password]', pass));
            await js(`document.querySelector('.login form').requestSubmit()`);
            return until(`${text('.main h3')} === 'Inicio' && !!document.querySelector('.main > .parati')`, 10000);
        };
        // «Para ti» va entre «Tu radio» y «Tus listas»
        const between = `(() => {
            const kids = [...document.querySelector('.main').children];
            const radio = document.querySelector('.main > .banner.radio');
            const para = document.querySelector('.main > .parati');
            const lists = kids.find(e => e.classList.contains('sec') && e.textContent.startsWith('Tus listas'));
            return !!radio && !!para && !!lists && kids.indexOf(radio) < kids.indexOf(para) && kids.indexOf(para) < kids.indexOf(lists);
        })()`;
        const pause = async () => { await js(`${A}.pause()`); await until(`${A}.paused`, 5000); };
        const stamp = Date.now() % 100000;
        const savedName = `zz guardada web ${stamp}`;
        const savedNameM = `zz guardada movil ${stamp}`;

        // --- Escritorio (pantallas 7 y 8, y la lista automática abierta como una lista)
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        check(`${P}entra «${rich}» y Inicio tiene «Para ti»`, Boolean(await loginAs(rich, richPassword)));
        const auto = await apiGet('/auto');
        const shownLists = auto.lists.filter(item => item.count > 0);
        const autoNames = auto.lists.map(item => item.name);
        const nameOf = kind => auto.lists.find(item => item.kind === kind)?.name;
        await sleep(600);
        const cardKinds = await js(`[...document.querySelectorAll('.parati .card[data-kind]')].map(e => e.dataset.kind).join(' ')`);
        check(`${P}escritorio: entre «Tu radio» y «Tus listas», las listas automáticas con canciones y la tarjeta de las estadísticas`,
            await js(between) && cardKinds === shownLists.map(item => item.kind).join(' ') && await js(`!!document.querySelector('.parati .card.st')`),
            `${cardKinds} + estadísticas (${shownLists.length + 1} tarjetas)`);
        const wantSubs = shownLists.map(item => `${songsTxt(item.count)} · ${{ top: 'últimos 30 días', forgotten: 'cambia cada día', radio: `${item.unsaved} sin guardar` }[item.kind]}`).join(' | ');
        const subs = await js(`[...document.querySelectorAll('.parati .card[data-kind]')].map(e => e.querySelector('b').textContent + ': ' + e.querySelector('small').textContent).join(' | ')`);
        check(`${P}escritorio: cada tarjeta dice su nombre y «N canciones · …»`, subs === shownLists.map((item, i) => `${item.name}: ${wantSubs.split(' | ')[i]}`).join(' | '), subs);
        const statCard = await js(text('.parati .card.st'));
        const week = auto.stats;
        check(`${P}escritorio: la tarjeta de las estadísticas lleva el tiempo de 7 días en grande, canciones y artistas, y «Ver más»`,
            await js(`${text('.parati .card.st .big')} === ${JSON.stringify(listened(week.listenedMs))}`) && statCard.includes(`${songsTxt(week.songs)} · ${artistsTxt(week.artists)}`) && statCard.includes('Últimos 7 días · Ver más ›'),
            statCard);
        check(`${P}las listas automáticas no salen en la barra lateral`, await js(`![...document.querySelectorAll('.side .pl')].some(e => ${JSON.stringify(autoNames)}.some(n => e.textContent.includes(n)))`));
        await shot('s01_inicio_para_ti');

        // Una lista automática sin canciones no sale (se simula que «Hace tiempo que no suena» viene vacía)
        await js(`window.__fetchHook = { path: '/api/auto', edit: data => ({ ...data, lists: data.lists.map(l => (l.kind === 'forgotten' ? { ...l, count: 0 } : l)) }) }`);
        await js(clickText('.side .nav', 'Buscar'));
        await js(clickText('.side .nav', 'Inicio'));
        const without = shownLists.filter(item => item.kind !== 'forgotten').map(item => item.kind).join(' ');
        const hidden = await until(`!!document.querySelector('.parati .card.st') && [...document.querySelectorAll('.parati .card[data-kind]')].map(e => e.dataset.kind).join(' ') === ${JSON.stringify(without)}`, 8000);
        await js('window.__fetchHook = null');
        check(`${P}una lista automática sin canciones no sale en «Para ti» (simulado)`, Boolean(hidden), `quedan: ${without} + estadísticas`);
        await js(clickText('.side .nav', 'Buscar'));
        await js(clickText('.side .nav', 'Inicio'));
        await until(`[...document.querySelectorAll('.parati .card[data-kind]')].length === ${shownLists.length}`, 8000);

        // «Tus estadísticas» (pantalla 8): los tres periodos, canciones y artistas lado a lado
        await js(`document.querySelector('.parati .card.st').click()`);
        let firstArtist = null;
        for (const [label, period] of [['7 días', '7'], ['30 días', '30'], ['Siempre', 'all']]) {
            if (period !== '7') await js(clickText('.pseg button', label));
            const want = await apiGet(`/stats?period=${period}`);
            const nums = await until(`${text('.main h3')} === 'Tus estadísticas' && !!document.querySelector('.stats[data-period="${period}"]:not(.busy)') && ${text('.pseg button.on')} === ${JSON.stringify(label)} && [...document.querySelectorAll('.stats .num')].map(e => e.textContent).join(' | ')`, 10000);
            const wantNums = `${listened(want.listenedMs)}escuchado | ${want.songs}canciones distintas | ${want.artists}artistas distintos`;
            check(`${P}estadísticas (escritorio), «${label}»: tiempo escuchado, canciones y artistas distintos como dice el servidor`, nums === wantNums, `${nums} — ${want.plays} escuchas`);
            const since = await js(text('.stats .since'));
            const sinceDay = await dayLabel(want.listenedSince);
            const rows = await js(`[...document.querySelectorAll('.two > div')].map(part => [...part.querySelectorAll('tbody tr')].map(row => row.textContent))`);
            const sideBySide = await js(`(() => { const [a, b] = document.querySelectorAll('.two > div'); const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return Math.abs(ra.top - rb.top) < 2 && rb.left >= ra.right; })()`);
            check(`${P}estadísticas (escritorio), «${label}»: «desde el ${sinceDay}», y las 10 canciones y los 10 artistas, lado a lado`,
                since === `El tiempo se mide desde el ${sinceDay}; las escuchas, desde que hay historial.` && sideBySide
                && rows[0].length === want.topTracks.length && rows[1].length === want.topArtists.length
                && rows[0].every((row, i) => row.includes(want.topTracks[i].title) && row.endsWith(String(want.topTracks[i].plays)))
                && rows[1].every((row, i) => row.includes(want.topArtists[i].name) && row.includes(songsTxt(want.topArtists[i].songs)) && row.endsWith(String(want.topArtists[i].plays))),
                `${rows[0].length} canciones, ${rows[1].length} artistas; 1.º ${want.topTracks[0]?.title} (${want.topTracks[0]?.plays}) · ${want.topArtists[0]?.name} (${want.topArtists[0]?.plays})`);
            await shot(`s02_estadisticas_${period}`);
            firstArtist = want.topArtists[0]?.name ?? null;
        }
        // Doble clic en una canción la reproduce
        const statKey = await js(`document.querySelector('table.stat tbody tr')?.dataset.key ?? null`);
        await js(`document.querySelector('table.stat tbody tr').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        check(`${P}estadísticas: doble clic en una canción la reproduce`, Boolean(await until(`!${A}.paused && ${A}.currentTime > 1 && document.querySelector('table.stat tbody tr.on')?.dataset.key === ${JSON.stringify(statKey)}`, 90000, 500)), String(statKey));
        await pause();
        // Tocar un artista abre Buscar con su nombre
        await js(`document.querySelector('table.stat.arts tbody tr').click()`);
        const searched = await until(`${text('.main h3')} === 'Buscar' && document.querySelector('.searchbox input').value === ${JSON.stringify(firstArtist)} && document.querySelectorAll('.main tbody tr').length`, 60000, 500);
        check(`${P}estadísticas: tocar un artista abre Buscar con su nombre y busca`, Boolean(searched), `«${firstArtist}»: ${searched} resultados`);
        await shot('s03_artista_en_buscar');

        // Cada lista automática, abierta como una lista: sin menú de lista, sin «Importar» ni arrastre, con «Guardar como lista»
        const details = {};
        for (const item of shownLists) {
            await js(clickText('.side .nav', 'Inicio'));
            await until(`!!document.querySelector('.parati .card[data-kind=${item.kind}]')`, 8000);
            await js(`document.querySelector('.parati .card[data-kind=${item.kind}]').click()`);
            const { list } = await apiGet(`/auto/${item.kind}`);
            details[item.kind] = list;
            const opened = await until(`${text('.listhead h3')} === ${JSON.stringify(item.name)} && document.querySelectorAll('.main tbody tr').length === ${list.count}`, 10000);
            const readOnly = await js(`!document.querySelector('.listhead .btn.icon') && ![...document.querySelectorAll('.main .btn')].some(b => b.textContent.includes('Importar'))
                && [...document.querySelectorAll('.listhead .btn')].some(b => b.innerText.trim() === 'Guardar como lista') && document.querySelectorAll('.main tbody tr[draggable=true]').length === 0
                && ${text('.listhead .kind')} === 'Lista automática' && ${text('.listhead .why')} === ${JSON.stringify(list.description)}`);
            check(`${P}«${item.name}» (escritorio): se abre como una lista con su «por qué», sin menú de lista, sin «Importar» ni arrastre, con «Guardar como lista»`, Boolean(opened) && readOnly, `${list.count} canciones`);
            const first = list.tracks[0];
            const row = await js(`document.querySelector('.main tbody tr').textContent`);
            let says;
            if (item.kind === 'top') says = row.includes(`${first.plays} veces`);
            else if (item.kind === 'forgotten') says = row.includes(first.list.name) && row.includes(first.lastPlayedAt ? await shortDay(first.lastPlayedAt) : 'sin escuchas');
            else says = row.includes(first.via) && row.includes(first.savedIn ? `en ${first.savedIn.name}` : 'sin guardar') && await js(`document.querySelectorAll('.main tbody .pill.loose').length === ${list.unsaved}`);
            check(`${P}«${item.name}» (escritorio): cada fila dice lo suyo`, says, row.replace(/\s+/g, ' ').slice(0, 140));
            await shot(`s04_auto_${item.kind}`);
        }

        // Menú de una canción (mejor una de Spotify, que es la que tendría «Cambiar coincidencia»)
        const menuKind = shownLists[0]?.kind;
        if (menuKind) {
            await js(clickText('.side .nav', 'Inicio'));
            await until(`!!document.querySelector('.parati .card[data-kind=${menuKind}]')`, 8000);
            await js(`document.querySelector('.parati .card[data-kind=${menuKind}]').click()`);
            await until(`document.querySelectorAll('.main tbody tr').length === ${details[menuKind].count}`, 10000);
            const spIndex = details[menuKind].tracks.findIndex(t => t.key.startsWith('sp:'));
            await js(`document.querySelectorAll('.main tbody tr')[${Math.max(0, spIndex)}].querySelector('.ib').click()`);
            await until(`!!document.querySelector('.menu')`);
            const labels = await js(`[...document.querySelectorAll('.menu button')].map(b => b.textContent)`);
            check(`${P}menú de una canción de una lista automática: las de siempre menos «Quitar de la lista» y «Cambiar coincidencia»`,
                ['Reproducir', 'Reproducir a continuación', 'Añadir a la cola', 'Añadir a una lista…'].every(l => labels.includes(l)) && !labels.some(l => l.startsWith('Quitar de la lista') || l.startsWith('Cambiar coincidencia')),
                `${labels.join(' | ')}${spIndex >= 0 ? ' (canción de Spotify)' : ' (no hay canciones de Spotify)'}`);
            await shot('s05_menu_cancion');
            await js(clickText('.menu button', 'Añadir a una lista'));
            await until(`!!document.querySelector('.modal .pick')`);
            const picks = await js(`[...document.querySelectorAll('.modal .pick b')].map(b => b.textContent)`);
            check(`${P}«Añadir a una lista…» no ofrece las listas automáticas`, picks.length > 1 && !picks.some(p => autoNames.includes(p)), picks.join(' | '));
            await js(clickText('.modal .btn', 'Cancelar'));

            // Reproducir: «Sonando de …» dice su nombre y la sesión lleva origen «auto»
            const name = nameOf(menuKind);
            await js(clickText('.listhead .btn', 'Reproducir'));
            const sub = await until(`!${A}.paused && ${A}.currentTime > 1 && ${text('.player .now small')}.includes(${JSON.stringify(`de ${name}`)}) && ${text('.player .now small')}`, 90000, 500);
            const source = await js(`fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()).then(r => r.session?.source ?? null)`);
            check(`${P}reproducir «${name}»: suena, la barra dice «de ${name}» y la sesión lleva origen «auto»`, Boolean(sub) && source?.type === 'auto' && source?.id === menuKind && source?.name === name, `${sub} · ${JSON.stringify(source)}`);
            await shot('s06_auto_sonando');
            await pause();       // que la prueba no sume escuchas de más al historial

            // «Guardar como lista»: una lista normal con lo de ahora, que sale en la barra lateral y se abre
            await js(`document.querySelector('.listhead .btn.save').click()`);
            await until(`!!document.querySelector('.modal input')`);
            const offered = await js(`document.querySelector('.modal input').value`);
            check(`${P}«Guardar como lista»: el diálogo trae el nombre con la fecha`, offered === details[menuKind].saveName, offered);
            await shot('s07_guardar_como_lista');
            await js(typeInto('.modal input', savedName));
            await js(clickText('.modal .btn.pri', 'Guardar'));
            const saved = await until(`${text('.listhead h3')} === ${JSON.stringify(savedName)} && ${text('.listhead .kind')} === 'Lista' && document.querySelectorAll('.main tbody tr').length === ${details[menuKind].count}
                && [...document.querySelectorAll('.side .pl')].some(e => e.textContent.startsWith(${JSON.stringify(savedName)}))`, 10000);
            check(`${P}«Guardar como lista» crea una lista normal con esas canciones, que sale en la barra lateral y se abre`, Boolean(saved), savedName);
            check(`${P}la lista guardada es una lista normal (con «Importar», su menú y arrastre)`,
                await js(`[...document.querySelectorAll('.listhead .btn')].some(b => b.textContent.includes('Importar')) && !!document.querySelector('.listhead .btn.icon') && document.querySelectorAll('.main tbody tr[draggable=true]').length > 0`));
            await shot('s08_lista_guardada');
            const after = await apiGet('/auto');
            check(`${P}la automática sigue en «Para ti» como estaba`, after.lists.find(l => l.kind === menuKind)?.count === details[menuKind].count);

            // Cada cuenta ve lo suyo (solo con dos cuentas distintas)
            if (rich !== user && other.token) {
                const theirs = (await asOther('GET', '/api/lists')).body.lists ?? [];
                const ids = new Set(theirs.map(l => l.id));
                const mine = new Set(((await apiGet('/lists')).lists ?? []).map(l => l.id));
                const theirForgotten = (await asOther('GET', '/api/auto/forgotten')).body.list?.tracks ?? [];
                const theirRadio = (await asOther('GET', '/api/auto/radio')).body.list?.tracks ?? [];
                const refs = [...theirForgotten.map(t => t.list?.id), ...theirRadio.map(t => t.savedIn?.id)].filter(Boolean);
                check(`${P}cada cuenta ve lo suyo: «${user}» no ve la lista guardada y sus listas automáticas solo apuntan a listas suyas`,
                    !theirs.some(l => l.name === savedName) && refs.every(id => ids.has(id) && !mine.has(id)), `${refs.length} referencias a listas de «${user}»`);
            } else {
                console.log(`INFO  ${P}«cada cuenta ve lo suyo» no se comprueba: hace falta una segunda cuenta distinta (MYMUSIC_CHECK_ADMIN ≠ <usuario>)`);
            }

            // Limpieza: la lista guardada, a la papelera
            await js(`document.querySelector('.listhead .btn.icon').click()`);
            await until(`!!document.querySelector('.menu')`);
            await js(clickText('.menu button', 'Enviar a la papelera'));
            await until(`!!document.querySelector('.modal')`);
            await js(clickText('.modal .btn.pri', 'Enviar a la papelera'));
            check(`${P}la lista guardada de la prueba va a la papelera`, await until(`![...document.querySelectorAll('.side .pl')].some(e => e.textContent.includes(${JSON.stringify(savedName)}))`, 10000));
        }
        await js(`fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-MyMusic': 'web' } })`);

        // --- Pantalla estrecha (pantallas 1-6, como en la app)
        const PM = `${P}móvil: `;
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        check(`${PM}entra y Inicio tiene «Para ti»`, Boolean(await loginAs(rich, richPassword)));
        if (menuKind) check(`${PM}«Continuar» dice el nombre de la lista automática que sonaba`, Boolean(await until(`${text('.main .banner')}.includes(${JSON.stringify(`Continuar: ${nameOf(menuKind)}`)})`, 8000)), await js(text('.main .banner b')));
        await sleep(600);
        const tiles = await js(`[...document.querySelectorAll('.parati .hs .ac')].map(e => e.dataset.kind + ': ' + e.querySelector('b').textContent + ' · ' + e.querySelector('small').textContent).join(' | ')`);
        const statLine = await js(text('.parati .statcard .tx div'));
        const autoM = await apiGet('/auto');
        const shownM = autoM.lists.filter(item => item.count > 0);
        check(`${PM}«Para ti» entre «Tu radio» y «Tus listas»: las listas en fila y la tarjeta «Tus estadísticas» debajo, y cabe`,
            await js(between) && tiles === shownM.map(item => `${item.kind}: ${item.name} · ${songsTxt(item.count)}`).join(' | ') && await js(`!!document.querySelector('.parati .hs + .statcard') && ${fits}`), tiles);
        check(`${PM}la tarjeta dice «7 días: <tiempo> · <N> canciones»`, statLine === `7 días: ${listened(autoM.stats.listenedMs)} · ${songsTxt(autoM.stats.songs)}`, statLine);
        await shot('sm01_inicio_para_ti');

        for (const item of shownM) {
            await tap(`document.querySelector('.parati .ac[data-kind=${item.kind}]')`);
            const { list } = await apiGet(`/auto/${item.kind}`);
            const opened = await until(`${text('.listhead h3')} === ${JSON.stringify(item.name)} && document.querySelectorAll('.main .row[data-key]').length === ${list.count}`, 10000);
            const shape = await js(`[...document.querySelectorAll('.listhead .btn')].some(b => b.innerText.trim() === 'Guardar') && ![...document.querySelectorAll('.main .btn')].some(b => b.textContent.includes('Importar'))
                && !document.querySelector('.main .top .ib[title="Más"]') && ${text('.listhead .info > .mut')}.startsWith('Automática · ') && ${fits}`);
            check(`${PM}«${item.name}»: se abre con volver, «Automática · N canciones», sin menú arriba ni «Importar», con «Guardar», y cabe`, Boolean(opened) && shape, `${list.count} canciones`);
            const first = list.tracks[0];
            const row = await js(`document.querySelector('.main .row[data-key]').innerText.replace(/\\s+/g, ' ')`);
            let says;
            if (item.kind === 'top') says = await js(`!!document.querySelector('.main .row[data-key] .n') && ${text('.main .row[data-key] .cnt')} === ${JSON.stringify(`${first.plays} veces`)}`);
            else if (item.kind === 'forgotten') says = row.includes(`en ${first.list.name} · ${first.lastPlayedAt ? `última vez ${await shortDay(first.lastPlayedAt)}` : 'sin escuchas'}`);
            else says = row.includes(first.via) && await js(`${text('.main .row[data-key] .pill')} === ${JSON.stringify(first.savedIn ? `en ${first.savedIn.name}` : 'sin guardar')}`);
            check(`${PM}«${item.name}»: cada fila dice lo suyo`, says, row.slice(0, 140));
            await shot(`sm02_auto_${item.kind}`);
            if (item === shownM[0]) {
                // Hoja de la canción: sin «Quitar de la lista» ni «Cambiar coincidencia»
                const spIndex = list.tracks.findIndex(t => t.key.startsWith('sp:'));
                await tap(`document.querySelectorAll('.main .row[data-key]')[${Math.max(0, spIndex)}].querySelector('.ib')`);
                await until(`!!document.querySelector('.sheet .opt')`);
                const labels = await js(`[...document.querySelectorAll('.sheet .opt')].map(b => b.textContent)`);
                check(`${PM}la hoja de una canción no ofrece «Quitar de la lista» ni «Cambiar coincidencia»`,
                    labels.includes('Añadir a una lista…') && !labels.some(l => l.startsWith('Quitar de la lista') || l.startsWith('Cambiar coincidencia')), labels.join(' | '));
                await shot('sm03_hoja_cancion');
                await tapAt(195, 120);
                await sleep(600);
                // Tocar una fila la reproduce: el reproductor dice «Sonando de <nombre>»
                await tap(`document.querySelectorAll('.main .row[data-key]')[0].querySelector('.t')`);
                await until(`!${A}.paused && ${A}.currentTime > 1`, 90000, 500);
                await tap(q('.mini .t'));
                const from = await until(`!!${shown('.full')} && ${text('.full .mid')}`, 5000);
                check(`${PM}tocar una fila la reproduce y el reproductor dice «Sonando de ${item.name}»`, String(from).replace(/\s+/g, ' ').trim() === `Sonando de${item.name}` || String(from).includes(`Sonando de${item.name}`), String(from));
                await shot('sm04_sonando_de');
                await pause();
                await js('history.back()');
                await until(`!${shown('.full')}`, 5000);
                // «Guardar» (pantalla 5): hoja con el nombre puesto; al guardar, la lista sale en Listas y se abre
                await tap(q('.listhead .btn.save'));
                await until(`!!document.querySelector('.modal input')`);
                const offered = await js(`document.querySelector('.modal input').value`);
                check(`${PM}«Guardar» abre la hoja «Guardar como lista» con el nombre puesto, Cancelar y Guardar`,
                    offered === list.saveName && await js(`${text('.modal h2')} === 'Guardar como lista' && document.querySelectorAll('.modal .acts.split .btn').length === 2`), offered);
                await shot('sm05_guardar');
                await js(typeInto('.modal input', savedNameM));
                await js(clickText('.modal .btn.pri', 'Guardar'));
                check(`${PM}al guardar, la lista nueva se abre`, Boolean(await until(`${text('.listhead h3')} === ${JSON.stringify(savedNameM)} && document.querySelectorAll('.main .row[data-key]').length === ${list.count}`, 10000)));
                await tap(byText('.side .nav', 'Listas'));
                check(`${PM}y sale en Listas, donde no están las automáticas`, Boolean(await until(`${text('.main h3')} === 'Listas' && !!${byText('.main .row', savedNameM)} && ![...document.querySelectorAll('.main .row')].some(e => ${JSON.stringify(autoNames)}.some(n => e.textContent.includes(n)))`, 8000)));
                await shot('sm06_listas');
                await tap(`${byText('.main .row', savedNameM)}.querySelector('.ib')`);
                await until(`!!document.querySelector('.sheet .opt')`);
                await tap(byText('.sheet .opt', 'Enviar a la papelera'));
                await until(`!!document.querySelector('.modal .btn.pri')`);
                await js(clickText('.modal .btn.pri', 'Enviar a la papelera'));
                check(`${PM}la lista guardada de la prueba va a la papelera`, await until(`!${byText('.main .row', savedNameM)}`, 10000));
                await tap(byText('.side .nav', 'Inicio'));
                await until(`!!document.querySelector('.main > .parati')`, 8000);
                continue;
            }
            await tap(q('.main .top .ib'));
            check(`${PM}volver lleva a Inicio`, Boolean(await until(`${text('.main h3')} === 'Inicio' && !!document.querySelector('.main > .parati')`, 8000)));
        }

        // «Tus estadísticas» (pantalla 6)
        await tap(q('.parati .statcard'));
        for (const [label, period] of [['7 días', '7'], ['30 días', '30'], ['Siempre', 'all']]) {
            if (period !== '7') await tap(byText('.pseg button', label));
            const want = await apiGet(`/stats?period=${period}`);
            const nums = await until(`!!document.querySelector('.stats[data-period="${period}"]:not(.busy)') && ${text('.pseg button.on')} === ${JSON.stringify(label)} && [...document.querySelectorAll('.stats .num')].map(e => e.textContent).join(' | ')`, 10000);
            const rows = await js(`[...document.querySelectorAll('.two > div')].map(part => part.querySelectorAll('.row').length)`);
            check(`${PM}estadísticas «${label}»: las tres cifras, canciones y artistas debajo, y cabe`,
                nums === `${listened(want.listenedMs)}escuchado | ${want.songs}canciones | ${want.artists}artistas` && rows[0] === want.topTracks.length && rows[1] === want.topArtists.length && await js(fits),
                `${nums} · ${rows.join(' + ')} filas`);
            await shot(`sm07_estadisticas_${period}`);
        }
        await js(`document.querySelector('.main').scrollTop = 99999`);
        await sleep(300);
        await shot('sm08_estadisticas_artistas');
        const artistName = await js(`document.querySelector('.row.art .t b').textContent`);
        await tap(`document.querySelector('.row.art .t')`);
        check(`${PM}tocar un artista abre Buscar con su nombre`, Boolean(await until(`${text('.main h3')} === 'Buscar' && document.querySelector('.searchbox input').value === ${JSON.stringify(artistName)}`, 8000)), artistName);
        await tap(byText('.side .nav', 'Inicio'));
        await until(`${text('.main h3')} === 'Inicio'`);
        await tap(q('.main .top .ib'));
        await until(`!!document.querySelector('.modal')`);
        await js(clickText('.modal .btn', 'Cerrar sesión'));
        await until(`!!document.querySelector('.login input[name=username]')`, 8000);
    }

    // 12. Artista y disco (mockups/artista-disco-v1.html): datos de YouTube Music de verdad, en el escritorio y en el móvil
    {
        const P = 'artista: ';
        const PM = `${P}móvil: `;
        const query = process.env.MYMUSIC_CHECK_ARTIST ?? 'daft punk';
        const apiCall = (method, path, body) => js(`fetch(${JSON.stringify(`/api${path}`)}, { method: ${JSON.stringify(method)}, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-MyMusic': 'web' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(r => r.json())`);
        // Entra (si la cookie sigue valiendo, ya está dentro) y espera Inicio
        const enter = async () => {
            await send('Page.navigate', { url: `${base}/` });
            const where = await until(`document.querySelector('.login input[name=username]') ? 'login' : (${text('.main h3')} === 'Inicio' && 'home')`, 15000);
            if (where === 'login') {
                await js(typeInto('.login input[name=username]', user));
                await js(typeInto('.login input[name=password]', password));
                await js(`document.querySelector('.login form').requestSubmit()`);
            }
            return until(`${text('.main h3')} === 'Inicio'`, 15000);
        };
        const searchFor = async (words, rows) => {
            await js(typeInto('.searchbox input', words));
            await js(press('.searchbox input', 'Enter'));
            return until(`document.querySelectorAll(${JSON.stringify(rows)}).length > 0 && !${text('.main .results')}.includes('Buscando')`, 60000);
        };
        const visible = sel => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent).length`;

        // --- Escritorio (pantallas 8 y 9; Buscar, menú y barra como en el móvil)
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        check(`${P}entra en el escritorio`, Boolean(await enter()));
        await js(clickText('.side .nav', 'Buscar'));
        await until(`!!document.querySelector('.searchbox input')`);
        await searchFor('amen break 174', '.main tbody tr');
        check(`${P}buscar una canción no saca la fila «Artistas»`, await js(`!document.querySelector('.main .acards')`));
        await searchFor(query, '.main tbody tr');
        const cards = await until(`document.querySelectorAll('.main .acards .acard').length`, 10000);
        const secs = await js(`[...document.querySelectorAll('.main .results .sec')].map(e => e.textContent).join('|')`);
        check(`${P}buscar «${query}» trae «Artistas» y debajo «Canciones»`, cards > 0 && secs === 'Artistas|Canciones', `${cards} artistas, el primero «${await js(text('.main .acards .acard b'))}»`);
        await shot('12a_buscar_artistas');

        await js(`document.querySelector('.main .acards .acard').click()`);
        const topRows = await until(`${text('.artisthead h3')} !== '' && document.querySelectorAll('.main table.toptracks tbody tr').length`, 60000);
        const artistId = await js('history.state?.view?.id');
        const page = (await apiCall('GET', `/artist/${artistId}`)).artist;
        const shownReleases = await js(visible('.main .releases .rel'));
        check(`${P}su página: nombre, oyentes, sus ${Math.min(5, page.songsCount)} más escuchadas, discos y parecidos`,
            topRows === Math.min(5, page.songsCount) && await js(text('.artisthead h3')) === page.name
            && (await js(text('.artisthead .mut'))).includes(page.listeners ?? 'Artista')
            && shownReleases === Math.min(6, page.albums.length) + Math.min(6, page.singles.length)
            && await js(`document.querySelectorAll('.main .acards.grid .acard').length`) === Math.min(9, page.related.length),
            `${page.name} · ${page.listeners} · ${page.songsCount} canciones · ${page.albums.length} álbumes · ${page.singles.length} sencillos · ${page.related.length} parecidos`);
        await shot('12b_artista');

        if (page.albums.length) {
            await js(clickText('.main .sec button', 'Ver todos'));
            check(`${P}«Ver todos» de los álbumes abre la discografía`, Boolean(await until(`${text('.pseg button.on')}.startsWith('Álbumes') && document.querySelectorAll('.releases.all .rel').length === ${page.albums.length}`, 8000)));
            await shot('12c_discografia');
            await js(clickText('.pseg button', 'Sencillos'));
            check(`${P}la pestaña «Sencillos y EP»`, Boolean(await until(`${text('.pseg button.on')}.startsWith('Sencillos') && document.querySelectorAll('.releases.all .rel').length === ${page.singles.length}`, 8000)));
            await js('history.back()');
            check(`${P}volver lleva al artista`, Boolean(await until(`${text('.artisthead h3')} === ${JSON.stringify(page.name)}`, 8000)));
        }

        await js(clickText('.main .sec button', 'Ver todas'));
        check(`${P}«Ver todas» abre sus ${page.songsCount} canciones`, Boolean(await until(`${text('.listhead h3')} === ${JSON.stringify(page.name)} && document.querySelectorAll('.main tbody tr').length === ${page.songsCount}`, 30000)));
        await js('history.back()');
        await until(`${text('.artisthead h3')} === ${JSON.stringify(page.name)}`, 8000);

        // El disco (pantalla 9)
        await js(`[...document.querySelectorAll('.main .releases .rel')].find(e => e.offsetParent).click()`);
        const albumId = await until(`history.state?.view?.name === 'album' && history.state.view.id`, 8000);
        const album = (await apiCall('GET', `/album/${albumId}`)).album;
        const albumRows = await until(`document.querySelectorAll('.main table.albumt tbody tr').length`, 60000);
        check(`${P}el disco: tipo y año, título, artista que se toca, filas con su corazón y sin columna de artista`,
            albumRows === album.count && await js(text('.albumhead h3')) === album.title && (await js(text('.albumhead .kind'))).includes(String(album.year ?? ''))
            && await js(`!!document.querySelector('.albumhead .by .alink') && !document.querySelector('.main table.albumt th.a') && document.querySelectorAll('.main table.albumt tbody tr .ib.like').length === ${album.count}`),
            `«${album.title}» (${album.kind} ${album.year}), ${albumRows} canciones`);
        await shot('12d_disco');

        const heart = `document.querySelector('.main table.albumt tbody tr .ib.like')`;
        const wasLiked = await js(`${heart}.classList.contains('on')`);
        await js(`${heart}.click()`);
        const flipped = await until(`${heart}.classList.contains('on') === ${!wasLiked}`, 8000);
        await js(`${heart}.click()`);
        const restored = await until(`${heart}.classList.contains('on') === ${wasLiked}`, 8000);
        check(`${P}el corazón de una fila mete y saca la canción de «me gusta»`, Boolean(flipped && restored));

        await js(clickText('.albumhead .btn', 'Reproducir'));
        const bar = await until(`(${text('.player .now small')}).includes(${JSON.stringify(`de ${album.title}`)}) && ${text('.player .now small')}`, 30000);
        check(`${P}«Reproducir» pone el disco («de ${album.title}» en la barra)`, Boolean(bar), bar ?? await js(text('.player .now small')));
        await js(`document.querySelector('.player .now .alink').click()`);
        check(`${P}el nombre del artista en la barra abre su página`, Boolean(await until(`${text('.artisthead h3')} === ${JSON.stringify(page.name)} && history.state?.view?.name === 'artist'`, 30000)));

        await js(clickText('.artisthead .btn', 'Radio'));
        const radioBar = await until(`(${text('.player .now small')}).includes('Radio de ') && ${text('.player .now small')}`, 120000);
        const session = (await apiCall('GET', '/session')).session;
        check(`${P}«Radio de este artista» empieza su radio`, Boolean(radioBar) && session?.source?.id === `artist:${artistId}`, `${session?.source?.name} · ${session?.count} canciones`);
        await js(`${A}?.pause()`);

        // «Ir al artista» desde el menú de una canción de Buscar
        await js(clickText('.side .nav', 'Buscar'));
        await until(`document.querySelectorAll('.main tbody tr').length > 0`, 8000);
        // Una canción del canal del propio artista (el primer resultado puede ser un recopilatorio de un canal
        // cualquiera: ahí el panel avisa de que no lo encuentra, que es lo correcto)
        const ownRow = `[...document.querySelectorAll('.main tbody tr')].find(row => row.querySelector('td.a')?.textContent === ${JSON.stringify(page.name)})`;
        const hasOwn = await js(`!!${ownRow}`);
        await js(`(${hasOwn ? ownRow : `document.querySelector('.main tbody tr')`}).querySelector('.ib').click()`);
        await until(`!!document.querySelector('.menu')`);
        check(`${P}el menú de una canción tiene «Ir al artista»`, await js(`[...document.querySelectorAll('.menu button')].some(e => e.textContent.startsWith('Ir al artista'))`), hasOwn ? `canal «${page.name}»` : 'ninguna del canal del artista: la primera');
        await shot('12e_menu_ir_al_artista');
        await js(clickText('.menu button', 'Ir al artista'));
        const went = await until(`(history.state?.view?.name === 'artist' && ${text('.artisthead h3')}) || (document.querySelector('.modal .pick') && 'elegir')`, 30000);
        if (went === 'elegir') await js(`document.querySelector('.modal .pick').click()`);
        check(`${P}«Ir al artista» abre la página de un artista`, Boolean(await until(`history.state?.view?.name === 'artist' && ${text('.artisthead h3')}`, 30000)), went);

        // «Guardar como lista» desde el disco, y la lista de prueba a la papelera
        await js('history.back()');
        await until(`history.state?.view?.name === 'search'`, 8000);
        await send('Page.navigate', { url: `${base}/` });       // vuelta al disco por el camino corto: artista → disco
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        await js(clickText('.side .nav', 'Buscar'));
        await searchFor(query, '.main tbody tr');
        await until(`document.querySelectorAll('.main .acards .acard').length`, 10000);
        await js(`document.querySelector('.main .acards .acard').click()`);
        await until(`document.querySelectorAll('.main .releases .rel').length`, 60000);
        await js(`[...document.querySelectorAll('.main .releases .rel')].find(e => e.offsetParent).click()`);
        await until(`document.querySelectorAll('.main table.albumt tbody tr').length`, 60000);
        const savedName = `zz prueba disco ${Date.now() % 100000}`;
        await js(clickText('.albumhead .btn', 'Guardar'));
        await until(`!!document.querySelector('.modal input')`);
        await js(typeInto('.modal input', savedName));
        await js(clickText('.modal .btn', 'Guardar'));
        const savedOk = await until(`${text('.listhead h3')} === ${JSON.stringify(savedName)} && document.querySelectorAll('.main tbody tr').length === ${album.count}`, 15000);
        check(`${P}«Guardar como lista» crea la lista con sus ${album.count} canciones y la abre`, Boolean(savedOk));
        const savedId = await js('history.state?.view?.id');
        if (savedOk && savedId) await apiCall('DELETE', `/lists/${savedId}`);

        // --- Móvil (pantallas 1-7)
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        check(`${PM}entra`, Boolean(await enter()) && await js(`document.documentElement.classList.contains('m')`));
        await tap(byText('.side .nav', 'Buscar'));
        await until(`!!document.querySelector('.searchbox input')`);
        await searchFor(query, '.main .row[data-key]');
        const mCards = await until(visible('.main .acards .acard'), 10000);
        check(`${PM}Buscar trae la fila «Artistas» y cabe`, mCards > 0 && await js(fits), `${mCards} artistas`);
        await shot('m12a_buscar_artistas');

        await tap(q('.main .acards .acard'));
        const mTop = await until(`${text('.artisthead h3')} !== '' && document.querySelectorAll('.main .rows .row[data-key]').length`, 60000);
        check(`${PM}el artista: foto, nombre, «Reproducir» y «Radio», sus canciones con número y carátula, y cabe`,
            mTop === Math.min(5, page.songsCount) && await js(`!!document.querySelector('.main .rows .row .n') && !!document.querySelector('.main .rows .row .cv') && ${text('.artisthead .acts')}.includes('Radio')`) && await js(fits),
            `${mTop} canciones`);
        await shot('m12b_artista');
        await js(`document.querySelector('.main').scrollTop = 99999`);
        await sleep(300);
        check(`${PM}más abajo: discos en fila y artistas parecidos`, await js(`${visible('.main .releases .rel')} > 0 && ${visible('.main .acards .acard')} === ${page.related.length}`) && await js(fits));
        await shot('m12c_artista_abajo');

        await tap(`[...document.querySelectorAll('.main .releases .rel')].find(e => e.offsetParent)`);
        const mRows = await until(`!!document.querySelector('.albumhead') && document.querySelectorAll('.main .row[data-key]').length`, 60000);
        check(`${PM}el disco: tipo y año arriba, filas con su corazón, y cabe`,
            mRows === album.count && await js(`getComputedStyle(document.querySelector('.albumhead .kind')).display !== 'none' && document.querySelectorAll('.main .row .ib.like').length === ${album.count}`) && await js(fits),
            `${mRows} canciones`);
        await shot('m12d_disco');

        await tap(`document.querySelector('.main .row[data-key] > .ib:last-child')`);
        check(`${PM}el menú de la canción tiene «Ir al artista»`, Boolean(await until(`[...document.querySelectorAll('.sheet .opt')].some(e => e.textContent.startsWith('Ir al artista'))`, 5000)));
        await shot('m12e_menu');
        await tap(byText('.sheet .opt', 'Ir al artista'));
        check(`${PM}«Ir al artista» abre su página`, Boolean(await until(`${text('.artisthead h3')} === ${JSON.stringify(page.name)}`, 30000)));

        // Tocar una de sus canciones, abrir el reproductor y tocar el nombre del artista
        await tap(q('.main .rows .row[data-key] .t'));
        await until(`!!document.querySelector('.mini:not(.hidden)')`, 30000);
        await tap(q('.mini .t'));
        await until(`!document.querySelector('.full').classList.contains('hidden') && !!document.querySelector('.full .artist .alink')`, 10000);
        await shot('m12f_reproductor');
        const linkText = await js(text('.full .artist .alink'));
        await tap(q('.full .artist .alink'));
        const mWent = await until(`document.querySelector('.full').classList.contains('hidden') && ((history.state?.view?.name === 'artist' && ${text('.artisthead h3')}) || (document.querySelector('.modal .pick') && 'elegir'))`, 30000);
        if (mWent === 'elegir') {
            await shot('m12g_elegir_artista');
            await tap(q('.modal .pick'));
        }
        check(`${PM}en el reproductor, el nombre del artista lo cierra y abre su página`, Boolean(await until(`history.state?.view?.name === 'artist' && ${text('.artisthead h3')}`, 30000)), `«${linkText}»${mWent === 'elegir' ? ' (varios: se elige)' : ''}`);
        await js(`${A}?.pause()`);
        await apiCall('POST', '/logout');
    }

    // 13. Canciones que fallan (mockups/fallos-v1.html): con vídeos inventados, que YouTube no tiene y fallan
    // siempre («El vídeo ya no está disponible»). Son distintos en cada pasada, así que su «otro enlace» no
    // estorba a la siguiente.
    {
        const P = 'fallos: ';
        const apiCall = (method, path, body) => js(`fetch(${JSON.stringify(`/api${path}`)}, { method: ${JSON.stringify(method)}, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-MyMusic': 'web' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(r => r.json())`);
        const fakeId = () => `zz${Math.random().toString(36).slice(2, 11).padEnd(9, 'q')}`;
        const fake = n => ({ key: `yt:${fakeId()}`, platform: 'youtube', title: `Prueba fallo ${n}`, artist: 'Nadie', durationSec: 200, thumb: null });
        const rick = { key: 'yt:dQw4w9WgXcQ', platform: 'youtube', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213, thumb: null };
        const playing = `decodeURIComponent(${A}?.src ?? '')`;
        const makeList = async (name, tracks) => {
            const { list } = await apiCall('POST', '/lists', { name });
            for (const track of tracks) await apiCall('POST', `/lists/${list.id}/tracks`, { track });
            return list.id;
        };

        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: `${base}/` });
        const where = await until(`document.querySelector('.login input[name=username]') ? 'login' : (${text('.main h3')} === 'Inicio' && 'home')`, 15000);
        if (where === 'login') {
            await js(typeInto('.login input[name=username]', user));
            await js(typeInto('.login input[name=password]', password));
            await js(`document.querySelector('.login form').requestSubmit()`);
            await until(`${text('.main h3')} === 'Inicio'`, 15000);
        }

        // Falla la primera: aviso con el motivo y, a los 2 s, la siguiente
        const first = fake(1);
        const skipList = await makeList(`zz prueba fallos ${Date.now() % 100000}`, [first, rick]);
        await js('location.reload()');        // para que la barra lateral tenga la lista nueva
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        await js(clickText('.side .pl', 'zz prueba fallos'));
        await until(`!!document.querySelector('.listhead')`, 8000);
        await js(clickText('.listhead .btn', 'Reproducir'));
        const notice = await until(`(${text('.toast')}).includes('Paso a la siguiente') && ${text('.toast')}`, 60000);
        check(`${P}al fallar, avisa con el motivo`, Boolean(notice) && notice.includes('«Prueba fallo 1»') && notice.includes('no está disponible'), notice ?? '(sin aviso)');
        await shot('13a_aviso');
        const skipped = await until(`${playing}.includes('yt:dQw4w9WgXcQ')`, 15000);
        check(`${P}y pasa sola a la siguiente`, Boolean(skipped), await js(playing));

        // El apartado, desde Ajustes, con su contador
        await js(`document.querySelector('.who').click()`);
        const count = await until(`!document.querySelector('.failline .count').classList.contains('hidden') && document.querySelector('.failline .count').textContent`, 8000);
        check(`${P}Ajustes tiene la línea con el contador`, Number(count) >= 1, `contador ${count}`);
        await shot('13b_ajustes');
        await js(`document.querySelector('.failline .btn').click()`);
        const row = await until(`[...document.querySelectorAll('.modal .pick.fail')].find(r => r.textContent.includes('Prueba fallo 1'))?.textContent`, 8000);
        check(`${P}el apartado la enseña con su lista y el motivo`, Boolean(row) && row.includes('El vídeo ya no está disponible') && row.includes('de «zz prueba fallos'), row ?? '(no sale)');
        await shot('13c_apartado');

        // «Otro enlace…»: pegar uno; sale del apartado y, desde entonces, suena desde ese vídeo
        await js(`[...document.querySelectorAll('.modal .pick.fail')].find(r => r.textContent.includes('Prueba fallo 1')).querySelector('.btn.sm:nth-of-type(2)').click()`);
        await until(`[...document.querySelectorAll('.modal h2')].some(e => e.textContent === 'Poner otro enlace')`, 8000);
        const altModal = `[...document.querySelectorAll('.modal')].find(m => m.querySelector('h2')?.textContent === 'Poner otro enlace')`;
        const found = await until(`!${altModal}.querySelector('.picks').textContent.includes('Buscando') && ${altModal}.querySelectorAll('.pick').length + 1`, 40000);
        check(`${P}«Otro enlace…» busca otros vídeos de la canción`, Boolean(found), `${(found || 1) - 1} candidatos`);
        await shot('13d_otro_enlace');
        await js(typeInto('.linkrow input', 'https://youtu.be/dQw4w9WgXcQ'));
        await js(`document.querySelector('.linkrow .btn').click()`);
        const linked = await until(`(${text('.toast')}).includes('Ahora suena desde') && ${text('.toast')}`, 30000);
        check(`${P}«Otro enlace…» con un enlace pegado`, Boolean(linked), linked ?? '(sin aviso)');
        const after = await apiCall('GET', '/failures');
        check(`${P}y sale del apartado`, !after.failures.some(f => f.key === first.key));
        await js(`document.querySelectorAll('.modal .acts .btn').forEach(b => b.textContent === 'Cerrar' && b.click())`);

        // Tres seguidas: se para en la tercera y lo dice
        const [b, c, d] = [fake(2), fake(3), fake(4)];
        const streakList = await makeList(`zz prueba tres fallos ${Date.now() % 100000}`, [b, c, d, rick]);
        await js('location.reload()');
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        await js(clickText('.side .pl', 'zz prueba tres fallos'));
        await until(`!!document.querySelector('.listhead')`, 8000);
        await js(clickText('.listhead .btn', 'Reproducir'));
        const stopped = await until(`(${text('.player .now small')}).includes('Han fallado 3 seguidas') && ${playing}`, 120000);
        check(`${P}con 3 fallos seguidos se para en la tercera`, Boolean(stopped) && stopped.includes(d.key) && !stopped.includes('dQw4w9WgXcQ'), stopped ?? await js(text('.player .now small')));
        await shot('13e_tres_seguidas');

        // «Descartar» en los tres puntos
        await js(`document.querySelector('.who').click()`);
        await until(`!!document.querySelector('.failline .btn')`, 8000);
        await js(`document.querySelector('.failline .btn').click()`);
        await until(`[...document.querySelectorAll('.modal .pick.fail')].some(r => r.textContent.includes('Prueba fallo 2'))`, 8000);
        await js(`[...document.querySelectorAll('.modal .pick.fail')].find(r => r.textContent.includes('Prueba fallo 2')).querySelector('.ib').click()`);
        await until(`!!document.querySelector('.menu')`, 5000);
        const menuItems = await js(`[...document.querySelectorAll('.menu button')].map(b => b.textContent).join(' | ')`);
        check(`${P}los tres puntos: «Quitar de la lista» y «Descartar»`, menuItems.includes('Quitar de «zz prueba tres fallos') && menuItems.includes('Descartar'), menuItems);
        await js(clickText('.menu button', 'Descartar'));
        check(`${P}«Descartar» la quita del apartado`, Boolean(await until(`![...document.querySelectorAll('.modal .pick.fail')].some(r => r.textContent.includes('Prueba fallo 2'))`, 8000)));

        // Móvil (pantallas 4 y 5): la fila abre una hoja con las cuatro opciones
        await js(`document.querySelectorAll('.modal .acts .btn').forEach(b => b.textContent === 'Cerrar' && b.click())`);
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await send('Page.navigate', { url: `${base}/` });
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        await tap(q('.main .top .ib'));
        await until(`!!document.querySelector('.failline .btn')`, 8000);
        await tap(q('.failline .btn'));
        await until(`[...document.querySelectorAll('.modal .pick.fail')].some(r => r.textContent.includes('Prueba fallo 3'))`, 8000);
        await shot('m13a_apartado');
        await tap(`[...document.querySelectorAll('.modal .pick.fail')].find(r => r.textContent.includes('Prueba fallo 3'))`);
        const sheet = await until(`[...document.querySelectorAll('.sheet .opt')].map(o => o.textContent).join(' | ')`, 5000);
        check(`${P}móvil: tocar una abre la hoja con las cuatro opciones`, Boolean(sheet) && ['Probar otra vez', 'Poner otro enlace', 'Quitar de «zz prueba tres fallos', 'Descartar'].every(label => sheet.includes(label)) && await js(fits), sheet ?? '(sin hoja)');
        await shot('m13b_opciones');

        // Limpieza: las dos listas de prueba a la papelera y lo que quede en el apartado, descartado
        await js(`${A}?.pause()`);
        for (const listId of [skipList, streakList]) await apiCall('DELETE', `/lists/${listId}`);
        for (const item of (await apiCall('GET', '/failures')).failures.filter(f => /^Prueba fallo/.test(f.track.title))) await apiCall('DELETE', `/failures/${encodeURIComponent(item.key)}`);
        await apiCall('POST', '/logout');
    }

    // 14. Artistas que sigues y novedades (mockups/novedades-v1.html): YouTube Music de verdad, escritorio y móvil.
    // Sigue a un artista con algo reciente (por defecto Machine Girl; MYMUSIC_CHECK_FOLLOW para otro), mira
    // Inicio, «Ver todas», el punto de «nuevo», «Tus artistas» y la pestaña «Artistas» del móvil, y al final lo
    // deja de seguir. Empieza dejando de seguir todo lo que siga la cuenta de pruebas.
    {
        const P = 'novedades: ';
        const PM = `${P}móvil: `;
        const who = process.env.MYMUSIC_CHECK_FOLLOW ?? 'machine girl';
        const apiCall = (method, path, body) => js(`fetch(${JSON.stringify(`/api${path}`)}, { method: ${JSON.stringify(method)}, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-MyMusic': 'web' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(r => r.json())`);
        const enter = async () => {
            await send('Page.navigate', { url: `${base}/` });
            const where = await until(`document.querySelector('.login input[name=username]') ? 'login' : (${text('.main h3')} === 'Inicio' && 'home')`, 15000);
            if (where === 'login') {
                await js(typeInto('.login input[name=username]', user));
                await js(typeInto('.login input[name=password]', password));
                await js(`document.querySelector('.login form').requestSubmit()`);
            }
            return until(`${text('.main h3')} === 'Inicio'`, 15000);
        };
        const visible = sel => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent).length`;
        const findArtist = async () => {
            await js(typeInto('.searchbox input', who));
            await js(press('.searchbox input', 'Enter'));
            return until(`document.querySelectorAll('.main .acards .acard').length > 0`, 60000);
        };

        // --- Escritorio (pantallas 6-8)
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        check(`${P}entra en el escritorio`, Boolean(await enter()));
        for (const artist of (await apiCall('GET', '/follows')).artists ?? []) await apiCall('DELETE', `/follows/${artist.id}`);
        await send('Page.navigate', { url: `${base}/` });
        check(`${P}sin seguir a nadie, Inicio enseña la tarjeta para elegir artistas`, Boolean(await until(`${text('.main .hintcard b')} === 'Novedades de tus artistas'`, 15000)));
        check(`${P}la barra lateral tiene «Tus artistas»`, await js(`[...document.querySelectorAll('.side .nav')].some(n => n.textContent.startsWith('Tus artistas') && n.offsetParent)`));
        await shot('14a_inicio_sin_seguir');
        await js(clickText('.main .hintcard .btn', 'Elegir artistas'));
        check(`${P}«Elegir artistas» abre «Tus artistas», vacía`, Boolean(await until(`${text('.main h3')} === 'Tus artistas' && ${text('.main .empty')}.startsWith('Aún no sigues')`, 8000)));
        const sug = (await apiCall('GET', '/follows/suggestions')).artists ?? [];
        check(`${P}«Los que más escuchas»: las ${sug.length} que da el servidor`, Boolean(await until(`document.querySelectorAll('.main .fgrid.sug .fcard').length === ${sug.length}`, 15000)), sug.map(a => `${a.name} (${a.plays})`).join(', ') || '(ninguna: la cuenta no tiene historial)');
        await shot('14b_tus_artistas_vacia');

        await js(clickText('.side .nav', 'Buscar'));
        await until(`!!document.querySelector('.searchbox input')`);
        await findArtist();
        await js(`document.querySelector('.main .acards .acard').click()`);
        await until(`${text('.artisthead h3')} !== ''`, 60000);
        const artistName = await js(text('.artisthead h3'));
        const followBtn = `[...document.querySelectorAll('.artisthead .btn.out')].find(b => b.offsetParent)`;
        check(`${P}la página del artista tiene «Seguir», junto a la radio`, await js(`${followBtn}?.textContent === 'Seguir' && ${followBtn}.parentElement.classList.contains('acts')`), artistName);
        await js(`${followBtn}.click()`);
        check(`${P}«Seguir» pasa a «Siguiendo»`, Boolean(await until(`${followBtn}?.textContent === 'Siguiendo' && ${followBtn}.classList.contains('on')`, 30000)));
        await shot('14c_artista_siguiendo');
        const t0 = Date.now();
        const fresh = await until(`fetch('/api/novedades', { credentials: 'same-origin' }).then(r => r.json()).then(d => d.releases.length)`, 90000, 2000);
        check(`${P}en unos segundos hay novedades de ${artistName} (las fechas van en segundo plano)`, Boolean(fresh), `${fresh ?? 0} en ${Math.round((Date.now() - t0) / 1000)} s`);
        const novs = await apiCall('GET', '/novedades');
        console.log(`      ${novs.releases.map(r => `${r.title} [${r.kind} · ${r.when}${r.appeared ? ' · apareció' : ''}]`).join(' | ')}`);

        await js(clickText('.side .nav', 'Inicio'));
        const cardsShown = await until(`${visible('.main .releases.novs .rel')}`, 15000);
        const dots = await js(`document.querySelectorAll('.main .releases.novs .rel .dot').length`);
        check(`${P}Inicio: «Novedades de tus artistas» con ${Math.min(6, novs.releases.length)} tarjetas, su punto y el artista`,
            cardsShown === Math.min(6, novs.releases.length) && dots === novs.releases.slice(0, 12).filter(r => !r.seen).length
            && (await js(text('.main .releases.novs .rel small'))).startsWith(artistName), `${cardsShown} tarjetas, ${dots} puntos, «${await js(text('.main .releases.novs .rel small'))}»`);
        check(`${P}va entre «Tu radio» y «Para ti»`, await js(`(() => { const secs = [...document.querySelectorAll('.main .sec')];
            const n = secs.find(s => s.textContent.startsWith('Novedades')); const p = secs.find(s => s.textContent.startsWith('Para ti')); const r = document.querySelector('.main .banner.radio');
            return Boolean(n) && (!r || Boolean(r.compareDocumentPosition(n) & 4)) && (!p || Boolean(n.compareDocumentPosition(p) & 4)); })()`));
        check(`${P}la barra lateral dice cuántas hay sin abrir`, await js(text('.side .nav .count')) === (novs.unseen ? String(novs.unseen) : ''), `«${await js(text('.side .nav .count'))}», servidor ${novs.unseen}`);
        await shot('14d_inicio_novedades');

        const all = await apiCall('GET', '/novedades?days=90');
        await js(clickText('.main .sec button', 'Ver todas'));
        check(`${P}«Ver todas»: las ${all.releases.length} de los últimos 3 meses, por grupos`, Boolean(await until(`document.querySelectorAll('.main .releases.all.novs .rel').length === ${all.releases.length}`, 15000)),
            await js(`[...document.querySelectorAll('.main .sec')].map(s => s.textContent).join(' | ')`));
        await shot('14e_ver_todas');
        const first = all.releases[0];
        await js(`document.querySelector('.main .releases.all.novs .rel').click()`);
        check(`${P}tocar una novedad abre su disco`, Boolean(await until(`${text('.albumhead h3')} === ${JSON.stringify(first.title)}`, 60000)), first.title);
        const after = await until(`fetch('/api/novedades?days=90', { credentials: 'same-origin' }).then(r => r.json()).then(d => d.releases.find(r => r.id === ${JSON.stringify(first.id)})?.seen && d)`, 10000);
        check(`${P}y el servidor lo apunta como visto`, Boolean(after), after ? `${after.unseen} sin abrir` : '');
        await js('history.back()');
        check(`${P}al volver, esa tarjeta ya no lleva punto`, Boolean(await until(`(() => { const c = document.querySelector('.main .releases.all.novs .rel'); return c && !c.querySelector('.dot'); })()`, 8000)));

        await js(clickText('.side .nav', 'Tus artistas'));
        check(`${P}«Tus artistas»: ${artistName} con lo último que ha sacado`, Boolean(await until(`document.querySelectorAll('.main .fgrid:not(.sug) .fcard').length === 1 && ${text('.main .fgrid:not(.sug) .fcard b')} === ${JSON.stringify(artistName)}`, 15000)),
            await js(text('.main .fgrid:not(.sug) .fcard small')));
        await js(`document.querySelector('.main .fgrid:not(.sug) .fcard').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }))`);
        const menu = await until(`[...document.querySelectorAll('.menu button')].map(b => b.textContent).join(' | ')`, 5000);
        check(`${P}con el botón derecho: «Radio de este artista» y «Dejar de seguir»`, menu === 'Radio de este artista | Dejar de seguir', menu ?? '(sin menú)');
        await shot('14f_tus_artistas');
        await js(`document.querySelector('.main h3').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);

        // --- Móvil (pantallas 1-5)
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await send('Page.navigate', { url: `${base}/` });
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        const mCards = await until(`${visible('.main .releases.novs .rel')}`, 15000);
        check(`${PM}Inicio: la fila de novedades, con artista y fecha en dos líneas`, mCards > 0
            && await js(`[...document.querySelector('.main .releases.novs .rel').querySelectorAll('small')].filter(s => s.offsetParent).length`) === 2 && await js(fits),
            await js(`[...document.querySelector('.main .releases.novs .rel').querySelectorAll('small')].filter(s => s.offsetParent).map(s => s.textContent).join(' / ')`));
        await shot('m14a_inicio');
        await tap(byText('.side .nav', 'Listas'));
        check(`${PM}Listas tiene las pestañas «Listas» y «Artistas · 1»`, Boolean(await until(`${text('.tabseg')}.includes('Artistas · 1')`, 8000)), await js(text('.tabseg')));
        await tap(byText('.tabseg button', 'Artistas'));
        check(`${PM}«Artistas»: ${artistName} con lo último`, Boolean(await until(`${text('.main .rows .row b')} === ${JSON.stringify(artistName)}`, 8000)) && await js(fits), await js(text('.main .rows .row small')));
        await shot('m14b_artistas');
        await tap(q('.main .rows .row .ib'));
        const sheet = await until(`[...document.querySelectorAll('.sheet .opt')].map(o => o.textContent).join(' | ')`, 5000);
        check(`${PM}los tres puntos: «Radio de este artista» y «Dejar de seguir»`, sheet === 'Radio de este artista | Dejar de seguir', sheet ?? '(sin hoja)');
        await shot('m14c_menu');
        await tap(byText('.sheet .opt', 'Dejar de seguir'));
        check(`${PM}«Dejar de seguir» lo quita de la pestaña`, Boolean(await until(`${text('.main .empty')}.startsWith('Aún no sigues')`, 10000)));
        check(`${P}y el servidor ya no lo tiene`, ((await apiCall('GET', '/follows')).artists ?? []).length === 0);
        await tap(byText('.side .nav', 'Inicio'));
        check(`${PM}Inicio vuelve a la tarjeta de elegir artistas`, Boolean(await until(`${text('.main .hintcard b')} === 'Novedades de tus artistas'`, 10000)) && await js(fits));
        await shot('m14d_inicio_sin_seguir');
        await tap(byText('.side .nav', 'Buscar'));
        await until(`!!document.querySelector('.searchbox input')`);
        await findArtist();
        await tap(q('.main .acards .acard'));
        await until(`${text('.artisthead h3')} !== ''`, 60000);
        check(`${PM}en la página del artista, «Seguir» va bajo los oyentes`, await js(`(() => { const b = [...document.querySelectorAll('.artisthead .btn.out')].find(x => x.offsetParent); return b?.textContent === 'Seguir' && b.classList.contains('followm'); })()`) && await js(fits));
        await shot('m14e_artista');
        await apiCall('POST', '/logout');
    }

    // 15. Copiar y compartir el enlace (§22): YouTube, Spotify (sus dos enlaces) y SoundCloud (su página, que
    // el servidor busca con yt-dlp de verdad). El portapapeles se lee de vuelta; «Compartir» se observa
    // sustituyendo navigator.share (el de verdad abriría la ventana del sistema). Escritorio, móvil y reproductor.
    {
        const P = 'enlace: ';
        const PM = `${P}móvil: `;
        const apiCall = (method, path, body) => js(`fetch(${JSON.stringify(`/api${path}`)}, { method: ${JSON.stringify(method)}, credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-MyMusic': 'web' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(r => r.json())`);
        const RICK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const SP_ID = '4uLU6hMCjMI75M1A2tKUQC';
        const SP_URL = `https://open.spotify.com/track/${SP_ID}`;
        const SC_PAGE = 'https://soundcloud.com/forss/flickermood';
        const YT_URL = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;
        const rick = { key: 'yt:dQw4w9WgXcQ', platform: 'youtube', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213, thumb: null };
        const sc = { key: 'sc:293', platform: 'soundcloud', title: 'Flickermood', artist: 'Forss', durationSec: 214, thumb: null };
        const stubShare = `(() => { window.__shared = []; Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared.push(data); } }); return true; })()`;
        const lastShared = `(window.__shared ?? []).at(-1)`;
        const clip = 'navigator.clipboard.readText()';
        const clear = () => js(`navigator.clipboard.writeText('-').then(() => true)`);
        const enter = async () => {
            await send('Page.navigate', { url: `${base}/` });
            const where = await until(`document.querySelector('.login input[name=username]') ? 'login' : (${text('.main h3')} === 'Inicio' && 'home')`, 15000);
            if (where === 'login') {
                await js(typeInto('.login input[name=username]', user));
                await js(typeInto('.login input[name=password]', password));
                await js(`document.querySelector('.login form').requestSubmit()`);
                await until(`${text('.main h3')} === 'Inicio'`, 15000);
            }
        };

        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
        // Sin ventana, la página no tiene el foco y el navegador no deja tocar el portapapeles: se simula
        await send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await enter();

        // La de Spotify se busca por su enlace (así queda apuntada para su coincidencia, como al importar)
        const sp = (await apiCall('GET', `/search?q=${encodeURIComponent(SP_URL)}`)).results?.[0] ?? null;
        check(`${P}la canción de Spotify de prueba se encuentra`, sp?.key === `sp:${SP_ID}`, sp?.key ?? '(nada)');
        const name = `zz prueba enlace ${Date.now() % 100000}`;
        const { list } = await apiCall('POST', '/lists', { name });
        for (const track of [rick, sp, sc].filter(Boolean)) await apiCall('POST', `/lists/${list.id}/tracks`, { track });
        await js('location.reload()');
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        await js(clickText('.side .pl', name));
        await until(`document.querySelectorAll('.main tbody tr').length === ${sp ? 3 : 2}`, 8000);
        await js(stubShare);

        const rowMenu = async key => {
            await js(`[...document.querySelectorAll('.main tbody tr')].find(r => r.dataset.key === ${JSON.stringify(key)})?.querySelector('.ib[title="Más"]').click()`);
            return until(`!!document.querySelector('.menu') && [...document.querySelectorAll('.menu button')].map(b => b.textContent.trim())`, 5000);
        };
        const copyFrom = async (key, label, ms = 15000) => {
            await clear();
            await rowMenu(key);
            await js(clickText('.menu button', label));
            return until(`${clip}.then(t => t !== '-' && t)`, ms);
        };

        // YouTube
        const ytLabels = await rowMenu(rick.key);
        check(`${P}el menú de una de YouTube tiene «Copiar enlace» y «Compartir…»`, ytLabels?.includes('Copiar enlace') && ytLabels?.includes('Compartir…') && !ytLabels.includes('Copiar enlace de Spotify'), (ytLabels ?? []).join(' | '));
        await shot('15a_menu_enlace');
        await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
        await sleep(200);
        const ytCopied = await copyFrom(rick.key, 'Copiar enlace');
        check(`${P}«Copiar enlace» deja el vídeo de YouTube en el portapapeles`, ytCopied === RICK, ytCopied ?? '(nada)');
        check(`${P}y avisa`, (await js(text('.toast'))).includes('Enlace copiado'), await js(text('.toast')));

        // Spotify: los dos enlaces
        if (sp) {
            const spLabels = await rowMenu(sp.key);
            check(`${P}el de una de Spotify tiene los dos enlaces`, spLabels?.includes('Copiar enlace de Spotify') && spLabels?.includes('Copiar enlace de YouTube') && !spLabels.includes('Copiar enlace'), (spLabels ?? []).join(' | '));
            await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
            await sleep(200);
            const spCopied = await copyFrom(sp.key, 'Copiar enlace de Spotify');
            check(`${P}«Copiar enlace de Spotify»`, spCopied === SP_URL, spCopied ?? '(nada)');
            const spYt = await copyFrom(sp.key, 'Copiar enlace de YouTube', 60000);
            check(`${P}«Copiar enlace de YouTube» da el vídeo desde el que suena`, YT_URL.test(spYt ?? ''), spYt ?? '(nada)');
        }

        // SoundCloud: su página, buscada por el servidor la primera vez
        await clear();
        await rowMenu(sc.key);
        await js(clickText('.menu button', 'Copiar enlace'));
        const scGot = await until(`${clip}.then(t => (t !== '-' && t) || (document.querySelector('.modal .linkin')?.value ? 'ventana: ' + document.querySelector('.modal .linkin').value : null))`, 90000, 500);
        check(`${P}en una de SoundCloud, su página pública`, scGot === SC_PAGE || scGot === `ventana: ${SC_PAGE}`, scGot ?? '(nada)');
        if (String(scGot).startsWith('ventana')) await js(clickText('.modal .btn', 'Cerrar'));

        // Compartir: el enlace y el nombre de la canción
        await rowMenu(rick.key);
        await js(clickText('.menu button', 'Compartir…'));
        const shared = await until(`${lastShared}`, 8000);
        check(`${P}«Compartir…» manda el enlace con el título`, shared?.url === RICK && String(shared?.title).startsWith('Never Gonna Give You Up'), JSON.stringify(shared));
        if (sp) {
            await rowMenu(sp.key);
            await js(clickText('.menu button', 'Compartir…'));
            const picks = await until(`[...document.querySelectorAll('.modal h2')].some(e => e.textContent === 'Compartir') && [...document.querySelectorAll('.modal .pick')].map(p => p.textContent.trim())`, 5000);
            check(`${P}en una de Spotify, «Compartir…» pregunta cuál de los dos`, JSON.stringify(picks) === JSON.stringify(['Enlace de Spotify', 'Enlace de YouTube']), JSON.stringify(picks));
            await shot('15b_compartir_spotify');
            await js('(window.__shared = [], true)');
            await js(clickText('.modal .pick', 'Enlace de YouTube'));
            const sharedYt = await until(`${lastShared}?.url`, 30000);
            check(`${P}y comparte el elegido`, YT_URL.test(sharedYt ?? ''), sharedYt ?? '(nada)');
        }

        // Si el navegador no deja copiar: ventana con el enlace y sus botones
        await js(`(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('sin permiso')) }); document.execCommand = () => false; return true; })()`);
        await rowMenu(rick.key);
        await js(clickText('.menu button', 'Copiar enlace'));
        const fallback = await until(`[...document.querySelectorAll('.modal h2')].some(e => e.textContent === 'Enlace de la canción') && document.querySelector('.modal .linkin')?.value`, 5000);
        check(`${P}si no deja copiar, enseña el enlace en una ventana`, fallback === RICK, fallback ?? '(no sale)');
        check(`${P}con «Copiar», «Compartir» y «Cerrar»`, await js(`JSON.stringify([...document.querySelectorAll('.modal .acts .btn')].map(b => b.textContent)) === JSON.stringify(['Cerrar', 'Compartir', 'Copiar'])`));
        await shot('15c_ventana_enlace');
        await js(clickText('.modal .btn', 'Cerrar'));

        // Móvil: en la hoja de la canción, con sus iconos
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await js('location.reload()');
        await until(`${text('.main h3')} === 'Inicio'`, 15000);
        await js(stubShare);
        await tap(byText('.side .nav', 'Listas'));
        await until(`${text('.main h3')} === 'Listas' && !!${byText('.main .row', name)}`, 8000);
        await tap(`${byText('.main .row', name)}.querySelector('.t')`);
        await until(`document.querySelectorAll('.main .row[data-key]').length === ${sp ? 3 : 2}`, 8000);
        const sheetOf = async key => {
            await tap(`[...document.querySelectorAll('.main .row[data-key]')].find(r => r.dataset.key === ${JSON.stringify(key)}).querySelector('.ib[title="Más"]')`);
            return until(`!!document.querySelector('.sheet .opt') && [...document.querySelectorAll('.sheet .opt')].map(o => o.textContent.trim())`, 5000);
        };
        const mLabels = await sheetOf(rick.key);
        check(`${PM}la hoja tiene «Copiar enlace» y «Compartir…» con sus iconos`, mLabels?.includes('Copiar enlace') && mLabels?.includes('Compartir…')
            && await js(`!!${byText('.sheet .opt', 'Copiar enlace')}.querySelector('use[href="#i-link"]') && !!${byText('.sheet .opt', 'Compartir')}.querySelector('use[href="#i-share"]')`), (mLabels ?? []).join(' | '));
        check(`${PM}cabe en la pantalla`, await js(fits));
        await shot('m15a_hoja_enlace');
        await clear();
        await tap(byText('.sheet .opt', 'Copiar enlace'));
        const mCopied = await until(`${clip}.then(t => t !== '-' && t)`, 8000);
        check(`${PM}«Copiar enlace» con el dedo`, mCopied === RICK, mCopied ?? '(nada)');
        if (sp) {
            await sheetOf(sp.key);
            await tap(byText('.sheet .opt', 'Compartir'));
            await until(`!!document.querySelector('.modal .pick')`, 5000);
            await shot('m15b_compartir_spotify');
            await tap(byText('.modal .pick', 'Enlace de Spotify'));
            const mShared = await until(`${lastShared}?.url`, 8000);
            check(`${PM}«Compartir…» de una de Spotify, eligiendo el de Spotify`, mShared === SP_URL, mShared ?? '(nada)');
        }

        // Desde el reproductor: su menú también lo tiene
        await tap(`[...document.querySelectorAll('.main .row[data-key]')].find(r => r.dataset.key === ${JSON.stringify(rick.key)}).querySelector('.t')`);
        await until(`!!document.querySelector('.mini').offsetParent && ${text('.mini b')}.length > 0`, 90000, 500);
        await tap(q('.mini .t'));
        await until(`!!${shown('.full')}`, 5000);
        await tap(q('.full .top .ib[title="Más"]'));
        const fLabels = await until(`!!document.querySelector('.sheet .opt') && [...document.querySelectorAll('.sheet .opt')].map(o => o.textContent.trim())`, 5000);
        check(`${PM}el menú del reproductor tiene «Copiar enlace»`, fLabels?.includes('Copiar enlace') && !fLabels.includes('Reproducir'), (fLabels ?? []).join(' | '));
        await shot('m15c_reproductor_enlace');
        await clear();
        await tap(byText('.sheet .opt', 'Copiar enlace'));
        const fCopied = await until(`${clip}.then(t => t !== '-' && t)`, 8000);
        check(`${PM}y copia el de la que suena`, fCopied === RICK, fCopied ?? '(nada)');
        await js(`${A}?.pause()`);

        // Limpieza: la lista de prueba, a la papelera
        await apiCall('DELETE', `/lists/${list.id}`);
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await apiCall('POST', '/logout');
    }

    // Respuestas que la propia prueba provoca y el navegador apunta en la consola: no son fallos
    const expected = [/status of 401 .*\/api\/(me|login)/, /status of 409 .*\/api\/session\//, /status of 400 .*\/api\/import\/preview/, /status of 403 .*\/api\/usage/,
        // sección 13: los vídeos inventados no se pueden sacar (502), y preguntar por un fallo que no existe da 404
        /status of 502 .*\/api\/stream\/yt%3Azz/, /status of 404 .*\/api\/failures\//,
        // alguna miniatura de los resultados de YouTube no existe: el panel pone un degradado en su lugar
        /status of 404 .*i\.ytimg\.com\//];
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
