#!/usr/bin/env bash
# =============================================================================
# Cuadra · instalación / actualización en el VPS (erp.budly.cl)
#   Primera vez:  git clone https://github.com/FelipeJS1295/cuadra.git /opt/cuadra
#                 (sube cuadra.dump y .env.production a /opt/cuadra)
#                 cd /opt/cuadra && sudo bash deploy/2-instalar-en-vps.sh
#   Actualizar:   cd /opt/cuadra && git pull && sudo bash deploy/2-instalar-en-vps.sh
# - Primera vez: crea la base, restaura deploy/cuadra.dump (tus datos locales),
#   levanta API y web, configura Nginx + HTTPS y el respaldo diario.
# - Las veces siguientes: solo recompila y reinicia (NUNCA pisa la base con datos).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DC="docker compose -f deploy/docker-compose.prod.yml --env-file .env"
DOMAIN=erp.budly.cl
ok()   { echo -e "\e[32m✔\e[0m $*"; }
info() { echo -e "\e[36m→\e[0m $*"; }
fail() { echo -e "\e[31m✘ $*\e[0m"; exit 1; }

# --- 0. Requisitos ----------------------------------------------------------
command -v docker >/dev/null || fail "No está Docker. Instálalo con:  curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || fail "Falta 'docker compose' (plugin v2). Instálalo con:  apt install docker-compose-plugin"
# Lo subido con scp queda en /opt/cuadra: lo ordeno
[ -f cuadra.dump ] && mv -f cuadra.dump deploy/cuadra.dump
[ -f conteo-local.txt ] && mv -f conteo-local.txt deploy/conteo-local.txt
[ -f .env.production ] && [ ! -f .env ] && mv .env.production .env && ok ".env creado desde .env.production"
if [ ! -f .env ]; then
  [ -f deploy/.env.production ] && mv deploy/.env.production .env && ok ".env creado desde deploy/.env.production" \
    || fail "Falta el archivo .env (súbelo: deploy/.env.production generado en tu PC)"
fi
chmod 600 .env
set -a; . ./.env; set +a
[ -n "${AUTH_SECRET:-}" ] || fail "AUTH_SECRET vacío en .env (debe ser el MISMO de tu PC)"
API_HOST_PORT=${API_HOST_PORT:-4290}; WEB_HOST_PORT=${WEB_HOST_PORT:-3290}
mkdir -p deploy/respaldos

# Puertos libres (los otros ERP del VPS ya usan algunos)
if ! $DC ps -q api 2>/dev/null | grep -q .; then
  for p in $API_HOST_PORT $WEB_HOST_PORT; do
    if ss -ltn "( sport = :$p )" | grep -q LISTEN; then
      fail "El puerto $p ya está ocupado. Cambia API_HOST_PORT / WEB_HOST_PORT en .env y vuelve a correr."
    fi
  done
fi

# --- 1. Base de datos -------------------------------------------------------
info "Levantando Postgres…"
$DC up -d postgres
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$($DC ps -q postgres)")" = healthy ] && break
  sleep 2
done
ok "Postgres listo"
PSQL="$DC exec -T postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -tA"
TABLES=$($PSQL -c "select count(*) from information_schema.tables where table_schema='public'")

if [ "$TABLES" = "0" ]; then
  if [ -f deploy/cuadra.dump ]; then
    info "Base vacía: restaurando tus datos desde deploy/cuadra.dump…"
    cp deploy/cuadra.dump deploy/respaldos/restaurar.dump
    $PSQL -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cuadra_app') THEN CREATE ROLE cuadra_app NOLOGIN; END IF; END \$\$; GRANT cuadra_app TO \"$POSTGRES_USER\";" >/dev/null
    $DC exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner /respaldos/restaurar.dump 2> deploy/respaldos/restauracion.log || true
    if grep -qi "error" deploy/respaldos/restauracion.log; then
      echo "---- avisos de pg_restore (deploy/respaldos/restauracion.log) ----"; head -30 deploy/respaldos/restauracion.log
    fi
    rm -f deploy/respaldos/restaurar.dump
    ok "Datos restaurados"
  else
    info "Base vacía y sin deploy/cuadra.dump: Cuadra partirá sin datos."
  fi
else
  ok "La base ya tiene datos ($TABLES tablas): no se toca"
fi

# --- 2. API y web -----------------------------------------------------------
info "Compilando y levantando API y web (la primera vez tarda unos minutos)…"
$DC up -d --build api web
for i in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$API_HOST_PORT/api/health" >/dev/null && break
  sleep 3
done
curl -fs "http://127.0.0.1:$API_HOST_PORT/api/health" >/dev/null && ok "API respondiendo" || { $DC logs --tail 40 api; fail "La API no partió (logs arriba)"; }

echo; info "Datos en el VPS:"
$PSQL -c "select 'empresas: '||(select count(*) from tenants)||' · usuarios: '||(select count(*) from users)||' · ventas: '||(select count(*) from sales_records)"
[ -f deploy/conteo-local.txt ] && echo "  (en tu PC:   $(cat deploy/conteo-local.txt | tr -d '\r'))"

# --- 3. Nginx + HTTPS -------------------------------------------------------
if [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/$DOMAIN
  if [ ! -f "$CONF" ]; then
    sed -e "s/__API_PORT__/$API_HOST_PORT/" -e "s/__WEB_PORT__/$WEB_HOST_PORT/" deploy/nginx-erp.budly.cl.conf > "$CONF"
    ln -sf "$CONF" /etc/nginx/sites-enabled/$DOMAIN
    nginx -t && systemctl reload nginx && ok "Nginx configurado para $DOMAIN"
    if command -v certbot >/dev/null; then
      certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect -m "${CERTBOT_EMAIL:-$SUPERADMIN_EMAIL}" \
        && ok "HTTPS activo" || info "certbot falló: revisa que $DOMAIN apunte a la IP de este VPS y corre:  certbot --nginx -d $DOMAIN"
    else
      info "No está certbot. Instálalo y activa HTTPS:  apt install certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN"
    fi
  else
    ok "Nginx ya tenía $DOMAIN (no se modifica)"
  fi
else
  info "No encontré Nginx. Apunta tu proxy a: /api/ -> 127.0.0.1:$API_HOST_PORT  y  / -> 127.0.0.1:$WEB_HOST_PORT"
fi

# --- 4. Respaldo diario -----------------------------------------------------
if [ -d /etc/cron.d ] && [ ! -f /etc/cron.d/cuadra-respaldo ]; then
  echo "30 3 * * * root bash $ROOT/deploy/respaldar-vps.sh >> $ROOT/deploy/respaldos/cron.log 2>&1" > /etc/cron.d/cuadra-respaldo
  ok "Respaldo diario programado (3:30 AM, guarda 14 días en deploy/respaldos)"
fi

echo; ok "Listo: https://$DOMAIN"
