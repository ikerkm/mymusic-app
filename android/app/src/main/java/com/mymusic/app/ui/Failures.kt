package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.data.FailureItem
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

// Canciones que fallan (§19): pantallas 4-6 de mockups/fallos-v1.html. El aviso al fallar y el salto a
// la siguiente los hace el servicio de reproducción (PlaybackService); esto es el apartado de Ajustes.

private val shortMonths = listOf("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")

/** «hoy», «ayer» o «15 nov». */
private fun whenShort(iso: String?): String? {
    val day = runCatching { Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate() }.getOrNull() ?: return null
    return when (ChronoUnit.DAYS.between(day, LocalDate.now())) {
        0L -> "hoy"
        1L -> "ayer"
        else -> "${day.dayOfMonth} ${shortMonths[day.monthValue - 1]}"
    }
}

/** «Tiene restricción de edad · 2 veces · hoy» */
private fun FailureItem.why() = listOfNotNull(reason.ifBlank { null }, if (count > 1) "$count veces" else null, whenShort(lastAt)).joinToString(" · ")

private fun FailureItem.from() = listOfNotNull(track.artist, if (track.platform == "spotify") "Spotify" else null, list?.let { "de «${it.name}»" }).joinToString(" · ")

/** Pantalla 4: las que no se pudieron reproducir, la más reciente arriba. */
@Composable
fun FailuresScreen(vm: AppViewModel) {
    val items = vm.failures
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("failures")) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
            Text("Canciones que fallaron", color = Mm.Tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        Text("Las que no se pudieron reproducir. Salen solas de aquí cuando vuelven a sonar bien.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp))
        when {
            items == null -> Text("Cargando…", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            items.isEmpty() -> Text("Ninguna: todo lo que has escuchado ha sonado.", color = Mm.Mut, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.key }) { item ->
                    Row(Modifier.fillMaxWidth().clickable { vm.failureFor = item }.padding(vertical = 7.dp).testTag("failureRow"), verticalAlignment = Alignment.CenterVertically) {
                        Cover(item.track.thumb, 42.dp)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(item.track.title, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(item.from(), color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(item.why(), color = Mm.Sc, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Box(Modifier.size(40.dp).clickable { vm.failureFor = item }, contentAlignment = Alignment.Center) {
                            Icon(MmIcons.More, contentDescription = "Más opciones", tint = Mm.Mut, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                item(key = "fin") { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

/** Pantalla 5: las opciones de una que falló. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FailureSheet(vm: AppViewModel, item: FailureItem) {
    ModalBottomSheet(onDismissRequest = { vm.failureFor = null }, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Cover(item.track.thumb, 42.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(item.track.title, color = Mm.Tx, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val detail = listOfNotNull(item.track.artist, item.track.durationSec?.let { formatTime(it * 1000L) }).joinToString(" · ")
                        Text(detail, color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Spacer(Modifier.width(6.dp))
                        PlatformBadge(item.track.platform)
                    }
                }
            }
            Text(item.why(), color = Mm.Sc, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp, bottom = 4.dp))
            Option(MmIcons.Retry, "Probar otra vez", "optRetry") { vm.retryFailure(item) }
            Option(MmIcons.Link, "Poner otro enlace…", "optAlternate") { vm.openAlternate(item) }
            HorizontalDivider(color = Mm.Line, modifier = Modifier.padding(vertical = 4.dp))
            item.list?.let { list -> Option(MmIcons.Bin, "Quitar de la lista", "optRemoveFailed", note = list.name) { vm.removeFailureFromList(item) } }
            Option(MmIcons.Close, "Descartar", "optDismiss", note = "deja de salir aquí") { vm.dismissFailure(item) }
        }
    }
}

/** Pantalla 6: otros vídeos de la misma canción, o pegar un enlace. Vale para todos los usuarios. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun AlternateSheet(vm: AppViewModel, item: FailureItem) {
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Con el teclado abierto la lista de candidatos se encoge: el campo del enlace y «Usar» siguen a la vista
    val typing = WindowInsets.isImeVisible
    ModalBottomSheet(onDismissRequest = { vm.closeAlternate() }, containerColor = Mm.Sur) {
        SheetWindowFix()
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 18.dp).imePadding()) {
            Text("Poner otro enlace", color = Mm.Tx, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(listOfNotNull(item.track.title, item.track.artist).joinToString(" — "), color = Mm.Mut, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Suena desde el vídeo que elijas, en todas sus listas y para todos.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp, bottom = 4.dp))
            val options = vm.alternateOptions
            when {
                vm.alternateError != null -> Text(vm.alternateError.orEmpty(), color = Mm.Yt, fontSize = 12.sp, modifier = Modifier.padding(vertical = 8.dp))
                options == null -> Box(Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Mm.Acc, strokeWidth = 3.dp)
                }
                options.candidates.isEmpty() -> Text("No he encontrado otros vídeos de esta canción. Puedes pegar un enlace.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(vertical = 8.dp))
                else -> Column(Modifier.heightIn(max = if (typing) 110.dp else 320.dp).verticalScroll(rememberScrollState())) {
                    for (candidate in options.candidates) {
                        val track = candidate.track
                        val failing = track.key == options.current
                        val diff = candidate.durationDiff
                        val detail = listOfNotNull(
                            track.artist, track.durationSec?.let { formatTime(it * 1000L) },
                            if (diff != null && diff != 0) "${if (diff > 0) "+" else "−"}${kotlin.math.abs(diff)} s" else null,
                        ).joinToString(" · ")
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = !busy) {
                                busy = true
                                error = null
                                vm.setAlternate(track = track) { problem ->
                                    busy = false
                                    error = problem
                                }
                            }.padding(vertical = 7.dp).testTag("alternate"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Cover(track.thumb, 40.dp)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(track.title, color = Mm.Tx, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(detail, color = Mm.Mut, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (failing) {
                                Text(
                                    "falla", color = Mm.Yt, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(50)).background(Mm.Yt.copy(alpha = 0.13f)).padding(horizontal = 7.dp, vertical = 1.dp),
                                )
                            }
                        }
                    }
                }
            }
            SectionLabel("O pega un enlace de YouTube")
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    colors = fieldColors(),
                    placeholder = { Text("https://youtu.be/…", color = Mm.Mut) },
                    modifier = Modifier.weight(1f).testTag("alternateLink"),
                )
                Button(
                    onClick = {
                        busy = true
                        error = null
                        vm.setAlternate(url = link.trim()) { problem ->
                            busy = false
                            error = problem
                        }
                    },
                    enabled = link.isNotBlank() && !busy,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Mm.Acc, contentColor = Mm.OnAcc,
                        disabledContainerColor = Mm.Acc.copy(alpha = 0.45f), disabledContentColor = Mm.OnAcc.copy(alpha = 0.6f),
                    ),
                    modifier = Modifier.height(44.dp).testTag("alternateUse"),
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Mm.OnAcc, strokeWidth = 2.dp)
                    else Text("Usar", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            error?.let { Text(it, color = Mm.Yt, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
        }
    }
}
