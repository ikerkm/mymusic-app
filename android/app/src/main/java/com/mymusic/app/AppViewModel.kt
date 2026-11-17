package com.mymusic.app

import android.app.Application
import android.content.Intent
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mymusic.app.data.AlbumPage
import com.mymusic.app.data.Api
import com.mymusic.app.data.ApiException
import com.mymusic.app.data.AppRelease
import com.mymusic.app.data.ArtistCard
import com.mymusic.app.data.ArtistPage
import com.mymusic.app.data.ArtistSongs
import com.mymusic.app.data.AutoDetail
import com.mymusic.app.data.AutoHome
import com.mymusic.app.data.Entry
import com.mymusic.app.data.ImportPreview
import com.mymusic.app.data.LikeResult
import com.mymusic.app.data.ListDetail
import com.mymusic.app.data.ListSummary
import com.mymusic.app.data.MatchInfo
import com.mymusic.app.data.Prefs
import com.mymusic.app.data.ProbeResult
import com.mymusic.app.data.SessionView
import com.mymusic.app.data.Stats
import com.mymusic.app.data.Track
import com.mymusic.app.data.Trash
import com.mymusic.app.data.TrashedList
import com.mymusic.app.data.TrashedTrack
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
    data object Settings : Overlay
    data object Trash : Overlay
    data class ListDetail(val id: String) : Overlay
    /** Una lista automática de «Para ti»: top | forgotten | radio. */
    data class AutoList(val kind: String) : Overlay
    /** «Tus estadísticas». */
    data object Stats : Overlay
    // Artista y disco (§18, mockups/artista-disco-v1.html): datos de YouTube Music por el servidor
    data class Artist(val id: String) : Overlay
    /** «Ver todas»: todas sus canciones. */
    data class ArtistSongs(val id: String) : Overlay
    /** «Ver todos»: la discografía; `tab` = albums | singles. */
    data class Discography(val id: String, val tab: String) : Overlay
    data class Album(val id: String) : Overlay
}

/** En qué punto está la actualización de la app. */
sealed interface UpdateState {
    data object None : UpdateState
    data class Available(val release: AppRelease) : UpdateState
    data class Downloading(val release: AppRelease, val progress: Float) : UpdateState
    data class Failed(val release: AppRelease, val message: String) : UpdateState
}

/** En qué punto está la importación de una playlist de fuera a una lista propia. */
sealed interface ImportState {
    data object Idle : ImportState                                   // esperando el enlace
    data object Reading : ImportState                                // leyendo la playlist
    data class Ready(val preview: ImportPreview) : ImportState       // se enseña qué trae
    data class Adding(val preview: ImportPreview) : ImportState
    data class Failed(val message: String) : ImportState
}

/** En qué punto está «Probar extracción» (Ajustes). */
sealed interface ProbeState {
    data object Idle : ProbeState
    data object Running : ProbeState
    data class Done(val result: ProbeResult) : ProbeState
    data class Failed(val message: String) : ProbeState
}

/**
 * Canción sobre la que se ha abierto el menú. `listId` solo cuando se abre desde dentro de una lista;
 * `autoKind`, desde una lista automática (sin «Quitar de la lista» ni «Cambiar coincidencia»);
 * `albumId` / `artistId`, desde un disco o desde las canciones de un artista (§18): «Reproducir ahora»
 * pone el disco o sus canciones desde ella.
 */
data class SheetTarget(val track: Track, val listId: String? = null, val autoKind: String? = null, val albumId: String? = null, val artistId: String? = null)

