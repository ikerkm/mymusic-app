#!/usr/bin/env node
// Atajo: cambia la contraseña del dueño (o crea su cuenta si todavía no hay ninguna).
//   node scripts/set-password.mjs
// Para los demás usuarios: node scripts/users.mjs password <nombre>
import dotenv from 'dotenv';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { Auth } from '../src/auth.js';
import { askPassword } from './_prompt.mjs';

dotenv.config({ path: join(config.root, '.env') });

try {
    const auth = new Auth(config.dataDir, { ownerName: config.ownerName });
    const owner = auth.owner();
    const password = await askPassword(owner ? `Contraseña nueva de ${owner.name}` : `Contraseña de ${config.ownerName}`);
    if (owner) {
        auth.setPassword(owner.id, password);
        console.log(`Contraseña de «${owner.name}» guardada. Sus sesiones anteriores ya no valen: vuelve a entrar desde la app.`);
    } else {
        const created = auth.createUser(config.ownerName, password, { admin: true });
        console.log(`Cuenta del dueño creada: «${created.name}».`);
    }
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
