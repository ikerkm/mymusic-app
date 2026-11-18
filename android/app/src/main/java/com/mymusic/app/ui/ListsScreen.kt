package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.Overlay
import com.mymusic.app.SheetTarget
import com.mymusic.app.data.ListSummary
import com.mymusic.app.playback.PlayerState
import sh.calvin.reorderable.ReorderableItem
import sh.calvin.reorderable.rememberReorderableLazyListState

private fun ListSummary.detail() = if (count == 0) "Vacía" else "${songs(count)} · ${formatTotal(durationSec)}"

/** Diálogo para poner o cambiar el nombre de una lista. */
@Composable
fun NameDialog(title: String, initial: String, confirm: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    // El cursor empieza al final del nombre, para corregirlo o seguir escribiendo
    var field by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    val name = field.text
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Mm.Sur,
        titleContentColor = Mm.Tx,
        title = { Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            OutlinedTextField(
                value = field,
                onValueChange = { field = if (it.text.length <= 80) it else it.copy(text = it.text.take(80)) },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                colors = fieldColors(),
                placeholder = { Text("Nombre", color = Mm.Mut) },
                modifier = Modifier.fillMaxWidth().testTag("listName"),
            )
        },
        confirmButton = { TextButton(onClick = { onConfirm(name.trim()) }, enabled = name.isNotBlank()) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar", color = Mm.Mut) } },
    )
}

