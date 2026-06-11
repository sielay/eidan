-- The non-superuser role the runtime connects as, so RLS enforces (a superuser bypasses RLS).
-- The operator sets its password out-of-band:  ALTER ROLE eidan_app PASSWORD '...';
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eidan_app') THEN
    CREATE ROLE eidan_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA eidan TO eidan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA eidan TO eidan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA eidan TO eidan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA eidan GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eidan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA eidan GRANT USAGE, SELECT ON SEQUENCES TO eidan_app;
