/**
 * Payload schema for isitsafebro's attack library.
 *
 * A payload describes one attack pattern:
 *   - what request(s) to send (plus optional variations to enumerate)
 *   - a STRUCTURED success signal that programmatically decides whether the
 *     attack worked, evaluated against the response
 *   - human-readable name / description / fix hint
 *
 * The structured-signal choice is deliberate. The spec's example used
 * natural language ("response status 200 AND body contains user data") but
 * that puts the LLM in the loop deciding what counts as a finding — which
 * is the single biggest source of false positives in automated scanners.
 * Here the LLM picks the payload and crafts variations; the code runs the
 * signal. The same signal expression that catches the bug is what
 * verify_clean re-runs after a fix.
 *
 * Schema is versioned in the file itself (`version: 1`) so future changes
 * are explicit.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Common enums
// ---------------------------------------------------------------------------

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;
export const HttpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const PAYLOAD_CATEGORIES = [
  "auth",
  "api",
  "prompt",
  "secrets",
  "idor",
] as const;
export const PayloadCategorySchema = z.enum(PAYLOAD_CATEGORIES);
export type PayloadCategory = z.infer<typeof PayloadCategorySchema>;

// ---------------------------------------------------------------------------
// Success signal: recursive, structurally validated, with all leaf predicates
// defined under a discriminated union on `kind`.
// ---------------------------------------------------------------------------

/**
 * Leaf predicates. Each is a single deterministic check against the response
 * (status, headers, body). The signal evaluator (lands in Day 6 with
 * probe_endpoint) consumes these directly.
 */
const SignalLeafSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status_in"),
    values: z.array(z.number().int()).min(1),
  }),
  z.object({
    kind: z.literal("status_not_in"),
    values: z.array(z.number().int()).min(1),
  }),
  z.object({
    kind: z.literal("body_contains_any"),
    patterns: z.array(z.string()).min(1),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("body_contains_all"),
    patterns: z.array(z.string()).min(1),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("body_not_contains_any"),
    patterns: z.array(z.string()).min(1),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("body_matches_regex"),
    pattern: z.string().min(1),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("header_present"),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("header_missing"),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("header_value_contains"),
    name: z.string().min(1),
    pattern: z.string().min(1),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("header_value_not_contains"),
    name: z.string().min(1),
    pattern: z.string().min(1),
    case_insensitive: z.boolean().optional(),
  }),
]);

export type SignalLeaf = z.infer<typeof SignalLeafSchema>;

/**
 * Full signal type — a leaf OR a combinator. Combinators (all_of, any_of)
 * recurse. Recursive Zod schema via z.lazy so the type doesn't blow up at
 * compile time on circular references.
 */
export type Signal =
  | SignalLeaf
  | { kind: "all_of"; conditions: Signal[] }
  | { kind: "any_of"; conditions: Signal[] };

export const SignalSchema: z.ZodType<Signal> = z.lazy(() =>
  z.union([
    SignalLeafSchema,
    z.object({
      kind: z.literal("all_of"),
      conditions: z.array(SignalSchema).min(1),
    }),
    z.object({
      kind: z.literal("any_of"),
      conditions: z.array(SignalSchema).min(1),
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Request shape (a request template). Variations let one payload enumerate
// multiple concrete probes (e.g., 6 credential pairs for default-creds).
// ---------------------------------------------------------------------------

export const RequestSpecSchema = z.object({
  method: HttpMethodSchema,
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export type RequestSpec = z.infer<typeof RequestSpecSchema>;

export const RequestVariantSchema = RequestSpecSchema.partial();
export type RequestVariant = z.infer<typeof RequestVariantSchema>;

// ---------------------------------------------------------------------------
// Payload itself.
// ---------------------------------------------------------------------------

export const PayloadSchema = z.object({
  /** Short, stable slug — used as a file/test identifier later. */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "id must be a lowercase kebab-case slug"),
  /** Short human name for findings. */
  name: z.string().min(1),
  /** One- or two-paragraph human description. */
  description: z.string().min(1),
  /** Must match the file's top-level category. */
  category: PayloadCategorySchema,
  severity: SeveritySchema,
  /**
   * Path patterns this payload applies to. The attacker tries the payload
   * against discovered endpoints whose path contains any of these as a
   * substring. Wildcard support intentionally NOT added in v1 — keep it
   * simple, expand later.
   */
  endpoints_hint: z.array(z.string().min(1)).min(1),
  /** The base request to send. */
  request: RequestSpecSchema,
  /**
   * Optional list of overrides to enumerate. Each variation is merged on
   * top of the base request to produce a concrete probe.
   */
  variations: z.array(RequestVariantSchema).optional(),
  /** Programmatic predicate — see SignalSchema. */
  success_signal: SignalSchema,
  /** Plain-English fix instructions. Shown verbatim to the user. */
  fix_hint: z.string().min(1),
  /** Optional curl one-liner template the user can copy-paste. */
  repro_hint: z.string().optional(),
  /**
   * If true, the probe causes a side effect (creates a user, deletes a
   * resource, sends an email, etc.). The attacker MUST surface a
   * confirmation prompt to the user before running it; default-off.
   */
  is_destructive: z.boolean().optional(),
});
export type Payload = z.infer<typeof PayloadSchema>;

// ---------------------------------------------------------------------------
// Payload file (top-level container per category).
// ---------------------------------------------------------------------------

export const PAYLOAD_FILE_VERSION = 1;

export const PayloadFileSchema = z.object({
  category: PayloadCategorySchema,
  /** Schema version. Bump when the shape changes incompatibly. */
  version: z.literal(PAYLOAD_FILE_VERSION),
  payloads: z.array(PayloadSchema).min(1),
}).superRefine((file, ctx) => {
  // Cross-field invariant: every payload's `category` must match the file.
  for (let i = 0; i < file.payloads.length; i++) {
    const p = file.payloads[i];
    if (p && p.category !== file.category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloads", i, "category"],
        message: `payload category '${p.category}' does not match file category '${file.category}'`,
      });
    }
  }
  // Cross-field invariant: payload ids must be unique within the file.
  const seen = new Set<string>();
  for (let i = 0; i < file.payloads.length; i++) {
    const p = file.payloads[i];
    if (!p) continue;
    if (seen.has(p.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloads", i, "id"],
        message: `duplicate payload id '${p.id}'`,
      });
    }
    seen.add(p.id);
  }
});

export type PayloadFile = z.infer<typeof PayloadFileSchema>;
