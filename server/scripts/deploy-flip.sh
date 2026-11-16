#!/usr/bin/env bash
# Lleva server/ al Flip y reinicia MyMusic.
#   Uso (Git Bash):  bash /z/AI/MyMusic/server/scripts/deploy-flip.sh
# - Antes de copiar pasa las pruebas en el PC; si fallan, no despliega.
# - Jamás borra: el código que había desplegado se mueve a ~/mymusic/removed/despliegue_<fecha>/.
# - No toca ~/mymusic/server/data ni el .env del Flip.
# - Termina comprobando que MyMusic responde y que el bot de Discord sigue intacto.
set -euo pipefail

SRC="/z/AI/MyMusic/server"
TS=$(date +%Y%m%d_%H%M%S)
FLIP="ssh -o ConnectTimeout=10 -o BatchMode=yes flip"
export PATH="/c/Program Files/nodejs:$PATH"

echo "== 1/4 pruebas en el PC"
(cd "$SRC" && npm test >/tmp/mymusic_test.log 2>&1) || { grep -E "✖|ℹ (tests|pass|fail)" /tmp/mymusic_test.log; echo "Pruebas en rojo: no se despliega."; exit 1; }
grep -E "ℹ (tests|pass|fail)" /tmp/mymusic_test.log | tr '\n' ' '; echo

echo "== 2/4 copiar al Flip (lo anterior va a removed/despliegue_$TS)"
$FLIP "mkdir -p ~/mymusic/server ~/mymusic/removed/despliegue_$TS && cd ~/mymusic/server && for f in src web scripts package.json package-lock.json .env.example; do if [ -e \$f ]; then mv \$f ~/mymusic/removed/despliegue_$TS/; fi; done"
tar -C "$SRC" -cf - src web scripts package.json package-lock.json .env.example | $FLIP 'tar -C ~/mymusic/server -xf -'
$FLIP 'cd ~/mymusic/server && if [ ! -f .env ]; then cp .env.example .env; echo ".env creado a partir de .env.example"; fi'

echo "== 3/4 dependencias y reinicio"
$FLIP 'cd ~/mymusic/server && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1 && if pm2 describe mymusic >/dev/null 2>&1; then pm2 restart mymusic --update-env >/dev/null && echo "mymusic reiniciado"; else pm2 start src/index.js --name mymusic --cwd ~/mymusic/server >/dev/null && pm2 save >/dev/null && echo "mymusic dado de alta en pm2"; fi'

echo "== 4/4 comprobaciones"
$FLIP 'ok=""; for i in 1 2 3 4 5 6 7 8 9 10; do if curl -fsS -m 3 http://127.0.0.1:3100/api/health >/dev/null 2>&1; then ok=1; break; fi; sleep 1; done; if [ -n "$ok" ]; then echo "MyMusic: responde"; else echo "MyMusic: NO RESPONDE"; fi; echo "panel del bot: HTTP $(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:3000/)"; echo "pid discordbot: $(pm2 pid discordbot)  pid mymusic: $(pm2 pid mymusic)"; [ -n "$ok" ]'
