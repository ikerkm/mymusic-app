package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.Overlay
import com.mymusic.app.SheetTarget
import com.mymusic.app.playback.PlayerState

/** Botón de icono del reproductor. Apagado se ve atenuado y no responde. */
@Composable
private fun Control(icon: ImageVector, label: String, tag: String, tint: Color = Mm.Tx, enabled: Boolean = true, size: Int = 24, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp).clip(CircleShape).clickable(enabled = enabled, onClick = onClick).alpha(if (enabled) 1f else 0.3f).testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(size.dp))
    }
}

/** Pantalla 8 de la maqueta. Se abre tocando el minirreproductor. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayerScreen(vm: AppViewModel, state: PlayerState) {
    val track = state.track ?: return
    // La sesión del servidor, si habla de la canción que suena (puede ir un instante por detrás al cambiar)
    val session = vm.session?.takeIf { it.current?.track?.key == track.key }
    // La canción que suena, si la puso la radio y aún no está guardada en una lista
    val fromRadio = session?.current?.track?.takeIf { it.radio }
    var dragging by remember { mutableStateOf<Float?>(null) }
    val duration = state.durationMs.coerceAtLeast(1)
    val fraction = dragging ?: (state.positionMs.toFloat() / duration).coerceIn(0f, 1f)

    Column(
        Modifier
            .fillMaxSize()
            .background(Mm.Bg)
            .systemBarsPadding()
            .padding(horizontal = 24.dp)
            .testTag("player"),
    ) {
        Row(Modifier.fillMaxWidth().height(52.dp), verticalAlignment = Alignment.CenterVertically) {
            Control(MmIcons.Down, "Cerrar", "playerClose") { vm.back() }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Sonando de", color = Mm.Mut, fontSize = 11.sp)
                Text(
                    vm.session?.sourceName?.takeIf { it.isNotBlank() } ?: "Búsqueda",
                    color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Control(MmIcons.More, "Más opciones", "playerMenu", size = 22) { vm.sheet = SheetTarget(track) }
        }

        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            Cover(track.thumb, size = min(maxWidth, maxHeight), radius = 20.dp)
        }

        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(track.title, color = Mm.Tx, fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(track.artist.orEmpty(), color = Mm.Mut, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Spacer(Modifier.width(6.dp))
                    PlatformBadge(track.platform)
                    if (fromRadio != null) Text(" · Radio", color = Mm.Acc, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
            Spacer(Modifier.width(6.dp))
            // Una canción que puso la radio se guarda de un toque en la lista que suena; las demás, eligiendo lista
            Control(MmIcons.ListAdd, "Añadir a una lista", "playerAddToList") { if (fromRadio != null) vm.keepRadioTrack(fromRadio) else vm.pickFor = track }
        }

        if (state.error != null) {
            Text(state.error, color = Mm.Yt, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp).testTag("playerError"))
        }

        Slider(
            value = fraction,
            onValueChange = { dragging = it },
            onValueChangeFinished = {
                dragging?.let { vm.player.seekTo((it * duration).toLong()) }
                dragging = null
            },
            enabled = state.durationMs > 0,
            // Como en la maqueta: barra fina con un punto blanco
            thumb = { Box(Modifier.size(14.dp).clip(CircleShape).background(Mm.Tx)) },
            track = {
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2)) {
                    Box(Modifier.fillMaxWidth(fraction).height(4.dp).background(Mm.Acc))
                }
            },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("seek"),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatTime((fraction * duration).toLong()), color = Mm.Mut, fontSize = 11.sp)
            Text(if (state.durationMs > 0) formatTime(state.durationMs) else "–:––", color = Mm.Mut, fontSize = 11.sp)
        }

        Row(
            Modifier.fillMaxWidth().padding(top = 6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Control(MmIcons.Shuffle, "Aleatorio", "shuffle", tint = if (vm.session?.shuffle == true) Mm.Acc else Mm.Tx) { vm.toggleShuffle() }
            Control(MmIcons.Prev, "Anterior", "prev") { vm.player.previous() }
            Box(
                Modifier.size(64.dp).clip(CircleShape).background(Mm.Acc).clickable { vm.player.toggle() }.testTag("playPause"),
                contentAlignment = Alignment.Center,
            ) {
                if (state.isLoading && state.error == null) {
                    CircularProgressIndicator(Modifier.size(28.dp), color = Mm.OnAcc, strokeWidth = 3.dp)
                } else {
                    Icon(if (state.wantsToPlay) MmIcons.Pause else MmIcons.Play, contentDescription = if (state.wantsToPlay) "Pausar" else "Reproducir", tint = Mm.OnAcc, modifier = Modifier.size(28.dp))
                }
            }
            Control(MmIcons.Next, "Siguiente", "next", enabled = state.hasNext) { vm.player.next() }
            // Repetir: apagado → toda la lista → esta canción (con un «1»)
            val repeat = vm.session?.repeat ?: "off"
            Box(contentAlignment = Alignment.Center) {
                Control(MmIcons.Repeat, "Repetir", "repeat", tint = if (repeat == "off") Mm.Tx else Mm.Acc) { vm.cycleRepeat() }
                if (repeat == "one") Text("1", color = Mm.Acc, fontSize = 9.sp, fontWeight = FontWeight.Bold)
            }
        }

        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Mm.Sur2).clickable { vm.open(Overlay.Queue) }.padding(horizontal = 14.dp, vertical = 9.dp).testTag("openQueue"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(MmIcons.Queue, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Cola", color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.width(8.dp))
            RadioCheck(vm)
            Spacer(Modifier.weight(1f))
            val status = when {
                state.isLoading && state.error == null && state.positionMs == 0L -> "Preparando la canción…"
                session?.current != null -> "${session.current.index + 1} de ${session.count}"
                else -> ""
            }
            Text(status, color = Mm.Mut, fontSize = 12.sp)
        }
    }
}
