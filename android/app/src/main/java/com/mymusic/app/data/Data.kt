package com.mymusic.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/** Una canción tal como la describe el servidor. `key` es «plataforma:id» (p. ej. yt:dQw4w9WgXcQ). */
data class Track(
    val key: String,
    val title: String,
    val artist: String?,
    val durationSec: Int?,
    val thumb: String?,
    val platform: String,
    /**
     * Solo en canciones que vienen de Spotify, que suenan por su coincidencia en YouTube:
     * "pending" (aún sin buscar), "auto" (la eligió el servidor) o "manual" (la eligió el usuario).
     */
    val match: String? = null,
    /** La puso la radio y el usuario aún no la ha guardado en una lista (Fase 4). Solo viene dentro de una sesión. */
    val radio: Boolean = false,
)

/** Lo que trae una playlist de fuera, antes de confirmar que se añade a una lista propia. */
data class ImportPreview(
    val importId: String,
    val platform: String,
    val title: String,
    val thumb: String?,
    val count: Int,
    val newCount: Int,
    val already: Int,
    val truncated: Boolean,     // Spotify solo deja leer las 100 primeras
)

/** Un vídeo de YouTube candidato a ser la coincidencia de una canción de Spotify. */
data class MatchCandidate(val track: Track, val durationDiff: Int?)

data class MatchInfo(val currentKey: String?, val auto: Boolean, val candidates: List<MatchCandidate>)

/** Resultado del buscador. `hint` avisa de que lo pegado era una lista ("playlist") o un enlace no reconocido ("bad_link"). */
data class SearchResponse(val results: List<Track>, val hint: String?)

data class ListSummary(val id: String, val name: String, val count: Int, val durationSec: Int, val thumb: String?)

data class ListDetail(val summary: ListSummary, val tracks: List<Track>)

/** Una canción situada en la sesión: su posición y sus datos. */
data class Entry(val index: Int, val track: Track)

/** La sesión de escucha tal como la lleva el servidor, con su ventana anterior / actual / siguiente. */
data class SessionView(
    val id: String,
    val sourceType: String,
    val sourceId: String?,
    val sourceName: String,
    val count: Int,
    val index: Int,
    val shuffle: Boolean,
    val repeat: String,          // off | all | one
    val positionMs: Long,
    val active: Boolean,         // ¿es este dispositivo el que lleva la sesión? (una por usuario, compartida entre sus dispositivos)
    val radioOn: Boolean,        // la casilla «Radio» del usuario
    val radioStatus: String,     // idle | loading (buscando canciones parecidas) | empty | error
    val prev: Entry?,
    val current: Entry?,
    val next: Entry?,
)

data class QueuePage(val index: Int, val count: Int, val entries: List<Entry>)

// --- Fase 4: papelera y «Probar extracción» ---

/** Una lista en la papelera. `id` es el nombre de su archivo allí. */
data class TrashedList(val id: String, val name: String, val count: Int, val thumb: String?, val removedAt: String?)

/** Una canción quitada de una lista. `listId` es null si esa lista ya no existe. */
data class TrashedTrack(val id: String, val track: Track, val listId: String?, val listName: String?, val removedAt: String?)

data class Trash(val lists: List<TrashedList>, val tracks: List<TrashedTrack>) {
    val size: Int get() = lists.size + tracks.size
}

data class ProbePart(val ok: Boolean, val ms: Long, val message: String?)

/** Resultado de «Probar extracción»: si responde el buscador y si YouTube entrega audio. */
data class ProbeResult(val search: ProbePart, val extract: ProbePart)

/** Versión de la app publicada en el servidor. */
data class AppRelease(val versionCode: Int, val versionName: String, val sha256: String, val size: Long, val notes: String?)

/** Dirección del servidor y token de este dispositivo. Almacenamiento privado de la app. */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("mymusic", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("server", null)
        set(value) { sp.edit().putString("server", value).apply() }

    var userName: String?
        get() = sp.getString("user", null)
        set(value) { sp.edit().putString("user", value).apply() }

    var token: String?
        get() = sp.getString("token", null)
        set(value) { sp.edit().putString("token", value).apply() }

    val loggedIn: Boolean get() = !serverUrl.isNullOrBlank() && !token.isNullOrBlank()
}

/** Error devuelto por el servidor: código HTTP y su campo «error». */
class ApiException(val status: Int, val error: String) : Exception("$status $error")

// --- JSON ↔ modelos ---

// optString devuelve el texto "null" para un null de JSON: hay que mirarlo aparte
private fun JSONObject.str(name: String): String? = if (isNull(name)) null else getString(name)

