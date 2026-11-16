package com.mymusic.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.SheetTarget
import com.mymusic.app.playback.PlayerState
import sh.calvin.reorderable.ReorderableItem
import sh.calvin.reorderable.rememberReorderableLazyListState

/**
 * Pantalla 9 de la maqueta. El orden lo lleva el servidor; aquí se pide de 20 en 20 al bajar.
 * Arrastrar por el asa para reordenar; deslizar una fila para quitarla de la cola.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueScreen(vm: AppViewModel) {
    val listState = rememberLazyListState()
    // Clave de la fila que se está arrastrando
    var dragged by remember { mutableStateOf<String?>(null) }
    val reorder = rememberReorderableLazyListState(listState) { from, to ->
        val a = vm.queue.indexOfFirst { it.track.key == from.key }
        val b = vm.queue.indexOfFirst { it.track.key == to.key }
        if (a >= 1 && b >= 1) vm.queue.add(b, vm.queue.removeAt(a))      // la posición 0 es la que suena: no se mueve
    }

    // Al acercarse al final de lo cargado, pedir las 20 siguientes
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last -> if (last >= listState.layoutInfo.totalItemsCount - 4) vm.loadMoreQueue() }
    }

    Column(Modifier.fillMaxSize().background(Mm.Bg).systemBarsPadding().padding(horizontal = 16.dp).testTag("queue")) {
        Row(Modifier.fillMaxWidth().height(52.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Down, contentDescription = "Cerrar", tint = Mm.Tx, modifier = Modifier.size(24.dp))
            }
            Text("Cola", color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(40.dp))
        }

        val now = vm.queue.firstOrNull()
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item(key = "t-sonando") { SectionLabel("Sonando") }
            if (now != null) {
                item(key = "sonando") { TrackRow(now.track, playing = true, onClick = { vm.back() }) }
            }
            item(key = "t-despues") {
                SectionLabel(listOfNotNull("A continuación", vm.session?.sourceName?.takeIf { it.isNotBlank() }).joinToString(" · "))
            }
            if (vm.queue.size <= 1) {
                item(key = "nada") {
                    val text = if (vm.session?.repeat == "all") "No hay más canciones: al terminar, la lista vuelve a empezar." else "No hay más canciones en la cola."
                    Text(text, color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                }
            }
            items(vm.queue.drop(1), key = { it.track.key }) { entry ->
                ReorderableItem(reorder, key = entry.track.key) { dragging ->
                    // La confirmación puede llegar más de una vez en un mismo gesto: se pide quitar una sola
                    var removed by remember(entry.track.key) { mutableStateOf(false) }
                    val dismiss = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
                        val gone = value != SwipeToDismissBoxValue.Settled
                        if (gone && !removed) {
                            removed = true
                            vm.removeQueued(entry.track.key)
                        }
                        gone
                    })
                    SwipeToDismissBox(state = dismiss, backgroundContent = {}) {
                        TrackRow(
                            entry.track,
                            playing = false,
                            onClick = {},
                            modifier = Modifier.background(if (dragging) Mm.Sur2 else Mm.Bg),
                            trailing = {
                                Box(
                                    Modifier.size(40.dp).draggableHandle(
                                        onDragStarted = { dragged = entry.track.key },
                                        onDragStopped = {
                                            val key = dragged
                                            dragged = null
                                            // Posición nueva en la sesión = la de la canción que suena + el hueco donde se soltó
                                            val place = vm.queue.indexOfFirst { it.track.key == key }
                                            val first = vm.queue.firstOrNull()?.index
                                            if (key != null && place >= 1 && first != null) vm.moveQueued(key, first + place)
                                        },
                                    ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(MmIcons.Drag, contentDescription = "Arrastrar para reordenar", tint = Mm.Mut, modifier = Modifier.size(20.dp))
                                }
                            },
                        )
                    }
                }
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }
}

/** «Ver todo» de Inicio: lo escuchado, lo más reciente primero. */
@Composable
fun HistoryScreen(vm: AppViewModel, state: PlayerState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
            Text("Historial", color = Mm.Tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        if (vm.history.isEmpty()) {
            Text("Todavía no hay nada escuchado.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
        }
        LazyColumn(Modifier.fillMaxSize()) {
            itemsIndexed(vm.history) { _, track ->
                TrackRow(track, playing = state.track?.key == track.key, onClick = { vm.playTrack(track) }, onMenu = { vm.sheet = SheetTarget(track) })
            }
        }
    }
}
