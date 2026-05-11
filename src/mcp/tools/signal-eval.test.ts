import { describe, it, expect } from "vitest";
import { evaluateSignal, normalizeHeaders, type EvalContext } from "./signal-eval.js";
import type { Signal } from "./payload-schema.js";

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    status: 200,
    headers: {},
    body: "",
    ...overrides,
  };
}

describe("evaluateSignal — leaves", () => {
  it("status_in matches when status is in the list", () => {
    const sig: Signal = { kind: "status_in", values: [200, 201] };
    expect(evaluateSignal(sig, ctx({ status: 200 })).matched).toBe(true);
    expect(evaluateSignal(sig, ctx({ status: 404 })).matched).toBe(false);
  });

  it("status_not_in is the negation of status_in", () => {
    const sig: Signal = { kind: "status_not_in", values: [401, 403] };
    expect(evaluateSignal(sig, ctx({ status: 200 })).matched).toBe(true);
    expect(evaluateSignal(sig, ctx({ status: 401 })).matched).toBe(false);
  });

  it("body_contains_any short-circuits on first match", () => {
    const sig: Signal = { kind: "body_contains_any", patterns: ["foo", "bar"] };
    const r = evaluateSignal(sig, ctx({ body: "this has bar in it" }));
    expect(r.matched).toBe(true);
    expect(r.explanation).toContain('"bar"');
  });

  it("body_contains_any case_insensitive normalizes both sides", () => {
    const sig: Signal = {
      kind: "body_contains_any",
      patterns: ["ADMIN"],
      case_insensitive: true,
    };
    expect(evaluateSignal(sig, ctx({ body: "the admin panel" })).matched).toBe(true);
  });

  it("body_contains_all requires every pattern", () => {
    const sig: Signal = { kind: "body_contains_all", patterns: ["a", "b", "c"] };
    expect(evaluateSignal(sig, ctx({ body: "a b c d" })).matched).toBe(true);
    expect(evaluateSignal(sig, ctx({ body: "a b d" })).matched).toBe(false);
  });

  it("body_not_contains_any matches when none of the patterns are present", () => {
    const sig: Signal = { kind: "body_not_contains_any", patterns: ["log in", "sign in"] };
    expect(evaluateSignal(sig, ctx({ body: "welcome admin" })).matched).toBe(true);
    expect(evaluateSignal(sig, ctx({ body: "please sign in" })).matched).toBe(false);
  });

  it("body_matches_regex compiles flags correctly", () => {
    const sig: Signal = {
      kind: "body_matches_regex",
      pattern: '"role"\\s*:\\s*"admin"',
    };
    expect(evaluateSignal(sig, ctx({ body: '{"role":"admin"}' })).matched).toBe(true);
    expect(evaluateSignal(sig, ctx({ body: '{"role":"user"}' })).matched).toBe(false);
  });

  it("body_matches_regex with invalid regex returns matched=false and explains why", () => {
    const sig: Signal = { kind: "body_matches_regex", pattern: "(" };
    const r = evaluateSignal(sig, ctx({ body: "anything" }));
    expect(r.matched).toBe(false);
    expect(r.explanation).toContain("invalid regex");
  });

  it("header_present looks up case-insensitively", () => {
    const headers = { "set-cookie": ["sid=abc"] };
    const sig: Signal = { kind: "header_present", name: "Set-Cookie" };
    expect(evaluateSignal(sig, ctx({ headers })).matched).toBe(true);
    expect(evaluateSignal(sig, ctx()).matched).toBe(false);
  });

  it("header_missing is the inverse of header_present", () => {
    const headers = { "x-frame-options": ["DENY"] };
    expect(
      evaluateSignal(
        { kind: "header_missing", name: "content-security-policy" },
        ctx({ headers }),
      ).matched,
    ).toBe(true);
    expect(
      evaluateSignal({ kind: "header_missing", name: "x-frame-options" }, ctx({ headers })).matched,
    ).toBe(false);
  });

  it("header_value_contains matches across multi-value headers", () => {
    const headers = { "set-cookie": ["csrf=xyz; Path=/", "sid=abc; HttpOnly"] };
    expect(
      evaluateSignal(
        {
          kind: "header_value_contains",
          name: "set-cookie",
          pattern: "HttpOnly",
          case_insensitive: true,
        },
        ctx({ headers }),
      ).matched,
    ).toBe(true);
  });

  it("header_value_not_contains is vacuously true when the header is absent", () => {
    const sig: Signal = {
      kind: "header_value_not_contains",
      name: "set-cookie",
      pattern: "HttpOnly",
    };
    expect(evaluateSignal(sig, ctx()).matched).toBe(true);
  });

  it("header_value_not_contains finds violations across multi-value", () => {
    const headers = { "set-cookie": ["a=1; HttpOnly", "b=2"] };
    const sig: Signal = {
      kind: "header_value_not_contains",
      name: "set-cookie",
      pattern: "HttpOnly",
      case_insensitive: true,
    };
    expect(evaluateSignal(sig, ctx({ headers })).matched).toBe(false);
  });
});