/** Menú de los tres puntos de una lista: renombrar o mandar a la papelera. */
@Composable
private fun ListMenu(onRename: () -> Unit, onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Box(Modifier.size(40.dp).clickable { open = true }, contentAlignment = Alignment.Center) {
            Icon(MmIcons.More, contentDescription = "Opciones de la lista", tint = Mm.Mut, modifier = Modifier.size(20.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = Mm.Sur2) {
            DropdownMenuItem(text = { Text("Renombrar", color = Mm.Tx) }, onClick = { open = false; onRename() })
            DropdownMenuItem(text = { Text("Mandar a la papelera", color = Mm.Tx) }, onClick = { open = false; onDelete() })
        }
    }
}

/** Pantalla 5 de la maqueta: tus listas y «Nueva lista». */
@Composable
fun ListsScreen(vm: AppViewModel) {
    var creating by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<ListSummary?>(null) }

    // Artistas que sigues (§21): con un servidor que sabe seguir, dos pestañas
    val withArtists = vm.follows != null
    if (withArtists && vm.listsTab == "artists") return FollowsTab(vm)
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            item { ScreenTitle("Listas") }
            if (withArtists) item { ListsTabs(vm) }
            if (vm.lists.isEmpty()) {
                item { Text("Todavía no tienes listas. Crea la primera con «Nueva lista».", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
            }
            items(vm.lists, key = { it.id }) { list ->
                Row(
                    Modifier.fillMaxWidth().clickable { vm.open(Overlay.ListDetail(list.id)) }.padding(vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ListCover(list, 48.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(list.name, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(list.detail(), color = Mm.Mut, fontSize = 12.sp)
                    }
                    ListMenu(onRename = { renaming = list }, onDelete = { vm.deleteList(list.id) })
                }
            }
            item { Spacer(Modifier.height(84.dp)) }
        }

        Row(
            Modifier.align(Alignment.BottomEnd).padding(16.dp).clip(RoundedCornerShape(16.dp)).background(Mm.Acc)
                .clickable { creating = true }.height(48.dp).padding(start = 12.dp, end = 16.dp).testTag("newList"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(MmIcons.Plus, contentDescription = null, tint = Mm.OnAcc, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(6.dp))
            Text("Nueva lista", color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
    }

    if (creating) {
        NameDialog("Nueva lista", "", "Crear", onDismiss = { creating = false }) {
            creating = false
            vm.createList(it)
        }
    }
    renaming?.let { list ->
        NameDialog("Renombrar lista", list.name, "Guardar", onDismiss = { renaming = null }) {
            renaming = null
            vm.renameList(list.id, it)
        }
    }
}

/** Pantalla 6 de la maqueta: dentro de una lista. Mantener pulsada una fila para reordenar. */
@Composable
fun ListDetailScreen(vm: AppViewModel, id: String, state: PlayerState) {
    val detail = vm.openList?.takeIf { it.summary.id == id }
    var renaming by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.weight(1f))
            ListMenu(onRename = { renaming = true }, onDelete = { vm.deleteList(id) })
        }

        if (detail == null) {
            Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
            }
            return@Column
        }

        // Copia local para que la fila siga al dedo mientras se arrastra; al soltar se guarda en el servidor
        var tracks by remember(detail) { mutableStateOf(detail.tracks) }
        val listState = rememberLazyListState()
        val reorder = rememberReorderableLazyListState(listState) { from, to ->
            val a = tracks.indexOfFirst { it.key == from.key }
            val b = tracks.indexOfFirst { it.key == to.key }
            if (a >= 0 && b >= 0) tracks = tracks.toMutableList().apply { add(b, removeAt(a)) }
        }
        val playingHere = vm.session?.sourceId == id

        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item(key = "cabecera") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ListCover(detail.summary, 76.dp, 14.dp)
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text(detail.summary.name, color = Mm.Tx, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(detail.summary.detail(), color = Mm.Mut, fontSize = 12.sp)
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val enabled = tracks.isNotEmpty()
                    Row(
                        Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(50)).background(Mm.Acc).alpha(if (enabled) 1f else 0.4f)
                            .clickable(enabled = enabled) { vm.playList(id) }.testTag("playList"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
                    ) {
                        Icon(MmIcons.Play, contentDescription = null, tint = Mm.OnAcc, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Reproducir", color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Box(
                        Modifier.size(40.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2).alpha(if (enabled) 1f else 0.4f)
                            .clickable(enabled = enabled) { vm.playList(id, shuffle = true) }.testTag("shuffleList"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(MmIcons.Shuffle, contentDescription = "Aleatorio", tint = Mm.Tx, modifier = Modifier.size(18.dp))
                    }
                    // Importar: pegar el enlace de una playlist de Spotify o YouTube y traer sus canciones a esta lista
                    Row(
                        Modifier.height(40.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2)
                            .clickable { vm.openImport(detail.summary) }.padding(horizontal = 14.dp).testTag("import"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(MmIcons.Import, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Importar", color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                    // Radio: al acabarse la lista, seguir con canciones parecidas que no estén en ella
                    RadioCheck(vm)
                }
            }

            if (tracks.isEmpty()) {
                item(key = "vacia") {
                    Text(
                        "Esta lista está vacía. Añade canciones desde Buscar, con los tres puntos de cada una.",
                        color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }

            itemsIndexed(tracks, key = { _, track -> track.key }) { index, track ->
                ReorderableItem(reorder, key = track.key) { dragging ->
                    TrackRow(
                        track,
                        playing = playingHere && state.track?.key == track.key,
                        onClick = { vm.playList(id, startKey = track.key) },
                        number = index + 1,
                        onMenu = { vm.sheet = SheetTarget(track, id) },
                        // Canción venida de Spotify cuya versión eligió (o elegirá) el servidor: se cambia desde su menú
                        note = if (track.platform == "spotify" && track.match != "manual") "≈ automática" else null,
                        modifier = Modifier
                            .longPressDraggableHandle(onDragStopped = {
                                vm.moveInList(id, track.key, tracks.indexOfFirst { it.key == track.key })
                            })
                            .background(if (dragging) Mm.Sur2 else Color.Transparent),
                    )
                }
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }

    if (renaming && detail != null) {
        NameDialog("Renombrar lista", detail.summary.name, "Guardar", onDismiss = { renaming = false }) {
            renaming = false
            vm.renameList(id, it)
        }
    }
}
