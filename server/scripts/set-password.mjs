#!/usr/bin/env node
// Fija la contraseña de MyMusic. Las sesiones abiertas dejan de valer.
//   Interactivo (recomendado):  node scripts/set-password.mjs
//   Por tubería:                printf '%s' "la-contraseña" | node scripts/set-password.mjs
// La contraseña no se guarda: solo su hash, en data/auth.json. La anterior queda en data/removed/.
import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { Auth } from '../src/auth.js';

dotenv.config({ path: join(config.root, '.env') });

// Lee una línea del teclado sin mostrarla
function askHidden(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const onData = key => {
            for (const ch of key) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off('data', onData);
                    process.stdout.write('\n');
                    return resolve(value);
                }
                if (ch === '\u0003') process.exit(130);                 // Ctrl+C
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else value += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function readPiped() {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text.replace(/\r?\n$/, '');
}

let password;
if (process.stdin.isTTY) {
    password = await askHidden('Contraseña nueva (mínimo 8 caracteres): ');
    const again = await askHidden('Repítela: ');
    if (password !== again) {
        console.error('No coinciden. No se ha cambiado nada.');
        process.exit(1);
    }
} else {
    password = await readPiped();
}

try {
    new Auth(config.dataDir).setPassword(password);
    console.log('Contraseña guardada. Las sesiones anteriores ya no valen: vuelve a entrar desde la app.');
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
