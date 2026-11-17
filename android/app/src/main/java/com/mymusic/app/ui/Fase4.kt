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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.data.TrashedTrack
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Fase 4: la casilla «Radio», «Tu radio» en Inicio y la papelera.

/**
 * Casilla «Radio»: al acabarse lo que suena, seguir con canciones parecidas que no estén ya en la lista.
 * Es del usuario (no de la sesión) y se recuerda en el servidor: marcarla aquí la marca también en el panel web.
 */
@Composable
fun RadioCheck(vm: AppViewModel, modifier: Modifier = Modifier) {
    Row(
        modifier
            .height(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .toggleable(value = vm.radioOn, role = Role.Checkbox, onValueChange = { vm.setRadio(it) })
            .padding(horizontal = 4.dp)
            .testTag("radioCheck"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(
            checked = vm.radioOn,
            onCheckedChange = null,
            colors = CheckboxDefaults.colors(checkedColor = Mm.Acc, uncheckedColor = Mm.Mut, checkmarkColor = Mm.OnAcc),
        )
        Spacer(Modifier.width(6.dp))
        Text("Radio", color = if (vm.radioOn) Mm.Tx else Mm.Mut, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/** «Tu radio» en Inicio: empieza una sesión de canciones parecidas a lo que el usuario escucha. */
@Composable
fun RadioCard(vm: AppViewModel) {
    Row(
        Modifier
            .padding(top = 10.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Mm.Sur)
            .clickable(enabled = !vm.radioStarting) { vm.playHomeRadio() }
            .padding(12.dp)
            .testTag("homeRadio"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(52.dp).clip(RoundedCornerShape(10.dp)).background(Mm.Sur2), contentAlignment = Alignment.Center) {
            Icon(MmIcons.Radio, contentDescription = null, tint = Mm.Acc, modifier = Modifier.size(24.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Tu radio", color = Mm.Tx, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(
                if (vm.radioStarting) "Buscando canciones parecidas…" else "Parecidas a lo que escuchas",
                color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(38.dp).clip(CircleShape).background(Mm.Sur2), contentAlignment = Alignment.Center) {
            if (vm.radioStarting) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Mm.Tx, strokeWidth = 2.dp)
            } else {
                Icon(MmIcons.Play, contentDescription = "Escuchar tu radio", tint = Mm.Tx, modifier = Modifier.size(16.dp))
            }
        }
    }
}

private val shortDate = DateTimeFormatter.ofPattern("d MMM", Locale("es", "ES"))

/** «2026-11-17T08:01:00.000Z» → «17 nov» */
private fun dayOf(iso: String?): String? =
    runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()).format(shortDate).trimEnd('.') }.getOrNull()

@Composable
private fun TrashRow(thumb: String?, title: String, detail: String, action: String, tag: String, onRestore: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Cover(thumb, 42.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            action, color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(Mm.Sur2).clickable(onClick = onRestore).padding(horizontal = 14.dp, vertical = 9.dp).testTag(tag),
        )
    }
}

/**
 * Papelera (pantalla 11 de la maqueta, «Tus datos»): lo que se ha quitado, listas y canciones, se puede
 * devolver a su sitio. No hay «vaciar»: en el servidor nada se borra.
 */
@Composable
fun TrashScreen(vm: AppViewModel) {
    val trash = vm.trash
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("trash")) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
            Text("Papelera", color = Mm.Tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        Text("Aquí queda lo que quitas: listas y canciones. Nada se borra, y se puede devolver a su sitio.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp))
        when {
            trash == null -> Text("Cargando…", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            trash.lists.isEmpty() && trash.tracks.isEmpty() -> Text("La papelera está vacía.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(trash.lists, key = { "lista:" + it.id }) { item ->
                    val detail = listOfNotNull("Lista", if (item.count == 1) "1 canción" else "${item.count} canciones", dayOf(item.removedAt)?.let { "quitada el $it" }).joinToString(" · ")
                    TrashRow(item.thumb, item.name, detail, "Restaurar", "restoreList") { vm.restoreList(item) }
                }
                items(trash.tracks, key = { "cancion:" + it.id }) { item ->
                    val detail = listOfNotNull(item.track.artist, item.listName?.let { "de «$it»" }, dayOf(item.removedAt)).joinToString(" · ")
                    // Si su lista ya no existe, se elige a cuál va
                    if (item.listId != null) TrashRow(item.track.thumb, item.track.title, detail, "Restaurar", "restoreTrack") { vm.restoreTrack(item) }
                    else TrashRow(item.track.thumb, item.track.title, detail, "Restaurar en…", "restoreTrackIn") { vm.restoreFor = item }
                }
                item(key = "fin") { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

/** La lista de una canción quitada ya no existe: se elige en cuál de las actuales se pone. */
@Composable
fun RestorePicker(vm: AppViewModel, item: TrashedTrack) {
    AlertDialog(
        onDismissRequest = { vm.restoreFor = null },
        containerColor = Mm.Sur,
        titleContentColor = Mm.Tx,
        title = { Text("Restaurar en…", fontSize = 18.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(item.track.title, color = Mm.Mut, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 8.dp))
                if (vm.lists.isEmpty()) Text("Crea antes una lista donde ponerla.", color = Mm.Mut, fontSize = 13.sp)
                for (list in vm.lists) {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { vm.restoreTrack(item, list.id) }.padding(vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Cover(list.thumb, 38.dp)
                        Spacer(Modifier.width(10.dp))
                        Text(list.name, color = Mm.Tx, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = { vm.restoreFor = null }) { Text("Cancelar", color = Mm.Mut) } },
    )
}
