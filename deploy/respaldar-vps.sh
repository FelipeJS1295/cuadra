#!/usr/bin/env bash
# Respaldo diario de la base de Cuadra en el VPS (guarda 14 días en deploy/respaldos).
# Lo deja programado el instalador; también se puede correr a mano.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
F="cuadra-$(date +%Y%m%d-%H%M).dump"
docker compose -f deploy/docker-compose.prod.yml --env-file .env exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "/respaldos/$F"
find deploy/respaldos -name 'cuadra-*.dump' -mtime +14 -delete
echo "Respaldo listo: deploy/respaldos/$F"
