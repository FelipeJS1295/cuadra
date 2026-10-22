/**
 * Cambia la contraseña de un usuario directo en la base de datos.
 * Sirve si nadie puede entrar (ej: se olvidó la clave del administrador).
 *
 *   pnpm --filter @cuadra/api user:password <correo> <nueva-contraseña>
 *
 * También reactiva el usuario si estaba desactivado.
 * Si el correo no existe, lo crea como administrador del sistema.
 */
import { randomBytes, scrypt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

// Mismo .env de la raíz del monorepo que usa la API
for (const file of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
}

const [usernameRaw, password] = process.argv.slice(2);
if (!usernameRaw || !password) {
  console.error('Uso: pnpm --filter @cuadra/api user:password <correo> <nueva-contraseña>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres');
  process.exit(1);
}
const username = usernameRaw.trim().toLowerCase();

// Igual que apps/api/src/auth/crypto.ts -> "scrypt$<sal>$<hash>"
const salt = randomBytes(16);
const hash = await promisify(scrypt)(password, salt, 64);
const passwordHash = `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query(
    `update users set password_hash = $2, is_active = true, must_change_password = false where email = $1`,
    [username, passwordHash],
  );
  if (rowCount) console.log(`Contraseña de ${username} actualizada.`);
  else {
    await client.query(`insert into users (email, name, password_hash, is_superadmin) values ($1, 'Administrador', $2, true)`, [username, passwordHash]);
    console.log(`Usuario ${username} creado como administrador del sistema.`);
  }
} finally {
  await client.end();
}
