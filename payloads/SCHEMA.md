# payload schema

isitsafebro stores attack patterns as JSON files under `payloads/<category>.json`. The schema is intentionally narrow so payloads stay portable, deterministic, and easy to author by hand or with an LLM. The single source of truth is `src/mcp/tools/payload-schema.ts` (Zod) — this doc explains it.

## why structured signals

The single biggest source of false positives in automated scanners is a human (or LLM) eyeballing a response and deciding "yeah that looks vulnerable." isitsafebro evaluates every finding with a **structured predicate** against the response. The LLM picks payloads and crafts variations; the code decides whether the signal fired.

The same `success_signal` expression that catches a bug is what `verify_clean` re-runs after a fix, so we never claim something is fixed that isn't.

## file shape

```json
{
  "category": "auth",
  "version": 1,
  "payloads": [
    { /* one payload */ },
    { /* another */ }
  ]
}
```

Top-level `category` must equal every payload's `category` (cross-checked by the loader). `version` is the file-format version; bump it (and update the Zod literal) when the shape changes incompatibly. Payload ids must be unique within a file.

## payload fields

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | lowercase kebab-case slug. Stable across releases — used as a filename for frozen regression tests. |
| `name` | string | yes | one-line human title shown in findings. |
| `description` | string | yes | one or two paragraphs explaining the class of bug. |
| `category` | enum | yes | one of `auth`, `api`, `prompt`, `secrets`, `idor`. Must match the file. |
| `severity` | enum | yes | one of `critical`, `high`, `medium`, `low`. Be conservative; `critical` = an attacker can take over. |
| `endpoints_hint` | string[] | yes | list of path substrings the attacker should try the payload against. No wildcards in v1 — substring match. Example: `["/admin", "/api/admin", "/dashboard/admin"]`. |
| `request` | object | yes | base request: `method`, optional `headers`, optional `body`. |
| `variations` | object[] | no | partial-request overrides. Each variation merges on top of `request` to produce one concrete probe. Use for enumerating credentials, tokens, or body shapes. |
| `success_signal` | Signal | yes | structured predicate (see below). |
| `fix_hint` | string | yes | one short paragraph of fix guidance. Shown to the user verbatim. |
| `repro_hint` | string | no | optional `curl` one-liner the user can copy-paste. |
| `is_destructive` | boolean | no | default `false`. If `true`, the probe causes side effects (creates a user, deletes a resource, sends an email). The attacker WILL surface a confirmation prompt before running it. |

## success_signal

A `Signal` is either a leaf predicate or a combinator.

### leaf predicates

```jsonc
{ "kind": "status_in", "values": [200, 201] }
{ "kind": "status_not_in", "values": [401, 403] }
{ "kind": "body_contains_any", "patterns": ["token", "session"], "case_insensitive": true }
{ "kind": "body_contains_all", "patterns": ["admin", "users"] }
{ "kind": "body_not_contains_any", "patterns": ["unauthorized", "log in"], "case_insensitive": true }
{ "kind": "body_matches_regex", "pattern": "\"role\"\\s*:\\s*\"admin\"" }
{ "kind": "header_present", "name": "set-cookie" }
{ "kind": "header_missing", "name": "content-security-policy" }
{ "kind": "header_value_contains", "name": "access-control-allow-origin", "pattern": "*" }
{ "kind": "header_value_not_contains", "name": "set-cookie", "pattern": "HttpOnly", "case_insensitive": true }
```

Header name matching is case-insensitive (per HTTP). `case_insensitive` on the value/pattern field controls value comparison.

### combinators

```jsonc
{ "kind": "all_of", "conditions": [<Signal>, <Signal>, ...] }
{ "kind": "any_of", "conditions": [<Signal>, <Signal>, ...] }
```

Combinators nest arbitrarily.

## a complete example

```json
{
  "id": "unauthenticated-admin-route",
  "name": "unauthenticated admin route",
  "description": "Endpoints under /admin should require authentication. If GET /admin returns 200 with admin-like content and without a login prompt, anyone on the internet can access it.",
  "category": "auth",
  "severity": "critical",
  "endpoints_hint": ["/admin", "/api/admin", "/dashboard/admin"],
  "request": { "method": "GET" },
  "success_signal": {
    "kind": "all_of",
    "conditions": [
      { "kind": "status_in", "values": [200] },
      { "kind": "body_contains_any", "patterns": ["admin panel", "user list", "users", "settings"], "case_insensitive": true },
      { "kind": "body_not_contains_any", "patterns": ["sign in", "log in", "unauthorized", "forbidden"], "case_insensitive": true }
    ]
  },
  "fix_hint": "Require an authenticated session on every /admin route. In Next.js, add a middleware.ts that checks for a valid session and redirects unauthenticated users to /login. In Express, mount an auth middleware on the /admin router.",
  "repro_hint": "curl -i '{base_url}/admin'"
}
```

## writing good payloads

- **One bug class per payload.** Don't combine "missing auth" and "verbose error" into one entry — they want different fixes.
- **Signal first.** Before you write the request, decide what the response would deterministically look like if the bug exists. If you can't pin that down, you can't avoid false positives.
- **Conservative severity.** `critical` means an attacker can take over (read all data, log in as anyone, run code). `high` means they can read or change data they shouldn't. `medium` is a real bug but not a takeover. `low` is config hygiene.
- **Avoid destructive side effects unless flagged.** Don't `DELETE /api/posts/1`. If a payload must create or modify state to be testable, set `is_destructive: true` and use clearly-marked test data (`isitsafebro-test-...@example.com`).
- **Keep `endpoints_hint` realistic.** Add the 4-6 most likely paths a vibe-coder's app would use, not 30. Better to add to the list later than to bloat probes.
