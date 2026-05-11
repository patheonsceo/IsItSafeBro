/**
 * Signal evaluator — turns a `Signal` predicate + an HTTP response context
 * into a `{matched, explanation}` result.
 *
 * This is the keystone of isitsafebro's false-positive prevention. The LLM
 * picks payloads and crafts variations; THIS module decides whether a
 * finding actually occurred. The explanation is intentionally generous —
 * we evaluate every branch even on failure so a user (or AI) can see
 * exactly why something did or didn't match.
 *
 * Pure function; no side effects, no I/O. Unit-testable in isolation.
 */
import type { Signal } from "./payload-schema.js";

/**
 * Response shape the evaluator consumes. Headers MUST be normalized:
 * lowercased keys, every value as an array (to preserve multi-value
 * headers like Set-Cookie).
 */
export interface EvalContext {
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

export interface EvalResult {
  matched: boolean;
  /** Multi-line trace. Top-line summary, then each child indented. */
  explanation: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function lookupHeader(ctx: EvalContext, name: string): string[] {
  return ctx.headers[name.toLowerCase()] ?? [];
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function summarize(value: string, max = 60): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function mark(matched: boolean): string {
  return matched ? "✓" : "✗";
}

/* -------------------------------------------------------------------------- */
/*  Leaf evaluators                                                           */
/* -------------------------------------------------------------------------- */

function evalStatusIn(values: number[], ctx: EvalContext): EvalResult {
  const matched = values.includes(ctx.status);
  return {
    matched,
    explanation: `${mark(matched)} status_in [${values.join(", ")}] (got ${ctx.status})`,
  };
}

function evalStatusNotIn(values: number[], ctx: EvalContext): EvalResult {
  const matched = !values.includes(ctx.status);
  return {
    matched,
    explanation: `${mark(matched)} status_not_in [${values.join(", ")}] (got ${ctx.status})`,
  };
}

function bodyHaystack(ctx: EvalContext, ci: boolean | undefined): string {
  return ci ? ctx.body.toLowerCase() : ctx.body;
}

function bodyNeedle(pattern: string, ci: boolean | undefined): string {
  return ci ? pattern.toLowerCase() : pattern;
}

function evalBodyContainsAny(
  patterns: string[],
  ctx: EvalContext,
  ci: boolean | undefined,
): EvalResult {
  const hay = bodyHaystack(ctx, ci);
  for (const p of patterns) {
    if (hay.includes(bodyNeedle(p, ci))) {
      return {
        matched: true,
        explanation: `${mark(true)} body_contains_any [${patterns.map(summarize).join(", ")}] (matched ${JSON.stringify(p)})`,
      };
    }
  }
  return {
    matched: false,
    explanation: `${mark(false)} body_contains_any [${patterns.map(summarize).join(", ")}] (not found in ${ctx.body.length}-byte body)`,
  };
}

function evalBodyContainsAll(
  patterns: string[],
  ctx: EvalContext,
  ci: boolean | undefined,
): EvalResult {
  const hay = bodyHaystack(ctx, ci);
  const missing = patterns.filter((p) => !hay.includes(bodyNeedle(p, ci)));
  const matched = missing.length === 0;
  return {
    matched,
    explanation: matched
      ? `${mark(true)} body_contains_all [${patterns.map(summarize).join(", ")}] (all present)`
      : `${mark(false)} body_contains_all [${patterns.map(summarize).join(", ")}] (missing ${missing.map((p) => JSON.stringify(p)).join(", ")})`,
  };
}

function evalBodyNotContainsAny(
  patterns: string[],
  ctx: EvalContext,
  ci: boolean | undefined,
): EvalResult {
  const hay = bodyHaystack(ctx, ci);
  for (const p of patterns) {
    if (hay.includes(bodyNeedle(p, ci))) {
      return {
        matched: false,
        explanation: `${mark(false)} body_not_contains_any [${patterns.map(summarize).join(", ")}] (found ${JSON.stringify(p)})`,
      };
    }
  }
  return {
    matched: true,
    explanation: `${mark(true)} body_not_contains_any [${patterns.map(summarize).join(", ")}] (none in ${ctx.body.length}-byte body)`,
  };
}

function evalBodyMatchesRegex(
  pattern: string,
  ctx: EvalContext,
  ci: boolean | undefined,
): EvalResult {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ci ? "i" : "");
  } catch (err) {
    return {
      matched: false,
      explanation: `${mark(false)} body_matches_regex /${summarize(pattern)}/ (invalid regex: ${(err as Error).message})`,
    };
  }
  const m = ctx.body.match(re);
  return {
    matched: m !== null,
    explanation: m
      ? `${mark(true)} body_matches_regex /${summarize(pattern)}/ (matched ${JSON.stringify(summarize(m[0], 40))})`
      : `${mark(false)} body_matches_regex /${summarize(pattern)}/ (no match)`,
  };
}

function evalHeaderPresent(name: string, ctx: EvalContext): EvalResult {
  const values = lookupHeader(ctx, name);
  const matched = values.length > 0;
  return {
    matched,
    explanation: matched
      ? `${mark(true)} header_present "${name}" (got ${values.length} value${values.length > 1 ? "s" : ""})`
      : `${mark(false)} header_present "${name}" (absent)`,
  };
}

function evalHeaderMissing(name: string, ctx: EvalContext): EvalResult {
  const values = lookupHeader(ctx, name);
  const matched = values.length === 0;
  return {
    matched,
    explanation: matched
      ? `${mark(true)} header_missing "${name}" (absent)`
      : `${mark(false)} header_missing "${name}" (present, ${values.length} value${values.length > 1 ? "s" : ""})`,
  };
}

function evalHeaderValueContains(
  name: string,
  pattern: string,
  ctx: EvalContext,
  ci: boolean | undefined,
): EvalResult {
  const values = lookupHeader(ctx, name);
  if (values.length === 0) {
    return {
      matched: false,
      explanation: `${mark(false)} header_value_contains "${name}" ~ ${JSON.stringify(summarize(pattern))} (header absent)`,
    };
  }
  const needle = ci ? pattern.toLowerCase() : pattern;
  for (const v of values) {
    const hay = ci ? v.toLowerCase() : v;
    if (hay.includes(needle)) {
      return {
        matched: true,
        explanation: `${mark(true)} header_value_contains "${name}" ~ ${JSON.stringify(summarize(pattern))} (matched in ${JSON.stringify(summarize(v))})`,
      };
    }
  }
  return {
    matched: false,
    explanation: `${mark(false)} header_value_contains "${name}" ~ ${JSON.stringify(summarize(pattern))} (not in ${values.length} value${values.length > 1 ? "s" : ""})`,
  };
}

function evalHeaderValueNotContains(
  name: string,
  pattern: string,
  ctx: EvalContext,
  ci: boolean | undefined,
): EvalResult {
  const values = lookupHeader(ctx, name);
  if (values.length === 0) {
    // Header absent → "not contains" is vacuously true.
    return {
      matched: true,
      explanation: `${mark(true)} header_value_not_contains "${name}" ~ ${JSON.stringify(summarize(pattern))} (header absent)`,
    };
  }
  const needle = ci ? pattern.toLowerCase() : pattern;
  for (const v of values) {
    const hay = ci ? v.toLowerCase() : v;
    if (hay.includes(needle)) {
      return {
        matched: false,
        explanation: `${mark(false)} header_value_not_contains "${name}" ~ ${JSON.stringify(summarize(pattern))} (found in ${JSON.stringify(summarize(v))})`,
      };
    }
  }
  return {
    matched: true,
    explanation: `${mark(true)} header_value_not_contains "${name}" ~ ${JSON.stringify(summarize(pattern))} (clean)`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Top-level evaluator                                                       */
/* -------------------------------------------------------------------------- */

export function evaluateSignal(signal: Signal, ctx: EvalContext): EvalResult {
  switch (signal.kind) {
    case "status_in":
      return evalStatusIn(signal.values, ctx);
    case "status_not_in":
      return evalStatusNotIn(signal.values, ctx);
    case "body_contains_any":
      return evalBodyContainsAny(signal.patterns, ctx, signal.case_insensitive);
    case "body_contains_all":
      return evalBodyContainsAll(signal.patterns, ctx, signal.case_insensitive);
    case "body_not_contains_any":
      return evalBodyNotContainsAny(signal.patterns, ctx, signal.case_insensitive);
    case "body_matches_regex":
      return evalBodyMatchesRegex(signal.pattern, ctx, signal.case_insensitive);
    case "header_present":
      return evalHeaderPresent(signal.name, ctx);
    case "header_missing":
      return evalHeaderMissing(signal.name, ctx);
    case "header_value_contains":
      return evalHeaderValueContains(signal.name, signal.pattern, ctx, signal.case_insensitive);
    case "header_value_not_contains":
      return evalHeaderValueNotContains(signal.name, signal.pattern, ctx, signal.case_insensitive);
    case "all_of": {
      const children = signal.conditions.map((c) => evaluateSignal(c, ctx));
      const matched = children.every((c) => c.matched);
      const hits = children.filter((c) => c.matched).length;
      const header = `${mark(matched)} all_of (${hits}/${children.length} matched)`;
      return {
        matched,
        explanation: [header, ...children.map((c) => indent(c.explanation))].join("\n"),
      };
    }
    case "any_of": {
      const children = signal.conditions.map((c) => evaluateSignal(c, ctx));
      const matched = children.some((c) => c.matched);
      const hits = children.filter((c) => c.matched).length;
      const header = `${mark(matched)} any_of (${hits}/${children.length} matched)`;
      return {
        matched,
        explanation: [header, ...children.map((c) => indent(c.explanation))].join("\n"),
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Convenience: normalize raw fetch/undici headers into eval shape           */
/* -------------------------------------------------------------------------- */

/**
 * Convert a record where values may be string | string[] | undefined into
 * the canonical Record<string, string[]> form the evaluator expects.
 * Lowercases keys.
 */
export function normalizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    const arr = Array.isArray(v) ? v : [v];
    out[key] = (out[key] ?? []).concat(arr);
  }
  return out;
}
