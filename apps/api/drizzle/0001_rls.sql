-- ===========================================================================
-- Aislamiento entre empresas (Row Level Security)
--
-- La API, en cada pedido de una empresa, hace:
--   SET LOCAL ROLE cuadra_app;  SELECT set_config('app.tenant_id', '<empresa>', true);
-- y PostgreSQL solo deja ver/escribir filas con ese tenant_id.
-- ===========================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cuadra_app') THEN
    CREATE ROLE cuadra_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT cuadra_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO cuadra_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cuadra_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cuadra_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cuadra_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cuadra_app;
--> statement-breakpoint
-- Tablas globales: dentro de una empresa solo se pueden leer (y de users, nunca la contraseña)
REVOKE ALL ON users, tenants, memberships FROM cuadra_app;
--> statement-breakpoint
GRANT SELECT (id, email, name) ON users TO cuadra_app;
--> statement-breakpoint
GRANT SELECT ON tenants, memberships TO cuadra_app;
--> statement-breakpoint
-- Activa RLS en toda tabla con tenant_id (menos memberships). Llamar de nuevo en migraciones futuras.
CREATE OR REPLACE FUNCTION cuadra_enable_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('memberships')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
SELECT cuadra_enable_rls();
