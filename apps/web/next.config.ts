import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Usa el mismo .env de la raíz del monorepo que la API
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  transpilePackages: ['@cuadra/shared'],
  // Oculta el botón flotante "N" de Next.js (solo aparece en desarrollo)
  devIndicators: false,
};

export default nextConfig;