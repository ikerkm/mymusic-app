import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Consumo: cuánto gasta cada usuario y cuánto gasta la máquina, para saber cuántos caben.
//
// Por usuario y día (data/usage/users-AAAA-MM.json) se apunta lo que provoca: tiempo escuchado,
// audio que se le sirve, extracciones que lanza (lo que bajan de fuera, lo que tardan y el tiempo
// de procesador de yt-dlp), búsquedas y tandas de radio. Una canción que ya estaba en memoria
// porque la pidió otro no le cuesta nada al segundo: se apunta a quien la hizo extraer.
//
// De la máquina (data/usage/system-AAAA-MM.jsonl) queda una muestra por minuto mientras hay
// actividad, y una cada cuarto de hora en reposo: oyentes a la vez, extracciones en marcha y en
// cola, audio en memoria, memoria del servidor y procesador.
//
// Solo se cuentan cantidades: aquí no queda qué canciones oye nadie.

/** Quién ha provocado lo que está pasando ahora: la petición en curso, o un trabajo que salió de ella. */
export const who = new AsyncLocalStorage();

/** Apunta algo al usuario del contexto actual. Sin contexto (arranque, pruebas sin consumo) no hace nada. */
export function note(counters) {
    const ctx = who.getStore();
    ctx?.usage?.add(ctx.userId, counters);
}

/** Extracciones a la vez en este instante: se guarda el máximo entre dos muestras (duran segundos y una muestra por minuto no las vería). */
export function noteRunning(running, waiting = 0) {
    who.getStore()?.usage?.busy(running, waiting);
}

/**
 * Tiempo de procesador que lleva gastado un proceso, con los hijos que ya ha recogido, en ms.
 * Sale de /proc (Linux, Android). Donde no existe (Windows) devuelve null: ese dato no se tiene.
 */
export function cpuMsOf(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // «pid (nombre) estado …»: el nombre puede llevar espacios y paréntesis, se salta entero
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ticks = Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]);      // utime, stime, cutime, cstime
        return Number.isFinite(ticks) ? ticks * 10 : null;       // 100 tics por segundo
    } catch {
        return null;
    }
}

/**
 * Sigue a un proceso recién lanzado (yt-dlp, ffmpeg) y, cuando acaba, apunta su tiempo de procesador
 * a quien lo provocó. El dato se lee mientras vive (al morir desaparece de /proc), así que a cada
 * proceso le puede faltar su último cuarto de segundo.
 */
export function trackChild(child, { readCpu = cpuMsOf, everyMs = 250 } = {}) {
    const ctx = who.getStore();
    if (!ctx?.usage || !child?.pid) return;
    let cpu = readCpu(child.pid);
    let done = false;
    const timer = setInterval(() => {
        const now = readCpu(child.pid);
        if (now !== null) cpu = now;
    }, everyMs);
    timer.unref?.();
    const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        ctx.usage.add(ctx.userId, { procs: 1, ...(cpu === null ? {} : { cpuProcs: 1, cpuMs: cpu }) });
    };
    child.once('exit', finish);
    child.once('error', finish);
}

export const COUNTERS = ['listenedMs', 'plays', 'servedBytes', 'extractions', 'extractFails', 'extractBytes', 'extractMs', 'procs', 'cpuProcs', 'cpuMs', 'searches', 'radioBatches'];

const ACTIVE_MS = 90_000;           // un oyente informa de su posición cada 20 s: pasado este tiempo sin noticias, ya no escucha
const SAMPLE_MS = 60_000;
const IDLE_EVERY = 15;              // en reposo, una muestra de cada tantas
const START_WINDOW_MS = 45_000;     // lo que puede llevar sonando una canción cuando llega su primer informe
const REPORT_GAP_MS = 25_000;       // entre dos informes seguidos de quien escucha sin parar pasan 20 s
const MARGIN = 0.6;                 // de procesador y de turnos de extracción se cuenta con el 60 %: el resto es holgura para las coincidencias

