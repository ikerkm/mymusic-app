package com.mymusic.app

import android.app.Application
import android.content.Intent
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mymusic.app.data.Api
import com.mymusic.app.data.ApiException
import com.mymusic.app.data.AppRelease
import com.mymusic.app.data.Entry
import com.mymusic.app.data.ListDetail
import com.mymusic.app.data.ListSummary
import com.mymusic.app.data.Prefs
import com.mymusic.app.data.SessionView
import com.mymusic.app.data.Track
import com.mymusic.app.playback.PlayerConnection
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/** Dirección propuesta en la pantalla de login (D11 de la SPEC). */
const val DEFAULT_SERVER = "https://mymusic.example.com"

private const val EXPIRED = "Sesión caducada. Vuelve a entrar."

/** Pantallas que se abren por encima de las tres pestañas. */
sealed interface Overlay {
    data object Player : Overlay
    data object Queue : Overlay
    data object History : Overlay
    data class ListDetail(val id: String) : Overlay
}

/** En qué punto está la actualización de la app. */
sealed interface UpdateState {
    data object None : UpdateState
    data class Available(val release: AppRelease) : UpdateState
    data class Downloading(val release: AppRelease, val progress: Float) : UpdateState
    data class Failed(val release: AppRelease, val message: String) : UpdateState
}

