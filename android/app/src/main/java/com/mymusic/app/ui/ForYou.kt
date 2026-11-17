package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.Overlay
import com.mymusic.app.SheetTarget
import com.mymusic.app.data.AutoDetail
import com.mymusic.app.data.AutoRow
import com.mymusic.app.data.AutoSummary
import com.mymusic.app.data.StatsBrief
import com.mymusic.app.data.Track
import com.mymusic.app.playback.PlayerState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// Listas automáticas («Para ti») y «Tus estadísticas»: pantallas 1-6 de mockups/estadisticas-v1.html.
// Son de solo lectura: las calcula el servidor con el historial de cada usuario al abrirlas.

/** Carátula de una lista automática: un icono sobre su color, no una foto. */
private data class AutoLook(val icon: ImageVector, val color: Color, val dark: Color)

private fun lookOf(kind: String) = when (kind) {
    "top" -> AutoLook(MmIcons.Trend, Color(0xFF9D8CFF), Color(0xFF1B1640))          // tendencia, morado
    "forgotten" -> AutoLook(MmIcons.Clock, Color(0xFF5FD4C4), Color(0xFF0F2A2A))    // reloj, turquesa
    else -> AutoLook(MmIcons.Radio, Color(0xFFFF9A4A), Color(0xFF2C1A0E))           // radio, naranja
}

@Composable
private fun AutoCover(kind: String, size: Dp, radius: Dp, iconSize: Dp) {
    val look = lookOf(kind)
    Box(
        Modifier.size(size).clip(RoundedCornerShape(radius)).background(look.dark).border(1.dp, look.color, RoundedCornerShape(radius)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(look.icon, contentDescription = null, tint = look.color, modifier = Modifier.size(iconSize))
    }
}

// --- Fechas y tiempos -----------------------------------------------------------------------------

// Los mismos nombres que pone el servidor (stats.js) en «Guardar como lista»: «sep», no «sept.» de Java
private val months = listOf("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")

/** 2026-09-09 → «9 sep» */
private fun LocalDate.short() = "$dayOfMonth ${months[monthValue - 1]}"

private fun localDateOf(iso: String?): LocalDate? =
    runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate() }.getOrNull()

/** «2026-10-02T08:00:00Z» → «2 oct» (en hora local). */
private fun shortDay(iso: String?): String? = localDateOf(iso)?.short()

/** «hoy», «ayer» o «d mmm», en hora local. */
private fun relativeDay(iso: String?): String? {
    val day = localDateOf(iso) ?: return null
    val today = LocalDate.now()
    return when (day) {
        today -> "hoy"
        today.minusDays(1) -> "ayer"
        else -> day.short()
    }
}

/** «2026-10-20» (día local que da el servidor) → «20 oct». */
private fun ymdDay(ymd: String?): String? = runCatching { LocalDate.parse(ymd).short() }.getOrNull()

/** Tiempo escuchado: 22 800 000 ms → «6 h 20 min»; 900 000 → «15 min»; menos de un minuto, en segundos. */
fun formatListened(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    if (seconds < 60) return "$seconds s"
    val minutes = seconds / 60
    return if (minutes >= 60) "${minutes / 60} h ${minutes % 60} min" else "$minutes min"
}

// --- Inicio: «Para ti» ------------------------------------------------------------------------------

/**
 * Pantalla 1: «Para ti», entre «Tu radio» y «Tus listas». Las listas automáticas en una fila que se
 * desliza de lado y, debajo, la tarjeta de «Tus estadísticas». Una lista sin canciones no sale.
 */
@Composable
fun ForYouSection(vm: AppViewModel) {
    val home = vm.forYou ?: return
    val lists = home.lists.filter { it.count > 0 }
    val brief = home.stats
    val anyStats = brief != null && (brief.plays > 0 || brief.listenedMs > 0)
    if (lists.isEmpty() && !anyStats) return
    Column(Modifier.fillMaxWidth()) {
        SectionLabel("Para ti")
        if (lists.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(lists, key = { it.kind }) { list -> AutoCard(list) { vm.open(Overlay.AutoList(list.kind)) } }
            }
        }
        if (brief != null) StatsCard(brief, Modifier.padding(top = 10.dp)) { vm.open(Overlay.Stats) }
    }
}

