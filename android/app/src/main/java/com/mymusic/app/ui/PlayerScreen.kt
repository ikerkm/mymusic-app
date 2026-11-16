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
import androidx.compose.material3.Icon
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import com.mymusic.app.playback.PlayerState

// Controles que la maqueta enseña pero que dependen de la cola (Fase 2): se ven, apagados
@Composable
private fun Later(icon: ImageVector, size: Int = 24) {
    Icon(icon, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(size.dp).alpha(0.3f))
}

/** Pantalla 8 de la maqueta. Se abre tocando el minirreproductor. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayerScreen(state: PlayerState, onClose: () -> Unit, onToggle: () -> Unit, onSeek: (Long) -> Unit) {
    val track = state.track ?: return
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
            Icon(MmIcons.Down, contentDescription = "Cerrar", tint = Mm.Tx, modifier = Modifier.size(24.dp).clickable(onClick = onClose))
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Sonando de", color = Mm.Mut, fontSize = 11.sp)
                Text("Búsqueda", color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Later(MmIcons.More, 22)
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
                }
            }
            Spacer(Modifier.width(10.dp))
            Later(MmIcons.ListAdd)
        }

        if (state.error != null) {
            Text(state.error, color = Mm.Yt, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp).testTag("playerError"))
        }

        Slider(
            value = fraction,
            onValueChange = { dragging = it },
            onValueChangeFinished = {
                dragging?.let { onSeek((it * duration).toLong()) }
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
            Modifier.fillMaxWidth().padding(top = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Later(MmIcons.Shuffle)
            Later(MmIcons.Prev)
            Box(
                Modifier.size(64.dp).clip(CircleShape).background(Mm.Acc).clickable(onClick = onToggle).testTag("playPause"),
                contentAlignment = Alignment.Center,
            ) {
                if (state.isLoading && state.error == null) {
                    CircularProgressIndicator(Modifier.size(28.dp), color = Mm.OnAcc, strokeWidth = 3.dp)
                } else {
                    Icon(if (state.wantsToPlay) MmIcons.Pause else MmIcons.Play, contentDescription = if (state.wantsToPlay) "Pausar" else "Reproducir", tint = Mm.OnAcc, modifier = Modifier.size(28.dp))
                }
            }
            Later(MmIcons.Next)
            Later(MmIcons.Repeat)
        }

        Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Mm.Sur2).padding(horizontal = 14.dp, vertical = 9.dp).alpha(0.4f),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(MmIcons.Queue, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Cola", color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.weight(1f))
            if (state.isLoading && state.error == null && state.positionMs == 0L) {
                Text("Preparando la canción…", color = Mm.Mut, fontSize = 12.sp, textAlign = TextAlign.End)
            }
        }
    }
}
