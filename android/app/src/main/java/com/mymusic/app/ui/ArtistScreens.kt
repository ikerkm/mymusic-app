package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.mymusic.app.AppViewModel
import com.mymusic.app.ArtistChoice
import com.mymusic.app.Overlay
import com.mymusic.app.SheetTarget
import com.mymusic.app.data.AlbumPage
import com.mymusic.app.data.ArtistCard
import com.mymusic.app.data.Release
import com.mymusic.app.data.Track
import com.mymusic.app.playback.PlayerState

// Artista y disco (§18): pantallas 3-7 de mockups/artista-disco-v1.html. Los datos salen de YouTube Music
// por el servidor. Nada de esto es del usuario: no sale en Listas, no se renombra ni se ordena; «Guardar
// como lista» copia el disco a una lista suya.

/** Foto redonda de un artista. */
@Composable
fun ArtistAvatar(url: String?, size: Dp) = Cover(url, size, radius = size / 2)

/** Artistas en fila que se desliza de lado (Buscar, «parecidos»). Con `showListeners`, sus oyentes al mes. */
@Composable
fun ArtistStrip(artists: List<ArtistCard>, showListeners: Boolean = false, onOpen: (ArtistCard) -> Unit) {
    LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(artists, key = { it.id }) { artist ->
            Column(
                Modifier.width(80.dp).clickable { onOpen(artist) }.testTag("artist"),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                ArtistAvatar(artist.thumb, 74.dp)
                Text(
                    artist.name, color = Mm.Tx, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp),
                )
                if (showListeners) {
                    Text(artist.listeners?.let { "$it al mes" } ?: "Artista", color = Mm.Mut, fontSize = 10.5.sp, maxLines = 1, textAlign = TextAlign.Center)
                }
            }
        }
    }
}

private fun kindLabel(kind: String) = when (kind) {
    "single" -> "Sencillo"
    "ep" -> "EP"
    else -> "Álbum"
}

// Debajo del nombre de un disco: el año, y el tipo si no es un álbum («Sencillo · 2024»)
private fun releaseLine(release: Release) = listOfNotNull(if (release.kind == "album") null else kindLabel(release.kind), release.year?.toString()).joinToString(" · ")

// Debajo del título de una de sus canciones: con quién la canta (si no es solo él) y cuánto dura
private fun featLine(artistName: String, track: Track): String {
    val others = track.artist.orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() && !it.equals(artistName, ignoreCase = true) }
    return listOfNotNull(if (others.isNotEmpty()) "con ${others.joinToString(", ")}" else null, track.durationSec?.let { formatTime(it * 1000L) }).joinToString(" · ")
}

