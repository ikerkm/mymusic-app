package com.mymusic.app.playback

import android.content.ComponentName
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.HttpDataSource
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.mymusic.app.data.SessionView
import com.mymusic.app.data.Track
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Lo que la pantalla necesita saber del reproductor. */
data class PlayerState(
    val track: Track? = null,
    val wantsToPlay: Boolean = false,     // el usuario ha dado a reproducir (aunque aún esté cargando)
    val isLoading: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val hasNext: Boolean = false,
    val error: String? = null,
    val sessionExpired: Boolean = false,  // el servidor ha rechazado el token
    val failure: FailureNotice? = null,   // canción que no se pudo reproducir (§19): el aviso o por qué se paró
)

/** Puente entre la pantalla y el servicio de reproducción. */
class PlayerConnection(private val context: Context) {

    private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state

    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var pending: (() -> Unit)? = null

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = sync()
    }

    fun connect() {
        if (future != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val building = MediaController.Builder(context, token).buildAsync()
        future = building
        building.addListener({
            runCatching { building.get() }.onSuccess { connected ->
                controller = connected
                connected.addListener(listener)
                sync()
                pending?.invoke()
                pending = null
            }
        }, ContextCompat.getMainExecutor(context))
    }

    fun release() {
        controller?.removeListener(listener)
        future?.let { MediaController.releaseFuture(it) }
        future = null
        controller = null
    }

    /** Carga en el reproductor la ventana de la sesión (anterior, actual, siguiente) y, si se pide, empieza a sonar. */
    fun load(view: SessionView, play: Boolean = true) {
        val (tracks, start) = Playlist.window(view)
        val current = tracks.getOrNull(start) ?: return
        _state.value = PlayerState(
            track = current,
            wantsToPlay = play,
            isLoading = true,
            positionMs = view.positionMs,
            durationMs = (current.durationSec ?: 0) * 1000L,
            hasNext = view.next != null,
        )
        val begin = {
            controller?.run {
                setMediaItems(tracks.map { Playlist.item(it) }, start, view.positionMs)
                repeatMode = if (view.repeat == "one") Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                prepare()
                if (play) play() else pause()
            }
            Unit
        }
        if (controller != null) begin() else {
            pending = begin
            connect()
        }
    }

    /** Tras tocar la cola, el aleatorio o la repetición: ajusta la anterior y la siguiente sin cortar lo que suena. */
    fun apply(view: SessionView) {
        controller?.let { c -> Playlist.reconcile(c, view) { Playlist.item(it) } }
        sync()
    }

    fun toggle() {
        val c = controller ?: return
        if (c.playWhenReady && c.playbackState != Player.STATE_IDLE && c.playbackState != Player.STATE_ENDED) {
            c.pause()
        } else {
            if (c.playbackState == Player.STATE_IDLE) c.prepare()
            if (c.playbackState == Player.STATE_ENDED) c.seekTo(0)
            c.play()
        }
    }

    fun pause() {
        controller?.pause()
    }

    fun seekTo(positionMs: Long) {
        controller?.seekTo(positionMs)
    }

    fun next() {
        controller?.seekToNextMediaItem()
    }

    /** Como en cualquier reproductor: pasados unos segundos vuelve al principio de la canción; si no, a la anterior. */
    fun previous() {
        controller?.seekToPrevious()
    }

    fun stop() {
        controller?.run {
            stop()
            clearMediaItems()
        }
        _state.value = PlayerState()
    }

    /** Copia el estado real del reproductor. Se llama en cada evento y periódicamente para la barra. */
    fun sync() {
        val c = controller ?: return
        val item = c.currentMediaItem
        if (item == null) {
            if (_state.value.track != null && pending == null) _state.value = PlayerState()
            return
        }
        val track = Playlist.track(item)
        val fallback = if (_state.value.track?.key == track.key) _state.value.durationMs else (track.durationSec ?: 0) * 1000L
        val duration = c.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: fallback
        val error = c.playerError
        // El servicio cuenta las canciones que no se pudieron reproducir (§19): con el motivo, y si salta o se para
        val failure = FailureNotice.from(c.sessionExtras)
        _state.value = PlayerState(
            track = track,
            wantsToPlay = c.playWhenReady && c.playbackState != Player.STATE_ENDED && c.playbackState != Player.STATE_IDLE,
            isLoading = c.playbackState == Player.STATE_BUFFERING,
            positionMs = c.currentPosition.coerceAtLeast(0),
            durationMs = duration,
            hasNext = c.hasNextMediaItem(),
            error = if (error != null && failure?.key == track.key) failure.message else error?.let(::describe),
            sessionExpired = error?.httpStatus() == 401,
            failure = failure,
        )
    }

    private fun PlaybackException.httpStatus(): Int? =
        generateSequence(cause) { it.cause }
            .filterIsInstance<HttpDataSource.InvalidResponseCodeException>()
            .firstOrNull()?.responseCode

    private fun describe(error: PlaybackException): String = when (error.httpStatus()) {
        401 -> "Sesión caducada. Vuelve a entrar."
        502 -> "No se pudo extraer el audio de esta canción."
        null -> when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "Sin conexión con el servidor."
            else -> "No se pudo reproducir (${error.errorCodeName})."
        }
        else -> "El servidor respondió con un error (${error.httpStatus()})."
    }
}
