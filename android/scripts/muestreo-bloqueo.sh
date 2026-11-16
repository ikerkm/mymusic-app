#!/usr/bin/env bash
# Prueba de reproducción con la pantalla bloqueada en el emulador: apunta el estado del reproductor
# una vez por minuto. Lanzar como proceso independiente, con una canción larga ya sonando.
#   bash /z/AI/MyMusic/android/scripts/muestreo-bloqueo.sh MINUTOS /z/ruta/al/registro.log
# Estado 3 = sonando, 2 = en pausa, 6 = cargando, 7 = error.
source /z/AI/android_sdk/env.sh
MIN="${1:-30}"
LOG="${2:?falta la ruta del registro}"
E="adb -s emulator-5554"     # siempre el emulador: el Flip también aparece en adb
sample() {
  local line state pos wake
  line=$($E shell dumpsys media_session | grep -m1 -E "state=PlaybackState")
  # «position=» aparece dos veces (la segunda es «buffered position»): se ancla a «state=N, position=»
  state=$(sed -E 's/.*state=([0-9]+), position=([0-9]+),.*/\1/' <<< "$line")
  pos=$(sed -E 's/.*state=([0-9]+), position=([0-9]+),.*/\2/' <<< "$line")
  wake=$($E shell dumpsys power | grep -m1 -o -E 'mWakefulness=[A-Za-z]+' | cut -d= -f2)
  echo "$(date +%H:%M:%S) minuto=$1 estado=${state:-?} posicion_s=$(( ${pos:-0} / 1000 )) pantalla=${wake:-?}"
}
{
  echo "INICIO $(date '+%Y-%m-%d %H:%M:%S') duracion=${MIN}min"
  sample 0
  for i in $(seq 1 "$MIN"); do
    sleep 60
    sample "$i"
  done
  echo "FIN $(date '+%Y-%m-%d %H:%M:%S')"
} >> "$LOG" 2>&1
