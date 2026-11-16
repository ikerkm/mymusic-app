import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCache, TrackBuffer, sniffMime } from '../src/audio.js';
import { collect, fakeAudio, fakeOpen } from './helpers.js';

const MB = 1024 * 1024;
const newCache = (open, over = {}) => new AudioCache({ maxBytes: 300 * MB, trackMaxBytes: 150 * MB, open, ...over });

test('sniffMime reconoce los contenedores habituales', () => {
    assert.equal(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), 'audio/webm');
    assert.equal(sniffMime(Buffer.from('\0\0\0\x20ftypdash', 'latin1')), 'audio/mp4');
    assert.equal(sniffMime(Buffer.from('ID3\x04\0\0', 'latin1')), 'audio/mpeg');
    assert.equal(sniffMime(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'audio/aac');
    assert.equal(sniffMime(Buffer.from('nada reconocible')), 'application/octet-stream');
});

test('con tamaño anunciado, las cabeceras están listas antes de acabar la descarga', async () => {
    const bytes = fakeAudio(50_000);
    const cache = newCache(fakeOpen(bytes, { delayMs: 3 }));
    const buffer = cache.get('yt:aaaaaaaaaaa', 'u');
    await buffer.waitHeader();
    assert.equal(buffer.total, 50_000);
    assert.equal(buffer.mime, 'audio/webm');
    assert.equal(buffer.done, false, 'aún descargando');
    assert.deepEqual(await collect(buffer.read(0, 49_999)), bytes);
    // El último byte llega justo antes de que el proceso se dé por terminado
    for (let i = 0; i < 100 && !buffer.done; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(buffer.done, true);
    assert.equal(buffer.error, null);
});

test('sin tamaño anunciado, espera a tener la canción entera', async () => {
    const bytes = fakeAudio(20_000);
    const cache = newCache(fakeOpen(bytes, { filesize: null }));
    const buffer = cache.get('yt:aaaaaaaaaaa', 'u');
    await buffer.waitHeader();
    assert.equal(buffer.done, true);
    assert.equal(buffer.total, 20_000);
});

test('sirve un tramo intermedio y uno que aún no ha llegado', async () => {
    const bytes = fakeAudio(30_000);
    const cache = newCache(fakeOpen(bytes, { delayMs: 2 }));
    const buffer = cache.get('yt:aaaaaaaaaaa', 'u');
    await buffer.waitHeader();
    const [tail, middle] = await Promise.all([
        collect(buffer.read(29_000, 29_999)),       // todavía no descargado: espera
        collect(buffer.read(1_500, 4_499)),
    ]);
    assert.deepEqual(tail, bytes.subarray(29_000, 30_000));
    assert.deepEqual(middle, bytes.subarray(1_500, 4_500));
});

test('la misma canción no se extrae dos veces', async () => {
    const open = fakeOpen(fakeAudio(5_000));
    const cache = newCache(open);
    const a = cache.get('yt:aaaaaaaaaaa', 'u');
    const b = cache.get('yt:aaaaaaaaaaa', 'u');
    assert.equal(a, b);
    await a.waitHeader();
    assert.equal(open.calls.length, 1);
});

test('si yt-dlp no da audio, falla con su mensaje y un reintento vuelve a extraer', async () => {
    const open = fakeOpen(Buffer.alloc(0), { filesize: null, stderr: 'ERROR: Video unavailable' });
    const cache = newCache(open);
    await assert.rejects(cache.get('yt:aaaaaaaaaaa', 'u').waitHeader(), /Video unavailable/);
    assert.equal(cache.items.size, 0);
    await assert.rejects(cache.get('yt:aaaaaaaaaaa', 'u').waitHeader());
    assert.equal(open.calls.length, 2);
});

test('una descarga cortada a medias rompe la lectura en vez de entregar audio incompleto', async () => {
    const bytes = fakeAudio(20_000);
    const cache = newCache(fakeOpen(bytes, { cutAt: 8_000 }));
    const buffer = cache.get('yt:aaaaaaaaaaa', 'u');
    await buffer.waitHeader();
    await assert.rejects(collect(buffer.read(0, 19_999)), /cortó|anunciado/);
    assert.equal(cache.items.size, 0);
});

test('una pista mayor que el tope por canción falla con too_big', async () => {
    const cache = newCache(fakeOpen(fakeAudio(9_000)), { trackMaxBytes: 4_000 });
    await assert.rejects(cache.get('yt:aaaaaaaaaaa', 'u').waitHeader(), error => error.code === 'too_big');
    assert.equal(cache.items.size, 0);
});

test('al pasar el tope de memoria se sueltan las más antiguas, nunca la que se está leyendo', async () => {
    const cache = newCache(fakeOpen(fakeAudio(10_000), { delayMs: 0 }), { maxBytes: 25_000 });
    const keys = ['yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', 'yt:aaaaaaaaaa3'];
    const first = cache.get(keys[0], 'u');
    await collect(first.read(0, 9_999));
    first.readers = 1;                               // alguien la sigue leyendo
    for (const key of keys.slice(1)) {
        const buffer = cache.get(key, 'u');
        await buffer.waitHeader();
        await collect(buffer.read(0, 9_999));
        buffer.lastUsed = Date.now() + keys.indexOf(key);
    }
    cache.evict();
    assert.ok(cache.items.has(keys[0]), 'la que tiene lector se queda');
    assert.ok(!cache.items.has(keys[1]), 'la más antigua sin lector se suelta');
    assert.ok(cache.items.has(keys[2]));
    assert.ok(cache.bytes <= 25_000);
});

test('TrackBuffer.read respeta la cancelación', async () => {
    const buffer = new TrackBuffer('k');
    buffer.declare(100);
    buffer.append(Buffer.alloc(20, 1));
    const abort = new AbortController();
    const reading = collect(buffer.read(0, 99, abort.signal));
    abort.abort();
    await assert.rejects(reading, { name: 'AbortError' });
});
