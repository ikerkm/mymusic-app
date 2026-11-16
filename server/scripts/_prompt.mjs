// Pedir una contraseña sin mostrarla (teclado) o leerla de una tubería. Lo usan los scripts de administración.

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

/** Devuelve la contraseña tecleada dos veces (o la que llega por tubería). Sale con error si no coinciden. */
export async function askPassword(label = 'Contraseña') {
    if (!process.stdin.isTTY) return readPiped();
    const first = await askHidden(`${label} (mínimo 8 caracteres): `);
    const again = await askHidden('Repítela: ');
    if (first !== again) {
        console.error('No coinciden. No se ha cambiado nada.');
        process.exit(1);
    }
    return first;
}