private fun JSONObject.toTrack() = Track(
    key = getString("key"),
    title = optString("title"),
    artist = str("artist"),
    durationSec = if (isNull("durationSec")) null else getInt("durationSec"),
    thumb = str("thumb"),
    platform = optString("platform", "youtube"),
    match = str("match"),
    radio = optBoolean("radio") && !optBoolean("saved"),
)

private fun Track.toJson(): JSONObject = JSONObject()
    .put("key", key).put("title", title).put("artist", artist ?: JSONObject.NULL)
    .put("durationSec", durationSec ?: JSONObject.NULL).put("thumb", thumb ?: JSONObject.NULL).put("platform", platform)

private fun JSONArray.tracks(): List<Track> = List(length()) { getJSONObject(it).toTrack() }

private fun JSONObject.toSummary() = ListSummary(getString("id"), getString("name"), getInt("count"), optInt("durationSec"), str("thumb"))

private fun JSONObject.entry(name: String): Entry? =
    if (isNull(name)) null else getJSONObject(name).let { Entry(it.getInt("index"), it.getJSONObject("track").toTrack()) }

private fun JSONObject.toSession(): SessionView {
    val source = getJSONObject("source")
    val window = getJSONObject("window")
    return SessionView(
        id = getString("id"),
        sourceType = source.optString("type"),
        sourceId = source.str("id"),
        sourceName = source.optString("name"),
        count = getInt("count"),
        index = getInt("index"),
        shuffle = optBoolean("shuffle"),
        repeat = optString("repeat", "off"),
        positionMs = optLong("positionMs"),
        active = optBoolean("active", true),
        radioOn = optJSONObject("radio")?.optBoolean("enabled") ?: false,
        radioStatus = optJSONObject("radio")?.optString("status", "idle") ?: "idle",
        prev = window.entry("prev"),
        current = window.entry("current"),
        next = window.entry("next"),
    )
}

