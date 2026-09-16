\set ON_ERROR_STOP on
\set QUIET on

-- Executed through the deployment DATABASE_URL. Verify identity and effective
-- denials rather than trusting configuration text or a configured username.
SELECT
  session_user = :'runtime_role'
  AND current_user = :'runtime_role'
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role_state
    WHERE role_state.rolname = :'runtime_role'
      AND role_state.rolcanlogin
      AND NOT role_state.rolinherit
      AND NOT role_state.rolsuper
      AND NOT role_state.rolcreatedb
      AND NOT role_state.rolcreaterole
      AND NOT role_state.rolreplication
      AND NOT role_state.rolbypassrls
  )
  -- With no memberships, SET ROLE cannot cross into another identity.
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = :'runtime_role'
  )
  AND NOT has_database_privilege(current_user, current_database(), 'TEMPORARY')
  AND has_schema_privilege(current_user, 'public', 'USAGE')
  AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
  AND NOT has_table_privilege(
    current_user,
    'public."_prisma_migrations"',
    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'
  )
  AND NOT has_table_privilege(current_user, 'public."Organization"', 'DELETE')
  AND NOT has_table_privilege(current_user, 'public."User"', 'DELETE')
  AND NOT has_table_privilege(current_user, 'public."AuditEvent"', 'UPDATE, DELETE')
  AND NOT has_table_privilege(current_user, 'public."MembershipAttribution"', 'UPDATE, DELETE')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation_object
    JOIN pg_catalog.pg_namespace namespace_object ON namespace_object.oid = relation_object.relnamespace
    WHERE namespace_object.nspname = 'public'
      AND relation_object.relkind IN ('r', 'p')
      AND (
        has_table_privilege(current_user, relation_object.oid, 'TRUNCATE')
        OR has_table_privilege(current_user, relation_object.oid, 'REFERENCES')
        OR has_table_privilege(current_user, relation_object.oid, 'TRIGGER')
        OR has_table_privilege(current_user, relation_object.oid, 'MAINTAIN')
      )
  )
  AND NOT EXISTS (
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
  ) AS runtime_contract_valid
\gset

\if :runtime_contract_valid
\else
  \echo 'DATABASE_URL does not satisfy the runtime database-role contract.'
  \quit 65
\endif
