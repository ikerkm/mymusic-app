#!/usr/bin/env node
// Cuentas de MyMusic. Se ejecuta EN el Flip, desde ~/mymusic/server:
//   node scripts/users.mjs list
//   node scripts/users.mjs add <nombre>            da de alta un usuario y pide su contraseña inicial
//   node scripts/users.mjs password <nombre>       cambia su contraseña (sus sesiones dejan de valer)
//   node scripts/users.mjs rename <actual> <nuevo>
// La contraseña se teclea sin que se vea; también puede llegar por tubería:
//   printf '%s' "la-contraseña" | node scripts/users.mjs add <nombre>
// El servidor en marcha se entera solo: no hace falta reiniciarlo.
import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { Auth } from '../src/auth.js';
import { askPassword } from './_prompt.mjs';

dotenv.config({ path: join(config.root, '.env') });

const [command, first, second] = process.argv.slice(2);
const auth = new Auth(config.dataDir, { ownerName: config.ownerName });
const need = name => {
    const user = auth.findUser(name);
    if (!user) {
        console.error(`No existe el usuario «${name ?? ''}». Usuarios: ${auth.users().map(u => u.name).join(', ') || '(ninguno)'}`);
        process.exit(1);
    }
    return user;
};

try {
    if (command === 'list') {
        const users = auth.users();
        if (users.length === 0) console.log('No hay usuarios. Crea el primero: node scripts/users.mjs add <nombre>');
        for (const user of users) console.log(`${user.name}${user.admin ? '  (dueño)' : ''}`);
    } else if (command === 'add' && first) {
        Auth.checkName(first);
        if (auth.findUser(first)) throw new Error(`Ya existe el usuario «${first}»`);
        const user = auth.createUser(first, await askPassword(`Contraseña inicial de ${first}`));
        console.log(`Usuario «${user.name}» creado${user.admin ? ' (dueño)' : ''}. Puede cambiar la contraseña desde la app.`);
    } else if (command === 'password' && first) {
        const user = need(first);
        auth.setPassword(user.id, await askPassword(`Contraseña nueva de ${user.name}`));
        console.log(`Contraseña de «${user.name}» cambiada. Sus sesiones anteriores ya no valen.`);
    } else if (command === 'rename' && first && second) {
        const user = auth.renameUser(need(first).id, second);
        console.log(`«${first}» ahora se llama «${user.name}». Sus sesiones siguen valiendo.`);
    } else {
        console.error('Uso: node scripts/users.mjs list | add <nombre> | password <nombre> | rename <actual> <nuevo>');
        process.exit(1);
    }
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
