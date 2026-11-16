#!/usr/bin/env bash
# Compila la app para los móviles (firmada con la clave definitiva) y la publica en el Flip.
# A partir de ahí, cada móvil ve el aviso «Hay una versión nueva» y se actualiza desde la app.
#   Uso (Git Bash):  bash /z/AI/MyMusic/android/scripts/publicar-app.sh "Qué trae esta versión"
# Antes hay que subir versionCode y versionName en android/app/build.gradle.kts.
# - No pisa una versión ya publicada: cada una es un archivo nuevo (mymusic-<versionCode>.apk).
# - El latest.json anterior se mueve a data/removed/app/ (no se borra).
# - No reinicia el servidor: no corta la música.
set -euo pipefail
source /z/AI/android_sdk/env.sh
export PATH="/c/Program Files/nodejs:$PATH"

ROOT=/z/AI/MyMusic/android
NOTES="${1:-}"
FLIP="ssh -o ConnectTimeout=10 -o BatchMode=yes flip"
[ -f /z/AI/MyMusic/keys/keystore.properties ] || { echo "Falta la clave de firma (Z:\\AI\\MyMusic\\keys). No se publica."; exit 1; }

echo "== 1/4 compilar"
(cd "$ROOT" && ./gradlew assembleRelease --console=plain -q)
OUT="$ROOT/app/build/outputs/apk/release"
APK="$OUT/app-release.apk"
CODE=$(grep -o '"versionCode": *[0-9]*' "$OUT/output-metadata.json" | grep -o '[0-9]*$')
NAME=$(grep -o '"versionName": *"[^"]*"' "$OUT/output-metadata.json" | sed -E 's/.*"([^"]*)"$/\1/')
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
FILE="mymusic-$CODE.apk"
echo "version $NAME (codigo $CODE), $(stat -c %s "$APK") bytes"

echo "== 2/4 comprobar la firma"
SIGNER=$(ls -d /z/AI/android_sdk/sdk/build-tools/*/ | sort -V | tail -1)apksigner.bat
cmd //c "$(cygpath -w "$SIGNER")" verify --print-certs "$(cygpath -w "$APK")" 2>/dev/null | grep -E "certificate DN|SHA-256" | head -2
cmd //c "$(cygpath -w "$SIGNER")" verify --print-certs "$(cygpath -w "$APK")" 2>/dev/null | grep -q "CN=MyMusic" || { echo "El instalable NO va firmado con la clave de MyMusic. No se publica."; exit 1; }

echo "== 3/4 subir al Flip"
$FLIP "mkdir -p ~/mymusic/server/data/app ~/mymusic/server/data/removed/app && [ ! -e ~/mymusic/server/data/app/$FILE ]" \
  || { echo "La version con codigo $CODE ya esta publicada. Sube versionCode y vuelve a lanzar."; exit 1; }
scp -q "$APK" "flip:mymusic/server/data/app/$FILE.tmp"
node -e 'process.stdout.write(JSON.stringify({versionCode:Number(process.argv[1]),versionName:process.argv[2],file:process.argv[3],sha256:process.argv[4],publishedAt:new Date().toISOString(),notes:process.argv[5]||null},null,2))' \
  "$CODE" "$NAME" "$FILE" "$SHA" "$NOTES" \
  | $FLIP "cd ~/mymusic/server/data/app && cat > latest.json.tmp && [ \"\$(sha256sum $FILE.tmp | cut -d' ' -f1)\" = '$SHA' ] && mv $FILE.tmp $FILE && { if [ -e latest.json ]; then mv latest.json ../removed/app/latest.json.\$(date +%Y%m%dT%H%M%S); fi; } && mv latest.json.tmp latest.json && echo 'subido y comprobado'"

echo "== 4/4 lo que anuncia el servidor"
$FLIP 'T=$(cat ~/mymusic/pruebas/token_emulador.txt 2>/dev/null); curl -s -m 10 -H "Authorization: Bearer $T" http://127.0.0.1:3100/api/app/latest'; echo
