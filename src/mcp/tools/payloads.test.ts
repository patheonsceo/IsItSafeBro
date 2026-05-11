import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PayloadFileSchema, type PayloadFile } from "./payload-schema.js";
import { loadPayloads } from "./payloads.js";

/* -------------------------------------------------------------------------- */
/*  Schema tests                                                              */
/* -------------------------------------------------------------------------- */

const minimalValidPayload = {
  id: "x-test",
  name: "test",
  description: "test",
  category: "auth" as const,
  severity: "low" as const,
  endpoints_hint: ["/x"],
  request: { method: "GET" as const },
  success_signal: { kind: "status_in" as const, values: [200] },
  fix_hint: "test",
};

function wrap(payload: object | object[]): unknown {
  return {
    category: "auth",
    version: 1,
    payloads: Array.isArray(payload) ? payload : [payload],
  };
}

describe("PayloadFileSchema", () => {
  it("accepts a minimal valid file", () => {
    const r = PayloadFileSchema.safeParse(wrap(minimalValidPayload));
    expect(r.success).toBe(true);
  });

  it("rejects an id with uppercase or underscores", () => {
    expect(
      PayloadFileSchema.safeParse(wrap({ ...minimalValidPayload, id: "Bad-Id" })).success,
    ).toBe(false);
    expect(
      PayloadFileSchema.safeParse(wrap({ ...minimalValidPayload, id: "bad_id" })).success,
    ).toBe(false);
  });

  it("rejects mismatched payload category vs file category", () => {
    const r = PayloadFileSchema.safeParse(wrap({ ...minimalValidPayload, category: "api" }));
    expect(r.success).toBe(false);
  });

  it("rejects duplicate payload ids", () => {
    const r = PayloadFileSchema.safeParse(
      wrap([
        minimalValidPayload,
        { ...minimalValidPayload, name: "dup" },
      ]),
    );
    expect(r.success).toBe(false);
  });

  it("rejects an unknown signal kind", () => {
    const r = PayloadFileSchema.safeParse(
      wrap({
        ...minimalValidPayload,
        success_signal: { kind: "magic_check", values: [] } as unknown,
      }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts deeply nested all_of / any_of signals", () => {
    const nested = {
      kind: "all_of",
      conditions: [
        { kind: "status_in", values: [200] },
        {
          kind: "any_of",
          conditions: [
            { kind: "body_contains_any", patterns: ["a"] },
            {
              kind: "all_of",
              conditions: [
                { kind: "header_present", name: "set-cookie" },
                { kind: "body_not_contains_any", patterns: ["x"], case_insensitive: true },
              ],
            },
          ],
        },
      ],
    };
    const r = PayloadFileSchema.safeParse(
      wrap({ ...minimalValidPayload, success_signal: nested }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects status_in with no values", () => {
    const r = PayloadFileSchema.safeParse(
      wrap({ ...minimalValidPayload, success_signal: { kind: "status_in", values: [] } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects body_contains_any with no patterns", () => {
    const r = PayloadFileSchema.safeParse(
      wrap({ ...minimalValidPayload, success_signal: { kind: "body_contains_any", patterns: [] } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects an empty payloads array", () => {
    const r = PayloadFileSchema.safeParse({ category: "auth", version: 1, payloads: [] });
    expect(r.success).toBe(false);
  });

  it("rejects file with wrong version", () => {
    const r = PayloadFileSchema.safeParse({
      category: "auth",
      version: 2,
      payloads: [minimalValidPayload],
    });
    expect(r.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Loader tests (against a temp directory)                                   */
/* -------------------------------------------------------------------------- */

describe("loadPayloads", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isitsafebro-payload-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function writeCategory(category: "auth" | "api" | "prompt" | "secrets" | "idor", contents: unknown) {
    writeFileSync(join(dir, `${category}.json`), JSON.stringify(contents));
  }

  function validFile(category: "auth" | "api" | "prompt" | "secrets" | "idor"): PayloadFile {
    return {
      category,
      version: 1,
      payloads: [
        {
          id: `${category}-sample`,
          name: `${category} sample`,
          description: "test payload",
          category,
          severity: "low",
          endpoints_hint: ["/x"],
          request: { method: "GET" },
          success_signal: { kind: "status_in", values: [200] },
          fix_hint: "test",
        },
      ],
    };
  }

  it("loads a single category successfully", () => {
    writeCategory("auth", validFile("auth"));
    const r = loadPayloads({ category: "auth", payloadsDir: dir });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(1);
    expect(r.loaded[0]?.category).toBe("auth");
    expect(r.loaded[0]?.payloads[0]?.id).toBe("auth-sample");
    expect(r.missing).toEqual([]);
  });

  it("hard-errors on missing single category", () => {
    const r = loadPayloads({ category: "auth", payloadsDir: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("hard-errors on bad JSON", () => {
    writeFileSync(join(dir, "auth.json"), "{ this is not json");
    const r = loadPayloads({ category: "auth", payloadsDir: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad_json");
  });

  it("hard-errors on schema violation", () => {
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ category: "auth", version: 1, payloads: [{ id: "BAD", name: "n", description: "d" }] }),
    );
    const r = loadPayloads({ category: "auth", payloadsDir: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad_schema");
  });

  it("'all' returns whatever's present and lists missing", () => {
    writeCategory("auth", validFile("auth"));
    writeCategory("api", validFile("api"));
    const r = loadPayloads({ category: "all", payloadsDir: dir });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
    expect(r.loaded.map((c) => c.category).sort()).toEqual(["api", "auth"]);
    expect(r.missing.sort()).toEqual(["idor", "prompt", "secrets"]);
  });

  it("'all' hard-errors if any present file is malformed (not silently skip)", () => {
    writeCategory("auth", validFile("auth"));
    writeFileSync(join(dir, "api.json"), "{ broken");
    const r = loadPayloads({ category: "all", payloadsDir: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad_json");
  });
});