const pad = n => String(n).padStart(2, '0');
const dayOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const zero = () => Object.fromEntries(COUNTERS.map(name => [name, 0]));
const sum = (into, from) => { for (const name of COUNTERS) into[name] += Number(from?.[name]) || 0; return into; };

/**
 * Cuántos oyentes a la vez aguantaría la máquina, según lo medido. Es una cuenta con medias: vale
 * para el orden de magnitud, no al oyente. Manda el límite más bajo.
 */
export function capacity(total, { cacheBytes, slots, cores }) {
    const hours = total.listenedMs / 3_600_000;
    const basis = { listenHours: round(hours, 2), extractions: total.extractions, enough: hours >= 2 && total.extractions >= 30 };
    if (!(hours > 0) || !(total.extractions > 0) || !(total.extractBytes > 0)) return { basis, perListener: null, limits: null, bottleneck: null };
    const perHour = total.extractions / hours;
    const avgBytes = total.extractBytes / total.extractions;
    const avgMs = total.extractMs / total.extractions;
    const slotShare = (perHour * avgMs) / 3_600_000;                                  // parte de un turno de extracción que ocupa un oyente
    const cpuShare = total.cpuProcs > 0 ? total.cpuMs / total.listenedMs : null;      // parte de un núcleo
    const seconds = total.listenedMs / 1000;
    const perListener = {
        extractionsPerHour: round(perHour),
        extractMB: round(avgBytes / 1048576, 2),
        extractSeconds: round(avgMs / 1000),
        slotShare: round(slotShare, 4),
        cpuShare: cpuShare === null ? null : round(cpuShare, 4),
        memoryMB: round((2 * avgBytes) / 1048576),                                   // la que suena y la siguiente, fijadas en memoria
        upKbps: round((total.servedBytes * 8) / seconds / 1000, 0),
        downKbps: round((total.extractBytes * 8) / seconds / 1000, 0),
    };
    const limits = {
        memory: Math.floor(cacheBytes / (2 * avgBytes)),
        slots: slotShare > 0 ? Math.floor((slots * MARGIN) / slotShare) : null,
        cpu: cpuShare ? Math.floor((cores * MARGIN) / cpuShare) : null,
    };
    const known = Object.entries(limits).filter(([, value]) => value !== null).sort((a, b) => a[1] - b[1]);
    return { basis, perListener, limits, bottleneck: known[0]?.[0] ?? null };
}

export class Usage {
    /**
     * @param {object} o
     * @param {import('./audio.js').AudioCache} o.cache   para leer el audio en memoria y las extracciones en marcha
     * @param {number} o.cores  núcleos que puede usar el servidor (si no se dice, los que vea Node)
     */
    constructor(dataDir, { now = Date.now, cache = null, cores = null, log = () => {} } = {}) {
        this.dir = join(dataDir, 'usage');
        this.now = now;
        this.cache = cache;
        this.cores = cores || os.availableParallelism?.() || os.cpus().length || 1;
        this.log = log;
        this.months = new Map();         // «AAAA-MM» → { usuario: { día: contadores } }
        this.dirty = new Set();
        this.last = new Map();           // usuario → último informe de posición { key, positionMs, at }
        this.active = new Map();         // usuario → cuándo dio señales de estar escuchando
        this.peak = { running: 0, waiting: 0 };
        this.childCpuMs = 0;             // procesador de yt-dlp y ffmpeg desde la última muestra
        this.cpuSeen = false;            // ¿da este sistema el tiempo de procesador de los procesos?
        this.cpuBefore = process.cpuUsage();
        this.sampledAt = this.now();
        this.skipped = 0;
        this.timer = null;
    }

