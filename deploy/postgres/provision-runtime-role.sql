\set ON_ERROR_STOP on
\set QUIET on
\getenv runtime_password POSTGRES_RUNTIME_PASSWORD

-- This script runs as the role that owns the Prisma-managed public schema.
-- psql's :'name' quoting makes role names and the password SQL literals; every
-- identifier is then emitted with PostgreSQL format('%I', ...).
BEGIN;

SELECT current_user = :'migrator_role' AS migrator_matches_connection
\gset
\if :migrator_matches_connection
\else
  \echo 'Migration connection user does not match POSTGRES_USER.'
  \quit 65
\endif

SELECT :'runtime_role' <> :'migrator_role' AS roles_are_separate
\gset
\if :roles_are_separate
\else
  \echo 'Runtime and migration roles must be different.'
  \quit 65
\endif

SELECT format(
  'CREATE ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'runtime_role'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'runtime_role'
)
\gexec

-- Reconcile attributes and rotate the runtime password on every run. This is
-- intentionally idempotent and removes attributes an operator may have added.
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_role',
  :'runtime_password'
)
\gexec

-- A runtime login must not be able to SET ROLE to any other identity.
SELECT format('REVOKE %I FROM %I', granted_role.rolname, :'runtime_role')
FROM pg_catalog.pg_auth_members membership
JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname = :'runtime_role'
ORDER BY granted_role.rolname
\gexec

-- Refuse to bless a runtime identity that already owns application/database
-- objects. Ownership would bypass the grant boundary below.
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_database database_object
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = database_object.datdba
  WHERE database_object.datname = current_database()
    AND owner_role.rolname = :'runtime_role'
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_namespace namespace_object
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = namespace_object.nspowner
  WHERE namespace_object.nspname = 'public'
    AND owner_role.rolname = :'runtime_role'
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_class relation_object
  JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = relation_object.relnamespace
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation_object.relowner
  WHERE namespace_object.nspname = 'public'
    AND owner_role.rolname = :'runtime_role'
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_proc function_object
  JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = function_object.pronamespace
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = function_object.proowner
  WHERE namespace_object.nspname = 'public'
    AND owner_role.rolname = :'runtime_role'
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_type type_object
  JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = type_object.typnamespace
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = type_object.typowner
  WHERE namespace_object.nspname = 'public'
    AND owner_role.rolname = :'runtime_role'
) AS runtime_owns_nothing
\gset
\if :runtime_owns_nothing
\else
  \echo 'Runtime role owns database objects; refusing to provision unsafe privileges.'
  \quit 65
\endif

-- PUBLIC otherwise gives every login temporary-table creation and, on some
-- PostgreSQL versions/configurations, public-schema creation or function use.
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'runtime_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role')
\gexec

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role')
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'runtime_role'
)
\gexec

-- The Prisma ledger belongs exclusively to the migrator. Append-only evidence
-- tables retain only the operations exercised by the API, while tenant/root
-- identity deletion stays an offline privileged operation.
SELECT format(
  'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
  '_prisma_migrations',
  :'runtime_role'
)
\gexec
SELECT format(
  'REVOKE UPDATE, DELETE ON TABLE public.%I, public.%I FROM %I',
  'AuditEvent',
  'MembershipAttribution',
  :'runtime_role'
)
\gexec
SELECT format(
  'REVOKE DELETE ON TABLE public.%I, public.%I FROM %I',
  'Organization',
  'User',
  :'runtime_role'
)
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', :'runtime_role')
\gexec

-- PostgreSQL has no aggregate schema form for type grants. Enumerate the
-- application enums and domains, quoting both schema and type identifiers.
SELECT format(
  'REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM PUBLIC',
  namespace_object.nspname,
  type_object.typname
)
FROM pg_catalog.pg_type type_object
JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = type_object.typnamespace
WHERE namespace_object.nspname = 'public'
  AND type_object.typtype IN ('d', 'e')
ORDER BY type_object.typname
\gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM %I',
  namespace_object.nspname,
  type_object.typname,
  :'runtime_role'
)
FROM pg_catalog.pg_type type_object
JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = type_object.typnamespace
WHERE namespace_object.nspname = 'public'
  AND type_object.typtype IN ('d', 'e')
ORDER BY type_object.typname
\gexec
SELECT format(
  'GRANT USAGE ON TYPE %I.%I TO %I',
  namespace_object.nspname,
  type_object.typname,
  :'runtime_role'
)
FROM pg_catalog.pg_type type_object
JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = type_object.typnamespace
WHERE namespace_object.nspname = 'public'
  AND type_object.typtype IN ('d', 'e')
ORDER BY type_object.typname
\gexec

-- PostgreSQL grants function EXECUTE to PUBLIC by default. Remove that broad
-- path before granting the sole scalar application function used by a CHECK
-- constraint. Trigger functions run through their owning table's trigger and
-- are deliberately not directly executable by the runtime role.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION public.%I(jsonb, integer) TO %I',
  'audit_event_metadata_shape_valid',
  :'runtime_role'
)
\gexec

-- Reconcile future objects created by the migration owner. A migration that
-- introduces another directly invoked application function must add it to the
-- explicit allowlist above rather than inheriting PostgreSQL's PUBLIC default.
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC',
  :'migrator_role'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC',
  :'migrator_role'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
  :'migrator_role'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL PRIVILEGES ON TYPES FROM PUBLIC',
  :'migrator_role'
)
\gexec

COMMIT;