/** Carátula cuadrada que ocupa el ancho que le den (la rejilla de la discografía). */
@Composable
private fun WideCover(url: String?, modifier: Modifier = Modifier) {
    Box(
        modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(10.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF3A3F5C), Color(0xFF8E9BD6)))),
    ) {
        if (url != null) AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

/** Un disco: carátula, nombre y año. Con `width`, de ese ancho (fila); sin él, todo el ancho (rejilla). */
@Composable
private fun ReleaseCard(release: Release, width: Dp?, onClick: () -> Unit) {
    Column((if (width != null) Modifier.width(width) else Modifier.fillMaxWidth()).clickable(onClick = onClick).testTag("release")) {
        if (width != null) Cover(release.thumb, width, radius = 10.dp) else WideCover(release.thumb)
        Text(release.title, color = Mm.Tx, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(releaseLine(release), color = Mm.Mut, fontSize = 11.sp, maxLines = 1)
    }
}

/** Arriba: la flecha de volver y, si se da, un título. */
@Composable
private fun BackBar(vm: AppViewModel, title: String? = null) {
    Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(40.dp).clickable { vm.back() }.testTag("back"), contentAlignment = Alignment.CenterStart) {
            Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
        }
        if (title != null) Text(title, color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Mientras llega la página, la rueda; si falló, por qué. */
@Composable
private fun PageWait(error: String?) {
    Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
        if (error != null) Text(error, color = Mm.Mut, fontSize = 13.sp, textAlign = TextAlign.Center)
        else CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
    }
}

/** Título de sección con su acción a la derecha («Ver todas · 148»). */
@Composable
private fun SectionHead(title: String, action: String?, tag: String = "", onAction: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { SectionLabel(title) }
        if (action != null) {
            Text(action, color = Mm.Acc, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable(onClick = onAction).padding(top = 14.dp, bottom = 6.dp).testTag(tag))
        }
    }
}

/** «Reproducir» (ancho) y, a su lado, lo que haga falta. */
@Composable
private fun PlayButton(label: String = "Reproducir", enabled: Boolean, tag: String, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.height(40.dp).clip(RoundedCornerShape(50)).background(Mm.Acc).alpha(if (enabled) 1f else 0.4f).clickable(enabled = enabled, onClick = onClick).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        Icon(MmIcons.Play, contentDescription = null, tint = Mm.OnAcc, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun PillButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String?, enabled: Boolean, tag: String, busy: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.height(40.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2).alpha(if (enabled) 1f else 0.4f)
            .clickable(enabled = enabled && !busy, onClick = onClick).padding(horizontal = if (label == null) 11.dp else 14.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(16.dp), color = Mm.Tx, strokeWidth = 2.dp)
        else Icon(icon, contentDescription = label ?: "Aleatorio", tint = Mm.Tx, modifier = Modifier.size(if (label == null) 18.dp else 16.dp))
        if (label != null) {
            Spacer(Modifier.width(6.dp))
            Text(label, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/**
 * Fila de canción de un artista o de un disco: número, carátula (si se pide), título y la línea de
 * debajo; a la derecha, el corazón (en el disco) y el menú de siempre.
 */
@Composable
private fun PageTrackRow(
    number: Int,
    track: Track,
    sub: String,
    playing: Boolean,
    withCover: Boolean,
    liked: Boolean?,
    onLike: () -> Unit,
    onClick: () -> Unit,
    onMenu: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 7.dp).testTag("pageRow"), verticalAlignment = Alignment.CenterVertically) {
        Text("$number", color = Mm.Mut, fontSize = 12.sp, textAlign = TextAlign.End, modifier = Modifier.width(22.dp))
        Spacer(Modifier.width(10.dp))
        if (withCover) {
            Cover(track.thumb, 42.dp)
            Spacer(Modifier.width(10.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(track.title, color = if (playing) Mm.Acc else Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub.isNotEmpty()) Text(sub, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (liked != null) {
            Box(Modifier.size(40.dp).clickable(onClick = onLike).testTag("rowLike"), contentAlignment = Alignment.Center) {
                Icon(
                    if (liked) MmIcons.HeartFull else MmIcons.Heart, contentDescription = if (liked) "Quitar de «me gusta»" else "Me gusta",
                    tint = if (liked) Mm.Acc else Mm.Mut, modifier = Modifier.size(20.dp),
                )
            }
        }
        Box(Modifier.size(40.dp).clickable(onClick = onMenu).testTag("rowMenu"), contentAlignment = Alignment.Center) {
            Icon(MmIcons.More, contentDescription = "Más opciones", tint = Mm.Mut, modifier = Modifier.size(20.dp))
        }
    }
}

// --- Pantallas 4 y 5: el artista ------------------------------------------------------------------------

@Composable
fun ArtistScreen(vm: AppViewModel, id: String, state: PlayerState) {
    val page = vm.artistPages[id]
    val listState = rememberLazyListState()
    // Al bajar, arriba queda el nombre del artista para no perderse (pantalla 5 de la maqueta)
    val scrolled by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 } }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        BackBar(vm, if (scrolled) page?.name else null)
        if (page == null) return@Column PageWait(vm.pageErrors["artist:$id"])
        val session = vm.session
        val playingHere = session?.sourceType == "artist" && session.sourceId == id
        val radioBusy = vm.artistRadioStarting == id

        LazyColumn(Modifier.fillMaxSize(), state = listState) {
            item(key = "cabecera") {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    ArtistAvatar(page.thumb, 96.dp)
                    Text(page.name, color = Mm.Tx, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp).testTag("artistName"))
                    Text(page.listeners?.let { "$it de oyentes al mes" } ?: "Artista", color = Mm.Mut, fontSize = 12.sp)
                }
                Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PlayButton(enabled = page.songsCount > 0, tag = "playArtist", modifier = Modifier.weight(1f)) { vm.playArtist(id) }
                    PillButton(MmIcons.Radio, if (radioBusy) "Buscando…" else "Radio", enabled = page.songsCount > 0, tag = "artistRadio", busy = radioBusy) { vm.playArtistRadio(id) }
                }
            }
            item(key = "top") {
                SectionHead("Canciones más escuchadas", if (page.songsCount > 0) "Ver todas · ${page.songsCount}" else null, "allSongs") { vm.open(Overlay.ArtistSongs(id)) }
                if (page.top.isEmpty()) Text("YouTube Music no tiene canciones suyas.", color = Mm.Mut, fontSize = 13.sp)
            }
            itemsIndexed(page.top, key = { index, track -> "top $index ${track.key}" }) { index, track ->
                PageTrackRow(
                    number = index + 1, track = track, sub = featLine(page.name, track), playing = playingHere && state.track?.key == track.key,
                    withCover = true, liked = null, onLike = {}, onClick = { vm.playArtist(id, track.key) },
                    onMenu = { vm.sheet = SheetTarget(track, artistId = id) },
                )
            }
            if (page.albums.isNotEmpty()) {
                item(key = "albumes") {
                    SectionHead("Álbumes", "Ver todos · ${page.albums.size}", "allAlbums") { vm.open(Overlay.Discography(id, "albums")) }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(page.albums.take(12), key = { it.id }) { release -> ReleaseCard(release, 104.dp) { vm.open(Overlay.Album(release.id)) } }
                    }
                }
            }
            if (page.singles.isNotEmpty()) {
                item(key = "sencillos") {
                    SectionHead("Sencillos y EP", "Ver todos · ${page.singles.size}", "allSingles") { vm.open(Overlay.Discography(id, "singles")) }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(page.singles.take(12), key = { it.id }) { release -> ReleaseCard(release, 104.dp) { vm.open(Overlay.Album(release.id)) } }
                    }
                }
            }
            if (page.related.isNotEmpty()) {
                item(key = "parecidos") {
                    SectionLabel("Artistas parecidos")
                    ArtistStrip(page.related) { vm.open(Overlay.Artist(it.id)) }
                }
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }
}

// --- «Ver todas»: todas sus canciones, de la más escuchada a la menos ------------------------------------

@Composable
fun ArtistSongsScreen(vm: AppViewModel, id: String, state: PlayerState) {
    val list = vm.artistSongs[id]
    val page = vm.artistPages[id]
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        BackBar(vm)
        if (list == null) return@Column PageWait(vm.pageErrors["songs:$id"])
        val session = vm.session
        val playingHere = session?.sourceType == "artist" && session.sourceId == id
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "cabecera") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ArtistAvatar(page?.thumb, 76.dp)
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text(list.name, color = Mm.Tx, fontSize = 21.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(listOf(songs(list.count), formatTotal(list.durationSec)).joinToString(" · "), color = Mm.Mut, fontSize = 12.sp)
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PlayButton(enabled = list.count > 0, tag = "playAllSongs", modifier = Modifier.weight(1f)) { vm.playArtist(id) }
                    PillButton(MmIcons.Shuffle, null, enabled = list.count > 0, tag = "shuffleAllSongs") { vm.playArtist(id, shuffle = true) }
                }
            }
            itemsIndexed(list.tracks, key = { index, track -> "$index ${track.key}" }) { index, track ->
                PageTrackRow(
                    number = index + 1, track = track, sub = featLine(list.name, track), playing = playingHere && state.track?.key == track.key,
                    withCover = true, liked = null, onLike = {}, onClick = { vm.playArtist(id, track.key) },
                    onMenu = { vm.sheet = SheetTarget(track, artistId = id) },
                )
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }
}