@Composable
private fun AutoCard(list: AutoSummary, onClick: () -> Unit) {
    Column(Modifier.width(100.dp).clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick)) {
        AutoCover(list.kind, 100.dp, 12.dp, 34.dp)
        Text(
            list.name, color = Mm.Tx, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, lineHeight = 15.sp,
            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp),
        )
        Text(songs(list.count), color = Mm.Mut, fontSize = 11.sp, maxLines = 1)
    }
}

@Composable
private fun StatsCard(brief: StatsBrief, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Mm.Sur).clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp).testTag("openStats"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).background(Mm.Sur2), contentAlignment = Alignment.Center) {
            Icon(MmIcons.Chart, contentDescription = null, tint = Mm.Acc, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Tus estadísticas", color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "7 días: ${formatListened(brief.listenedMs)} · ${songs(brief.songs)}",
                color = Mm.Mut, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(MmIcons.Forward, contentDescription = null, tint = Mm.Mut, modifier = Modifier.size(16.dp))
    }
}

// --- Pantallas 2-4: una lista automática -------------------------------------------------------------

/**
 * Una lista automática abierta. Se parece a una lista normal, pero sin menú arriba (no se renombra ni se
 * quita), sin «Importar» y sin arrastrar; en su lugar, «Guardar» la copia a una lista normal nueva.
 */
