package com.mymusic.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mymusic.app.AppViewModel
import com.mymusic.app.playback.PlayerState

private enum class Tab(val label: String, val icon: ImageVector) {
    Home("Inicio", MmIcons.Home),
    Search("Buscar", MmIcons.Search),
    Lists("Listas", MmIcons.Lists),
}

/** Estructura común de la maqueta: contenido, minirreproductor y las tres pestañas de abajo. */
@Composable
fun MainScreen(vm: AppViewModel) {
    val state by vm.player.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.Search) }
    var playerOpen by rememberSaveable { mutableStateOf(false) }

    if (playerOpen && state.track != null) {
        BackHandler { playerOpen = false }
        PlayerScreen(state, onClose = { playerOpen = false }, onToggle = vm.player::toggle, onSeek = vm.player::seekTo)
        return
    }

    Column(Modifier.fillMaxSize().background(Mm.Bg).statusBarsPadding()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (tab) {
                Tab.Search -> SearchScreen(vm, playingKey = state.track?.key)
                Tab.Home -> ComingSoon("Inicio", "«Continuar», tus listas y lo escuchado hace poco llegan en la Fase 2.") {
                    Icon(MmIcons.Settings, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(22.dp).alpha(0.35f))
                }
                Tab.Lists -> ComingSoon("Listas", "Tus listas llegan en la Fase 2.")
            }
        }
        if (state.track != null) MiniPlayer(state, onOpen = { playerOpen = true }, onToggle = vm.player::toggle)
        Row(Modifier.fillMaxWidth().background(Mm.Line).padding(top = 1.dp).background(Mm.Bg).navigationBarsPadding().height(56.dp)) {
            for (item in Tab.entries) {
                val color = if (item == tab) Mm.Acc else Mm.Mut
                Column(
                    Modifier.weight(1f).fillMaxSize().clickable { tab = item }.testTag("tab${item.name}"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
                ) {
                    Icon(item.icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.height(2.dp))
                    Text(item.label, color = color, fontSize = 11.sp)
                }
            }
        }
    }
}

@Composable
private fun ComingSoon(title: String, message: String, trailing: @Composable () -> Unit = {}) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenTitle(title, trailing = trailing)
        Text(message, color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
    }
}

/** Barra fija sobre las pestañas con lo que suena; tocarla abre el reproductor. */
@Composable
private fun MiniPlayer(state: PlayerState, onOpen: () -> Unit, onToggle: () -> Unit) {
    val track = state.track ?: return
    val fraction = if (state.durationMs > 0) (state.positionMs.toFloat() / state.durationMs).coerceIn(0f, 1f) else 0f
    Column(
        Modifier
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Mm.Sur2)
            .clickable(onClick = onOpen)
            .testTag("mini"),
    ) {
        Row(Modifier.padding(start = 8.dp, end = 12.dp, top = 8.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Cover(track.thumb, 38.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(track.title, color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    state.error ?: track.artist.orEmpty(),
                    color = if (state.error != null) Mm.Yt else Mm.Mut,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Box(Modifier.size(40.dp).clickable(onClick = onToggle).testTag("miniPlayPause"), contentAlignment = Alignment.Center) {
                if (state.isLoading && state.error == null) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Mm.Tx, strokeWidth = 2.dp)
                } else {
                    Icon(if (state.wantsToPlay) MmIcons.Pause else MmIcons.Play, contentDescription = if (state.wantsToPlay) "Pausar" else "Reproducir", tint = Mm.Tx, modifier = Modifier.size(22.dp))
                }
            }
            // «Siguiente» depende de la cola (Fase 2)
            Icon(MmIcons.Next, contentDescription = null, tint = Mm.Tx, modifier = Modifier.padding(start = 6.dp).size(22.dp).alpha(0.3f))
        }
        Box(Modifier.fillMaxWidth().height(2.dp)) {
            Box(Modifier.fillMaxWidth(fraction).height(2.dp).background(Mm.Acc))
        }
    }
}