// --- Pantalla 6: toda la discografía, en dos pestañas ----------------------------------------------------

@Composable
fun DiscographyScreen(vm: AppViewModel, id: String, tab: String) {
    val page = vm.artistPages[id]
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        BackBar(vm, page?.name)
        if (page == null) return@Column PageWait(vm.pageErrors["artist:$id"])
        Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 12.dp).clip(RoundedCornerShape(50)).background(Mm.Sur).padding(3.dp)) {
            for ((value, label) in listOf("albums" to "Álbumes · ${page.albums.size}", "singles" to "Sencillos y EP · ${page.singles.size}")) {
                val on = value == tab
                Box(
                    Modifier.weight(1f).clip(RoundedCornerShape(50)).background(if (on) Mm.Sur2 else Color.Transparent).clickable { vm.discographyTab(value) }
                        .padding(vertical = 7.dp).testTag("tab_$value"),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, color = if (on) Mm.Tx else Mm.Mut, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        val releases = if (tab == "singles") page.singles else page.albums
        if (releases.isEmpty()) return@Column Text("No hay ninguno.", color = Mm.Mut, fontSize = 13.sp)
        LazyVerticalGrid(GridCells.Fixed(2), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxSize()) {
            items(releases, key = { it.id }) { release -> ReleaseCard(release, null) { vm.open(Overlay.Album(release.id)) } }
        }
    }
}

// --- Pantalla 7: el disco --------------------------------------------------------------------------------

@Composable
fun AlbumScreen(vm: AppViewModel, id: String, state: PlayerState) {
    val album = vm.albumPages[id]
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        BackBar(vm)
        if (album == null) return@Column PageWait(vm.pageErrors["album:$id"])
        val session = vm.session
        val playingHere = session?.sourceType == "album" && session.sourceId == id
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "cabecera") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Cover(album.thumb, 96.dp, radius = 12.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            listOfNotNull(kindLabel(album.kind), album.year?.toString()).joinToString(" · ").uppercase(),
                            color = Mm.Mut, fontSize = 10.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
                        )
                        Text(album.title, color = Mm.Tx, fontSize = 19.sp, fontWeight = FontWeight.Bold, lineHeight = 23.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp).testTag("albumTitle"))
                        // El artista se toca y lleva a su página
                        Row(Modifier.padding(top = 3.dp)) {
                            album.artists.forEachIndexed { index, artist ->
                                if (index > 0) Text(", ", color = Mm.Tx, fontSize = 12.5.sp)
                                val artistId = artist.id
                                if (artistId != null) {
                                    Text(artist.name, color = Mm.Tx, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.clickable { vm.open(Overlay.Artist(artistId)) }.testTag("albumArtist"))
                                    Text(" ›", color = Mm.Acc, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
                                } else {
                                    Text(artist.name, color = Mm.Tx, fontSize = 12.5.sp, maxLines = 1)
                                }
                            }
                        }
                        Text(listOf(songs(album.count), formatTotal(album.durationSec)).joinToString(" · "), color = Mm.Mut, fontSize = 11.5.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val enabled = album.tracks.isNotEmpty()
                    PlayButton(enabled = enabled, tag = "playAlbum", modifier = Modifier.weight(1f)) { vm.playAlbum(id) }
                    PillButton(MmIcons.Shuffle, null, enabled = enabled, tag = "shuffleAlbum") { vm.playAlbum(id, shuffle = true) }
                    PillButton(MmIcons.ListAdd, "Guardar", enabled = enabled, tag = "saveAlbum") { vm.saveAlbumFor = album }
                }
                if (album.tracks.isEmpty()) Text("YouTube Music no da canciones de este disco.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp))
            }
            itemsIndexed(album.tracks, key = { index, track -> "$index ${track.key}" }) { index, track ->
                PageTrackRow(
                    number = index + 1, track = track, sub = track.durationSec?.let { formatTime(it * 1000L) }.orEmpty(),
                    playing = playingHere && state.track?.key == track.key, withCover = false,
                    liked = vm.isLiked(track), onLike = { vm.toggleLike(track) },
                    onClick = { vm.playAlbum(id, track.key) },
                    onMenu = { vm.sheet = SheetTarget(track, albumId = id) },
                )
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }
}

