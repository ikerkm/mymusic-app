#!/usr/bin/env node
// Da de alta un dispositivo sin pasar por la contraseña y escribe su token por la salida estándar.
// Pensado para dispositivos de prueba (el emulador), para no tener que usar la contraseña del usuario.
//   Uso EN el Flip:  node scripts/new-token.mjs "emulador" > ~/mymusic/pruebas/token_emulador.txt
// El servidor en marcha lo reconoce sin reiniciar. Todos los tokens se anulan al cambiar la contraseña.
import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { Auth } from '../src/auth.js';

dotenv.config({ path: join(config.root, '.env') });

const auth = new Auth(config.dataDir);
if (!auth.hasPassword()) {
    console.error('Primero hay que fijar la contraseña: node scripts/set-password.mjs');
    process.exit(1);
}
process.stdout.write(auth.issueToken(process.argv[2] || 'prueba'));
