import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  assertAuditEventIntegrity,
  AUDIT_ACTION_MAX_LENGTH,
  AUDIT_METADATA_MAX_ARRAY_ITEMS,
  AUDIT_METADATA_MAX_OBJECT_KEYS,
  AUDIT_METADATA_MAX_STRING_BYTES,
} from "../src/audit/integrity.js";
import { MemoryStore } from "../src/store/memory.js";
import { PrismaStore } from "../src/store/prisma.js";

const event = (metadata: Record<string, unknown> = {}) => ({
  organizationId: "org-a",
  actorType: "system",
  action: "test.recorded",
  entityType: "test",
  metadata,
});

describe("audit event local integrity limits", () => {
  afterEach(() => vi.useRealTimers());

  it("accepts bounded scalar and structured metadata", () => {
    expect(() =>
      assertAuditEventIntegrity({
        ...event({ nested: { values: [1, true, null, "ok"] } }),
        action: "a".repeat(AUDIT_ACTION_MAX_LENGTH),
      }),
    ).not.toThrow();
  });

  it("rejects empty or oversized scalar fields", () => {
    expect(() =>
      assertAuditEventIntegrity({ ...event(), actorType: "" }),
    ).toThrow(RangeError);
    expect(() =>
      assertAuditEventIntegrity({
        ...event(),
        action: "a".repeat(AUDIT_ACTION_MAX_LENGTH + 1),
      }),
    ).toThrow(RangeError);
    expect(() =>
      assertAuditEventIntegrity({ ...event(), action: "invalid\0action" }),
    ).toThrow("U+0000");
    expect(() =>
      assertAuditEventIntegrity({ ...event(), entityType: "invalid\ud800" }),
    ).toThrow("unpaired UTF-16");
  });

  it("matches PostgreSQL text compatibility for metadata strings and keys", () => {
    expect(() =>
      assertAuditEventIntegrity(event({ value: "bad\0value" })),
    ).toThrow("U+0000");
    expect(() =>
      assertAuditEventIntegrity(event({ ["bad\udc00key"]: true })),
    ).toThrow("unpaired UTF-16");
    expect(() =>
      assertAuditEventIntegrity(
        event({ ["valid-\ud83d\ude00"]: "value-\ud83d\ude00" }),
      ),
    ).not.toThrow();
  });

  it("rejects non-JSON, excessive-depth, cardinality, and size metadata", () => {
    expect(() =>
      assertAuditEventIntegrity({ ...event(), metadata: [] as never }),
    ).toThrow("must be a JSON object");
    expect(() =>
      assertAuditEventIntegrity(event({ invalid: Number.NaN })),
    ).toThrow("finite");
    expect(() =>
      assertAuditEventIntegrity(event({ invalid: undefined })),
    ).toThrow("only JSON values");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertAuditEventIntegrity(event(cyclic))).toThrow("cycles");

    const shared = { value: "shared" };
    expect(() =>
      assertAuditEventIntegrity(event({ first: shared, second: shared })),
    ).toThrow("repeated object references");

    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 9; depth++) nested = { nested };
    expect(() => assertAuditEventIntegrity(event(nested))).toThrow(
      "nested levels",
    );

    expect(() =>
      assertAuditEventIntegrity(
        event(
          Object.fromEntries(
            Array.from(
              { length: AUDIT_METADATA_MAX_OBJECT_KEYS + 1 },
              (_, index) => [`key-${index}`, index],
            ),
          ),
        ),
      ),
    ).toThrow("keys");
    expect(() =>
      assertAuditEventIntegrity(
        event({ values: Array(AUDIT_METADATA_MAX_ARRAY_ITEMS + 1).fill(0) }),
      ),
    ).toThrow("items");
    expect(() =>
      assertAuditEventIntegrity(
        event({ value: "x".repeat(AUDIT_METADATA_MAX_STRING_BYTES + 1) }),
      ),
    ).toThrow("strings");
    expect(() =>
      assertAuditEventIntegrity(
        event(
          Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
              `key-${index}`,
              "x".repeat(2_000),
            ]),
          ),
        ),
      ),
    ).toThrow("PostgreSQL-text-estimate");
  });

  it("enforces the conservative 16 KiB metadata estimate in MemoryStore", async () => {
    const store = new MemoryStore();
    const metadata = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `key-${index}`,
          "x".repeat(1_900),
        ]),
      );

    await expect(store.audit(event(metadata(8)))).resolves.toBeUndefined();
    await expect(store.audit(event(metadata(9)))).rejects.toThrow(
      "PostgreSQL-text-estimate",
    );
    expect(store.audits).toHaveLength(1);
  });

  it("clones and freezes MemoryStore audit records and snapshots", async () => {
    const store = new MemoryStore();
    const metadata = { nested: { value: "original" } };
    await store.audit(event(metadata));

    metadata.nested.value = "changed";
    expect(store.audits[0]!.metadata).toEqual({
      nested: { value: "original" },
    });
    expect(Object.isFrozen(store.audits)).toBe(true);
    expect(Object.isFrozen(store.audits[0])).toBe(true);
    expect(Object.isFrozen(store.audits[0]!.metadata.nested)).toBe(true);
    expect(() => (store.audits as unknown as Array<unknown>).push({})).toThrow(
      TypeError,
    );
  });

  it("orders equal-time MemoryStore rows by descending id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const store = new MemoryStore();
    await store.audit({ ...event(), action: "test.first" });
    await store.audit({ ...event(), action: "test.second" });
    const expectedIds = store.audits
      .map(({ id }) => id)
      .sort((left, right) => right.localeCompare(left));

    expect((await store.listAudits("org-a", 10)).map(({ id }) => id)).toEqual(
      expectedIds,
    );
  });

  it("requests both deterministic audit sort keys from Prisma", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { auditEvent: { findMany } } as unknown as PrismaClient;

    await expect(
      new PrismaStore(prisma).listAudits("org-a", 10),
    ).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-a" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
    });
  });

  it("does not claim a pairing when caller-influenced audit data is invalid", async () => {
    const store = new MemoryStore();
    const pairing = await store.createPairing(
      "org-a",
      "code-hash",
      new Date(Date.now() + 60_000).toISOString(),
    );

    await expect(
      store.claimPairingAndAudit(
        pairing.codeHash,
        {
          installationId: "installation-a",
          model: "Model",
          osVersion: "1",
          playerVersion: "1",
        },
        "token-hash",
        { metadata: { value: "x".repeat(20_000) } },
      ),
    ).rejects.toThrow();
    expect(pairing.status).toBe("PENDING");
    expect(store.screens).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("does not claim a pairing when audit construction fails", async () => {
    class RejectingAuditStore extends MemoryStore {
      protected override buildAuditRecord(): never {
        throw new Error("audit unavailable");
      }
    }
    const store = new RejectingAuditStore();
    const pairing = await store.createPairing(
      "org-a",
      "rejecting-code-hash",
      new Date(Date.now() + 60_000).toISOString(),
    );

    await expect(
      store.claimPairingAndAudit(
        pairing.codeHash,
        {
          installationId: "installation-a",
          model: "Model",
          osVersion: "1",
          playerVersion: "1",
        },
        "token-hash",
        {},
      ),
    ).rejects.toThrow("audit unavailable");
    expect(pairing.status).toBe("PENDING");
    expect(store.screens).toEqual([]);
    expect(store.audits).toEqual([]);
  });
});
