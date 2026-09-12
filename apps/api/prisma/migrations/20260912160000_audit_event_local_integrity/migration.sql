-- These controls bound local audit rows and reject ordinary row mutation. They
-- are not a WORM or tamper-evidence boundary: the current table-owning database
-- role can alter/disable the trigger or truncate the table.
BEGIN;

CREATE FUNCTION "audit_event_metadata_shape_valid"("value" JSONB, "depth" INTEGER DEFAULT 0)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $audit_metadata_shape$
DECLARE
  "child" JSONB;
  "memberCount" BIGINT;
BEGIN
  IF "depth" > 8 THEN
    RETURN FALSE;
  END IF;

  CASE jsonb_typeof("value")
    WHEN 'object' THEN
      SELECT COUNT(*) INTO "memberCount" FROM jsonb_object_keys("value");
      IF "memberCount" > 64 THEN
        RETURN FALSE;
      END IF;
      FOR "child" IN SELECT "entry"."value" FROM jsonb_each("value") AS "entry"
      LOOP
        IF NOT public."audit_event_metadata_shape_valid"("child", "depth" + 1) THEN
          RETURN FALSE;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      IF jsonb_array_length("value") > 256 THEN
        RETURN FALSE;
      END IF;
      FOR "child" IN SELECT "entry"."value" FROM jsonb_array_elements("value") AS "entry"
      LOOP
        IF NOT public."audit_event_metadata_shape_valid"("child", "depth" + 1) THEN
          RETURN FALSE;
        END IF;
      END LOOP;
    WHEN 'string' THEN
      IF octet_length("value" #>> '{}') > 2048 THEN
        RETURN FALSE;
      END IF;
  END CASE;

  RETURN TRUE;
END
$audit_metadata_shape$;

CREATE FUNCTION "reject_audit_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $audit_mutation_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Preserve the existing User ON DELETE SET NULL lifecycle without opening a
    -- general update path. The deleted parent is no longer visible to its own
    -- referential action, and every other audit value must remain identical.
    IF OLD."actorUserId" IS NOT NULL
      AND NEW."actorUserId" IS NULL
      AND ROW(
        NEW."id", NEW."organizationId", NEW."actorType", NEW."action",
        NEW."entityType", NEW."entityId", NEW."ipAddress", NEW."requestId",
        NEW."metadata", NEW."createdAt"
      ) IS NOT DISTINCT FROM ROW(
        OLD."id", OLD."organizationId", OLD."actorType", OLD."action",
        OLD."entityType", OLD."entityId", OLD."ipAddress", OLD."requestId",
        OLD."metadata", OLD."createdAt"
      )
      AND NOT EXISTS (
        SELECT 1 FROM public."User" WHERE "id" = OLD."actorUserId"
      )
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'AuditEvent rows cannot be updated';
  END IF;

  -- Preserve the existing Organization ON DELETE CASCADE lifecycle. Direct
  -- deletion remains rejected while the owning tenant exists.
  IF EXISTS (
    SELECT 1 FROM public."Organization" WHERE "id" = OLD."organizationId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'AuditEvent rows cannot be deleted directly';
  END IF;

  RETURN OLD;
END
$audit_mutation_guard$;

CREATE TRIGGER "AuditEvent_reject_mutation"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_audit_event_mutation"();

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_actorType_length"
    CHECK (char_length("actorType") BETWEEN 1 AND 32) NOT VALID,
  ADD CONSTRAINT "AuditEvent_action_length"
    CHECK (char_length("action") BETWEEN 1 AND 96) NOT VALID,
  ADD CONSTRAINT "AuditEvent_entityType_length"
    CHECK (char_length("entityType") BETWEEN 1 AND 64) NOT VALID,
  ADD CONSTRAINT "AuditEvent_entityId_length"
    CHECK ("entityId" IS NULL OR char_length("entityId") BETWEEN 1 AND 256) NOT VALID,
  ADD CONSTRAINT "AuditEvent_ipAddress_length"
    CHECK ("ipAddress" IS NULL OR char_length("ipAddress") BETWEEN 1 AND 64) NOT VALID,
  ADD CONSTRAINT "AuditEvent_requestId_length"
    CHECK ("requestId" IS NULL OR char_length("requestId") BETWEEN 1 AND 128) NOT VALID,
  ADD CONSTRAINT "AuditEvent_metadata_object"
    CHECK (jsonb_typeof("metadata") = 'object') NOT VALID,
  ADD CONSTRAINT "AuditEvent_metadata_storage_size"
    CHECK (pg_column_size("metadata") <= 32768) NOT VALID,
  ADD CONSTRAINT "AuditEvent_metadata_shape"
    CHECK (public."audit_event_metadata_shape_valid"("metadata")) NOT VALID;

ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_actorType_length";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_action_length";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_entityType_length";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_entityId_length";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_ipAddress_length";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_requestId_length";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_metadata_object";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_metadata_storage_size";
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_metadata_shape";

DROP INDEX "AuditEvent_organizationId_createdAt_idx";
CREATE INDEX "AuditEvent_organizationId_createdAt_id_idx"
  ON "AuditEvent"("organizationId", "createdAt", "id");

COMMIT;
