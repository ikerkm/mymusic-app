package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import com.mymusic.app.ImportState
import com.mymusic.app.data.ListSummary
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.SheetTarget
import com.mymusic.app.data.Track

/**
 * Una hoja inferior es una ventana aparte. En Android 10+ el sistema le pone una franja clara detrás
 * de los botones de navegación para darles contraste; aquí sobra, porque la hoja ya es oscura.
 */
@Composable
internal fun SheetWindowFix() {
    val view = LocalView.current
    SideEffect {
        val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    }
}

@Composable
private fun Option(icon: ImageVector, label: String, tag: String = "", tint: Color = Mm.Mut, note: String? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 13.dp, horizontal = 2.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, color = Mm.Tx, fontSize = 14.sp, modifier = Modifier.weight(1f))
        // A la derecha, el dato de la opción («Ir al artista» → su nombre)
        if (note != null) Text(note, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
    }
}

/**
 * El nombre que se enseña junto a «Ir al artista». En YouTube el campo es el canal, que no siempre es el
 * artista (un canal de letras): ahí solo se enseña si el título lo nombra o es un canal «X - Topic».
 */
fun artistShown(track: Track): String? {
    val raw = track.artist.orEmpty()
    val name = raw.replace(Regex("\\s+-\\s+topic$", RegexOption.IGNORE_CASE), "").replace(Regex("\\s*vevo$", RegexOption.IGNORE_CASE), "")
        .replace(Regex("\\s+(official|oficial)$", RegexOption.IGNORE_CASE), "").trim()
    if (name.isEmpty()) return null
    if (track.platform != "youtube" || Regex("\\s-\\s+topic$", RegexOption.IGNORE_CASE).containsMatchIn(raw)) return name
    return if (track.title.contains(name, ignoreCase = true)) name else null
}