    #month(month) {
        if (!this.months.has(month)) this.months.set(month, readJson(join(this.dir, `users-${month}.json`), {}));
        return this.months.get(month);
    }

    /** Suma contadores al día de hoy de un usuario. */
    add(userId, counters) {
        if (!userId) return;
        const day = dayOf(this.now());
        const month = day.slice(0, 7);
        const users = this.#month(month);
        const days = (users[userId] ??= {});
        const today = (days[day] ??= zero());
        for (const name of COUNTERS) {
            const value = Number(counters?.[name]);
            if (Number.isFinite(value) && value > 0) today[name] = (today[name] ?? 0) + Math.round(value);
        }
        if (counters?.cpuProcs > 0) {
            this.cpuSeen = true;
            this.childCpuMs += Number(counters.cpuMs) || 0;
        }
        this.dirty.add(month);
    }

    busy(running, waiting = 0) {
        this.peak.running = Math.max(this.peak.running, running);
        this.peak.waiting = Math.max(this.peak.waiting, waiting);
    }

    /**
     * Informe de posición de quien escucha. El tiempo escuchado sale de lo que avanza la canción
     * entre dos informes, mientras no avance más que el reloj (eso es un salto en la barra).
     */
    listened(userId, key, positionMs) {
        const now = this.now();
        this.active.set(userId, now);
        if (!key || !Number.isFinite(positionMs) || positionMs < 0) return;
        const last = this.last.get(userId);
        this.last.set(userId, { key, positionMs, at: now });
        if (!last) return;
        const elapsed = now - last.at;
        if (last.key === key) {
            const moved = positionMs - last.positionMs;
            if (moved > 0 && moved <= elapsed + 5000) this.add(userId, { listenedMs: moved });
        } else if (positionMs > 0 && positionMs <= Math.min(elapsed + 5000, START_WINDOW_MS)) {
            // Canción nueva desde el informe anterior: lo que lleva sonando y, si no hubo pausa por
            // medio, el final de la anterior (lo que sonó entre su último informe y el cambio)
            const tail = elapsed - positionMs;
            this.add(userId, { listenedMs: positionMs + (tail > 0 && tail <= REPORT_GAP_MS ? tail : 0) });
        }
    }

    listeners() {
        const now = this.now();
        return [...this.active.values()].filter(at => now - at <= ACTIVE_MS).length;
    }

    /** Guarda en disco los contadores que hayan cambiado. */
    flush() {
        for (const month of this.dirty) writeJsonAtomic(join(this.dir, `users-${month}.json`), this.months.get(month));
        this.dirty.clear();
    }

    /** Cómo está la máquina ahora. Con `keep`, cierra el minuto: lo apunta si hubo actividad y pone los máximos a cero. */
    sample({ keep = false } = {}) {
        const now = this.now();
        const cpu = process.cpuUsage();
        const elapsed = Math.max(1, now - this.sampledAt);
        const nodeMs = (cpu.user + cpu.system - this.cpuBefore.user - this.cpuBefore.system) / 1000;
        const running = this.cache?.running ?? 0;
        const waiting = this.cache?.waiting?.length ?? 0;
        const sample = {
            at: new Date(now).toISOString(),
            listeners: this.listeners(),
            running: Math.max(running, this.peak.running),
            waiting: Math.max(waiting, this.peak.waiting),
            cacheMB: round((this.cache?.bytes ?? 0) / 1048576),
            rssMB: Math.round(process.memoryUsage.rss() / 1048576),
            freeMB: Math.round(os.freemem() / 1048576),
            nodeCpu: round((nodeMs / elapsed) * 100),                                        // % de un núcleo
            childCpu: this.cpuSeen ? round((this.childCpuMs / elapsed) * 100) : null,       // % de un núcleo; null = este sistema no lo da
        };
        if (!keep) return { ...sample, running, waiting };
        const activity = sample.listeners > 0 || sample.running > 0 || this.childCpuMs > 0;
        if (activity || ++this.skipped >= IDLE_EVERY) {
            this.skipped = 0;
            mkdirSync(this.dir, { recursive: true });
            appendFileSync(join(this.dir, `system-${dayOf(now).slice(0, 7)}.jsonl`), JSON.stringify(sample) + '\n');
        }
        this.cpuBefore = cpu;
        this.sampledAt = now;
        this.childCpuMs = 0;
        this.peak = { running: 0, waiting: 0 };
        return sample;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            try {
                this.sample({ keep: true });
                this.flush();
            } catch (error) {
                this.log(`[consumo] no se pudo apuntar: ${String(error?.message ?? error).slice(0, 200)}`);
            }
        }, SAMPLE_MS);
        this.timer.unref();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
        try { this.flush(); } catch { /* al cerrar: si no se puede, se pierde el último minuto */ }
    }

    #samples(fromDay, toDay) {
        const out = [];
        const months = new Set([fromDay.slice(0, 7), toDay.slice(0, 7)]);
        for (const month of [...months].sort()) {
            let text;
            try { text = readFileSync(join(this.dir, `system-${month}.jsonl`), 'utf8'); } catch { continue; }
            for (const line of text.split('\n')) {
                if (!line) continue;
                try {
                    const sample = JSON.parse(line);
                    const day = dayOf(Date.parse(sample.at));
                    if (day >= fromDay && day <= toDay) out.push(sample);
                } catch { /* línea a medias: se salta */ }
            }
        }
        return out;
    }

    /**
     * Resumen de los últimos `days` días (hoy incluido): lo de cada usuario, el total, los máximos
     * de la máquina, cómo está ahora y cuántos oyentes a la vez caben según lo medido.
     * @param {{id: string, name: string}[]} o.users  las cuentas que existen, para poner nombre a cada una
     */
    report({ days = 7, users = [] } = {}) {
        const now = this.now();
        const wanted = [];
        for (let i = days - 1; i >= 0; i--) wanted.push(dayOf(now - i * 86_400_000));
        const [fromDay, toDay] = [wanted[0], wanted[wanted.length - 1]];
        const perUser = new Map(users.map(user => [user.id, { id: user.id, name: user.name, ...zero() }]));
        const total = zero();
        for (const month of new Set(wanted.map(day => day.slice(0, 7)))) {
            for (const [userId, byDay] of Object.entries(this.#month(month))) {
                for (const day of wanted) {
                    if (!byDay[day]) continue;
                    if (!perUser.has(userId)) perUser.set(userId, { id: userId, name: null, ...zero() });      // cuenta que ya no existe
                    sum(perUser.get(userId), byDay[day]);
                    sum(total, byDay[day]);
                }
            }
        }
        const samples = this.#samples(fromDay, toDay);
        // El mayor valor de cada medida y cuándo fue. null = no hay ese dato en el periodo (p. ej. el procesador de las extracciones en Windows)
        const top = name => samples.reduce((max, sample) => (typeof sample[name] === 'number' && sample[name] > (max?.[name] ?? -1) ? sample : max), null);
        const peaks = Object.fromEntries(['listeners', 'running', 'waiting', 'cacheMB', 'rssMB', 'nodeCpu', 'childCpu'].map(name => {
            const sample = top(name);
            return [name, sample ? { value: sample[name], at: sample.at } : null];
        }));
        const limits = { cacheMB: Math.round((this.cache?.maxBytes ?? 0) / 1048576), slots: this.cache?.maxConcurrent ?? 0, cores: this.cores };
        return {
            days, from: fromDay, to: toDay,
            users: [...perUser.values()].sort((a, b) => b.listenedMs - a.listenedMs || b.servedBytes - a.servedBytes),
            total,
            now: this.sample(),
            samples: samples.length,
            peaks,
            limits,
            capacity: capacity(total, { cacheBytes: this.cache?.maxBytes ?? 0, slots: limits.slots, cores: limits.cores }),
        };
    }
}
