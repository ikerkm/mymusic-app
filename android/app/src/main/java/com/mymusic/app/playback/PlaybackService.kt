package com.mymusic.app.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.mymusic.app.BuildConfig
import com.mymusic.app.MainActivity
import com.mymusic.app.data.Api
import com.mymusic.app.data.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Servicio de reproducción. Vive aparte de la pantalla: sigue sonando con la app cerrada o el
 * móvil bloqueado, y es quien publica los controles en la pantalla de bloqueo, la notificación
 * y los botones de auriculares o coche.
 *
 * También es quien avanza la sesión canción a canción: al cambiar de canción se lo dice al
 * servidor y recibe cuál es la siguiente. Tiene que hacerlo él y no la pantalla, porque la
 * pantalla puede llevar horas cerrada.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val advancing = Mutex()        // los avisos al servidor salen de uno en uno y en orden
    private lateinit var prefs: Prefs
    private lateinit var api: Api

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        api = Api(prefs)

        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("MyMusic/${BuildConfig.VERSION_NAME}")
            .setConnectTimeoutMs(15_000)
            // El servidor no responde hasta que termina de extraer la canción (más de 10 s en frío)
            .setReadTimeoutMs(90_000)
        // El token se añade en cada petición, por si cambia mientras el servicio está vivo
        val authorized = ResolvingDataSource.Factory(http) { spec ->
            spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer ${prefs.token.orEmpty()}"))
        }

        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(authorized))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)      // pausa al desconectar los auriculares
            .setWakeMode(C.WAKE_MODE_NETWORK)       // CPU y Wi-Fi despiertos mientras suena
            .build()

        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                // Solo los cambios de canción de verdad: acaba la anterior (AUTO) o se pulsa siguiente/anterior (SEEK).
                // Los cambios que hacemos nosotros en la lista (PLAYLIST_CHANGED) y la repetición no avanzan la sesión.
                if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && reason != Player.MEDIA_ITEM_TRANSITION_REASON_SEEK) return
                val key = mediaItem?.mediaId ?: return
                advance(player, key)
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) report(player)
            }
        })

        // Mientras suena, el servidor sabe por dónde vamos (para «Continuar» y para el historial)
        scope.launch {
            while (isActive) {
                delay(20_000)
                if (player.isPlaying) report(player)
            }
        }

        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        session = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .setCallback(SessionCallback(prefs))
            .build()
    }

    /** Avisa al servidor de que ahora suena `key` y coloca en el reproductor la siguiente que él diga. */
    private fun advance(player: Player, key: String) {
        scope.launch {
            advancing.withLock {
                // Sin la respuesta no hay canción siguiente: se insiste unas cuantas veces
                for (attempt in 1..4) {
                    val view = runCatching { api.goto(key) }.getOrNull()
                    if (view != null) {
                        Playlist.reconcile(player, view) { Playlist.item(it, prefs.serverUrl.orEmpty()) }
                        return@withLock
                    }
                    if (player.currentMediaItem?.mediaId != key) return@withLock     // ya suena otra: este aviso sobra
                    delay(3_000L * attempt)
                }
            }
        }
    }

    private fun report(player: Player) {
        val key = player.currentMediaItem?.mediaId ?: return
        val position = player.currentPosition
        if (position <= 0) return
        scope.launch { runCatching { api.reportState(key, position) } }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    // Al quitar la app de recientes: si no está sonando, el servicio se apaga
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    /**
     * La pantalla solo dice «reproduce estas canciones» (sus claves y sus datos). La dirección real
     * del audio se construye aquí, con el servidor configurado.
     */
    private class SessionCallback(private val prefs: Prefs) : MediaSession.Callback {
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val base = prefs.serverUrl.orEmpty()
            val resolved = mediaItems.map { item ->
                item.buildUpon().setUri(Playlist.streamUri(base, item.mediaId)).build()
            }.toMutableList()
            return Futures.immediateFuture(resolved)
        }
    }
}
