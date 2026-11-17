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
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.mymusic.app.BuildConfig
import com.mymusic.app.MainActivity
import com.mymusic.app.data.Api
import com.mymusic.app.data.ApiException
import com.mymusic.app.data.Prefs
import com.mymusic.app.data.Track
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
            // Saltar por estimación en los formatos sin índice (el AAC de SoundCloud llega en ADTS)
            .setMediaSourceFactory(DefaultMediaSourceFactory(authorized, DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)))
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

            override fun onPlaybackStateChanged(playbackState: Int) {
                // Se acabó lo que había: con la radio, el servidor puede estar añadiendo la siguiente
                if (playbackState == Player.STATE_ENDED) awaitNext(player)
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                // Se pulsa reproducir (app, notificación, auriculares): si la sesión la llevaba otro dispositivo, vuelve aquí
                if (playWhenReady) reclaim(player)
            }
        })

        // Mientras suena, el servidor sabe por dónde vamos (para «Continuar» y para el historial)
        scope.launch {
            while (isActive) {
                delay(20_000)
                if (player.isPlaying) {
                    report(player)
                    // La radio añade canciones por su cuenta: si aquí no hay siguiente, se pregunta si ya la hay
                    if (!player.hasNextMediaItem() && player.repeatMode == Player.REPEAT_MODE_OFF) refreshWindow(player)
                }
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
                    val view = try {
                        api.goto(key)
                    } catch (e: ApiException) {
                        // 409: la sesión la lleva ahora otro dispositivo del mismo usuario. Este se calla.
                        if (e.status == 409) {
                            player.pause()
                            return@withLock
                        }
                        null
                    } catch (e: Exception) {
                        null
                    }
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

    private fun item(track: Track): MediaItem = Playlist.item(track, prefs.serverUrl.orEmpty())

    /** Si el servidor ya tiene canción siguiente y el reproductor no (la radio acaba de añadirla), se coloca. */
    private fun refreshWindow(player: Player) {
        scope.launch {
            advancing.withLock {
                val key = player.currentMediaItem?.mediaId ?: return@withLock
                val view = runCatching { api.session() }.getOrNull() ?: return@withLock
                if (view.active && view.current?.track?.key == key && view.next != null) Playlist.reconcile(player, view, ::item)
            }
        }
    }

    /**
     * La última canción ha terminado. Con la radio encendida el servidor añade más: se le pregunta y, mientras
     * diga que las está buscando, se espera (hasta un minuto). Si aparece la siguiente, se sigue con ella.
     */
    private fun awaitNext(player: Player) {
        scope.launch {
            repeat(20) {
                val key = player.currentMediaItem?.mediaId ?: return@launch
                if (player.playbackState != Player.STATE_ENDED || !player.playWhenReady) return@launch
                val view = runCatching { api.session() }.getOrNull()
                if (view != null) {
                    if (!view.active || view.current?.track?.key != key) return@launch
                    if (view.next != null) {
                        advancing.withLock { Playlist.reconcile(player, view, ::item) }
                        if (player.hasNextMediaItem() && player.playbackState == Player.STATE_ENDED) {
                            player.seekToNextMediaItem()
                            player.play()
                        }
                        return@launch
                    }
                    if (view.radioStatus != "loading") return@launch
                }
                delay(3_000)
            }
        }
    }

    /**
     * Una sola sesión por usuario. Si la llevaba otro dispositivo suyo y aquí se pulsa reproducir, este
     * la recupera y sigue por donde iba la sesión, que puede ser otra canción distinta de la que se quedó aquí.
     */
    private fun reclaim(player: Player) {
        scope.launch {
            advancing.withLock {
                val seen = runCatching { api.session() }.getOrNull() ?: return@withLock
                if (seen.active) return@withLock
                val view = runCatching { api.claim() }.getOrNull() ?: return@withLock
                val current = view.current?.track ?: return@withLock
                val make = { track: Track -> Playlist.item(track, prefs.serverUrl.orEmpty()) }
                if (player.currentMediaItem?.mediaId == current.key) {
                    Playlist.reconcile(player, view, make)
                    if (kotlin.math.abs(player.currentPosition - view.positionMs) > 5_000) player.seekTo(view.positionMs)
                } else {
                    val (tracks, index) = Playlist.window(view)
                    player.setMediaItems(tracks.map(make), index, view.positionMs)
                    player.prepare()
                }
            }
        }
    }

    private fun report(player: Player) {
        val key = player.currentMediaItem?.mediaId ?: return
        val position = player.currentPosition
        if (position <= 0) return
        scope.launch {
            try {
                api.reportState(key, position)
            } catch (e: ApiException) {
                // 409: otro dispositivo del mismo usuario ha tomado la sesión. Este deja de sonar.
                if (e.status == 409 && player.isPlaying) player.pause()
            } catch (e: Exception) {
                // sin red un momento: ya se informará en la siguiente vuelta
            }
        }
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
