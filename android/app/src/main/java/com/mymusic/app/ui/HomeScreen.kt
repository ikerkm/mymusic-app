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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.Overlay
import com.mymusic.app.SheetTarget
import com.mymusic.app.data.ListSummary
import com.mymusic.app.playback.PlayerState

/** Pantalla 2 de la maqueta: «Continuar», tus listas y lo escuchado hace poco. */
@Composable
fun HomeScreen(vm: AppViewModel, state: PlayerState) {
    val session = vm.session
    val current = session?.current
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        item {
            ScreenTitle("Inicio") {
                // Ajustes llega en la Fase 4
                Icon(MmIcons.Settings, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(22.dp).alpha(0.35f))
            }
        }

        if (session != null && current != null) {
            item {
                SectionLabel("Continuar")
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Mm.Sur).clickable { vm.resume() }.padding(12.dp).testTag("continue"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Cover(current.track.thumb, 52.dp, 10.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(session.sourceName, color = Mm.Tx, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        // Si es lo que está sonando, el minuto es el del reproductor; si no, el que guardó el servidor
                        val position = if (state.track?.key == current.track.key) state.positionMs else session.positionMs
                        Text(
                            "Canción ${current.index + 1} de ${session.count} · ${formatTime(position)}",
                            color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Box(Modifier.size(38.dp).clip(CircleShape).background(Mm.Acc), contentAlignment = Alignment.Center) {
                        Icon(MmIcons.Play, contentDescription = "Continuar", tint = Mm.OnAcc, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }

        if (vm.lists.isNotEmpty()) {
            item { SectionLabel("Tus listas") }
            items(vm.lists.take(4).chunked(2)) { pair ->
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (list in pair) ListTile(list, Modifier.weight(1f)) { vm.open(Overlay.ListDetail(list.id)) }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }

        if (vm.recent.isNotEmpty()) {
            item {
                Row(verticalAlignment = Alignment.Bottom) {
                    Box(Modifier.weight(1f)) { SectionLabel("Escuchado hace poco") }
                    Text(
                        "Ver todo", color = Mm.Acc, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.clickable { vm.open(Overlay.History) }.padding(bottom = 6.dp, start = 12.dp, top = 12.dp),
                    )
                }
            }
            items(vm.recent, key = { it.key }) { track ->
                TrackRow(track, playing = state.track?.key == track.key, onClick = { vm.playTrack(track) }, onMenu = { vm.sheet = SheetTarget(track) })
            }
        }

        if (session == null && vm.lists.isEmpty() && vm.recent.isEmpty()) {
            item {
                Text(
                    "Aquí verás lo último que escuchaste y tus listas. Empieza por Buscar.",
                    color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
private fun ListTile(list: ListSummary, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.clip(RoundedCornerShape(10.dp)).background(Mm.Sur).clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Cover(list.thumb, 46.dp, radius = 0.dp)
        Text(
            list.name, color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
    }
}
