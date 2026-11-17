// Prueba de verdad del lector de YouTube Music (src/ytmusic.js), desde el PC. Solo lee de YouTube
// Music: no toca el servidor ni sus datos. Las pruebas automáticas (npm test) usan un doble.
// Uso: node scripts/ytmusic-check.mjs ["búsqueda" …]
import { YtMusic, createYtMusicClient } from '../src/ytmusic.js';

const queries = process.argv.slice(2);
const ytm = new YtMusic({ client: createYtMusicClient({ log: console.log }) });
let fails = 0;
const check = (ok, what) => {
    if (!ok) fails++;
    console.log(`${ok ? '✓' : '✗'} ${what}`);
};
const ms = async fn => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t]; };

for (const q of queries.length ? queries : ['Daft Punk', 'daft punk get lucky', 'rosal', 'amen break 174', 'Air', 'Sewerslvt']) {
    const [row, t] = await ms(() => ytm.artistsFor(q));
    console.log(`\n«${q}» → fila de Artistas: ${row.map(a => `${a.name} (${a.listeners ?? '?'})`).join(' · ') || '(no sale)'} [${t} ms]`);
}

const [daft, tDaft] = await ms(() => ytm.findArtist('Daft Punk'));
check(daft?.id === 'UCRr1xG_2WIDs18a6cIiCxeA', `findArtist("Daft Punk") → ${daft?.name} ${daft?.id} [${tDaft} ms]`);
const [page, tPage] = await ms(() => ytm.artist(daft.id));
check(page.songs.length > 100, `artista: ${page.songs.length} canciones, ${page.albums.length} álbumes, ${page.singles.length} sencillos/EP, ${page.related.length} parecidos [${tPage} ms]`);
check(!!page.listeners && !!page.thumb, `oyentes «${page.listeners}», foto ${page.thumb?.slice(0, 60)}…`);
console.log('  top 5:', page.songs.slice(0, 5).map(s => `${s.title} (${s.durationSec}s, ${s.artist})`).join(' | '));
console.log('  álbumes:', page.albums.map(a => `${a.title} [${a.kind} ${a.year}]`).join(' | '));
console.log('  sencillos:', page.singles.slice(0, 8).map(a => `${a.title} [${a.kind} ${a.year}]`).join(' | '));
check(page.singles.filter(s => s.title === 'Human After All' && s.year === 2005).length === 1, 'los «Human After All» de 2005 repetidos se juntan en uno');
const [again, tAgain] = await ms(() => ytm.artist(daft.id));
check(again.songs.length === page.songs.length && tAgain < 50, `la segunda vez sale de la memoria [${tAgain} ms]`);

const ram = page.albums.find(a => a.title === 'Random Access Memories');
const [album, tAlbum] = await ms(() => ytm.album(ram.id));
check(album.tracks.length === 13 && album.tracks.every(t => t.key.startsWith('yt:') && t.durationSec), `disco «${album.title}» ${album.kind} ${album.year}: ${album.tracks.length} canciones con vídeo y duración [${tAlbum} ms]`);
console.log('  artistas del disco:', JSON.stringify(album.artists), '| carátula', album.thumb?.slice(0, 60));
console.log('  pista 5:', JSON.stringify(album.tracks[4]));

const metallica = await ytm.findArtist('Metallica');
const mpage = await ytm.artist(metallica.id);
const box = mpage.albums.find(a => /ReLoad \(Remastered Deluxe Box Set\)/.test(a.title));
if (box) {
    const [big, tBig] = await ms(() => ytm.album(box.id));
    check(big.tracks.length > 200, `caja «${big.title}»: ${big.tracks.length} canciones (más de 200) [${tBig} ms]`);
} else console.log('(no está la caja de Metallica para probar los discos de más de 200)');

const [none] = await ms(() => ytm.findArtist('canal de letras que no es un artista 12345'));
check(none === null, 'un nombre que no es de ningún artista → null');
console.log(`\n${fails === 0 ? 'Todo bien' : `${fails} comprobaciones fallidas`}`);
process.exit(fails === 0 ? 0 : 1);
