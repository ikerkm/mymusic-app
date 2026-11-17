import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AudioCache } from '../src/audio.js';
import { Usage, capacity, cpuMsOf, trackChild, who } from '../src/usage.js';
import { fakeAudio, fakeOpen, startServer, tempDataDir } from './helpers.js';

const MB = 1048576;
const yt = n => ({ key: `yt:aaaaaaaaaa${n}`, platform: 'youtube', title: `Canción ${n}`, artist: 'Alguien', durationSec: 200, thumb: null });
const until = async (check, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return true;
        await sleep(10);
    }
    return false;
};
const totalsOf = (usage, userId) => usage.report({ days: 1 }).users.find(user => user.id === userId);

// ------------------------------------------------------------------ contadores

test('consumo: los contadores se suman por usuario y día, y sobreviven a un reinicio', () => {
    let now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const dir = tempDataDir();
    const usage = new Usage(dir, { now: () => now });
    usage.add('u_a', { servedBytes: 1000, searches: 1 });
    usage.add('u_a', { servedBytes: 500, extractions: 1, extractBytes: 4 * MB, extractMs: 12_000, desconocido: 7, plays: -3 });
    usage.add('u_b', { searches: 2 });
    now += 86_400_000;
    usage.add('u_a', { searches: 5 });

    const today = usage.report({ days: 1, users: [{ id: 'u_a', name: 'ana' }, { id: 'u_b', name: 'berto' }, { id: 'u_c', name: 'carla' }] });
    assert.deepEqual([today.from, today.to], ['2026-11-18', '2026-11-18']);
    assert.deepEqual(today.users.map(user => [user.name, user.searches, user.servedBytes]), [['ana', 5, 0], ['berto', 0, 0], ['carla', 0, 0]], 'salen todas las cuentas, también las que no han gastado');
    const both = usage.report({ days: 2, users: [{ id: 'u_a', name: 'ana' }] });
    assert.deepEqual([both.from, both.to], ['2026-11-17', '2026-11-18']);
    const ana = both.users.find(user => user.id === 'u_a');
    assert.deepEqual([ana.servedBytes, ana.searches, ana.extractions, ana.extractBytes, ana.extractMs, ana.plays], [1500, 6, 1, 4 * MB, 12_000, 0]);
    assert.deepEqual(both.users.find(user => user.id === 'u_b').name, null, 'una cuenta que ya no existe sale sin nombre');
    assert.deepEqual([both.total.searches, both.total.servedBytes], [8, 1500]);

    assert.equal(existsSync(join(dir, 'usage')), false, 'hasta que no se guarda no hay nada en disco');
    usage.flush();
    const again = new Usage(dir, { now: () => now });
    assert.equal(again.report({ days: 2 }).total.searches, 8);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'usage', 'users-2026-11.json'), 'utf8')).u_a), ['2026-11-17', '2026-11-18']);
});

test('consumo: el tiempo escuchado es lo que avanza la canción, sin contar los saltos en la barra', () => {
    let now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const usage = new Usage(tempDataDir(), { now: () => now });
    const tick = (seconds, key, positionMs) => { now += seconds * 1000; usage.listened('u_a', key, positionMs); };
    const listened = () => totalsOf(usage, 'u_a')?.listenedMs ?? 0;

    tick(0, 'yt:a', 95_000);            // «Continuar» a mitad de canción: el primer informe no cuenta nada
    assert.equal(listened(), 0);
    tick(20, 'yt:a', 115_000);          // 20 s después ha avanzado 20 s
    assert.equal(listened(), 20_000);
    tick(20, 'yt:a', 200_000);          // salto adelante en la barra: no ha sonado
    assert.equal(listened(), 20_000);
    tick(20, 'yt:a', 220_000);
    tick(20, 'yt:a', 100_000);          // salto atrás: tampoco
    assert.equal(listened(), 40_000);
    tick(20, 'yt:b', 12_000);           // canción nueva: lleva 12 s sonando, y antes sonaron los últimos 8 s de la anterior
    assert.equal(listened(), 60_000);
    tick(600, 'yt:c', 30_000);          // tras 10 min en pausa, otra canción que lleva 30 s (de la anterior, nada)
    assert.equal(listened(), 90_000);
    tick(600, 'yt:d', 125_000);         // otra, pero movida a los 2 min: eso no ha sonado
    assert.equal(listened(), 90_000);
    usage.listened('u_a', null, 5);
    usage.listened('u_a', 'yt:d', Number.NaN);
    assert.equal(listened(), 90_000);

    // Quien escucha sin parar: 3 min 30 s de canción y la siguiente, con informes cada 20 s → no se pierde nada
    const steady = new Usage(tempDataDir(), { now: () => now });
    const beat = (key, positionMs) => { now += 20_000; steady.listened('u_b', key, positionMs); };
    steady.listened('u_b', 'yt:x', 190_000);
    beat('yt:x', 210_000);              // acaba a los 3:30, justo en este informe
    beat('yt:y', 20_000);
    for (let at = 40_000; at <= 200_000; at += 20_000) beat('yt:y', at);
    beat('yt:z', 10_000);               // yt:y acabó a los 3:30: 10 s suyos y 10 s de la nueva
    assert.equal(totalsOf(steady, 'u_b').listenedMs, 20_000 + 200_000 + 20_000);
});

