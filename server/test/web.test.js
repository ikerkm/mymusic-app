import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PASSWORD, OWNER } from './helpers.js';

const WEB = join(fileURLToPath(new URL('..', import.meta.url)), 'web');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Entra como lo hace el panel web y devuelve la cookie tal como la reenviaría el navegador
async function webLogin(s, device = 'Navegador de prueba') {
    const res = await s.api('/api/login', { method: 'POST', body: JSON.stringify({ user: OWNER, password: PASSWORD, device, web: true }) });
    const setCookie = res.headers.get('set-cookie') ?? '';
    return { res, body: await res.json(), setCookie, cookie: setCookie.split(';')[0] };
}

test('el panel web entra con una cookie que su JavaScript no puede leer, y no recibe el token', async () => {
    const s = await startServer({ webDir: WEB });
    try {
        const { res, body, setCookie, cookie } = await webLogin(s);
        assert.equal(res.status, 200);
        assert.equal(body.token, undefined);
        assert.equal(body.user.name, OWNER);
        assert.match(setCookie, /^mm_session=[^;]{20,}/);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Strict/);
        assert.match(setCookie, /Path=\/api/);
        assert.doesNotMatch(setCookie, /Secure/);        // en 127.0.0.1 no hay HTTPS; fuera sí se marca

        const me = await s.api('/api/me', { headers: { Cookie: cookie } });
        assert.equal(me.status, 200);
        assert.equal((await me.json()).device, 'Navegador de prueba');

        // El audio se pide con la misma cookie (la etiqueta de audio no puede mandar otra cosa)
        const audio = await s.api('/api/stream/yt:dQw4w9WgXcQ', { headers: { Cookie: cookie } });
        assert.equal(audio.status, 200);
        await audio.arrayBuffer();
    } finally {
        await s.close();
    }
});

test('fuera de 127.0.0.1 la cookie se marca Secure', async () => {
    const s = await startServer({ webDir: WEB });
    try {
        const res = await s.api('/api/login', {
            method: 'POST', headers: { Host: 'mymusic.example' },
            body: JSON.stringify({ user: OWNER, password: PASSWORD, web: true }),
        });
        // fetch no deja cambiar Host: se comprueba la función directamente
        await res.arrayBuffer();
        const { sessionCookie } = await import('../src/auth.js');
        assert.match(sessionCookie({ hostname: 'mymusic.example' }, 'x'.repeat(30)), /; Secure$/);
        assert.doesNotMatch(sessionCookie({ hostname: 'localhost' }, 'x'.repeat(30)), /Secure/);
        assert.match(sessionCookie({ hostname: 'mymusic.example' }, null), /Max-Age=0/);
    } finally {
        await s.close();
    }
});

test('con la cookie, cambiar algo exige la cabecera X-MyMusic (una página ajena no puede ponerla)', async () => {
    const s = await startServer({ webDir: WEB });
    try {
        const { cookie } = await webLogin(s);
        const body = JSON.stringify({ name: 'desde otra web' });
        const forged = await s.api('/api/lists', { method: 'POST', body, headers: { Cookie: cookie } });
        assert.equal(forged.status, 403);
        assert.equal(s.lists.all().length, 0);

        const own = await s.api('/api/lists', { method: 'POST', body, headers: { Cookie: cookie, 'X-MyMusic': 'web' } });
        assert.equal(own.status, 201);
        assert.equal(s.lists.all().length, 1);

        // La app (token en Authorization) no necesita esa cabecera
        const app = await s.call('POST', '/api/lists', { name: 'desde la app' });
        assert.equal(app.status, 201);
    } finally {
        await s.close();
    }
});

test('cerrar sesión en el panel borra la cookie y el token deja de valer', async () => {
    const s = await startServer({ webDir: WEB });
    try {
        const { cookie } = await webLogin(s);
        const out = await s.api('/api/logout', { method: 'POST', headers: { Cookie: cookie, 'X-MyMusic': 'web' } });
        assert.equal(out.status, 200);
        assert.match(out.headers.get('set-cookie') ?? '', /^mm_session=;.*Max-Age=0/);
        assert.equal((await s.api('/api/me', { headers: { Cookie: cookie } })).status, 401);
        // La sesión de la app (otro dispositivo) sigue dentro
        assert.equal((await s.call('GET', '/api/me')).status, 200);
    } finally {
        await s.close();
    }
});

test('el servidor entrega las páginas del panel con sus cabeceras de seguridad', async () => {
    const s = await startServer({ webDir: WEB });
    try {
        const page = await s.api('/');
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        const csp = page.headers.get('content-security-policy');
        assert.match(csp, /script-src 'self'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.equal(page.headers.get('cache-control'), 'no-cache');
        assert.match(await page.text(), /<script type="module" src="app\.js">/);

        for (const [file, type] of [['app.js', /javascript/], ['style.css', /text\/css/], ['icon.svg', /svg/]]) {
            const res = await s.api(`/${file}`);
            assert.equal(res.status, 200, file);
            assert.match(res.headers.get('content-type'), type);
            await res.arrayBuffer();
        }
        // Lo que no existe sigue dando 404, y la API no se confunde con las páginas
        assert.equal((await s.api('/no-existe.html')).status, 404);
        assert.equal((await s.api('/api/no-existe')).status, 401);       // sin entrar, la API no dice qué existe
        assert.equal((await s.call('GET', '/api/no-existe')).status, 404);
        assert.equal((await s.api('/api/health')).status, 200);
    } finally {
        await s.close();
    }
});

test('sin carpeta de panel, el servidor sigue siendo solo la API', async () => {
    const s = await startServer();
    try {
        assert.equal((await s.api('/')).status, 404);
        assert.equal((await s.api('/api/health')).status, 200);
    } finally {
        await s.close();
    }
});

test('la sesión dice en qué dispositivo suena cuando no es este («Continuar aquí»)', async () => {
    const s = await startServer({ webDir: WEB });
    try {
        const phone = (await (await s.login(PASSWORD, OWNER, 'Xiaomi POCOPHONE F1')).json()).token;
        const { cookie } = await webLogin(s);
        const web = { Cookie: cookie, 'X-MyMusic': 'web' };
        await s.call('POST', '/api/session', { track: { key: 'yt:dQw4w9WgXcQ', title: 'Una' } }, phone);

        const seen = await (await s.api('/api/session', { headers: web })).json();
        assert.equal(seen.session.active, false);
        assert.equal(seen.session.deviceName, 'Xiaomi POCOPHONE F1');
        assert.equal(seen.session.device, undefined);

        const mine = await (await s.api('/api/session/claim', { method: 'POST', headers: web })).json();
        assert.equal(mine.session.active, true);
        assert.equal(mine.session.deviceName, null);

        const fromPhone = await s.call('GET', '/api/session', undefined, phone);
        assert.equal(fromPhone.body.session.active, false);
        assert.equal(fromPhone.body.session.deviceName, 'Navegador de prueba');
        assert.equal((await s.call('PUT', '/api/session/state', { key: 'yt:dQw4w9WgXcQ', positionMs: 5000 }, phone)).status, 409);
    } finally {
        await s.close();
    }
});
