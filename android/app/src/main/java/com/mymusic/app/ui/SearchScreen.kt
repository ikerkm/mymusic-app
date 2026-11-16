package com.mymusic.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.SheetTarget
import com.mymusic.app.data.Track

@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Mm.Tx, modifier = Modifier.weight(1f))
        trailing()
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        color = Mm.Mut,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.7.sp,
        modifier = Modifier.padding(top = 14.dp, bottom = 6.dp),
    )
}

/**
 * Fila de canción: carátula, título, «artista · duración» con la etiqueta de plataforma, y el menú.
 * @param number  si se da, se muestra el número de orden en vez de la carátula (dentro de una lista)
 * @param onMenu  abre el menú de la canción (pantalla 4 de la maqueta); null = sin menú
 * @param trailing  contenido al final en lugar del menú (p. ej. el asa de arrastre en la cola)
 */
@Composable
fun TrackRow(
    track: Track,
    playing: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    number: Int? = null,
    onMenu: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (number != null) {
            Text("$number", color = Mm.Mut, fontSize = 12.sp, textAlign = TextAlign.End, modifier = Modifier.width(26.dp))
        } else {
            Cover(track.thumb, 42.dp)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                track.title,
                color = if (playing) Mm.Acc else Mm.Tx,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                val detail = listOfNotNull(track.artist, track.durationSec?.let { formatTime(it * 1000L) }).joinToString(" · ")
                Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(6.dp))
                PlatformBadge(track.platform)
            }
        }
        if (trailing != null) {
            trailing()
        } else if (onMenu != null) {
            Box(Modifier.size(40.dp).clickable(onClick = onMenu), contentAlignment = Alignment.Center) {
                Icon(MmIcons.More, contentDescription = "Más opciones", tint = Mm.Mut, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** Pantalla 3 de la maqueta: un solo campo, resultados debajo; tocar uno lo reproduce. */
@Composable
fun SearchScreen(vm: AppViewModel, playingKey: String?, modifier: Modifier = Modifier) {
    val keyboard = LocalSoftwareKeyboardController.current
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenTitle("Buscar")
        OutlinedTextField(
            value = vm.query,
            onValueChange = { vm.query = it },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
            leadingIcon = { Icon(MmIcons.Search, contentDescription = null, tint = Mm.Mut, modifier = Modifier.size(18.dp)) },
            placeholder = { Text("Canción, artista…", color = Mm.Mut) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                keyboard?.hide()
                vm.search()
            }),
            modifier = Modifier.fillMaxWidth().testTag("query"),
        )

        when {
            vm.searching -> Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
            }
            vm.searchError != null -> Text(vm.searchError.orEmpty(), color = Mm.Yt, fontSize = 13.sp, modifier = Modifier.padding(top = 16.dp))
            !vm.searched -> Text(
                // En la Fase 1 solo se busca por texto; pegar enlaces llega en la Fase 3
                "Escribe el nombre de una canción o de un artista.",
                color = Mm.Mut,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
            vm.results.isEmpty() -> Text("Sin resultados.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 16.dp))
            else -> {
                SectionLabel("Resultados")
                LazyColumn(Modifier.fillMaxSize()) {
                    items(vm.results, key = { it.key }) { track ->
                        TrackRow(
                            track,
                            playing = track.key == playingKey,
                            onClick = {
                                keyboard?.hide()
                                vm.playTrack(track)
                            },
                            onMenu = { vm.sheet = SheetTarget(track) },
                        )
                    }
                }
            }
        }
    }
}