test('consumo: oyentes a la vez = quienes han informado de su posición en el último minuto y medio', () => {
    let now = Date.now();
    const usage = new Usage(tempDataDir(), { now: () => now });
    usage.listened('u_a', 'yt:a', 1000);
    now += 60_000;
    usage.listened('u_b', 'yt:b', 1000);
    assert.equal(usage.listeners(), 2);
    now += 40_000;
    assert.equal(usage.listeners(), 1, 'el primero lleva 100 s sin dar señales');
    now += 60_000;
    assert.equal(usage.listeners(), 0);
});

// ------------------------------------------------------------------ procesador de los procesos lanzados

test('consumo: el procesador de un proceso lanzado se apunta, al acabar, a quien lo provocó', async () => {
    const usage = new Usage(tempDataDir());
    const child = Object.assign(new EventEmitter(), { pid: 4321 });
    let cpu = 100;
    who.run({ userId: 'u_a', usage }, () => trackChild(child, { readCpu: () => cpu, everyMs: 5 }));
    cpu = 730;
    await sleep(30);
    cpu = null;                 // el proceso ya ha salido: /proc no dice nada
    await sleep(15);
    child.emit('exit', 0);
    child.emit('exit', 0);
    assert.deepEqual([totalsOf(usage, 'u_a').procs, totalsOf(usage, 'u_a').cpuProcs, totalsOf(usage, 'u_a').cpuMs], [1, 1, 730]);

    // Donde el sistema no da ese dato (Windows) se cuenta el proceso, pero no su procesador
    const blind = Object.assign(new EventEmitter(), { pid: 99 });
    who.run({ userId: 'u_b', usage }, () => trackChild(blind, { readCpu: () => null, everyMs: 5 }));
    blind.emit('exit', 0);
    assert.deepEqual([totalsOf(usage, 'u_b').procs, totalsOf(usage, 'u_b').cpuProcs, totalsOf(usage, 'u_b').cpuMs], [1, 0, 0]);

    // Fuera de una petición no hay a quién apuntarlo: no hace nada (ni falla)
    trackChild(Object.assign(new EventEmitter(), { pid: 5 }));
    assert.equal(cpuMsOf(-1), null);
});

test('consumo: una extracción que espera turno se apunta a quien la pidió, no a quien libera el turno', async () => {
    const open = fakeOpen(fakeAudio(20_000), { chunk: 2000, delayMs: 2 });
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open, maxConcurrent: 1 });
    const usage = new Usage(tempDataDir(), { cache });
    const a = who.run({ userId: 'u_a', usage }, () => cache.get('yt:a', 'https://x/a'));
    const b = who.run({ userId: 'u_b', usage }, () => cache.get('yt:b', 'https://x/b'));
    const c = who.run({ userId: 'u_b', usage }, () => cache.get('yt:c', 'https://x/c'));
    assert.deepEqual([cache.running, cache.waiting.length], [1, 2]);
    assert.ok(await until(() => a.done && b.done && c.done));
    await sleep(20);
    assert.deepEqual([totalsOf(usage, 'u_a').extractions, totalsOf(usage, 'u_a').extractBytes], [1, 20_000]);
    assert.deepEqual([totalsOf(usage, 'u_b').extractions, totalsOf(usage, 'u_b').extractBytes], [2, 40_000]);
    const minute = usage.sample({ keep: true });
    assert.deepEqual([minute.running, minute.waiting], [1, 2], 'la muestra guarda el máximo del minuto, no el instante');
    assert.deepEqual([usage.sample().running, usage.sample().waiting], [0, 0]);
});