/** Canción sobre la que se ha abierto el menú. `listId` solo cuando se abre desde dentro de una lista. */
data class SheetTarget(val track: Track, val listId: String? = null)

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = Prefs(app)
    private val api = Api(prefs)
    val player = PlayerConnection(app)

    // --- Login ---
    var loggedIn by mutableStateOf(prefs.loggedIn)
        private set
    var loginBusy by mutableStateOf(false)
        private set
    var loginError by mutableStateOf<String?>(null)
        private set
    val savedServer: String get() = prefs.serverUrl ?: DEFAULT_SERVER

    // --- Buscar ---
    var query by mutableStateOf("")
    var results by mutableStateOf<List<Track>>(emptyList())
        private set
    var searching by mutableStateOf(false)
        private set
    var searched by mutableStateOf(false)
        private set
    var searchError by mutableStateOf<String?>(null)
        private set

    // --- Sesión de escucha, listas, historial ---
    var session by mutableStateOf<SessionView?>(null)
        private set
    var lists by mutableStateOf<List<ListSummary>>(emptyList())
        private set
    var recent by mutableStateOf<List<Track>>(emptyList())
        private set
    var history by mutableStateOf<List<Track>>(emptyList())
        private set
    var openList by mutableStateOf<ListDetail?>(null)
        private set
    val queue = mutableStateListOf<Entry>()        // la canción actual y las que vienen, cargadas de 20 en 20
    var queueCount by mutableStateOf(0)
        private set
    private var queueLoading = false

    // --- Navegación y avisos ---
    val overlays = mutableStateListOf<Overlay>()
    var update by mutableStateOf<UpdateState>(UpdateState.None)
        private set
    var sheet by mutableStateOf<SheetTarget?>(null)
    var pickFor by mutableStateOf<Track?>(null)    // canción para la que se está eligiendo lista
    var notice by mutableStateOf<String?>(null)    // aviso breve en pantalla

    private var lastKey: String? = null
    private var sessionRefresh: Job? = null

    init {
        if (loggedIn) {
            player.connect()
            // Al abrir: comprobar que el token sigue valiendo
            viewModelScope.launch {
                runCatching { api.me() }.onFailure { if (it is ApiException && it.status == 401) logout(EXPIRED) }
            }
        }
        // Dos veces por segundo: barra de progreso, sesión caducada y cambio de canción
        viewModelScope.launch {
            while (true) {
                player.sync()
                val state = player.state.value
                if (state.sessionExpired && loggedIn) logout(EXPIRED)
                val key = state.track?.key
                if (loggedIn && key != lastKey) {
                    lastKey = key
                    if (key != null) refreshSessionSoon(key)
                }
                delay(500)
            }
        }
    }

    /** Lanza una acción contra el servidor con el tratamiento de errores común. */
    private fun run(onError: String = "No se pudo completar. Prueba otra vez.", block: suspend () -> Unit): Job =
        viewModelScope.launch {
            try {
                block()
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED) else notice = onError
            } catch (e: Exception) {
                notice = "Sin conexión con el servidor."
            }
        }

    // Al cambiar de canción (por sí sola, o desde la pantalla de bloqueo) es el servicio quien avisa al
    // servidor; la pantalla vuelve a pedir la sesión un momento después para enseñar «14 de 212».
    private fun refreshSessionSoon(key: String) {
        sessionRefresh?.cancel()
        sessionRefresh = viewModelScope.launch {
            for (wait in listOf(700L, 1500L, 3000L)) {
                delay(wait)
                val view = runCatching { api.session() }.getOrNull() ?: continue
                session = view
                if (view.current?.track?.key == key) break
            }
            if (overlays.lastOrNull() == Overlay.Queue) loadQueue()
            refreshRecent()
        }
    }

    // ------------------------------------------------------------------ login

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
        session = null
        lists = emptyList()
        recent = emptyList()
        openList = null
        queue.clear()
        overlays.clear()
        sheet = null
        pickFor = null
        loginError = message
        loggedIn = false
    }

    // ------------------------------------------------------------------ navegación

    fun open(overlay: Overlay) {
        if (overlays.lastOrNull() != overlay) overlays.add(overlay)
        when (overlay) {
            is Overlay.ListDetail -> loadList(overlay.id)
            Overlay.Queue -> loadQueue()
            Overlay.History -> run { history = api.history(100, distinct = false) }
            Overlay.Player -> Unit
        }
    }

    fun back() {
        if (overlays.isNotEmpty()) overlays.removeAt(overlays.lastIndex)
    }

    // ------------------------------------------------------------------ inicio

    fun refreshHome() = run {
        checkUpdate()
        lists = api.lists()
        session = api.session()
        recent = api.history(6, distinct = true)
    }

    // ------------------------------------------------------------------ actualización de la app

    /** Pregunta al servidor si hay una versión más nueva que la instalada. */
    fun checkUpdate() {
        if (update is UpdateState.Downloading) return
        viewModelScope.launch {
            val latest = runCatching { api.latestApp() }.getOrNull()
            if (update is UpdateState.Downloading) return@launch
            update = if (latest != null && latest.versionCode > BuildConfig.VERSION_CODE) UpdateState.Available(latest) else UpdateState.None
        }
    }

    /** Descarga el instalable del servidor, lo comprueba y abre el instalador de Android (que pide confirmar). */
    fun installUpdate() {
        val release = when (val state = update) {
            is UpdateState.Available -> state.release
            is UpdateState.Failed -> state.release
            else -> return
        }
        update = UpdateState.Downloading(release, 0f)
        viewModelScope.launch {
            try {
                val app = getApplication<Application>()
                val file = File(app.cacheDir, "updates/mymusic-${release.versionCode}.apk")
                api.downloadApp(release, file) { progress -> update = UpdateState.Downloading(release, progress) }
                update = UpdateState.Available(release)
                val uri = FileProvider.getUriForFile(app, "${app.packageName}.files", file)
                app.startActivity(
                    Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED) else update = UpdateState.Failed(release, "No se pudo descargar la actualización.")
            } catch (e: Exception) {
                update = UpdateState.Failed(release, "No se pudo descargar la actualización.")
            }
        }
    }

    private fun refreshRecent() = viewModelScope.launch {
        runCatching { api.history(6, distinct = true) }.onSuccess { recent = it }
    }

    // ------------------------------------------------------------------ buscar

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
                if (e.status == 401) logout(EXPIRED) else searchError = "La búsqueda ha fallado. Prueba otra vez."
            } catch (e: Exception) {
                searchError = "Sin conexión con el servidor."
            } finally {
                searching = false
            }
        }
    }

    // ------------------------------------------------------------------ reproducir

    private fun start(view: SessionView) {
        session = view
        lastKey = view.current?.track?.key      // la pantalla ya tiene la sesión: no hace falta volver a pedirla
        player.load(view)
    }

    /** Una canción suelta (desde el buscador o el historial). */
    fun playTrack(track: Track) = run("No se pudo reproducir. Prueba otra vez.") { start(api.startTrack(track)) }

    /** Una lista, desde `startKey` o desde el principio; con `shuffle`, en orden aleatorio. */
    fun playList(listId: String, startKey: String? = null, shuffle: Boolean = false) =
        run("No se pudo reproducir la lista.") { start(api.startList(listId, startKey, shuffle)) }

    /** «Continuar»: retoma la sesión que guarda el servidor, en la canción y el minuto donde se dejó. */
    fun resume() {
        if (player.state.value.track != null) {
            if (!player.state.value.wantsToPlay) player.toggle()
            open(Overlay.Player)
            return
        }
        run("No se pudo continuar.") { api.session()?.let(::start) }
    }

    private fun changed(view: SessionView) {
        session = view
        if (player.state.value.track == null) player.load(view) else player.apply(view)
        if (overlays.lastOrNull() == Overlay.Queue) loadQueue()
    }

    fun playNext(track: Track) = run {
        changed(api.enqueue(track, "next"))
        notice = "Sonará a continuación"
    }

    fun addToQueue(track: Track) = run {
        changed(api.enqueue(track, "end"))
        notice = "Añadida a la cola"
    }

    fun toggleShuffle() = run { changed(api.sessionOptions(shuffle = !(session?.shuffle ?: false))) }

    fun cycleRepeat() = run {
        val next = when (session?.repeat) { "off" -> "all"; "all" -> "one"; else -> "off" }
        changed(api.sessionOptions(repeat = next))
    }

    // ------------------------------------------------------------------ listas

    fun createList(name: String, thenAdd: Track? = null) = run("No se pudo crear la lista.") {
        val created = api.createList(name)
        if (thenAdd != null) api.addToList(created.id, thenAdd)
        lists = api.lists()
        notice = if (thenAdd != null) "Añadida a «${created.name}»" else null
    }

    fun renameList(id: String, name: String) = run("No se pudo renombrar.") {
        api.renameList(id, name)
        lists = api.lists()
        if (openList?.summary?.id == id) openList = api.list(id)
    }

    /** A la papelera del servidor (no se borra). */
    fun deleteList(id: String) = run("No se pudo quitar la lista.") {
        api.deleteList(id)
        lists = api.lists()
        overlays.removeAll { it is Overlay.ListDetail && it.id == id }
        notice = "Lista enviada a la papelera"
    }

    private fun loadList(id: String) {
        if (openList?.summary?.id != id) openList = null
        run("No se pudo abrir la lista.") { openList = api.list(id) }
    }

    fun addToList(list: ListSummary, track: Track) = run("No se pudo añadir.") {
        val added = api.addToList(list.id, track)
        notice = if (added) "Añadida a «${list.name}»" else "Ya estaba en «${list.name}»"
        lists = api.lists()
        if (openList?.summary?.id == list.id) openList = api.list(list.id)
    }

    /** A la papelera del servidor (no se borra). */
    fun removeFromList(listId: String, track: Track) = run("No se pudo quitar.") {
        api.removeFromList(listId, track.key)
        openList = api.list(listId)
        lists = api.lists()
        notice = "Quitada de la lista"
    }

    fun moveInList(listId: String, key: String, toIndex: Int) = run("No se pudo reordenar.") {
        api.moveInList(listId, key, toIndex)
        openList = api.list(listId)
    }

    // ------------------------------------------------------------------ cola

    fun loadQueue() = run("No se pudo cargar la cola.") {
        val from = api.session()?.also { session = it }?.index ?: return@run
        val page = api.queue(from)
        queue.clear()
        queue.addAll(page.entries)
        queueCount = page.count
    }

    /** La pantalla lo llama al acercarse al final de lo cargado. */
    fun loadMoreQueue() {
        val last = queue.lastOrNull() ?: return
        if (queueLoading || last.index + 1 >= queueCount) return
        queueLoading = true
        run {
            try {
                val page = api.queue(last.index + 1)
                if (queue.lastOrNull()?.index == last.index) queue.addAll(page.entries)
                queueCount = page.count
            } finally {
                queueLoading = false
            }
        }
    }

    /** Lleva una canción de la cola a la posición `to` de la sesión. */
    fun moveQueued(key: String, to: Int) = run("No se pudo reordenar la cola.") { changed(api.moveQueued(key, to)) }

    /** Quita de la cola una canción que aún no ha sonado (no la quita de su lista). */
    fun removeQueued(key: String) = run("No se pudo quitar de la cola.") { changed(api.removeQueued(key)) }

    override fun onCleared() {
        player.release()
    }
}
