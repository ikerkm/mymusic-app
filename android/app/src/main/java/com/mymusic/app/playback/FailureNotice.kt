package com.mymusic.app.playback

import android.os.Bundle

/**
 * Una canción que no se pudo reproducir (§19, mockups/fallos-v1.html), tal como la cuenta el servicio a
 * la pantalla por los «extras» de la sesión. `skipping`: el servicio va a pasar a la siguiente; si no,
 * se queda parado (no hay siguiente, o han fallado `MAX_FAILS` seguidas).
 */
data class FailureNotice(
    val key: String,
    val title: String,
    val reason: String?,
    val streak: Int,
    val skipping: Boolean,
    val at: Long,
) {
    fun toBundle() = Bundle().apply {
        putString("failKey", key)
        putString("failTitle", title)
        putString("failReason", reason)
        putInt("failStreak", streak)
        putBoolean("failSkipping", skipping)
        putLong("failAt", at)
    }

    /** Lo que se enseña: el aviso que pasa a la siguiente, o por qué se ha parado. */
    val message: String
        get() {
            val why = reason?.let { " (${lowerFirst(it)})" }.orEmpty()
            return when {
                streak >= MAX_FAILS -> "Han fallado $MAX_FAILS seguidas. Parece un problema de YouTube o del servidor, así que me paro aquí. Prueba más tarde, o «Probar extracción» en Ajustes."
                skipping -> "No se pudo reproducir «$title»$why. Paso a la siguiente."
                else -> "No se pudo reproducir esta canción$why."
            }
        }

    companion object {
        const val MAX_FAILS = 3
        const val SKIP_AFTER_MS = 2_000L

        fun from(extras: Bundle?): FailureNotice? {
            val key = extras?.getString("failKey") ?: return null
            return FailureNotice(
                key = key,
                title = extras.getString("failTitle").orEmpty(),
                reason = extras.getString("failReason"),
                streak = extras.getInt("failStreak"),
                skipping = extras.getBoolean("failSkipping"),
                at = extras.getLong("failAt"),
            )
        }

        // «Tiene restricción de edad» → «tiene restricción de edad»; «YouTube rechazó…» se queda igual
        private fun lowerFirst(text: String): String {
            val first = text.substringBefore(' ')
            return if (first.drop(1).any { it.isUpperCase() }) text else text.replaceFirstChar { it.lowercaseChar() }
        }
    }
}
