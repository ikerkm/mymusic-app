#!/usr/bin/env node
// Da de alta un dispositivo sin pasar por la contraseña y escribe su token por la salida estándar.
// Pensado para dispositivos de prueba (el emulador), para no tener que usar la contraseña de nadie.
//   node scripts/new-token.mjs "emulador" [usuario] > ~/mymusic/pruebas/token_emulador.txt
// Sin usuario, el token es del dueño. El servidor en marcha lo reconoce sin reiniciar.
import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { Auth } from '../src/auth.js';

dotenv.config({ path: join(config.root, '.env') });

const auth = new Auth(config.dataDir, { ownerName: config.ownerName });
const user = process.argv[3] ? auth.findUser(process.argv[3]) : auth.owner();
if (!user) {
    console.error(process.argv[3] ? `No existe el usuario «${process.argv[3]}»` : 'Todavía no hay usuarios: node scripts/users.mjs add <nombre>');
    process.exit(1);
}
process.stdout.write(auth.issueToken(user.id, process.argv[2] || 'prueba'));