/**
 * Pantalla 4 de la maqueta: el menú de una canción, el mismo en toda la app.
 * «Quitar de la lista» y «Cambiar coincidencia» solo salen dentro de una lista normal: en una lista
 * automática (`autoKind`) no, porque esa lista no se toca a mano.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackSheet(vm: AppViewModel, target: SheetTarget) {
    val track = target.track
    val close = { vm.sheet = null }
    ModalBottomSheet(onDismissRequest = close, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Row(Modifier.padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Cover(track.thumb, 42.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(track.title, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val detail = listOfNotNull(track.artist, track.durationSec?.let { formatTime(it * 1000L) }).joinToString(" · ")
                        Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Spacer(Modifier.width(6.dp))
                        PlatformBadge(track.platform)
                    }
                }
            }
            Option(MmIcons.Play, "Reproducir ahora", "optPlay") {
                close()
                when {
                    target.listId != null -> vm.playList(target.listId, startKey = track.key)
                    target.autoKind != null -> vm.playAuto(target.autoKind, startKey = track.key)
                    target.albumId != null -> vm.playAlbum(target.albumId, startKey = track.key)
                    target.artistId != null -> vm.playArtist(target.artistId, startKey = track.key)
                    else -> vm.playTrack(track)
                }
            }
            Option(MmIcons.Next, "A continuación", "optNext") {
                close()
                vm.playNext(track)
            }
            Option(MmIcons.Queue, "Añadir a la cola", "optQueue") {
                close()
                vm.addToQueue(track)
            }
            // «Me gusta», justo encima de «Añadir a una lista…»; si ya está, ofrece quitarla
            val liked = vm.isLiked(track)
            Option(if (liked) MmIcons.HeartFull else MmIcons.Heart, if (liked) "Quitar de «me gusta»" else "Me gusta", "optLike", tint = if (liked) Mm.Acc else Mm.Mut) {
                close()
                vm.setLike(track, !liked)
            }
            Option(MmIcons.ListAdd, "Añadir a una lista…", "optAddToList") {
                close()
                vm.pickFor = track
            }
            // «Ir al artista» (§18), debajo de «Añadir a una lista…»; con varios artistas («A, B») se elige después
            if (!track.artist.isNullOrBlank()) {
                val several = track.artist.contains(',')
                Option(MmIcons.User, if (several) "Ir al artista…" else "Ir al artista", "optArtist", note = if (several) null else artistShown(track)) {
                    close()
                    vm.goArtistOf(track)
                }
            }
            if (target.listId != null) {
                HorizontalDivider(color = Mm.Line, modifier = Modifier.padding(vertical = 4.dp))
                if (track.platform == "spotify") {
                    Option(MmIcons.Swap, "Cambiar coincidencia", "optMatch") {
                        close()
                        vm.openMatch(track)
                    }
                }
                Option(MmIcons.Bin, "Quitar de la lista", "optRemove") {
                    close()
                    vm.removeFromList(target.listId, track)
                }
            }
        }
    }
}

/**
 * Pantalla 7 de la maqueta: importar a una lista. Se pega el enlace de una playlist de Spotify o
 * YouTube, la app enseña qué trae y cuántas ya estaban, y al confirmar se añaden sin duplicar.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportSheet(vm: AppViewModel, list: ListSummary) {
    var link by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val state = vm.importState
    val read = {
        keyboard?.hide()
        if (link.isNotBlank()) vm.previewImport(link)
    }
    ModalBottomSheet(onDismissRequest = { vm.closeImport() }, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 18.dp).imePadding()) {
            Text("Importar a «${list.name}»", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text("Enlace de una lista de Spotify, YouTube o SoundCloud", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp, bottom = 5.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it.take(400) },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    colors = fieldColors(),
                    placeholder = { Text("https://…", color = Mm.Mut) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { read() }),
                    modifier = Modifier.weight(1f).testTag("importLink"),
                )
                Spacer(Modifier.width(8.dp))
                // Lo normal es venir de copiar el enlace en Spotify o YouTube: un toque lo pega y lo lee
                Text(
                    "Pegar", color = Mm.Acc, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clip(RoundedCornerShape(50)).clickable {
                        clipboard.getText()?.text?.trim()?.takeIf { it.isNotEmpty() }?.let {
                            link = it.take(400)
                            read()
                        }
                    }.padding(horizontal = 10.dp, vertical = 10.dp).testTag("importPaste"),
                )
            }

            when (state) {
                ImportState.Idle -> Text(
                    "Pega el enlace y verás qué trae antes de añadir nada.",
                    color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp),
                )
                ImportState.Reading -> Row(Modifier.padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = Mm.Acc, strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Leyendo la lista…", color = Mm.Mut, fontSize = 13.sp)
                }
                is ImportState.Failed -> Text(state.message, color = Mm.Yt, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp).testTag("importError"))
                is ImportState.Ready, is ImportState.Adding -> {
                    val preview = if (state is ImportState.Ready) state.preview else (state as ImportState.Adding).preview
                    val adding = state is ImportState.Adding
                    Row(
                        Modifier.padding(top = 12.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Mm.Sur2).padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Cover(preview.thumb, 48.dp, 10.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(preview.title, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(songs(preview.count), color = Mm.Mut, fontSize = 12.sp)
                                Spacer(Modifier.width(6.dp))
                                PlatformBadge(preview.platform)
                            }
                        }
                    }
                    Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.Bottom) {
                        Text("${preview.newCount}", color = Mm.Ok, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                        Text(if (preview.newCount == 1) " nueva" else " nuevas", color = Mm.Tx, fontSize = 13.sp, modifier = Modifier.padding(bottom = 2.dp))
                        Spacer(Modifier.width(18.dp))
                        Text("${preview.already}", color = Mm.Mut, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                        Text(if (preview.already == 1) " ya está en tu lista" else " ya están en tu lista", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(bottom = 2.dp))
                    }
                    val enabled = preview.newCount > 0 && !adding
                    Box(
                        Modifier.padding(top = 14.dp).fillMaxWidth().height(46.dp).clip(RoundedCornerShape(50)).background(Mm.Acc)
                            .alpha(if (enabled) 1f else 0.45f).clickable(enabled = enabled) { vm.confirmImport() }.testTag("importConfirm"),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (adding) {
                            CircularProgressIndicator(Modifier.size(20.dp), color = Mm.OnAcc, strokeWidth = 2.dp)
                        } else {
                            val label = when (preview.newCount) {
                                0 -> "Ya las tienes todas"
                                1 -> "Añadir 1 canción"
                                else -> "Añadir ${preview.newCount} canciones"
                            }
                            Text(label, color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    val notes = listOfNotNull(
                        "Las canciones de Spotify se buscan en YouTube la primera vez que suenan.".takeIf { preview.platform == "spotify" },
                        // Spotify y SoundCloud solo se dejan leer hasta 100 canciones por lista
                        "De esta lista solo se pueden leer las 100 primeras canciones.".takeIf { preview.truncated },
                    )
                    if (notes.isNotEmpty()) {
                        Text(notes.joinToString(" "), color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
                    }
                }
            }
        }
    }
}

/**
 * «Cambiar coincidencia»: los vídeos de YouTube candidatos para una canción venida de Spotify.
 * Tocar uno lo deja elegido; la marca «≈ automática» desaparece de esa canción.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MatchSheet(vm: AppViewModel, track: Track) {
    val info = vm.matchInfo
    ModalBottomSheet(onDismissRequest = { vm.closeMatch() }, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Text("Cambiar coincidencia", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            val wanted = listOfNotNull(track.title, track.artist, track.durationSec?.let { formatTime(it * 1000L) }).joinToString(" · ")
            Text(wanted, color = Mm.Mut, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, bottom = 8.dp))
            when {
                info == null -> Row(Modifier.padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = Mm.Acc, strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Buscando en YouTube…", color = Mm.Mut, fontSize = 13.sp)
                }
                info.candidates.isEmpty() -> Text("No he encontrado nada parecido en YouTube.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(vertical = 12.dp))
                else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(info.candidates, key = { it.track.key }) { candidate ->
                        val current = candidate.track.key == info.currentKey
                        Row(
                            Modifier.fillMaxWidth().clickable { vm.chooseMatch(candidate.track) }.padding(vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Cover(candidate.track.thumb, 42.dp)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(candidate.track.title, color = if (current) Mm.Acc else Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                val detail = listOfNotNull(candidate.track.artist, candidate.track.durationSec?.let { formatTime(it * 1000L) }).joinToString(" · ")
                                Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (current) {
                                Text(if (info.auto) "Actual (automática)" else "Actual", color = Mm.Acc, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 8.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Elegir a qué lista se añade una canción, o crear una nueva en el momento. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListPickerSheet(vm: AppViewModel, track: Track) {
    var creating by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = { vm.pickFor = null }, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Text("Añadir a una lista", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 8.dp))
            LazyColumn(Modifier.heightIn(max = 340.dp)) {
                items(vm.lists, key = { it.id }) { list ->
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            vm.pickFor = null
                            vm.addToList(list, track)
                        }.padding(vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ListCover(list, 40.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(list.name, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(songs(list.count), color = Mm.Mut, fontSize = 12.sp)
                        }
                    }
                }
            }
            Option(MmIcons.Plus, "Nueva lista…", "optNewList") { creating = true }
        }
    }
    if (creating) {
        NameDialog("Nueva lista", "", "Crear y añadir", onDismiss = { creating = false }) {
            creating = false
            vm.pickFor = null
            vm.createList(it, thenAdd = track)
        }
    }
}