/** «Guardar como lista»: el disco pasa a una lista nueva tuya, con su nombre (se puede cambiar aquí). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SaveAlbumSheet(vm: AppViewModel, album: AlbumPage) {
    val initial = album.title.take(80)
    var field by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val close = { vm.saveAlbumFor = null }
    ModalBottomSheet(onDismissRequest = close, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 18.dp).imePadding()) {
            Text("Guardar como lista", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            val what = if (album.count == 1) "Copia la canción" else "Copia las ${album.count} canciones"
            Text("$what del disco a una lista nueva tuya.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
            Text("Nombre", color = Mm.Mut, fontSize = 11.5.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
            OutlinedTextField(
                value = field,
                onValueChange = { field = if (it.text.length <= 80) it else it.copy(text = it.text.take(80)) },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                colors = fieldColors(),
                placeholder = { Text("Nombre", color = Mm.Mut) },
                modifier = Modifier.fillMaxWidth().testTag("saveAlbumName"),
            )
            error?.let { Text(it, color = Mm.Yt, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2).clickable(onClick = close),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Cancelar", color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
                val enabled = field.text.isNotBlank() && !busy
                Box(
                    Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(50)).background(Mm.Acc).alpha(if (enabled) 1f else 0.45f)
                        .clickable(enabled = enabled) {
                            busy = true
                            error = null
                            vm.saveAlbum(album.id, field.text.trim()) { problem ->
                                busy = false
                                error = problem
                            }
                        }.testTag("saveAlbumConfirm"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Mm.OnAcc, strokeWidth = 2.dp)
                    else Text("Guardar", color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/** «Ir al artista» con varios artistas («A, B»): se elige cuál. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtistChoiceSheet(vm: AppViewModel, choice: ArtistChoice) {
    ModalBottomSheet(onDismissRequest = { vm.artistChoice = null }, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 18.dp)) {
            Text("Ir al artista", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(choice.track.title, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, bottom = 8.dp))
            for (artist in choice.artists) {
                Row(
                    Modifier.fillMaxWidth().clickable { vm.openArtist(artist.id) }.padding(vertical = 8.dp).testTag("chooseArtist"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ArtistAvatar(artist.thumb, 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(artist.name, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(artist.listeners?.let { "$it de oyentes al mes" } ?: "Artista", color = Mm.Mut, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}
