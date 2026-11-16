package com.mymusic.app.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
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
import com.mymusic.app.data.Prefs

/**
 * Servicio de reproducción. Vive aparte de la pantalla: sigue sonando con la app cerrada o el
 * móvil bloqueado, y es quien publica los controles en la pantalla de bloqueo, la notificación
 * y los botones de auriculares o coche.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val prefs = Prefs(this)

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

        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        session = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .setCallback(SessionCallback(prefs))
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    // Al quitar la app de recientes: si no está sonando, el servicio se apaga
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    /**
     * La pantalla solo dice «reproduce esta canción» (su clave y sus datos). La dirección real del
     * audio se construye aquí, con el servidor configurado.
     */
    private class SessionCallback(private val prefs: Prefs) : MediaSession.Callback {
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val base = prefs.serverUrl.orEmpty()
            val resolved = mediaItems.map { item ->
                item.buildUpon().setUri("$base/api/stream/${item.mediaId}").build()
            }.toMutableList()
            return Futures.immediateFuture(resolved)
        }
    }
}
