package com.mymusic.app.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.HttpDataSource
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.mymusic.app.data.Track
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** Lo que la pantalla necesita saber del reproductor. */
data class PlayerState(
    val track: Track? = null,
    val wantsToPlay: Boolean = false,     // el usuario ha dado a reproducir (aunque aún esté cargando)
    val isLoading: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val error: String? = null,
    val sessionExpired: Boolean = false,  // el servidor ha rechazado el token
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

    fun play(track: Track) {
        _state.update {
            PlayerState(track = track, wantsToPlay = true, isLoading = true, durationMs = (track.durationSec ?: 0) * 1000L)
        }
        val start = {
            controller?.run {
                setMediaItem(track.toMediaItem())
                prepare()
                play()
            }
            Unit
        }
        if (controller != null) start() else {
            pending = start
            connect()
        }
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

    fun seekTo(positionMs: Long) {
        controller?.seekTo(positionMs)
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
        val meta = item.mediaMetadata
        val previous = _state.value
        val duration = c.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: previous.durationMs
        val error = c.playerError
        _state.value = PlayerState(
            track = Track(
                key = item.mediaId,
                title = meta.title?.toString().orEmpty(),
                artist = meta.artist?.toString(),
                durationSec = (duration / 1000).toInt().takeIf { it > 0 },
                thumb = meta.artworkUri?.toString(),
                platform = "youtube",
            ),
            wantsToPlay = c.playWhenReady && c.playbackState != Player.STATE_ENDED && c.playbackState != Player.STATE_IDLE,
            isLoading = c.playbackState == Player.STATE_BUFFERING,
            positionMs = c.currentPosition.coerceAtLeast(0),
            durationMs = duration,
            error = error?.let(::describe),
            sessionExpired = error?.httpStatus() == 401,
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

    private fun Track.toMediaItem(): MediaItem =
        MediaItem.Builder()
            .setMediaId(key)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(artist)
                    .setArtworkUri(thumb?.let(Uri::parse))
                    .build()
            )
            .build()
}