test('consumo: una extracción fallida cuenta como fallo, con el tiempo que ocupó', async () => {
    const open = fakeOpen(fakeAudio(5000), { failFirst: 5 });
    const cache = new AudioCache({ maxBytes: 1e9, trackMaxBytes: 1e9, open, attempts: 2 });
    const usage = new Usage(tempDataDir(), { cache });
    const buffer = who.run({ userId: 'u_a', usage }, () => cache.get('yt:a', 'https://x/a'));
    assert.ok(await until(() => buffer.done));
    await sleep(20);
    const mine = totalsOf(usage, 'u_a');
    assert.deepEqual([mine.extractions, mine.extractFails, mine.extractBytes], [0, 1, 0]);
    assert.equal(open.calls.length, 2, 'el reintento también se hizo');
});

// ------------------------------------------------------------------ la máquina

test('consumo: la muestra del minuto se apunta si hubo actividad; en reposo, una de cada quince', () => {
    let now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const dir = tempDataDir();
    const cache = { bytes: 12 * MB, running: 0, waiting: [], maxBytes: 300 * MB, maxConcurrent: 3 };
    const usage = new Usage(dir, { now: () => now, cache, cores: 4 });
    const file = join(dir, 'usage', 'system-2026-11.jsonl');
    const lines = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
    const minute = () => { now += 60_000; return usage.sample({ keep: true }); };

    for (let i = 0; i < 14; i++) minute();
    assert.equal(lines().length, 0, 'catorce minutos en reposo: nada');
    minute();
    assert.equal(lines().length, 1, 'el decimoquinto deja constancia de que sigue vivo');

    usage.listened('u_a', 'yt:a', 1000);
    usage.busy(2, 1);
    usage.add('u_a', { procs: 1, cpuProcs: 1, cpuMs: 6000 });
    const busy = minute();
    assert.deepEqual([busy.listeners, busy.running, busy.waiting, busy.cacheMB, busy.childCpu], [1, 2, 1, 12, 10], '6 s de procesador en un minuto = 10 % de un núcleo');
    assert.equal(lines().length, 2);
    assert.equal(lines()[1].listeners, 1);

    now += 3 * 60_000;
    const quiet = minute();
    assert.deepEqual([quiet.listeners, quiet.running, quiet.childCpu], [0, 0, 0], 'los máximos empiezan de cero cada minuto');
    assert.equal(lines().length, 2);

    const report = usage.report({ days: 1 });
    assert.equal(report.samples, 2);
    assert.deepEqual([report.peaks.listeners.value, report.peaks.running.value, report.peaks.waiting.value, report.peaks.childCpu.value], [1, 2, 1, 10]);
    assert.deepEqual(report.limits, { cacheMB: 300, slots: 3, cores: 4 });
    assert.equal(typeof report.now.rssMB, 'number');
});

test('consumo: cuántos oyentes a la vez caben, según lo medido', () => {
    const total = {
        listenedMs: 10 * 3_600_000, plays: 150, servedBytes: 680 * MB,
        extractions: 170, extractFails: 0, extractBytes: 680 * MB, extractMs: 170 * 12_000,
        procs: 170, cpuProcs: 170, cpuMs: 170 * 3000, searches: 0, radioBatches: 0,
    };
    const result = capacity(total, { cacheBytes: 300 * MB, slots: 3, cores: 4 });
    assert.deepEqual(result.basis, { listenHours: 10, extractions: 170, enough: true });
    assert.deepEqual(result.perListener, {
        extractionsPerHour: 17, extractMB: 4, extractSeconds: 12, slotShare: 0.0567, cpuShare: 0.0142, memoryMB: 8, upKbps: 158, downKbps: 158,
    });
    // Memoria: 300 MB entre 8 MB por oyente. Turnos: 3 × 60 % entre 0,0567. Procesador: 4 × 60 % entre 0,0142.
    assert.deepEqual(result.limits, { memory: 37, slots: 31, cpu: 169 });
    assert.equal(result.bottleneck, 'slots');

    // Sin el dato de procesador (Windows) ese límite no se da; con pocos datos se avisa
    const blind = capacity({ ...total, cpuProcs: 0, cpuMs: 0, listenedMs: 3_600_000, extractions: 17, extractBytes: 68 * MB, extractMs: 17 * 12_000 }, { cacheBytes: 300 * MB, slots: 3, cores: 4 });
    assert.equal(blind.limits.cpu, null);
    assert.equal(blind.basis.enough, false);
    // Sin nada escuchado no hay cuenta que hacer
    assert.deepEqual(capacity({ ...total, listenedMs: 0 }, { cacheBytes: 300 * MB, slots: 3, cores: 4 }).limits, null);
});

// ------------------------------------------------------------------ API

