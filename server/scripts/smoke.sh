#!/usr/bin/env bash
# Prueba de humo de MyMusic contra un servidor en marcha (extracción real, no dobles).
# Pensada para ejecutarse EN el Flip:
#   bash ~/mymusic/server/scripts/smoke.sh [URL_BASE]
# Token: variable MYMUSIC_TOKEN o el archivo ~/mymusic/pruebas/token_prueba.txt.
# Deja sus archivos de trabajo en ~/mymusic/pruebas/ (se reutilizan en cada pasada).
set -u
BASE="${1:-http://127.0.0.1:3100}"
DIR="$HOME/mymusic/pruebas"
KEY="${MYMUSIC_SMOKE_KEY:-yt:dQw4w9WgXcQ}"
mkdir -p "$DIR"
TOKEN="${MYMUSIC_TOKEN:-$(cat "$DIR/token_prueba.txt" 2>/dev/null)}"
[ -n "$TOKEN" ] || { echo "Falta el token (MYMUSIC_TOKEN o $DIR/token_prueba.txt)"; exit 1; }
H="Authorization: Bearer $TOKEN"

echo "== sesion"
curl -s -m 15 -H "$H" "$BASE/api/me"; echo
echo "== busqueda"
curl -s -m 30 -H "$H" -w "\n(%{time_total}s)\n" "$BASE/api/search?q=never+gonna+give+you+up" | cut -c1-260
echo "== audio completo"
curl -s -m 180 -o "$DIR/smoke_full.bin" -H "$H" \
  -w "http %{http_code} | %{content_type} | primer byte %{time_starttransfer}s | total %{time_total}s | %{size_download} bytes\n" \
  "$BASE/api/stream/$KEY"
echo "== tramo intermedio (ya en memoria)"
curl -s -m 60 -o "$DIR/smoke_range.bin" -D "$DIR/smoke_range.headers" -H "$H" -H "Range: bytes=1000000-1000999" \
  -w "http %{http_code} | primer byte %{time_starttransfer}s | %{size_download} bytes\n" "$BASE/api/stream/$KEY"
grep -i "^content-range" "$DIR/smoke_range.headers" | tr -d '\r'
if dd if="$DIR/smoke_full.bin" bs=1 skip=1000000 count=1000 2>/dev/null | cmp -s - "$DIR/smoke_range.bin"; then
  echo "tramo: coincide con el archivo completo"
else
  echo "tramo: NO COINCIDE"
fi
echo "== sin token"
curl -s -o /dev/null -m 15 -w "http %{http_code}\n" "$BASE/api/stream/$KEY"