/** «Ir al artista» con varios artistas («A, B»): se elige cuál. */
data class ArtistChoice(val track: Track, val artists: List<ArtistCard>)

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
    var userName by mutableStateOf(prefs.userName.orEmpty())      // usuario con el que se ha entrado
        private set

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
    var importFor by mutableStateOf<ListSummary?>(null)      // lista a la que se está importando
        private set
    var importState by mutableStateOf<ImportState>(ImportState.Idle)
        private set
    var matchFor by mutableStateOf<Track?>(null)             // canción de Spotify a la que se le cambia la coincidencia
        private set
    var matchInfo by mutableStateOf<MatchInfo?>(null)
        private set
    var searchHint by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)    // aviso breve en pantalla

    // --- Fase 4: radio, papelera y «Probar extracción» ---
    var radioOn by mutableStateOf(false)            // la casilla «Radio» del usuario (la recuerda el servidor)
        private set
    var radioStarting by mutableStateOf(false)      // «Tu radio» está buscando sus primeras canciones
        private set
    var trash by mutableStateOf<Trash?>(null)
        private set
    var restoreFor by mutableStateOf<TrashedTrack?>(null)     // canción de la papelera para la que se elige lista
    var probe by mutableStateOf<ProbeState>(ProbeState.Idle)
        private set

    // --- Listas automáticas y «Tus estadísticas» (mockups/estadisticas-v1.html) ---
    var forYou by mutableStateOf<AutoHome?>(null)             // «Para ti» en Inicio; null con un servidor anterior
        private set
    var openAuto by mutableStateOf<AutoDetail?>(null)
        private set
    var saveAutoFor by mutableStateOf<AutoDetail?>(null)      // lista automática que se está guardando como lista normal
    var statsPeriod by mutableStateOf("7")                    // 7 | 30 | all
        private set
    var stats by mutableStateOf<Stats?>(null)
        private set
    var statsError by mutableStateOf<String?>(null)
        private set
    var showSearch by mutableStateOf(false)                   // pide a la pantalla principal que pase a Buscar

    // --- Artista y disco (§18, mockups/artista-disco-v1.html) ---
    var searchArtists by mutableStateOf<List<ArtistCard>>(emptyList())   // la fila «Artistas» de Buscar
        private set
    val artistPages = mutableStateMapOf<String, ArtistPage>()          // ya leídas en esta visita (el servidor las guarda un día)
    val artistSongs = mutableStateMapOf<String, ArtistSongs>()
    val albumPages = mutableStateMapOf<String, AlbumPage>()
    val pageErrors = mutableStateMapOf<String, String>()               // «artist:<id>», «songs:<id>», «album:<id>» → mensaje
    var artistChoice by mutableStateOf<ArtistChoice?>(null)
    var saveAlbumFor by mutableStateOf<AlbumPage?>(null)               // disco que se está guardando como lista
    var artistRadioStarting by mutableStateOf<String?>(null)           // id del artista cuya radio se está buscando
        private set

    // --- «Me gusta» ---
    // Lo que se ha marcado o quitado en este dispositivo, por clave de canción. Solo hace falta para la
    // canción que suena mientras la sesión aún no ha llegado (el reproductor no guarda ese dato al día).
    private val likeChanges = mutableStateMapOf<String, Boolean>()

    private var lastKey: String? = null
    private var ticks = 0
    private var sessionRefresh: Job? = null

    init {
        if (loggedIn) {
            player.connect()
            // Al abrir: comprobar que el token sigue valiendo
            viewModelScope.launch {
                runCatching { api.me() }
                    .onSuccess { me ->
                        // Quien ya estaba dentro antes de que hubiera usuarios no tiene guardado su nombre: lo dice el servidor
                        val name = me.optJSONObject("user")?.optString("name").orEmpty()
                        if (name.isNotEmpty() && name != userName) {
                            prefs.userName = name
                            userName = name
                        }
                    }
                    .onFailure { if (it is ApiException && it.status == 401) logout(EXPIRED) }
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
                // Mientras suena, cada 15 s se mira si la sesión la ha tomado otro dispositivo del mismo usuario
                if (loggedIn && key != null && state.wantsToPlay && ++ticks % 30 == 0) refreshSessionSoon(key)
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
                // La radio ha añadido canciones: el reproductor aún no sabe cuál es la siguiente
                if (view.active && view.next != null && view.current?.track?.key == player.state.value.track?.key && !player.state.value.hasNext) player.apply(view)
                // Una sola sesión por usuario: si la ha tomado otro dispositivo suyo, este deja de sonar
                if (!view.active && player.state.value.wantsToPlay) {
                    player.pause()
                    notice = "Se está escuchando en otro dispositivo."
                    break
                }
                if (view.current?.track?.key == key) break
            }
            if (overlays.lastOrNull() == Overlay.Queue) loadQueue()
            refreshRecent()
        }
    }

    // ------------------------------------------------------------------ login

    fun login(serverInput: String, user: String, password: String) {
        if (loginBusy) return
        val server = Api.normalizeServer(serverInput)
        loginBusy = true
        loginError = null
        viewModelScope.launch {
            try {
                val (token, name) = api.login(server, user, password, "${Build.MANUFACTURER} ${Build.MODEL}")
                prefs.serverUrl = server
                prefs.userName = name
                prefs.token = token
                userName = name
                loggedIn = true
                player.connect()
            } catch (e: ApiException) {
                loginError = when (e.error) {
                    "bad_password" -> "Usuario o contraseña incorrectos."
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
        importFor = null
        matchFor = null
        matchInfo = null
        radioOn = false
        likeChanges.clear()
        trash = null
        restoreFor = null
        probe = ProbeState.Idle
        forYou = null
        openAuto = null
        saveAutoFor = null
        stats = null
        statsError = null
        statsPeriod = "7"
        searchArtists = emptyList()
        artistPages.clear()
        artistSongs.clear()
        albumPages.clear()
        pageErrors.clear()
        artistChoice = null
        saveAlbumFor = null
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
            Overlay.Settings, Overlay.Trash -> loadTrash()       // en Ajustes, para decir cuánto hay en la papelera
            Overlay.Player -> Unit
            is Overlay.AutoList -> loadAuto(overlay.kind)
            Overlay.Stats -> loadStats("7")                       // se abre siempre en «7 días»
            is Overlay.Artist -> loadArtist(overlay.id)
            is Overlay.Discography -> loadArtist(overlay.id)
            is Overlay.ArtistSongs -> loadArtistSongs(overlay.id)
            is Overlay.Album -> loadAlbum(overlay.id)
        }
    }

    /** Cambia de pestaña en la discografía sin apilar otra pantalla. */
    fun discographyTab(tab: String) {
        val top = overlays.lastOrNull() as? Overlay.Discography ?: return
        overlays[overlays.lastIndex] = top.copy(tab = tab)
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
        // Un servidor anterior a la radio no conoce esta dirección: la casilla se queda sin marcar
        runCatching { api.radio() }.onSuccess { radioOn = it }
        // Ni a las listas automáticas: «Para ti» no sale
        forYou = runCatching { api.autoHome() }.getOrNull()
    }

    // ------------------------------------------------------------------ listas automáticas y estadísticas

    private fun loadAuto(kind: String) {
        if (openAuto?.kind != kind) openAuto = null
        run("No se pudo abrir la lista.") { openAuto = api.auto(kind).also { detail -> detail.rows.forEach { likeChanges.remove(it.track.key) } } }
    }

    // Lo guardado cambia «en <lista>» / «sin guardar» de «Descubierto en la radio» y los contadores de «Para ti»
    private suspend fun refreshAuto() {
        val kind = openAuto?.kind ?: return
        if (overlays.none { it == Overlay.AutoList(kind) }) return
        runCatching { api.auto(kind) }.onSuccess { if (openAuto?.kind == kind) openAuto = it }
    }

    /** Una lista automática, desde `startKey` o desde el principio; con `shuffle`, en orden aleatorio. */
    fun playAuto(kind: String, startKey: String? = null, shuffle: Boolean = false) = viewModelScope.launch {
        try {
            start(api.startAuto(kind, startKey, shuffle))
        } catch (e: ApiException) {
            if (e.status == 401) logout(EXPIRED)
            else notice = if (e.error == "empty_list") "Esta lista todavía no tiene canciones." else "No se pudo reproducir la lista."
        } catch (e: Exception) {
            notice = "Sin conexión con el servidor."
        }
    }

    /**
     * «Guardar como lista»: copia la automática a una lista normal nueva, que ya no cambia sola, y la abre.
     * `done` recibe null si salió bien, o el mensaje de error (la hoja tapa los avisos de abajo).
     */
    fun saveAuto(kind: String, name: String, done: (String?) -> Unit) {
        viewModelScope.launch {
            try {
                val created = api.saveAuto(kind, name)
                saveAutoFor = null
                done(null)
                lists = api.lists()
                open(Overlay.ListDetail(created.id))
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED)
                done(
                    when (e.error) {
                        "bad_name" -> "Ponle un nombre a la lista."
                        "empty_list" -> "Esta lista no tiene canciones que guardar."
                        else -> "No se pudo guardar la lista (${e.status})."
                    }
                )
            } catch (e: Exception) {
                done("Sin conexión con el servidor.")
            }
        }
    }

    /** Cambia el periodo de «Tus estadísticas»: "7", "30" o "all". */
    fun loadStats(period: String) {
        statsPeriod = period
        statsError = null
        viewModelScope.launch {
            try {
                val loaded = api.stats(period)
                if (statsPeriod == period) stats = loaded
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED) else if (statsPeriod == period) statsError = "No se pudieron calcular las estadísticas."
            } catch (e: Exception) {
                if (statsPeriod == period) statsError = "Sin conexión con el servidor."
            }
        }
    }

    /** Tocar un artista en «Tus estadísticas»: Buscar con su nombre. */
    fun searchFor(text: String) {
        overlays.clear()
        query = text
        showSearch = true
        search()
    }

    // ------------------------------------------------------------------ artista y disco (§18)

    private fun pageFailed(key: String, e: Exception) {
        if (e is ApiException && e.status == 401) return logout(EXPIRED)
        pageErrors[key] = when {
            e is ApiException && e.status == 404 -> "YouTube Music no lo tiene."
            e is ApiException -> "No se ha podido leer YouTube Music ahora mismo. Prueba otra vez en un rato."
            else -> "Sin conexión con el servidor."
        }
    }

    private fun loadArtist(id: String) {
        if (artistPages.containsKey(id)) return
        pageErrors.remove("artist:$id")
        viewModelScope.launch {
            try {
                artistPages[id] = api.artist(id).also { page -> page.top.forEach { likeChanges.remove(it.key) } }
            } catch (e: Exception) {
                pageFailed("artist:$id", e)
            }
        }
    }

    private fun loadArtistSongs(id: String) {
        if (artistSongs.containsKey(id)) return
        pageErrors.remove("songs:$id")
        viewModelScope.launch {
            try {
                artistSongs[id] = api.artistSongs(id).also { list -> list.tracks.forEach { likeChanges.remove(it.key) } }
            } catch (e: Exception) {
                pageFailed("songs:$id", e)
            }
        }
    }

    private fun loadAlbum(id: String) {
        if (albumPages.containsKey(id)) return
        pageErrors.remove("album:$id")
        viewModelScope.launch {
            try {
                albumPages[id] = api.album(id).also { album -> album.tracks.forEach { likeChanges.remove(it.key) } }
            } catch (e: Exception) {
                pageFailed("album:$id", e)
            }
        }
    }

    /**
     * «Ir al artista» (reproductor, menú de la canción): el servidor lo busca en YouTube Music. Con uno, se
     * abre su página; con varios («A, B»), se elige; con ninguno, se avisa.
     */
    fun goArtistOf(track: Track) {
        viewModelScope.launch {
            try {
                val found = api.artistsOf(track)
                when (found.size) {
                    0 -> notice = "No he encontrado a este artista en YouTube Music."
                    1 -> openArtist(found[0].id)
                    else -> artistChoice = ArtistChoice(track, found)
                }
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED) else notice = "No se ha podido leer YouTube Music ahora mismo."
            } catch (e: Exception) {
                notice = "Sin conexión con el servidor."
            }
        }
    }

    /** Abre la página de un artista; si se estaba en el reproductor, se cierra (sigue sonando). */
    fun openArtist(id: String) {
        artistChoice = null
        overlays.removeAll { it == Overlay.Player || it == Overlay.Queue }
        open(Overlay.Artist(id))
    }

    fun playAlbum(id: String, startKey: String? = null, shuffle: Boolean = false) =
        run("No se pudo reproducir el disco.") { start(api.startAlbum(id, startKey, shuffle)) }

    fun playArtist(id: String, startKey: String? = null, shuffle: Boolean = false) =
        run("No se pudo reproducir. Prueba otra vez.") { start(api.startArtist(id, startKey, shuffle)) }

    /** «Radio» en la página de un artista: una de sus más escuchadas y, detrás, parecidas. */
    fun playArtistRadio(id: String) {
        if (artistRadioStarting != null) return
        artistRadioStarting = id
        viewModelScope.launch {
            try {
                start(api.startArtistRadio(id))
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED) else notice = when (e.error) {
                    "radio_empty" -> "No han salido canciones nuevas. Prueba más tarde."
                    else -> "No se pudo empezar la radio. Prueba otra vez."
                }
            } catch (e: Exception) {
                notice = "Sin conexión con el servidor."
            } finally {
                artistRadioStarting = null
            }
        }
    }

    /** «Guardar como lista»: el disco pasa a una lista nueva tuya y se abre. `done` recibe null o el error. */
    fun saveAlbum(id: String, name: String, done: (String?) -> Unit) {
        viewModelScope.launch {
            try {
                val created = api.saveAlbum(id, name)
                saveAlbumFor = null
                done(null)
                lists = api.lists()
                open(Overlay.ListDetail(created.id))
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED)
                done(if (e.error == "bad_name") "Ponle un nombre a la lista." else "No se pudo guardar la lista (${e.status}).")
            } catch (e: Exception) {
                done("Sin conexión con el servidor.")
            }
        }
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
                val found = api.search(text)
                results = found.results
                searchArtists = found.artists
                found.results.forEach { likeChanges.remove(it.key) }     // lo recién traído manda sobre lo apuntado aquí
                searchHint = when (found.hint) {
                    "playlist" -> "Eso es el enlace de una lista. Para traerla, abre una lista tuya y pulsa Importar."
                    "bad_link" -> "No reconozco ese enlace. Valen los de canciones de YouTube, Spotify y SoundCloud."
                    else -> null
                }
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
        // Este dispositivo pasa a llevar la sesión (si sonaba en otro, allí se para)
        run("No se pudo continuar.") { api.claim()?.let(::start) }
    }

    // ------------------------------------------------------------------ radio (Fase 4)

    /** Marca o desmarca la casilla «Radio»: al acabarse lo que suena, seguir con canciones parecidas. */
    fun setRadio(enabled: Boolean) {
        val before = radioOn
        radioOn = enabled
        viewModelScope.launch {
            try {
                radioOn = api.setRadio(enabled)
                if (radioOn) {
                    // Si ya se estaba al final de la lista, el servidor añade la tanda enseguida
                    delay(3_500)
                    player.state.value.track?.key?.let(::refreshSessionSoon)
                }
            } catch (e: Exception) {
                radioOn = before
                if (e is ApiException && e.status == 401) logout(EXPIRED) else notice = "No se pudo cambiar la radio."
            }
        }
    }

    /** «Tu radio» (Inicio): una sesión de canciones parecidas a lo que el usuario escucha. */
    fun playHomeRadio() {
        if (radioStarting) return
        radioStarting = true
        viewModelScope.launch {
            try {
                start(api.startHomeRadio())
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED) else notice = when (e.error) {
                    "no_seeds" -> "Todavía no hay de dónde partir: escucha algo o crea una lista."
                    "radio_empty" -> "No han salido canciones nuevas. Prueba más tarde."
                    else -> "No se pudo empezar la radio. Prueba otra vez."
                }
            } catch (e: Exception) {
                notice = "Sin conexión con el servidor."
            } finally {
                radioStarting = false
            }
        }
    }

    /** Guardar una canción que puso la radio: si se escucha una lista, va directa a ella; si no, se elige a cuál. */
    fun keepRadioTrack(track: Track) {
        val view = session
        val listId = view?.sourceId
        if (view?.sourceType == "list" && listId != null) addToList(ListSummary(listId, view.sourceName, 0, 0, null), track) else pickFor = track
    }

    // ------------------------------------------------------------------ «me gusta»

    /**
     * ¿Está la canción en «me gusta»? Manda lo más reciente que se sabe: la sesión (que el servidor
     * acaba de dar), después lo marcado en este dispositivo y, si no, lo que traía la canción.
     */
    fun isLiked(track: Track): Boolean {
        val inSession = session?.let { listOfNotNull(it.current, it.prev, it.next) }?.firstOrNull { it.track.key == track.key }
        return inSession?.track?.liked ?: likeChanges[track.key] ?: track.liked
    }

    // El cambio se apunta en las canciones que ya hay en pantalla, sin esperar a volver a pedirlas
    private fun markLiked(songKey: String, value: Boolean) {
        fun Track.marked() = if (key == songKey && liked != value) copy(liked = value) else this
        fun Entry.marked() = if (track.key == songKey && track.liked != value) copy(track = track.copy(liked = value)) else this
        likeChanges[songKey] = value
        results = results.map { it.marked() }
        recent = recent.map { it.marked() }
        history = history.map { it.marked() }
        openList = openList?.let { it.copy(tracks = it.tracks.map { track -> track.marked() }) }
        openAuto = openAuto?.let { it.copy(rows = it.rows.map { row -> row.copy(track = row.track.marked()) }) }
        stats = stats?.let { it.copy(topTracks = it.topTracks.map { (track, plays) -> track.marked() to plays }) }
        session = session?.let { it.copy(prev = it.prev?.marked(), current = it.current?.marked(), next = it.next?.marked()) }
        for (i in queue.indices) queue[i] = queue[i].marked()
        // Artista y disco (§18)
        for ((id, page) in artistPages.toMap()) artistPages[id] = page.copy(top = page.top.map { it.marked() })
        for ((id, list) in artistSongs.toMap()) artistSongs[id] = list.copy(tracks = list.tracks.map { it.marked() })
        for ((id, album) in albumPages.toMap()) albumPages[id] = album.copy(tracks = album.tracks.map { it.marked() })
    }

    /** El corazón: mete la canción en la lista de «me gusta» (arriba del todo) o la saca (a la papelera). */
    fun setLike(track: Track, liked: Boolean) = run("No se pudo cambiar el «me gusta». Prueba otra vez.") {
        val result: LikeResult = api.setLike(track, liked)
        markLiked(track.key, result.liked)
        val name = result.list?.name ?: "me gusta"
        notice = when {
            !result.liked -> "Quitada de «$name»"
            result.changed > 0 -> "Añadida a «$name»"
            else -> "Ya estaba en «$name»"
        }
        lists = api.lists()
        val likesId = result.list?.id
        if (likesId != null && openList?.summary?.id == likesId) openList = api.list(likesId)
        refreshAuto()
        // Guardada, deja de ser «de la radio»: la sesión y la cola lo reflejan
        if (result.liked && track.radio) {
            if (overlays.lastOrNull() == Overlay.Queue) loadQueue() else runCatching { api.session() }.getOrNull()?.let { session = it }
        }
    }

    fun toggleLike(track: Track) = setLike(track, !isLiked(track))

    // ------------------------------------------------------------------ papelera y «Probar extracción» (Fase 4)

    fun loadTrash() = run("No se pudo leer la papelera.") { trash = api.trash() }

    fun restoreList(item: TrashedList) = run("No se pudo restaurar.") {
        val list = api.restoreTrashed("list", item.id)
        notice = "Lista «${list.name}» restaurada"
        trash = api.trash()
        lists = api.lists()
    }

    /** Devuelve una canción a su lista; con `listId`, a otra (cuando la suya ya no existe). */
    fun restoreTrack(item: TrashedTrack, listId: String? = null) = run("No se pudo restaurar.") {
        restoreFor = null
        val list = api.restoreTrashed("track", item.id, listId)
        notice = "Devuelta a «${list.name}»"
        trash = api.trash()
        lists = api.lists()
        if (openList?.summary?.id == list.id) openList = api.list(list.id)
    }

    /** Pide al servidor que compruebe que el buscador responde y que YouTube entrega audio. */
    fun probeExtraction() {
        if (probe is ProbeState.Running) return
        probe = ProbeState.Running
        viewModelScope.launch {
            probe = try {
                ProbeState.Done(api.probe())
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED)
                ProbeState.Failed(if (e.error == "busy") "Ya hay una prueba en marcha." else "El servidor no ha podido hacer la prueba (${e.status}).")
            } catch (e: Exception) {
                ProbeState.Failed("Sin conexión con el servidor.")
            }
        }
    }

    // ------------------------------------------------------------------ cuenta

    /** Cambia la contraseña del usuario. `done` recibe null si salió bien, o el mensaje de error. */
    fun changePassword(current: String, next: String, done: (String?) -> Unit) {
        viewModelScope.launch {
            try {
                api.changePassword(current, next)
                notice = "Contraseña cambiada."
                done(null)
            } catch (e: ApiException) {
                done(
                    when (e.error) {
                        "bad_password" -> "La contraseña actual no es esa."
                        "weak_password" -> "La nueva necesita al menos 8 caracteres."
                        "too_many_attempts" -> "Demasiados intentos. Espera unos minutos."
                        else -> "No se pudo cambiar (${e.status})."
                    }
                )
            } catch (e: Exception) {
                done("Sin conexión con el servidor.")
            }
        }
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
        if (thenAdd != null) refreshAuto()
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
        run("No se pudo abrir la lista.") { openList = api.list(id).also { detail -> detail.tracks.forEach { likeChanges.remove(it.key) } } }
    }

    fun addToList(list: ListSummary, track: Track) = run("No se pudo añadir.") {
        val added = api.addToList(list.id, track)
        notice = if (added) "Añadida a «${list.name}»" else "Ya estaba en «${list.name}»"
        lists = api.lists()
        if (openList?.summary?.id == list.id) openList = api.list(list.id)
        refreshAuto()
        // Guardada, deja de ser «de la radio»: la sesión y la cola lo reflejan
        if (track.radio) {
            if (overlays.lastOrNull() == Overlay.Queue) loadQueue() else runCatching { api.session() }.getOrNull()?.let { session = it }
        }
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

    // ------------------------------------------------------------------ importar una playlist de fuera

    fun openImport(list: ListSummary) {
        importFor = list
        importState = ImportState.Idle
    }

    fun closeImport() {
        importFor = null
        importState = ImportState.Idle
    }

    /** Lee la playlist del enlace y enseña qué trae. Todavía no añade nada. */
    fun previewImport(url: String) {
        val list = importFor ?: return
        if (importState is ImportState.Reading || importState is ImportState.Adding) return
        importState = ImportState.Reading
        viewModelScope.launch {
            importState = try {
                ImportState.Ready(api.importPreview(list.id, url.trim()))
            } catch (e: ApiException) {
                if (e.status == 401) logout(EXPIRED)
                ImportState.Failed(
                    when (e.error) {
                        "bad_link" -> "Ese enlace no es de una lista de Spotify, YouTube o SoundCloud."
                        "not_a_playlist" -> "Es el enlace de una canción, no de una lista. Las canciones sueltas se pegan en Buscar."
                        "mix_not_supported" -> "Las mezclas automáticas de YouTube no se pueden importar."
                        "empty_playlist" -> "Esa lista está vacía."
                        "import_failed" -> "No se ha podido leer la lista. Comprueba que es pública."
                        else -> "No se ha podido leer la lista (${e.status})."
                    }
                )
            } catch (e: Exception) {
                ImportState.Failed("Sin conexión con el servidor.")
            }
        }
    }

    fun confirmImport() {
        val list = importFor ?: return
        val preview = (importState as? ImportState.Ready)?.preview ?: return
        importState = ImportState.Adding(preview)
        viewModelScope.launch {
            try {
                val added = api.confirmImport(list.id, preview.importId)
                notice = if (added == 1) "1 canción añadida a «${list.name}»" else "$added canciones añadidas a «${list.name}»"
                closeImport()
                lists = api.lists()
                if (openList?.summary?.id == list.id) openList = api.list(list.id)
            } catch (e: ApiException) {
                importState = ImportState.Failed(if (e.status == 410) "Ha pasado demasiado tiempo. Vuelve a pegar el enlace." else "No se pudo añadir. Prueba otra vez.")
            } catch (e: Exception) {
                importState = ImportState.Failed("Sin conexión con el servidor.")
            }
        }
    }

    // ------------------------------------------------------------------ coincidencia de una canción de Spotify

    /** Abre «Cambiar coincidencia»: busca los vídeos de YouTube candidatos para esa canción. */
    fun openMatch(track: Track) {
        matchFor = track
        matchInfo = null
        viewModelScope.launch {
            try {
                matchInfo = api.matchInfo(track.key)
            } catch (e: Exception) {
                if (e is ApiException && e.status == 401) logout(EXPIRED)
                matchFor = null
                notice = "No se pudieron buscar alternativas."
            }
        }
    }

    fun closeMatch() {
        matchFor = null
        matchInfo = null
    }

    fun chooseMatch(candidate: Track) {
        val track = matchFor ?: return
        closeMatch()
        run("No se pudo cambiar la coincidencia.") {
            api.chooseMatch(track.key, candidate)
            notice = "Coincidencia cambiada. Se oirá la próxima vez que suene."
            openList?.summary?.id?.let { openList = api.list(it) }
        }
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
