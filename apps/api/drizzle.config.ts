import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Lee el .env de la raíz del monorepo
config({ path: '../../.env' });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cuadra:cuadra@localhost:5450/cuadra',
  },
  strict: true,
  verbose: true,
});
