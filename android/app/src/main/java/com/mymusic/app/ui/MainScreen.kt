package com.mymusic.app.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.runtime.LaunchedEffect
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
import com.mymusic.app.Overlay
import com.mymusic.app.playback.PlayerState
import kotlinx.coroutines.delay

private enum class Tab(val label: String, val icon: ImageVector) {
    Home("Inicio", MmIcons.Home),
    Search("Buscar", MmIcons.Search),
    Lists("Listas", MmIcons.Lists),
}

/**
 * Estructura común de la maqueta: contenido, minirreproductor y las tres pestañas de abajo.
 * El reproductor y la cola ocupan toda la pantalla; el interior de una lista y el historial
 * se abren sobre las pestañas y conservan el minirreproductor.
 */
@Composable
fun MainScreen(vm: AppViewModel) {
    val state by vm.player.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.Home) }
    val top = vm.overlays.lastOrNull()

    LaunchedEffect(Unit) { vm.refreshHome() }
    BackHandler(enabled = top != null) { vm.back() }
    // Tocar un artista en «Tus estadísticas» lleva a Buscar con su nombre
    LaunchedEffect(vm.showSearch) {
        if (vm.showSearch) {
            tab = Tab.Search
            vm.showSearch = false
        }
    }

    Box(Modifier.fillMaxSize().background(Mm.Bg)) {
        when {
            top == Overlay.Player && state.track != null -> PlayerScreen(vm, state)
            top == Overlay.Queue -> QueueScreen(vm)
            else -> Column(Modifier.fillMaxSize().statusBarsPadding()) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (top) {
                        is Overlay.ListDetail -> ListDetailScreen(vm, top.id, state)
                        is Overlay.AutoList -> AutoListScreen(vm, top.kind, state)
                        Overlay.Stats -> StatsScreen(vm, state)
                        Overlay.History -> HistoryScreen(vm, state)
                        Overlay.Settings -> SettingsScreen(vm)
                        Overlay.Trash -> TrashScreen(vm)
                        is Overlay.Artist -> ArtistScreen(vm, top.id, state)
                        is Overlay.ArtistSongs -> ArtistSongsScreen(vm, top.id, state)
                        is Overlay.Discography -> DiscographyScreen(vm, top.id, top.tab)
                        is Overlay.Album -> AlbumScreen(vm, top.id, state)
                        Overlay.Failures -> FailuresScreen(vm)
                        else -> when (tab) {
                            Tab.Home -> HomeScreen(vm, state)
                            Tab.Search -> SearchScreen(vm, playingKey = state.track?.key)
                            Tab.Lists -> ListsScreen(vm)
                        }
                    }
                }
                if (state.track != null) {
                    MiniPlayer(state, onOpen = { vm.open(Overlay.Player) }, onToggle = vm.player::toggle, onNext = vm.player::next)
                }
                Row(Modifier.fillMaxWidth().background(Mm.Line).padding(top = 1.dp).background(Mm.Bg).navigationBarsPadding().height(56.dp)) {
                    for (item in Tab.entries) {
                        val color = if (item == tab && top == null) Mm.Acc else Mm.Mut
                        Column(
                            Modifier.weight(1f).fillMaxSize().clickable {
                                vm.overlays.clear()
                                tab = item
                                if (item != Tab.Search) vm.refreshHome()
                            }.testTag("tab${item.name}"),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Icon(item.icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.height(2.dp))
                            Text(item.label, color = color, fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        // Por encima de cualquier pantalla: el menú de canción, el selector de lista y los avisos
        vm.sheet?.let { TrackSheet(vm, it) }
        vm.pickFor?.let { ListPickerSheet(vm, it) }
        vm.importFor?.let { ImportSheet(vm, it) }
        vm.matchFor?.let { MatchSheet(vm, it) }
        vm.restoreFor?.let { RestorePicker(vm, it) }
        vm.saveAutoFor?.let { SaveAutoSheet(vm, it) }
        vm.saveAlbumFor?.let { SaveAlbumSheet(vm, it) }
        vm.artistChoice?.let { ArtistChoiceSheet(vm, it) }
        vm.failureFor?.let { FailureSheet(vm, it) }
        vm.alternateFor?.let { AlternateSheet(vm, it) }
        Notice(vm, Modifier.align(Alignment.BottomCenter))
    }
}

/** Aviso breve («Añadida a breakcore») que se quita solo. */
@Composable
private fun Notice(vm: AppViewModel, modifier: Modifier) {
    val text = vm.notice ?: return
    LaunchedEffect(text) {
        delay(2500)
        if (vm.notice == text) vm.notice = null
    }
    Text(
        text,
        color = Mm.Tx,
        fontSize = 13.sp,
        modifier = modifier
            .navigationBarsPadding()
            .padding(bottom = 132.dp, start = 24.dp, end = 24.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Mm.Sur2)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag("notice"),
    )
}

/** Barra fija sobre las pestañas con lo que suena; tocarla abre el reproductor. */
@Composable
private fun MiniPlayer(state: PlayerState, onOpen: () -> Unit, onToggle: () -> Unit, onNext: () -> Unit) {
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
        Row(Modifier.padding(start = 8.dp, end = 6.dp, top = 8.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
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
            Box(
                Modifier.size(40.dp).clickable(enabled = state.hasNext, onClick = onNext).alpha(if (state.hasNext) 1f else 0.3f).testTag("miniNext"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(MmIcons.Next, contentDescription = "Siguiente", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
        }
        Box(Modifier.fillMaxWidth().height(2.dp)) {
            Box(Modifier.fillMaxWidth(fraction).height(2.dp).background(Mm.Acc))
        }
    }
}
