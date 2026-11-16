package com.mymusic.app.playback

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.mymusic.app.data.SessionView
import com.mymusic.app.data.Track

/**
 * Cómo se traduce la sesión del servidor a la lista del reproductor.
 *
 * El reproductor nunca tiene la lista entera: solo la canción que suena, la anterior y la siguiente
 * (§3.4 de la SPEC). Cada canción se identifica por su clave, que no se repite dentro de una sesión.
 */
object Playlist {
    private const val X_DURATION = "mm.durationSec"
    private const val X_PLATFORM = "mm.platform"

    /**
     * @param streamBase dirección del servidor. Solo la pone el servicio; cuando el elemento sale de la
     *   pantalla va sin dirección y el servicio la añade al recibirlo.
     */
    fun item(track: Track, streamBase: String? = null): MediaItem {
        val extras = Bundle().apply {
            putInt(X_DURATION, track.durationSec ?: 0)
            putString(X_PLATFORM, track.platform)
        }
        val builder = MediaItem.Builder()
            .setMediaId(track.key)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(track.title)
                    .setArtist(track.artist)
                    .setArtworkUri(track.thumb?.let(Uri::parse))
                    .setExtras(extras)
                    .build()
            )
        if (streamBase != null) builder.setUri(streamUri(streamBase, track.key))
        return builder.build()
    }

    fun streamUri(base: String, key: String) = "$base/api/stream/$key"

    fun track(item: MediaItem): Track {
        val meta = item.mediaMetadata
        return Track(
            key = item.mediaId,
            title = meta.title?.toString().orEmpty(),
            artist = meta.artist?.toString(),
            durationSec = meta.extras?.getInt(X_DURATION)?.takeIf { it > 0 },
            thumb = meta.artworkUri?.toString(),
            platform = meta.extras?.getString(X_PLATFORM) ?: "youtube",
        )
    }

    /** Lista inicial para el reproductor, [anterior, actual, siguiente], y la posición de la actual en ella. */
    fun window(view: SessionView): Pair<List<Track>, Int> {
        val tracks = listOfNotNull(view.prev?.track, view.current?.track, view.next?.track)
        return tracks to (if (view.prev != null) 1 else 0)
    }

    /**
     * Deja alrededor de la canción que suena exactamente la anterior y la siguiente que dice el
     * servidor, sin tocar la que suena. Si el servidor habla de otra canción (respuesta atrasada), no hace nada.
     */
    fun reconcile(player: Player, view: SessionView, make: (Track) -> MediaItem) {
        val playing = player.currentMediaItem?.mediaId ?: return
        if (playing != view.current?.track?.key) return
        val at = player.currentMediaItemIndex

        // Después de la actual
        val next = view.next?.track
        val after = player.mediaItemCount - at - 1
        val rightOk = if (next == null) after == 0 else after == 1 && player.getMediaItemAt(at + 1).mediaId == next.key
        if (!rightOk) {
            if (after > 0) player.removeMediaItems(at + 1, player.mediaItemCount)
            if (next != null) player.addMediaItem(at + 1, make(next))
        }

        // Antes de la actual
        val prev = view.prev?.track
        if (prev != null && at >= 1 && player.getMediaItemAt(at - 1).mediaId == prev.key) {
            if (at > 1) player.removeMediaItems(0, at - 1)
        } else {
            if (at > 0) player.removeMediaItems(0, at)
            if (prev != null) player.addMediaItem(0, make(prev))
        }

        player.repeatMode = if (view.repeat == "one") Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }
}