test('API: lo que se sirve, se busca y se escucha se apunta a cada usuario; la extracción, a quien la provocó', async () => {
    const s = await startServer({ bytes: fakeAudio(30_000), prefetchDelayMs: 100_000 });
    try {
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        const hers = s.auth.users().find(user => user.name === 'pareja').id;

        // El dueño pide una canción: se extrae y se le sirve entera
        assert.equal((await (await s.api(`/api/stream/${yt(0).key}`, { token: s.token })).arrayBuffer()).byteLength, 30_000);
        // La pareja pide la misma: ya está en memoria, solo se le sirve (y un trozo, con Range)
        assert.equal((await (await s.api(`/api/stream/${yt(0).key}`, { token: other, headers: { Range: 'bytes=0-9999' } })).arrayBuffer()).byteLength, 10_000);
        await s.call('GET', '/api/search?q=algo');
        await s.call('GET', '/api/search?q=algo', undefined, other);
        await s.call('GET', '/api/search?q=mas', undefined, other);
        assert.ok(await until(() => totalsOf(s.usage, s.owner.id)?.extractions === 1));

        const mine = totalsOf(s.usage, s.owner.id);
        const her = totalsOf(s.usage, hers);
        assert.deepEqual([mine.servedBytes, mine.extractions, mine.extractBytes, mine.searches], [30_000, 1, 30_000, 1]);
        assert.deepEqual([her.servedBytes, her.extractions, her.extractBytes, her.searches], [10_000, 0, 0, 2]);

        // Escuchar: el informe de posición cuenta el tiempo y, pasados 30 s, la canción
        await s.call('POST', '/api/session', { track: yt(0) });
        await s.call('PUT', '/api/session/state', { key: yt(0).key, positionMs: 20_000 });
        await s.call('PUT', '/api/session/state', { key: yt(0).key, positionMs: 20_900 });
        await s.call('PUT', '/api/session/state', { key: yt(0).key, positionMs: 31_000 });
        const after = totalsOf(s.usage, s.owner.id);
        assert.deepEqual([after.listenedMs, after.plays], [900, 1], 'el salto de 20,9 a 31 s no ha sonado; la canción sí cuenta como escuchada');
        assert.equal(s.usage.listeners(), 1);
    } finally {
        await s.close();
    }
});

test('API: la siguiente canción, que se prepara sola, también se apunta a quien escucha', async () => {
    const s = await startServer({ bytes: fakeAudio(8000), prefetchDelayMs: 10 });
    try {
        const list = s.lists.create('rock');
        s.lists.addTracks(list.id, [yt(0), yt(1)]);
        await s.call('POST', '/api/session', { listId: list.id });
        assert.ok(await until(() => totalsOf(s.usage, s.owner.id)?.extractions === 1), 'la siguiente se ha extraído sin que nadie la pida');
        assert.equal(totalsOf(s.usage, s.owner.id).extractBytes, 8000);
        assert.equal(totalsOf(s.usage, s.owner.id).servedBytes, 0);
    } finally {
        await s.close();
    }
});

test('API: el consumo solo lo ve el dueño', async () => {
    const s = await startServer();
    try {
        s.auth.createUser('pareja', 'otra-clave-larga');
        const other = (await (await s.login('otra-clave-larga', 'pareja', 'iPhone')).json()).token;
        await s.call('GET', '/api/search?q=algo', undefined, other);

        assert.equal((await s.api('/api/usage')).status, 401);
        assert.deepEqual((await s.call('GET', '/api/usage', undefined, other)).body, { error: 'forbidden' });
        const { status, body } = await s.call('GET', '/api/usage?days=30');
        assert.equal(status, 200);
        assert.equal(body.days, 30);
        assert.deepEqual(body.users.map(user => [user.name, user.searches]).sort(), [['duena', 0], ['pareja', 1]]);
        assert.equal(body.total.searches, 1);
        assert.deepEqual(body.limits, { cacheMB: Math.round(1e9 / MB), slots: 3, cores: 4 });
        assert.deepEqual([body.now.listeners, body.now.running, body.capacity.limits], [0, 0, null]);
        assert.equal((await s.call('GET', '/api/usage')).body.days, 7, 'sin decir nada, una semana');
        assert.equal((await s.call('GET', '/api/usage?days=nada')).body.days, 7);
        assert.equal((await s.call('GET', '/api/usage?days=0')).body.days, 1);
        assert.equal((await s.call('GET', '/api/usage?days=5000')).body.days, 92, 'como mucho, tres meses');
    } finally {
        await s.close();
    }
});
