package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mymusic.app.AppViewModel

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = Mm.Sur,
    unfocusedContainerColor = Mm.Sur,
    focusedBorderColor = Mm.Acc,
    unfocusedBorderColor = Mm.Line,
    cursorColor = Mm.Acc,
    focusedTextColor = Mm.Tx,
    unfocusedTextColor = Mm.Tx,
)

/** Pantalla 1 de la maqueta: dirección del servidor y contraseña propia. */
@Composable
fun LoginScreen(vm: AppViewModel) {
    var server by rememberSaveable { mutableStateOf(vm.savedServer) }
    var user by rememberSaveable { mutableStateOf(vm.userName) }
    var password by rememberSaveable { mutableStateOf("") }
    val submit = { if (password.isNotEmpty() && user.isNotBlank()) vm.login(server, user, password) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Mm.Bg)
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(58.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(Brush.linearGradient(listOf(Color(0xFFFF6BD6), Color(0xFF5B2BFF))))
        )
        Spacer(Modifier.height(16.dp))
        Text("MyMusic", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Mm.Tx)
        Text("Tu música, desde tu servidor", color = Mm.Mut, fontSize = 14.sp)

        Spacer(Modifier.height(22.dp))
        Text("Servidor", color = Mm.Mut, fontSize = 12.sp)
        Spacer(Modifier.height(5.dp))
        OutlinedTextField(
            value = server,
            onValueChange = { server = it },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth().testTag("server"),
        )

        Spacer(Modifier.height(14.dp))
        Text("Usuario", color = Mm.Mut, fontSize = 12.sp)
        Spacer(Modifier.height(5.dp))
        OutlinedTextField(
            value = user,
            onValueChange = { user = it.take(30) },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth().testTag("user"),
        )

        Spacer(Modifier.height(14.dp))
        Text("Contraseña", color = Mm.Mut, fontSize = 12.sp)
        Spacer(Modifier.height(5.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth().testTag("password"),
        )

        if (vm.loginError != null) {
            Spacer(Modifier.height(12.dp))
            Text(vm.loginError.orEmpty(), color = Mm.Yt, fontSize = 13.sp)
        }

        Spacer(Modifier.height(18.dp))
        Button(
            onClick = submit,
            enabled = !vm.loginBusy && password.isNotEmpty() && user.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(46.dp),
        ) {
            if (vm.loginBusy) {
                CircularProgressIndicator(Modifier.size(20.dp), color = Mm.OnAcc, strokeWidth = 2.dp)
            } else {
                Text("Entrar", fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "Solo se pide la primera vez en cada dispositivo.",
            color = Mm.Mut,
            fontSize = 12.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
