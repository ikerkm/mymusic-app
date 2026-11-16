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
    await js(clickText('.modal .btn', 'Cancelar'));

    // 6. Ajustes
    await js(`document.querySelector('.who').click()`);
    check('Ajustes muestra el usuario', await until(`${text('.modal')}.includes(${JSON.stringify(user)}) && ${text('.modal h2')} === 'Ajustes'`, 5000));
    await shot('9_ajustes');
    await js(`[...document.querySelectorAll('.modal .btn')].find(e => e.textContent.trim() === 'Cerrar').click()`);

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
