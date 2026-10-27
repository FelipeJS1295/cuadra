#!/bin/sh
# Solo corre la primera vez que se crea la base: el rol que usa Cuadra para separar empresas (RLS).
# Tiene que existir antes de restaurar el respaldo, porque pg_dump no guarda los roles.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cuadra_app') THEN CREATE ROLE cuadra_app NOLOGIN; END IF;
END \$\$;
GRANT cuadra_app TO "$POSTGRES_USER";
SQL