describe("evaluateSignal — combinators", () => {
  it("all_of evaluates every child and reports the score", () => {
    const sig: Signal = {
      kind: "all_of",
      conditions: [
        { kind: "status_in", values: [200] },
        { kind: "body_contains_any", patterns: ["admin"], case_insensitive: true },
        { kind: "body_not_contains_any", patterns: ["log in"], case_insensitive: true },
      ],
    };
    const r = evaluateSignal(sig, ctx({ status: 200, body: "admin panel" }));
    expect(r.matched).toBe(true);
    expect(r.explanation).toContain("all_of (3/3 matched)");
  });

  it("all_of fails when any child fails (explanation still shows all children)", () => {
    const sig: Signal = {
      kind: "all_of",
      conditions: [
        { kind: "status_in", values: [200] },
        { kind: "body_contains_any", patterns: ["admin"] },
      ],
    };
    const r = evaluateSignal(sig, ctx({ status: 200, body: "login form" }));
    expect(r.matched).toBe(false);
    expect(r.explanation).toContain("all_of (1/2 matched)");
    expect(r.explanation).toContain("status_in");
    expect(r.explanation).toContain("body_contains_any");
  });

  it("any_of matches when at least one child matches", () => {
    const sig: Signal = {
      kind: "any_of",
      conditions: [
        { kind: "status_in", values: [200] },
        { kind: "header_present", name: "set-cookie" },
      ],
    };
    expect(
      evaluateSignal(sig, ctx({ status: 401, headers: { "set-cookie": ["x=1"] } })).matched,
    ).toBe(true);
    expect(evaluateSignal(sig, ctx({ status: 401 })).matched).toBe(false);
  });

  it("supports arbitrarily nested combinators", () => {
    const sig: Signal = {
      kind: "all_of",
      conditions: [
        { kind: "status_in", values: [200, 201] },
        {
          kind: "any_of",
          conditions: [
            { kind: "body_contains_any", patterns: ["token"] },
            { kind: "header_present", name: "set-cookie" },
          ],
        },
      ],
    };
    expect(
      evaluateSignal(sig, ctx({ status: 200, body: "{ \"token\": \"abc\" }" })).matched,
    ).toBe(true);
    expect(
      evaluateSignal(sig, ctx({ status: 200, headers: { "set-cookie": ["x=1"] } })).matched,
    ).toBe(true);
    expect(evaluateSignal(sig, ctx({ status: 200, body: "no auth stuff" })).matched).toBe(false);
  });
});

describe("normalizeHeaders", () => {
  it("lowercases keys and wraps values in arrays", () => {
    const out = normalizeHeaders({
      "Content-Type": "application/json",
      "Set-Cookie": ["a=1", "b=2"],
    });
    expect(out["content-type"]).toEqual(["application/json"]);
    expect(out["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  it("skips undefined values", () => {
    const out = normalizeHeaders({ "X-Skip": undefined, "X-Keep": "yes" });
    expect(out["x-skip"]).toBeUndefined();
    expect(out["x-keep"]).toEqual(["yes"]);
  });

  it("merges multiple casings of the same header", () => {
    const out = normalizeHeaders({ "Set-Cookie": "a=1", "set-cookie": "b=2" });
    expect(out["set-cookie"]).toEqual(["a=1", "b=2"]);
  });
});
