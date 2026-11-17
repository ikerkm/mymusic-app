import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Clave de firma definitiva: Z:\AI\MyMusic\keys\keystore.properties, fuera del repositorio
// (copia de seguridad en la Raspberry). Android solo instala una versión encima de otra si las
// dos van firmadas con la misma clave, así que todas las compilaciones usan esta.
val keystore = Properties().apply {
    val file = rootProject.file("../keys/keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.mymusic.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.mymusic.app"
        minSdk = 26          // Android 8.0: cubre el Pocophone F1 (Android 10)
        targetSdk = 36
        // -PversionCodeOverride=N compila una versión «más vieja» para probar la actualización en el emulador
        versionCode = (project.findProperty("versionCodeOverride") as String?)?.toInt() ?: 10
        versionName = "0.10.0"
    }

    signingConfigs {
        if (keystore.containsKey("storeFile")) {
            create("mymusic") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        val mymusic = signingConfigs.findByName("mymusic")
        // debug: la que se usa en el emulador (permite inspeccionarla). release: la que va a los móviles.
        debug {
            if (mymusic != null) signingConfig = mymusic
        }
        release {
            isMinifyEnabled = false
            if (mymusic != null) signingConfig = mymusic
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")

    // Reproducción: ExoPlayer + sesión multimedia (pantalla de bloqueo, notificación, Bluetooth)
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-session:1.11.1")

    // Carátulas
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")

    // Arrastrar para reordenar (listas y cola)
    implementation("sh.calvin.reorderable:reorderable:3.1.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
