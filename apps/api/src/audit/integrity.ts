import type { AuditRecord } from "../domain/types.js";

export const AUDIT_ACTOR_TYPE_MAX_LENGTH = 32;
export const AUDIT_ACTION_MAX_LENGTH = 96;
export const AUDIT_ENTITY_TYPE_MAX_LENGTH = 64;
export const AUDIT_ENTITY_ID_MAX_LENGTH = 256;
export const AUDIT_IP_ADDRESS_MAX_LENGTH = 64;
export const AUDIT_REQUEST_ID_MAX_LENGTH = 128;
export const AUDIT_METADATA_MAX_BYTES = 16 * 1024;
export const AUDIT_METADATA_MAX_DEPTH = 8;
export const AUDIT_METADATA_MAX_OBJECT_KEYS = 64;
export const AUDIT_METADATA_MAX_ARRAY_ITEMS = 256;
export const AUDIT_METADATA_MAX_STRING_BYTES = 2 * 1024;

type AuditEventInput = Omit<AuditRecord, "id" | "createdAt">;

const assertPostgresTextCompatible = (value: string, field: string) => {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0)
      throw new TypeError(`${field} cannot contain the U+0000 character`);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff))
        throw new TypeError(
          `${field} cannot contain unpaired UTF-16 surrogates`,
        );
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${field} cannot contain unpaired UTF-16 surrogates`);
    }
  }
};

const assertBoundedString = (
  value: string | undefined,
  field: string,
  maximum: number,
  optional = false,
) => {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new RangeError(`${field} must contain 1 to ${maximum} characters`);
  assertPostgresTextCompatible(value, field);
};

const validateJsonValue = (
  value: unknown,
  depth: number,
  seen: Set<object>,
): number => {
  if (depth > AUDIT_METADATA_MAX_DEPTH)
    throw new RangeError(
      `Audit metadata cannot exceed ${AUDIT_METADATA_MAX_DEPTH} nested levels`,
    );
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "string") {
    assertPostgresTextCompatible(value, "Audit metadata strings");
    if (Buffer.byteLength(value, "utf8") > AUDIT_METADATA_MAX_STRING_BYTES)
      throw new RangeError(
        `Audit metadata strings cannot exceed ${AUDIT_METADATA_MAX_STRING_BYTES} UTF-8 bytes`,
      );
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Audit metadata numbers must be finite");
    // PostgreSQL jsonb may expand JavaScript's exponent notation when rendering
    // metadata::text. This bounds every finite IEEE-754 value conservatively.
    return 330;
  }
  if (typeof value !== "object")
    throw new TypeError("Audit metadata must contain only JSON values");
  if (seen.has(value))
    throw new TypeError(
      "Audit metadata cannot contain cycles or repeated object references",
    );

  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > AUDIT_METADATA_MAX_ARRAY_ITEMS)
      throw new RangeError(
        `Audit metadata arrays cannot exceed ${AUDIT_METADATA_MAX_ARRAY_ITEMS} items`,
      );
    let bytes = 2;
    for (const [index, item] of value.entries()) {
      if (index > 0) bytes += 2; // PostgreSQL jsonb text uses `, `.
      bytes += validateJsonValue(item, depth + 1, seen);
      if (bytes > AUDIT_METADATA_MAX_BYTES)
        throw new RangeError(
          `Audit metadata cannot exceed ${AUDIT_METADATA_MAX_BYTES} PostgreSQL-text-estimate bytes`,
        );
    }
    return bytes;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Audit metadata objects must be plain JSON objects");
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0)
    throw new TypeError("Audit metadata cannot contain symbol keys");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  if (entries.length > AUDIT_METADATA_MAX_OBJECT_KEYS)
    throw new RangeError(
      `Audit metadata objects cannot exceed ${AUDIT_METADATA_MAX_OBJECT_KEYS} keys`,
    );
  let bytes = 2;
  for (const [index, [key, descriptor]] of entries.entries()) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set)
      throw new TypeError(
        "Audit metadata must contain only enumerable data properties",
      );
    if (index > 0) bytes += 2; // PostgreSQL jsonb text uses `, `.
    assertPostgresTextCompatible(key, "Audit metadata keys");
    bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 2; // `: `
    bytes += validateJsonValue(descriptor.value, depth + 1, seen);
    if (bytes > AUDIT_METADATA_MAX_BYTES)
      throw new RangeError(
        `Audit metadata cannot exceed ${AUDIT_METADATA_MAX_BYTES} PostgreSQL-text-estimate bytes`,
      );
  }
  return bytes;
};

export const assertAuditEventIntegrity = (event: AuditEventInput): void => {
  assertBoundedString(
    event.actorType,
    "Audit actorType",
    AUDIT_ACTOR_TYPE_MAX_LENGTH,
  );
  assertBoundedString(event.action, "Audit action", AUDIT_ACTION_MAX_LENGTH);
  assertBoundedString(
    event.entityType,
    "Audit entityType",
    AUDIT_ENTITY_TYPE_MAX_LENGTH,
  );
  assertBoundedString(
    event.entityId,
    "Audit entityId",
    AUDIT_ENTITY_ID_MAX_LENGTH,
    true,
  );
  assertBoundedString(
    event.ipAddress,
    "Audit ipAddress",
    AUDIT_IP_ADDRESS_MAX_LENGTH,
    true,
  );
  assertBoundedString(
    event.requestId,
    "Audit requestId",
    AUDIT_REQUEST_ID_MAX_LENGTH,
    true,
  );

  if (
    event.metadata === null ||
    typeof event.metadata !== "object" ||
    Array.isArray(event.metadata)
  )
    throw new TypeError("Audit metadata must be a JSON object");
  const estimatedBytes = validateJsonValue(event.metadata, 0, new Set());
  if (estimatedBytes > AUDIT_METADATA_MAX_BYTES)
    throw new RangeError(
      `Audit metadata cannot exceed ${AUDIT_METADATA_MAX_BYTES} PostgreSQL-text-estimate bytes`,
    );
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

export const immutableAuditRecord = (
  event: AuditEventInput,
  id: string,
  createdAt: string,
): AuditRecord => {
  assertAuditEventIntegrity(event);
  return deepFreeze({
    id,
    ...event,
    metadata: structuredClone(event.metadata),
    createdAt,
  });
};
