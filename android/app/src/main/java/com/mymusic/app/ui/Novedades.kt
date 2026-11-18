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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.Overlay
import com.mymusic.app.data.FollowedArtist
import com.mymusic.app.data.Novedad
import java.time.LocalDate
import java.time.temporal.ChronoUnit

// Artistas que sigues y sus novedades (§21, mockups/novedades-v1.html). A quién sigue y qué ha abierto lo
// guarda el servidor; lo que saca cada artista lo mira él al seguirlo y una vez al día. Sin avisos en el
// móvil (decisión del usuario): solo Inicio, Listas → «Artistas» y «Ver todas».

private val MONTHS = listOf("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")
private val OUTLINE = Color(0xFF4A5068)

/** Días desde un día AAAA-MM-DD hasta hoy, o null. */
internal fun dayDiff(day: String?): Long? = runCatching { ChronoUnit.DAYS.between(LocalDate.parse(day), LocalDate.now()) }.getOrNull()

/** «22 oct». */
internal fun dayLabel(day: String?): String = runCatching { LocalDate.parse(day).let { "${it.dayOfMonth} ${MONTHS[it.monthValue - 1]}" } }.getOrDefault("")

/** «hace 5 días», «ayer», «hoy»; una reedición: «apareció hace 3 días». */
internal fun agoOf(day: String?, appeared: Boolean): String {
    val n = dayDiff(day)
    val ago = when {
        n == null -> ""
        n <= 0L -> "hoy"
        n == 1L -> "ayer"
        else -> "hace $n días"
    }
    return if (appeared) "apareció $ago" else ago
}

private fun plays30(n: Int) = if (n == 1) "1 escucha en 30 días" else "$n escuchas en 30 días"

/** El punto de «aún no lo has abierto». */
@Composable
private fun NewDot(modifier: Modifier = Modifier) {
    Box(modifier.size(12.dp).clip(CircleShape).background(Mm.Bg).padding(2.dp).clip(CircleShape).background(Mm.Acc).testTag("newDot"))
}

