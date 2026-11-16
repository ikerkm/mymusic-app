// Versiones fijadas el 2026-11-16 (últimas estables ese día).
// AGP 9 trae Kotlin integrado: no se aplica el plugin kotlin-android; el de Compose fija la versión de Kotlin.
plugins {
    id("com.android.application") version "9.5.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
