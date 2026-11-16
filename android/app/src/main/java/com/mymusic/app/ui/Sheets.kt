package com.mymusic.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
private fun SheetWindowFix() {
    val view = LocalView.current
    SideEffect {
        val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    }
}

@Composable
private fun Option(icon: ImageVector, label: String, tag: String = "", onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 13.dp, horizontal = 2.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = Mm.Mut, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, color = Mm.Tx, fontSize = 14.sp)
    }
}

/**
 * Pantalla 4 de la maqueta: el menú de una canción, el mismo en toda la app.
 * «Quitar de la lista» solo sale dentro de una lista. «Cambiar coincidencia» llega en la Fase 3.
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
                if (target.listId != null) vm.playList(target.listId, startKey = track.key) else vm.playTrack(track)
            }
            Option(MmIcons.Next, "A continuación", "optNext") {
                close()
                vm.playNext(track)
            }
            Option(MmIcons.Queue, "Añadir a la cola", "optQueue") {
                close()
                vm.addToQueue(track)
            }
            Option(MmIcons.ListAdd, "Añadir a una lista…", "optAddToList") {
                close()
                vm.pickFor = track
            }
            if (target.listId != null) {
                HorizontalDivider(color = Mm.Line, modifier = Modifier.padding(vertical = 4.dp))
                Option(MmIcons.Bin, "Quitar de la lista", "optRemove") {
                    close()
                    vm.removeFromList(target.listId, track)
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
                        Cover(list.thumb, 40.dp)
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
