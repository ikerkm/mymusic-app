package com.mymusic.app

import android.app.Application
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mymusic.app.data.Api
import com.mymusic.app.data.ApiException
import com.mymusic.app.data.Prefs
import com.mymusic.app.data.Track
import com.mymusic.app.playback.PlayerConnection
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Dirección propuesta en la pantalla de login (D11 de la SPEC). */
const val DEFAULT_SERVER = "https://mymusic.example.com"

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = Prefs(app)
    private val api = Api(prefs)
    val player = PlayerConnection(app)

    var loggedIn by mutableStateOf(prefs.loggedIn)
        private set
    var loginBusy by mutableStateOf(false)
        private set
    var loginError by mutableStateOf<String?>(null)
        private set
    val savedServer: String get() = prefs.serverUrl ?: DEFAULT_SERVER

    var query by mutableStateOf("")
    var results by mutableStateOf<List<Track>>(emptyList())
        private set
    var searching by mutableStateOf(false)
        private set
    var searched by mutableStateOf(false)
        private set
    var searchError by mutableStateOf<String?>(null)
        private set

    init {
        if (loggedIn) {
            player.connect()
            // Al abrir: comprobar que el token sigue valiendo
            viewModelScope.launch {
                runCatching { api.me() }.onFailure { if (it is ApiException && it.status == 401) logout("Sesión caducada. Vuelve a entrar.") }
            }
        }
        // La barra de progreso se refresca dos veces por segundo
        viewModelScope.launch {
            while (true) {
                player.sync()
                if (player.state.value.sessionExpired && loggedIn) logout("Sesión caducada. Vuelve a entrar.")
                delay(500)
            }
        }
    }

    fun login(serverInput: String, password: String) {
        if (loginBusy) return
        val server = Api.normalizeServer(serverInput)
        loginBusy = true
        loginError = null
        viewModelScope.launch {
            try {
                val token = api.login(server, password, "${Build.MANUFACTURER} ${Build.MODEL}")
                prefs.serverUrl = server
                prefs.token = token
                loggedIn = true
                player.connect()
            } catch (e: ApiException) {
                loginError = when (e.error) {
                    "bad_password" -> "Contraseña incorrecta."
                    "too_many_attempts" -> "Demasiados intentos. Espera unos minutos."
                    "no_password_set" -> "El servidor todavía no tiene contraseña."
                    else -> "El servidor respondió con un error (${e.status})."
                }
            } catch (e: Exception) {
                loginError = "No se pudo conectar con el servidor."
            } finally {
                loginBusy = false
            }
        }
    }

    fun logout(message: String? = null) {
        player.stop()
        prefs.token = null
        results = emptyList()
        searched = false
        query = ""
        loginError = message
        loggedIn = false
    }

    fun search() {
        val text = query.trim()
        if (text.isEmpty() || searching) return
        searching = true
        searchError = null
        viewModelScope.launch {
            try {
                results = api.search(text)
                searched = true
            } catch (e: ApiException) {
                if (e.status == 401) logout("Sesión caducada. Vuelve a entrar.") else searchError = "La búsqueda ha fallado. Prueba otra vez."
            } catch (e: Exception) {
                searchError = "Sin conexión con el servidor."
            } finally {
                searching = false
            }
        }
    }

    override fun onCleared() {
        player.release()
    }
}
