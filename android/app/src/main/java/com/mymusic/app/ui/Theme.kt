package com.mymusic.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.mymusic.app.data.ListSummary

/** Colores de la maqueta v1 (mockups/app-v1.html). */
object Mm {
    val Bg = Color(0xFF0D0E12)
    val Sur = Color(0xFF1A1C24)
    val Sur2 = Color(0xFF252834)
    val Line = Color(0xFF2F3342)
    val Tx = Color(0xFFEEF0F6)
    val Mut = Color(0xFF9AA0B3)
    val Acc = Color(0xFF9D8CFF)
    val OnAcc = Color(0xFF14102E)
    val Yt = Color(0xFFFF6B6B)
    val Sp = Color(0xFF4AD98A)
    val Sc = Color(0xFFFF9A4A)
    val Ok = Color(0xFF6FDC9A)
}

@Composable
fun MyMusicTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Mm.Acc,
            onPrimary = Mm.OnAcc,
            secondary = Mm.Acc,
            background = Mm.Bg,
            onBackground = Mm.Tx,
            surface = Mm.Bg,
            onSurface = Mm.Tx,
            surfaceVariant = Mm.Sur,
            onSurfaceVariant = Mm.Mut,
            outline = Mm.Line,
            outlineVariant = Mm.Line,
            error = Mm.Yt,
        ),
        content = content,
    )
}

/** Iconos de la maqueta, a partir de sus mismos trazados SVG (lienzo de 24×24). */
object MmIcons {
    private fun icon(filled: Boolean, vararg paths: String): ImageVector =
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            for (path in paths) {
                if (filled) {
                    addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black))
                } else {
                    addPath(
                        pathData = addPathNodes(path),
                        stroke = SolidColor(Color.Black),
                        strokeLineWidth = 2f,
                        strokeLineCap = StrokeCap.Round,
                        strokeLineJoin = StrokeJoin.Round,
                    )
                }
            }
        }.build()

    private fun line(vararg paths: String) = icon(false, *paths)
    private fun solid(vararg paths: String) = icon(true, *paths)
    private fun dot(cx: Float, cy: Float, r: Float) = "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0z"

    val Home = line("M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z")
    val Search = line(dot(11f, 11f, 7f), "M16.5 16.5L21 21")
    val Lists = line("M4 6h16M4 12h16M4 18h10")
    val Play = solid("M7 4l13 8-13 8z")
    val Pause = solid("M6 4h4.5v16H6z", "M13.5 4H18v16h-4.5z")
    val Next = solid("M5 4l10 8-10 8z", "M17 4h2.6v16H17z")
    val Prev = solid("M19 4L9 12l10 8z", "M4.4 4H7v16H4.4z")
    val Shuffle = line("M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3")
    val Repeat = line("M4 12V9a3 3 0 0 1 3-3h11M20 12v3a3 3 0 0 1-3 3H6M15 3l3 3-3 3M9 15l-3 3 3 3")
    val More = solid(dot(12f, 5f, 1.6f), dot(12f, 12f, 1.6f), dot(12f, 19f, 1.6f))
    val Queue = line("M4 6h13M4 11h13M4 16h7", "M15 14.5l5 3-5 3z")
    val Settings = line("M4 7h9M19 7h1M4 17h1M11 17h9", dot(16f, 7f, 2.5f), dot(8f, 17f, 2.5f))
    val Down = line("M5 9l7 7 7-7")
    val ListAdd = line("M4 6h12M4 11h12M4 16h6M17 14v6M14 17h6")
    val Plus = line("M12 5v14M5 12h14")
    val Back = line("M15 5l-7 7 7 7")
    val Forward = line("M9 5l7 7-7 7")
    val Import = line("M12 4v11M7 11l5 5 5-5M5 20h14")
    val Drag = line("M5 9h14M5 15h14")
    val Bin = line("M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13")
    val Edit = line("M4 20h4L19 9l-4-4L4 16z", "M13 7l4 4")
    val Swap = line("M4 8h14l-3-3M20 16H6l3 3")
    val Radio = line(dot(12f, 12f, 2f), "M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8")

    // Listas automáticas y «Tus estadísticas» (mockups/estadisticas-v1.html)
    val Trend = line("M3 17l6-6 4 4 8-8", "M15 7h6v6")
    val Clock = line(dot(12f, 12f, 9f), "M12 7v5l3 2")
    val Chart = line("M5 20V11M12 20V5M19 20v-6")

    // «Me gusta» (mockups/me-gusta-v1.html): solo el contorno si la canción no está, relleno si está
    private const val HEART = "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
    val Heart = line(HEART)
    val HeartFull = solid(HEART)

    // Artista y disco (mockups/artista-disco-v1.html)
    val User = line(dot(12f, 8f, 4f), "M4 21a8 8 0 0 1 16 0")

    // Canciones que fallan (mockups/fallos-v1.html)
    val Retry = line("M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4")
    val Link = line("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1")
    val Close = line("M6 6l12 12M18 6L6 18")
}

/** 42000 s → «11 h 40 min»; 1500 s → «25 min». */
fun formatTotal(seconds: Int): String {
    val minutes = (seconds + 30) / 60
    return if (minutes >= 60) "%d h %02d min".format(minutes / 60, minutes % 60) else "$minutes min"
}

fun songs(count: Int) = if (count == 1) "1 canción" else "$count canciones"

/** Carátula cuadrada con esquinas redondeadas; mientras carga (o si no hay) se ve un degradado. */
@Composable
fun Cover(url: String?, size: Dp, radius: Dp = 8.dp, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(radius))
            .background(Brush.linearGradient(listOf(Color(0xFF3A3F5C), Color(0xFF8E9BD6))))
    ) {
        if (url != null) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

/** Carátula de una lista. La de «me gusta» lleva un corazón en vez de la imagen de su primera canción. */
@Composable
fun ListCover(list: ListSummary, size: Dp, radius: Dp = 8.dp, modifier: Modifier = Modifier) {
    if (!list.likes) return Cover(list.thumb, size, radius, modifier)
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(radius))
            .background(Color(0xFF1B1640))
            .border(1.dp, Mm.Acc, RoundedCornerShape(radius)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(MmIcons.HeartFull, contentDescription = "Me gusta", tint = Mm.Acc, modifier = Modifier.size(size * 0.42f))
    }
}

/** Etiqueta de la plataforma de la que sale la canción. */
@Composable
fun PlatformBadge(platform: String, modifier: Modifier = Modifier) {
    val (label, color) = when (platform) {
        "youtube" -> "YouTube" to Mm.Yt
        "spotify" -> "Spotify" to Mm.Sp
        "soundcloud" -> "SoundCloud" to Mm.Sc
        else -> platform to Mm.Mut
    }
    Text(
        text = label,
        color = color,
        fontSize = 10.sp,
        lineHeight = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = modifier
            .border(1.dp, color.copy(alpha = 0.6f), RoundedCornerShape(50))
            .padding(horizontal = 5.dp),
    )
}

/** 215000 → «3:35»; con horas, «1:02:07». */
fun formatTime(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}
