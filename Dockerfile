# Cuadra en producción: una sola imagen de compilación y dos destinos (api y web).
#   docker compose -f deploy/docker-compose.prod.yml build
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
# La web necesita la URL pública de la API al compilar
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @cuadra/shared build \
 && pnpm --filter @cuadra/api build \
 && pnpm --filter @cuadra/web build

# API: aplica las migraciones pendientes y parte
FROM build AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4200
WORKDIR /app/apps/api
EXPOSE 4200
CMD ["sh", "-c", "pnpm db:migrate && node dist/main.js"]

# Web (Next.js)
FROM build AS web
ENV NODE_ENV=production
WORKDIR /app/apps/web
EXPOSE 3200
CMD ["pnpm", "start"]