/** Botón de borde fino («Seguir», «✓ Siguiendo», «Elegir artistas»). */
@Composable
internal fun OutlinePill(
    label: String,
    tag: String,
    icon: ImageVector? = null,
    on: Boolean = false,
    busy: Boolean = false,
    onClick: () -> Unit,
) {
    val color = if (on) Mm.Acc else Mm.Tx
    Row(
        Modifier.height(32.dp).clip(RoundedCornerShape(50)).border(1.dp, if (on) Mm.Acc else OUTLINE, RoundedCornerShape(50))
            .clickable(enabled = !busy, onClick = onClick).padding(horizontal = 14.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(14.dp), color = color, strokeWidth = 2.dp)
        else if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(15.dp))
        if (busy || icon != null) Spacer(Modifier.width(6.dp))
        Text(label, color = color, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** «Seguir» / «✓ Siguiendo» en la página del artista (pantalla 2). */
@Composable
fun FollowPill(following: Boolean, busy: Boolean, tag: String, onClick: () -> Unit) =
    OutlinePill(if (following) "Siguiendo" else "Seguir", tag, icon = if (following) MmIcons.Check else null, on = following, busy = busy, onClick = onClick)

// --- Pantallas 1 y 5: Inicio ------------------------------------------------------------------------------

@Composable
private fun NovedadCard(item: Novedad, onClick: () -> Unit) {
    Column(Modifier.width(104.dp).clickable(onClick = onClick).testTag("novedad")) {
        Box {
            Cover(item.thumb, 104.dp, radius = 10.dp)
            if (!item.seen) NewDot(Modifier.align(Alignment.TopEnd).padding(6.dp))
        }
        Text(item.title, color = Mm.Tx, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(item.artistName, color = Mm.Mut, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(agoOf(item.day, item.appeared), color = Mm.Mut, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Inicio, entre «Tu radio» y «Para ti»: lo de los últimos 30 días, lo más nuevo primero. Sin seguir a
 * nadie, la tarjeta para elegir artistas; siguiendo a alguien y sin nada reciente, no sale.
 */
@Composable
fun NovedadesRow(vm: AppViewModel) {
    val n = vm.novedades ?: return
    if (n.following == 0) {
        Column(
            Modifier.fillMaxWidth().padding(top = 14.dp)
                .drawBehind {
                    drawRoundRect(
                        OUTLINE, cornerRadius = CornerRadius(14.dp.toPx()),
                        style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx()))),
                    )
                }
                .clip(RoundedCornerShape(14.dp)).background(Mm.Sur).padding(12.dp).testTag("pickArtistsCard"),
        ) {
            Text("Novedades de tus artistas", color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text("Sigue a tus artistas y aquí saldrá lo que saquen.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp, bottom = 10.dp))
            OutlinePill("Elegir artistas", "pickArtists", icon = MmIcons.User) { vm.pickArtists() }
        }
        return
    }
    if (n.releases.isEmpty()) return
    Column(Modifier.fillMaxWidth()) {
        SectionHead("Novedades de tus artistas", "Ver todas", "allNovedades") { vm.open(Overlay.Novedades) }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(n.releases.take(12), key = { it.id }) { item -> NovedadCard(item) { vm.openNovedad(item) } }
        }
    }
}

// --- Pantalla 4: «Ver todas» ------------------------------------------------------------------------------

@Composable
private fun NovedadRow(item: Novedad, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 7.dp).testTag("novedadRow"), verticalAlignment = Alignment.CenterVertically) {
        Box {
            Cover(item.thumb, 48.dp)
            if (!item.seen) NewDot(Modifier.align(Alignment.TopEnd))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.title, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOf(item.artistName, kindLabel(item.kind), if (item.appeared) agoOf(item.day, true) else dayLabel(item.day)).filter { it.isNotEmpty() }.joinToString(" · "),
                color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Lo de los últimos 3 meses, en «Esta semana», «Este mes» y «Hasta 3 meses». */
@Composable
fun NovedadesScreen(vm: AppViewModel) {
    val n = vm.novedadesAll
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        BackBar(vm, "Novedades de tus artistas")
        if (n == null) {
            Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                val error = vm.novedadesAllError
                if (error != null) Text(error, color = Mm.Mut, fontSize = 13.sp, textAlign = TextAlign.Center)
                else CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
            }
            return@Column
        }
        if (n.releases.isEmpty()) {
            Text(
                if (n.following == 0) "Aún no sigues a nadie." else "Tus artistas no han sacado nada en los últimos 3 meses.",
                color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp),
            )
            return@Column
        }
        val groups = listOf(Triple("Esta semana", 0L, 6L), Triple("Este mes", 7L, 30L), Triple("Hasta 3 meses", 31L, Long.MAX_VALUE))
        LazyColumn(Modifier.fillMaxSize()) {
            for ((label, from, to) in groups) {
                val rows = n.releases.filter { (dayDiff(it.day) ?: 0L) in from..to }
                if (rows.isEmpty()) continue
                item(key = label) { SectionLabel(label) }
                items(rows, key = { it.id }) { item -> NovedadRow(item) { vm.openNovedad(item) } }
            }
            item(key = "fin") { Spacer(Modifier.height(16.dp)) }
        }
    }
}

// --- Pantalla 3: Listas → «Artistas» ----------------------------------------------------------------------

/** Las dos pestañas de Listas: «Listas · N» y «Artistas · N». */
@Composable
fun ListsTabs(vm: AppViewModel) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp).clip(RoundedCornerShape(50)).background(Mm.Sur).padding(3.dp)) {
        val tabs = listOf("lists" to "Listas · ${vm.lists.size}", "artists" to "Artistas" + (vm.follows?.let { " · ${it.artists.size}" } ?: ""))
        for ((key, label) in tabs) {
            val on = vm.listsTab == key
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(50)).background(if (on) Mm.Sur2 else Color.Transparent)
                    .clickable { vm.listsTab = key }.padding(vertical = 7.dp).testTag("listsTab_$key"),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (on) Mm.Tx else Mm.Mut, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

// Debajo del nombre: lo nuevo sin abrir (en morado) o lo último que ha sacado
private fun followLine(artist: FollowedArtist): String {
    val latest = artist.latest ?: return "Sin discos en YouTube Music"
    if (artist.isNew) return "Nuevo: ${latest.title} · ${agoOf(latest.day, latest.appeared)}"
    val whenText = latest.day?.let { " · ${dayLabel(it)}" } ?: latest.year?.let { " · $it" } ?: ""
    return "Último: ${latest.title}$whenText"
}

@Composable
private fun FollowMenu(onRadio: () -> Unit, onUnfollow: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Box(Modifier.size(40.dp).clickable { open = true }.testTag("followMenu"), contentAlignment = Alignment.Center) {
            Icon(MmIcons.More, contentDescription = "Opciones del artista", tint = Mm.Mut, modifier = Modifier.size(20.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = Mm.Sur2) {
            DropdownMenuItem(text = { Text("Radio de este artista", color = Mm.Tx) }, onClick = { open = false; onRadio() })
            DropdownMenuItem(text = { Text("Dejar de seguir", color = Mm.Tx) }, onClick = { open = false; onUnfollow() })
        }
    }
}

/** Los artistas que sigue (con novedad sin abrir primero) y, al final, «Los que más escuchas». */
@Composable
fun FollowsTab(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadFollowsTab() }
    val follows = vm.follows
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        item(key = "titulo") { ScreenTitle("Listas") }
        item(key = "pestanas") { ListsTabs(vm) }
        if (follows != null && follows.artists.isEmpty()) {
            item(key = "vacio") {
                Text(
                    "Aún no sigues a nadie. Toca «Seguir» en la página de un artista, o elige entre los que más escuchas.",
                    color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
        items(follows?.artists.orEmpty(), key = { it.id }) { artist ->
            Row(
                Modifier.fillMaxWidth().clickable { vm.open(Overlay.Artist(artist.id)) }.padding(vertical = 7.dp).testTag("followed"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    ArtistAvatar(artist.thumb, 48.dp)
                    if (artist.isNew) NewDot(Modifier.align(Alignment.TopEnd))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(artist.name, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(followLine(artist), color = if (artist.isNew) Mm.Acc else Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                FollowMenu(onRadio = { vm.playArtistRadio(artist.id) }, onUnfollow = { vm.setFollow(artist.id, artist.name, false) })
            }
        }
        if (vm.followSuggestions.isNotEmpty()) {
            item(key = "sugerencias") { SectionLabel("Los que más escuchas") }
            items(vm.followSuggestions, key = { "s ${it.id}" }) { suggestion ->
                Row(
                    Modifier.fillMaxWidth().clickable { vm.open(Overlay.Artist(suggestion.id)) }.padding(vertical = 6.dp).testTag("suggestion"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ArtistAvatar(suggestion.thumb, 40.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(suggestion.name, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(plays30(suggestion.plays), color = Mm.Mut, fontSize = 12.sp, maxLines = 1)
                    }
                    OutlinePill("Seguir", "suggestionFollow", busy = suggestion.id in vm.followBusy) { vm.setFollow(suggestion.id, suggestion.name, true) }
                }
            }
        }
        item(key = "fin") { Spacer(Modifier.height(16.dp)) }
    }
}