@Composable
fun AutoListScreen(vm: AppViewModel, kind: String, state: PlayerState) {
    val detail = vm.openAuto?.takeIf { it.kind == kind }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
        }

        if (detail == null) {
            Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
            }
            return@Column
        }

        val session = vm.session
        val playingHere = session?.sourceType == "auto" && session.sourceId == kind

        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "cabecera") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AutoCover(kind, 76.dp, 14.dp, 30.dp)
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text(detail.name, color = Mm.Tx, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("Automática · ${songs(detail.count)}", color = Mm.Mut, fontSize = 12.sp)
                    }
                }
                if (detail.description.isNotBlank()) {
                    Text(detail.description, color = Mm.Mut, fontSize = 12.sp, lineHeight = 16.sp, modifier = Modifier.padding(top = 10.dp))
                }
                Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val enabled = detail.rows.isNotEmpty()
                    Row(
                        Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(50)).background(Mm.Acc).alpha(if (enabled) 1f else 0.4f)
                            .clickable(enabled = enabled) { vm.playAuto(kind) }.testTag("playAuto"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
                    ) {
                        Icon(MmIcons.Play, contentDescription = null, tint = Mm.OnAcc, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Reproducir", color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Box(
                        Modifier.size(40.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2).alpha(if (enabled) 1f else 0.4f)
                            .clickable(enabled = enabled) { vm.playAuto(kind, shuffle = true) }.testTag("shuffleAuto"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(MmIcons.Shuffle, contentDescription = "Aleatorio", tint = Mm.Tx, modifier = Modifier.size(18.dp))
                    }
                    // «Guardar»: copiar lo que hay ahora a una lista normal tuya, que ya no cambia sola
                    Row(
                        Modifier.height(40.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2).alpha(if (enabled) 1f else 0.4f)
                            .clickable(enabled = enabled) { vm.saveAutoFor = detail }.padding(horizontal = 14.dp).testTag("saveAuto"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(MmIcons.ListAdd, contentDescription = null, tint = Mm.Tx, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Guardar", color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            if (detail.rows.isEmpty()) {
                item(key = "vacia") {
                    Text(
                        "Todavía no hay nada aquí. Irá llenándose a medida que escuches música.",
                        color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }

            itemsIndexed(detail.rows, key = { index, row -> "$index ${row.track.key}" }) { index, row ->
                val track = row.track
                AutoTrackRow(
                    track = track,
                    playing = playingHere && state.track?.key == track.key,
                    onClick = { vm.playAuto(kind, startKey = track.key) },
                    onMenu = { vm.sheet = SheetTarget(track, autoKind = kind) },
                    number = if (kind == "top") index + 1 else null,
                    detail = rowDetail(kind, row),
                    trailing = { RowTrailing(kind, row) },
                )
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }
}

/** Segunda línea de la fila: en qué lista está y cuándo sonó («forgotten»), o cuándo y qué radio la puso («radio»). */
private fun rowDetail(kind: String, row: AutoRow): String? = when (kind) {
    "forgotten" -> listOfNotNull(
        row.list?.name?.let { "en $it" },
        row.lastPlayedAt?.let { iso -> shortDay(iso)?.let { "última vez $it" } } ?: "sin escuchas",
    ).joinToString(" · ")
    "radio" -> listOfNotNull(relativeDay(row.at), row.via).joinToString(" · ").ifEmpty { null }
    else -> null
}

/** Lo que va a la derecha de la fila: «N veces» («top») o si ya está guardada («radio»). */
@Composable
private fun RowTrailing(kind: String, row: AutoRow) {
    when (kind) {
        "top" -> row.plays?.let {
            Text(if (it == 1) "1 vez" else "$it veces", color = Mm.Mut, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(start = 8.dp))
        }
        "radio" -> {
            val saved = row.savedIn
            Pill(if (saved != null) "en ${saved.name}" else "sin guardar", if (saved != null) Mm.Ok else Mm.Sc)
        }
    }
}

@Composable
private fun Pill(text: String, color: Color) {
    Text(
        text, color = color, fontSize = 10.sp, lineHeight = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(start = 8.dp).widthIn(max = 110.dp).clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.13f))
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

/**
 * Fila de una lista automática: número («top») o carátula, título, artista y, debajo, el porqué;
 * a la derecha, lo propio de cada lista y el menú de siempre.
 */
@Composable
private fun AutoTrackRow(
    track: Track,
    playing: Boolean,
    onClick: () -> Unit,
    onMenu: () -> Unit,
    number: Int?,
    detail: String?,
    trailing: @Composable () -> Unit,
) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        if (number != null) {
            Text("$number", color = Mm.Mut, fontSize = 12.sp, textAlign = TextAlign.End, modifier = Modifier.width(26.dp))
        } else {
            Cover(track.thumb, 42.dp)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                track.title, color = if (playing) Mm.Acc else Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            track.artist?.takeIf { it.isNotBlank() }?.let { Text(it, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            if (detail != null) Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing()
        Box(Modifier.size(40.dp).clickable(onClick = onMenu), contentAlignment = Alignment.Center) {
            Icon(MmIcons.More, contentDescription = "Más opciones", tint = Mm.Mut, modifier = Modifier.size(20.dp))
        }
    }
}

// --- Pantalla 5: «Guardar como lista» ----------------------------------------------------------------

/** Copia lo que hay ahora en la lista automática a una lista normal nueva, con el nombre que se elija. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SaveAutoSheet(vm: AppViewModel, detail: AutoDetail) {
    val initial = detail.saveName.take(80)
    var field by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val close = { vm.saveAutoFor = null }
    ModalBottomSheet(onDismissRequest = close, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 18.dp).imePadding()) {
            Text("Guardar como lista", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            val what = if (detail.count == 1) "Copia la canción de ahora" else "Copia las ${detail.count} canciones de ahora"
            Text(
                "$what a una lista nueva. Esa lista ya no cambia sola: es tuya, como las demás.",
                color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp),
            )
            Text("Nombre", color = Mm.Mut, fontSize = 11.5.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
            OutlinedTextField(
                value = field,
                onValueChange = { field = if (it.text.length <= 80) it else it.copy(text = it.text.take(80)) },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                colors = fieldColors(),
                placeholder = { Text("Nombre", color = Mm.Mut) },
                modifier = Modifier.fillMaxWidth().testTag("saveAutoName"),
            )
            error?.let { Text(it, color = Mm.Yt, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(50)).background(Mm.Sur2).clickable(onClick = close),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Cancelar", color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
                val enabled = field.text.isNotBlank() && !busy
                Box(
                    Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(50)).background(Mm.Acc).alpha(if (enabled) 1f else 0.45f)
                        .clickable(enabled = enabled) {
                            busy = true
                            error = null
                            vm.saveAuto(detail.kind, field.text.trim()) { problem ->
                                busy = false
                                error = problem
                            }
                        }.testTag("saveAutoConfirm"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Mm.OnAcc, strokeWidth = 2.dp)
                    else Text("Guardar", color = Mm.OnAcc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

// --- Pantalla 6: «Tus estadísticas» --------------------------------------------------------------------

private val periods = listOf("7" to "7 días", "30" to "30 días", "all" to "Siempre")

/**
 * Periodo arriba (últimos 7 días, 30 días o desde siempre), tres cifras y las 10 canciones y los
 * 10 artistas que más han sonado. Tocar una canción la reproduce; tocar un artista lo busca en Buscar.
 */
@Composable
fun StatsScreen(vm: AppViewModel, state: PlayerState) {
    val stats = vm.stats?.takeIf { it.period == vm.statsPeriod }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
            Text("Tus estadísticas", color = Mm.Tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }

        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "periodo") {
                Row(Modifier.padding(top = 4.dp).fillMaxWidth().clip(RoundedCornerShape(50)).background(Mm.Sur).padding(3.dp)) {
                    for ((value, label) in periods) {
                        val on = value == vm.statsPeriod
                        Box(
                            Modifier.weight(1f).clip(RoundedCornerShape(50)).background(if (on) Mm.Sur2 else Color.Transparent)
                                .clickable { if (!on) vm.loadStats(value) }.padding(vertical = 7.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(label, color = if (on) Mm.Tx else Mm.Mut, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            when {
                vm.statsError != null && stats == null -> item(key = "error") {
                    Text(vm.statsError.orEmpty(), color = Mm.Yt, fontSize = 13.sp, modifier = Modifier.padding(top = 16.dp))
                }
                stats == null -> item(key = "cargando") {
                    Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
                    }
                }
                else -> {
                    item(key = "cifras") {
                        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Figure(formatListened(stats.listenedMs), "escuchado", Modifier.weight(1.25f))
                            Figure("${stats.songs}", "canciones", Modifier.weight(1f))
                            Figure("${stats.artists}", "artistas", Modifier.weight(1f))
                        }
                        val since = ymdDay(stats.listenedSince)
                        Text(
                            if (since != null) "El tiempo se mide desde el $since; las escuchas, desde que hay historial."
                            else "Todavía no hay tiempo medido; las escuchas cuentan desde que hay historial.",
                            color = Mm.Mut, fontSize = 11.5.sp, lineHeight = 15.sp, modifier = Modifier.padding(top = 8.dp),
                        )
                    }

                    item(key = "titCanciones") { SectionLabel("Canciones más escuchadas") }
                    if (stats.topTracks.isEmpty()) item(key = "sinCanciones") { Empty() }
                    itemsIndexed(stats.topTracks, key = { index, (track, _) -> "c$index ${track.key}" }) { index, (track, plays) ->
                        StatRow(
                            number = index + 1,
                            cover = { Cover(track.thumb, 34.dp) },
                            title = track.title,
                            detail = track.artist,
                            count = plays,
                            highlight = state.track?.key == track.key,
                            onClick = { vm.playTrack(track) },
                        )
                    }

                    item(key = "titArtistas") { SectionLabel("Artistas más escuchados") }
                    if (stats.topArtists.isEmpty()) item(key = "sinArtistas") { Empty() }
                    itemsIndexed(stats.topArtists, key = { index, artist -> "a$index ${artist.name}" }) { index, artist ->
                        StatRow(
                            number = index + 1,
                            cover = { Cover(artist.thumb, 36.dp, radius = 18.dp) },
                            title = artist.name,
                            detail = if (artist.songs == 1) "1 canción distinta" else "${artist.songs} canciones distintas",
                            count = artist.plays,
                            highlight = false,
                            onClick = { vm.searchFor(artist.name) },
                        )
                    }
                    item(key = "fin") { Spacer(Modifier.height(16.dp)) }
                }
            }
        }
    }
}

@Composable
private fun Empty() {
    Text("Todavía no hay escuchas en este periodo.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
}

@Composable
private fun Figure(value: String, label: String, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Mm.Sur).padding(10.dp)) {
        Text(value, color = Mm.Tx, fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(label, color = Mm.Mut, fontSize = 11.sp, maxLines = 1)
    }
}

@Composable
private fun StatRow(
    number: Int,
    cover: @Composable () -> Unit,
    title: String,
    detail: String?,
    count: Int,
    highlight: Boolean,
    onClick: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("$number", color = Mm.Mut, fontSize = 12.sp, textAlign = TextAlign.End, modifier = Modifier.width(18.dp))
        Spacer(Modifier.width(10.dp))
        cover()
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = if (highlight) Mm.Acc else Mm.Tx, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!detail.isNullOrBlank()) Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("$count", color = Mm.Mut, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(start = 8.dp, end = 4.dp))
    }
}