class Api(private val prefs: Prefs) {

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        base: String = prefs.serverUrl.orEmpty(),
        token: String? = prefs.token,
        readTimeoutMs: Int = 30_000,
    ): JSONObject {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = readTimeoutMs
            conn.setRequestProperty("Accept", "application/json")
            if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (status !in 200..299) throw ApiException(status, json.optString("error", "http_$status"))
            return json
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun call(method: String, path: String, body: JSONObject? = null, readTimeoutMs: Int = 30_000): JSONObject =
        withContext(Dispatchers.IO) { request(method, path, body, readTimeoutMs = readTimeoutMs) }

    private fun enc(text: String) = URLEncoder.encode(text, "UTF-8")
    private fun JSONObject.sessionOrNull(): SessionView? = if (isNull("session")) null else getJSONObject("session").toSession()

    // --- Sesión del dispositivo ---

    /** Entra con usuario y contraseña. Devuelve el token de este dispositivo y el nombre del usuario tal como está dado de alta. */
    suspend fun login(server: String, user: String, password: String, device: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val body = JSONObject().put("user", user.trim()).put("password", password).put("device", device)
        val reply = request("POST", "/api/login", body, base = server, token = null)
        reply.getString("token") to (reply.optJSONObject("user")?.optString("name") ?: user.trim())
    }

    /** Cambia la contraseña del usuario. Este dispositivo sigue dentro; sus otros dispositivos tienen que volver a entrar. */
    suspend fun changePassword(current: String, next: String) {
        call("POST", "/api/password", JSONObject().put("current", current).put("next", next))
    }

    suspend fun me(): JSONObject = call("GET", "/api/me")

    /** Texto, o un enlace de canción de YouTube o Spotify. */
    suspend fun search(query: String): SearchResponse =
        call("GET", "/api/search?q=" + enc(query)).let { SearchResponse(it.getJSONArray("results").tracks(), it.str("hint")) }

    // --- Importar una playlist de fuera ---

    /** Lee la playlist del enlace y dice qué trae para esa lista, sin añadir nada todavía. */
    suspend fun importPreview(listId: String, url: String): ImportPreview =
        // Leer una lista larga de SoundCloud puede pasar del minuto: se espera más que en el resto de llamadas
        call("POST", "/api/import/preview", JSONObject().put("listId", listId).put("url", url), readTimeoutMs = 110_000).let {
            ImportPreview(
                importId = it.getString("importId"), platform = it.optString("platform"), title = it.optString("title"), thumb = it.str("thumb"),
                count = it.getInt("count"), newCount = it.getInt("newCount"), already = it.getInt("already"), truncated = it.optBoolean("truncated"),
            )
        }

    /** Añade a la lista las canciones de una playlist ya leída. Devuelve cuántas entraron. */
    suspend fun confirmImport(listId: String, importId: String): Int =
        call("POST", "/api/lists/$listId/import", JSONObject().put("importId", importId)).getInt("added")

    // --- Coincidencia en YouTube de una canción de Spotify ---

    suspend fun matchInfo(key: String): MatchInfo = call("GET", "/api/match/${enc(key)}").let { o ->
        val candidates = o.getJSONArray("candidates")
        MatchInfo(
            currentKey = if (o.isNull("current")) null else o.getJSONObject("current").getString("key"),
            auto = o.optBoolean("auto", true),
            candidates = List(candidates.length()) { i ->
                candidates.getJSONObject(i).let { c -> MatchCandidate(c.toTrack(), if (c.isNull("durationDiff")) null else c.getInt("durationDiff")) }
            },
        )
    }

    suspend fun chooseMatch(key: String, candidate: Track) {
        call("PUT", "/api/match/${enc(key)}", JSONObject().put("track", candidate.toJson()))
    }

    // --- Listas ---

    suspend fun lists(): List<ListSummary> =
        call("GET", "/api/lists").getJSONArray("lists").let { a -> List(a.length()) { a.getJSONObject(it).toSummary() } }

    suspend fun createList(name: String): ListSummary =
        call("POST", "/api/lists", JSONObject().put("name", name)).getJSONObject("list").toSummary()

    suspend fun list(id: String): ListDetail =
        call("GET", "/api/lists/$id").getJSONObject("list").let { ListDetail(it.toSummary(), it.getJSONArray("tracks").tracks()) }

    suspend fun renameList(id: String, name: String) { call("PUT", "/api/lists/$id", JSONObject().put("name", name)) }

    suspend fun deleteList(id: String) { call("DELETE", "/api/lists/$id") }

    /** true si la canción entró; false si ya estaba en la lista. */
    suspend fun addToList(id: String, track: Track): Boolean =
        call("POST", "/api/lists/$id/tracks", JSONObject().put("track", track.toJson())).getInt("added") > 0

    suspend fun removeFromList(id: String, key: String) { call("DELETE", "/api/lists/$id/tracks/${enc(key)}") }

    suspend fun moveInList(id: String, key: String, toIndex: Int) {
        call("POST", "/api/lists/$id/move", JSONObject().put("key", key).put("toIndex", toIndex))
    }

    // --- Sesión de escucha ---

    suspend fun session(): SessionView? = call("GET", "/api/session").sessionOrNull()

    /** «Continuar» en este dispositivo: pasa a ser él quien lleva la sesión del usuario. null si no hay ninguna. */
    suspend fun claim(): SessionView? = try {
        call("POST", "/api/session/claim").sessionOrNull()
    } catch (e: ApiException) {
        if (e.status == 404) null else throw e
    }

    suspend fun startList(listId: String, startKey: String?, shuffle: Boolean): SessionView =
        call("POST", "/api/session", JSONObject().put("listId", listId).put("startKey", startKey ?: JSONObject.NULL).put("shuffle", shuffle))
            .getJSONObject("session").toSession()

    suspend fun startTrack(track: Track): SessionView =
        call("POST", "/api/session", JSONObject().put("track", track.toJson())).getJSONObject("session").toSession()

    suspend fun goto(key: String): SessionView =
        call("POST", "/api/session/goto", JSONObject().put("key", key)).getJSONObject("session").toSession()

    suspend fun sessionOptions(shuffle: Boolean? = null, repeat: String? = null): SessionView {
        val body = JSONObject()
        if (shuffle != null) body.put("shuffle", shuffle)
        if (repeat != null) body.put("repeat", repeat)
        return call("PUT", "/api/session", body).getJSONObject("session").toSession()
    }

    suspend fun reportState(key: String, positionMs: Long) {
        call("PUT", "/api/session/state", JSONObject().put("key", key).put("positionMs", positionMs))
    }

    suspend fun queue(from: Int, limit: Int = 20): QueuePage =
        call("GET", "/api/session/queue?from=$from&limit=$limit").let { o ->
            val entries = o.getJSONArray("entries")
            QueuePage(o.getInt("index"), o.getInt("count"), List(entries.length()) {
                entries.getJSONObject(it).let { e -> Entry(e.getInt("index"), e.getJSONObject("track").toTrack()) }
            })
        }

    /** mode: "next" (a continuación) o "end" (al final de la cola). */
    suspend fun enqueue(track: Track, mode: String): SessionView =
        call("POST", "/api/session/queue", JSONObject().put("track", track.toJson()).put("mode", mode)).getJSONObject("session").toSession()

    // Mover y quitar van por clave de canción, no por posición: una orden repetida no hace daño
    suspend fun moveQueued(key: String, to: Int): SessionView =
        call("POST", "/api/session/queue/move", JSONObject().put("key", key).put("to", to)).getJSONObject("session").toSession()

    suspend fun removeQueued(key: String): SessionView =
        call("DELETE", "/api/session/queue/${enc(key)}").getJSONObject("session").toSession()

    // --- Radio (Fase 4) ---

    /** ¿Tiene el usuario marcada la casilla «Radio»? */
    suspend fun radio(): Boolean = call("GET", "/api/radio").getJSONObject("radio").optBoolean("enabled")

    suspend fun setRadio(enabled: Boolean): Boolean =
        call("PUT", "/api/radio", JSONObject().put("enabled", enabled)).getJSONObject("radio").optBoolean("enabled")

    /** «Tu radio»: una sesión de canciones parecidas a lo que escucha. Tarda lo que tarde YouTube en dar las mezclas. */
    suspend fun startHomeRadio(): SessionView =
        call("POST", "/api/session", JSONObject().put("radio", "home"), readTimeoutMs = 110_000).getJSONObject("session").toSession()

    // --- Papelera (Fase 4) ---

    suspend fun trash(): Trash = call("GET", "/api/trash").let { o ->
        val lists = o.getJSONArray("lists")
        val tracks = o.getJSONArray("tracks")
        Trash(
            lists = List(lists.length()) { i ->
                lists.getJSONObject(i).let { TrashedList(it.getString("id"), it.optString("name"), it.optInt("count"), it.str("thumb"), it.str("removedAt")) }
            },
            tracks = List(tracks.length()) { i ->
                tracks.getJSONObject(i).let { TrashedTrack(it.getString("id"), it.getJSONObject("track").toTrack(), it.str("listId"), it.str("listName"), it.str("removedAt")) }
            },
        )
    }

    /** Devuelve a su sitio una lista ("list") o una canción ("track"); `listId` solo si la canción va a otra lista. */
    suspend fun restoreTrashed(type: String, id: String, listId: String? = null): ListSummary {
        val body = JSONObject().put("type", type).put("id", id)
        if (listId != null) body.put("listId", listId)
        return call("POST", "/api/trash/restore", body).getJSONObject("list").toSummary()
    }

    // --- «Probar extracción» (Fase 4) ---

    suspend fun probe(): ProbeResult = call("POST", "/api/diagnostics/extract", JSONObject(), readTimeoutMs = 70_000).let { o ->
        fun part(name: String) = o.getJSONObject(name).let { ProbePart(it.optBoolean("ok"), it.optLong("ms"), it.str("message")) }
        ProbeResult(part("search"), part("extract"))
    }

    // --- Historial ---

    /** Canciones escuchadas, lo más reciente primero. Con `distinct`, cada canción una sola vez. */
    suspend fun history(limit: Int, distinct: Boolean): List<Track> =
        call("GET", "/api/history?limit=$limit" + if (distinct) "&distinct=1" else "").getJSONArray("entries")
            .let { a -> List(a.length()) { a.getJSONObject(it).getJSONObject("track").toTrack() } }

    // --- Actualización de la app ---

    /** La versión publicada en el servidor, o null si no hay ninguna. */
    suspend fun latestApp(): AppRelease? = try {
        call("GET", "/api/app/latest").let { AppRelease(it.getInt("versionCode"), it.optString("versionName"), it.optString("sha256"), it.optLong("size"), it.str("notes")) }
    } catch (e: ApiException) {
        if (e.status == 404) null else throw e
    }

    /**
     * Descarga el instalable a `target` y comprueba que es exactamente el que anuncia el servidor
     * (suma SHA-256). `onProgress` recibe el avance de 0 a 1.
     */
    suspend fun downloadApp(release: AppRelease, target: File, onProgress: (Float) -> Unit) = withContext(Dispatchers.IO) {
        val conn = URL(prefs.serverUrl.orEmpty() + "/api/app/download").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            conn.setRequestProperty("Authorization", "Bearer ${prefs.token.orEmpty()}")
            if (conn.responseCode != 200) throw ApiException(conn.responseCode, "download_failed")
            val digest = MessageDigest.getInstance("SHA-256")
            target.parentFile?.mkdirs()
            val partial = File(target.path + ".part")
            var done = 0L
            var shown = -1
            conn.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        done += read
                        val percent = if (release.size > 0) (done * 100 / release.size).toInt() else 0
                        if (percent != shown) {
                            shown = percent
                            onProgress(percent.coerceIn(0, 100) / 100f)
                        }
                    }
                }
            }
            val sum = digest.digest().joinToString("") { "%02x".format(it) }
            if (!sum.equals(release.sha256, ignoreCase = true)) throw IOException("El instalable descargado no coincide con el publicado")
            if (!partial.renameTo(target)) throw IOException("No se pudo guardar el instalable")
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        /** «mymusic.ejemplo.com/» → «https://mymusic.ejemplo.com» */
        fun normalizeServer(input: String): String {
            val trimmed = input.trim().trimEnd('/')
            return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "https://$trimmed"
        }
    }
}
