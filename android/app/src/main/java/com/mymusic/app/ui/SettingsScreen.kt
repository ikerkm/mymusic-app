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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel
import com.mymusic.app.BuildConfig
import com.mymusic.app.Overlay
import com.mymusic.app.ProbeState
import com.mymusic.app.data.ProbePart

@Composable
private fun Group(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Mm.Sur).padding(horizontal = 14.dp)) { content() }
}

@Composable
private fun Line(title: String, detail: String? = null, tag: String = "", danger: Boolean = false, arrow: Boolean = false, badge: Int? = null, onClick: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(vertical = 12.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = if (danger) Mm.Yt else Mm.Tx, fontSize = 14.sp)
            if (detail != null) Text(detail, color = Mm.Mut, fontSize = 12.sp)
        }
        // Contador («Canciones que fallaron», §19)
        if (badge != null && badge > 0) {
            Text(
                "$badge", color = Color(0xFF2B1300), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(end = 8.dp).clip(RoundedCornerShape(50)).background(Mm.Sc).padding(horizontal = 7.dp, vertical = 1.dp),
            )
        }
        if (arrow) Icon(MmIcons.Forward, contentDescription = null, tint = Mm.Mut, modifier = Modifier.size(16.dp))
    }
}

/** Una línea del resultado de «Probar extracción»: «YouTube: responde (2,1 s)». */
@Composable
private fun ProbeLine(name: String, part: ProbePart) {
    val seconds = "%.1f".format(java.util.Locale.US, part.ms / 1000.0).replace('.', ',')
    val text = "$name: ${if (part.ok) "responde" else "no responde"} ($seconds s)" + if (!part.ok && part.message != null) " — ${part.message}" else ""
    Text(text, color = if (part.ok) Mm.Ok else Mm.Yt, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp).testTag("probeResult"))
}

/**
 * Pantalla 11 de la maqueta (Ajustes): servidor y «Probar extracción», historial y papelera, y la cuenta.
 * «Cambiar contraseña» es nuevo respecto a la maqueta: hace falta desde que hay varios usuarios.
 */
@Composable
fun SettingsScreen(vm: AppViewModel) {
    var changing by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clickable { vm.back() }, contentAlignment = Alignment.CenterStart) {
                Icon(MmIcons.Back, contentDescription = "Volver", tint = Mm.Tx, modifier = Modifier.size(22.dp))
            }
            Text("Ajustes", color = Mm.Tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }

        SectionLabel("Servidor")
        Group {
            Line(vm.savedServer.removePrefix("https://").removePrefix("http://"), "Conectado")
            HorizontalDivider(color = Mm.Line)
            val probe = vm.probe
            Line("Probar extracción", if (probe is ProbeState.Running) "Probando…" else "Comprueba que YouTube responde", tag = "probe", arrow = probe !is ProbeState.Running) { vm.probeExtraction() }
            when (probe) {
                is ProbeState.Done -> {
                    ProbeLine("Buscador", probe.result.search)
                    ProbeLine("YouTube", probe.result.extract)
                }
                is ProbeState.Failed -> Text(probe.message, color = Mm.Yt, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp).testTag("probeResult"))
                else -> Unit
            }
        }

        SectionLabel("Tus datos")
        Group {
            Line("Historial", tag = "settingsHistory", arrow = true) { vm.open(Overlay.History) }
            HorizontalDivider(color = Mm.Line)
            val inTrash = vm.trash?.size
            val detail = when (inTrash) {
                null -> "Lo que has quitado, por si quieres recuperarlo"
                0 -> "Vacía"
                1 -> "1 elemento recuperable"
                else -> "$inTrash elementos recuperables"
            }
            Line("Papelera", detail, tag = "settingsTrash", arrow = true) { vm.open(Overlay.Trash) }
            HorizontalDivider(color = Mm.Line)
            // Canciones que fallaron (§19, mockups/fallos-v1.html), con su contador
            val failed = vm.failures?.size
            val failedDetail = when (failed) {
                null -> "Las que no se pudieron reproducir"
                0 -> "Ninguna"
                1 -> "1 por revisar"
                else -> "$failed por revisar"
            }
            Line("Canciones que fallaron", failedDetail, tag = "settingsFailures", arrow = true, badge = failed) { vm.open(Overlay.Failures) }
        }

        SectionLabel("Cuenta")
        Group {
            Line(vm.userName.ifBlank { "Tu cuenta" }, "Sesión iniciada en este dispositivo")
            HorizontalDivider(color = Mm.Line)
            Line("Cambiar contraseña", tag = "changePassword", arrow = true) { changing = true }
            HorizontalDivider(color = Mm.Line)
            Line("Cerrar sesión", tag = "logout", danger = true) { vm.logout() }
        }

        Text("MyMusic ${BuildConfig.VERSION_NAME}", color = Mm.Mut, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp))
    }
    if (changing) PasswordDialog(vm) { changing = false }
}

/** Cambiar la propia contraseña: la actual y la nueva dos veces. Este dispositivo sigue dentro. */
@Composable
private fun PasswordDialog(vm: AppViewModel, onClose: () -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    @Composable
    fun Field(label: String, value: String, tag: String, onChange: (String) -> Unit) {
        Text(label, color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag(tag),
        )
    }

    AlertDialog(
        onDismissRequest = onClose,
        containerColor = Mm.Sur,
        titleContentColor = Mm.Tx,
        title = { Text("Cambiar contraseña", fontSize = 18.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            Column {
                Field("Contraseña actual", current, "pwCurrent") { current = it }
                Field("Contraseña nueva (mínimo 8 caracteres)", next, "pwNext") { next = it }
                Field("Repítela", again, "pwAgain") { again = it }
                if (error != null) Text(error.orEmpty(), color = Mm.Yt, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
                Spacer(Modifier.height(4.dp))
                Text("Tendrás que volver a entrar en tus otros dispositivos.", color = Mm.Mut, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && current.isNotEmpty() && next.isNotEmpty(),
                onClick = {
                    error = when {
                        next.length < 8 -> "La nueva necesita al menos 8 caracteres."
                        next != again -> "Las dos nuevas no coinciden."
                        else -> null
                    }
                    if (error == null) {
                        busy = true
                        vm.changePassword(current, next) { problem ->
                            busy = false
                            if (problem == null) onClose() else error = problem
                        }
                    }
                },
            ) { Text("Cambiar") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancelar", color = Mm.Mut) } },
    )
}
