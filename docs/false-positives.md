# False positives, and how we avoid them

The single biggest source of distrust in automated security scanners is the noise: 47 findings, 3 real bugs, you can't tell which is which, so you ignore them all. isitsafebro is built around the inverse promise — we report verified exploits, or we say nothing.

This doc explains how we make that work in practice, and where the architecture still has known gaps.

## The core decision

> Every attack payload carries a **structured predicate** over the HTTP response. The LLM picks payloads and crafts variations. The code decides whether a finding occurred.

The spec's original sketch had the success criterion as natural language: *"response status 200 AND response body contains user data"*. That phrasing reads well to a human, but it pushes the verdict into the LLM, where a thousand subtle judgement calls turn into noise. Instead we use a recursive predicate:

```jsonc
{
  "kind": "all_of",
  "conditions": [
    { "kind": "status_in", "values": [200] },
    { "kind": "body_contains_any", "patterns": ["admin panel", "user list", "users"] },
    { "kind": "body_not_contains_any", "patterns": ["sign in", "log in", "unauthorized"] }
  ]
}
```

Same intent. Different operational reality: this expression is evaluated by `src/mcp/tools/signal-eval.ts`, deterministically, against the response bytes. The LLM never gets to decide "looks vulnerable to me."

## What the LLM does and doesn't do

| step | who decides |
|---|---|
| which payloads to try | the LLM (matched against `endpoints_hint` and discovered routes) |
| what variations to construct | the LLM (within the payload's `variations` array, or new ones the model proposes) |
| whether a probe revealed the bug | the **code** — the signal evaluator |
| how to explain the finding to the user | the LLM (but the evidence trace from the evaluator is included verbatim) |
| whether a fix worked | the **code** — the same signal expression, re-run by `verify_clean` |

Inverting the usual scanner architecture costs us coverage in cases where the bug is real but doesn't fit a predicate-shaped signal. We pay that cost on purpose. Lower coverage with high trust beats high coverage with low trust for our audience.

## The explanation trace IS the evidence

When a signal matches, the evaluator emits a multi-line trace like:

```
✓ all_of (3/3 matched)
  ✓ status_in [200] (got 200)
  ✓ body_contains_any [admin panel,users,...] (matched "admin panel")
  ✓ body_not_contains_any [sign in,...] (none in 117-byte body)
```

That trace gets shipped as the `evidence.signal_explanation` field on every finding. The user (or the eventual fix agent) can audit a verdict without re-running the probe. There's no opaque "the AI says it's a bug" — every condition is stated with what was found.

## Verification step

A signal match is necessary, not sufficient. The orchestrator design (Day 9-10) re-runs the same signal expression after a fix is applied. If the signal still fires, the fix didn't actually close the hole — surfaced as a fix-failure, not a fix-success. The same expression that detected the bug is the test the fix has to pass. One source of truth across detect → fix → verify → freeze (regression).

## Known limitations

Honest about where the architecture is weaker.

### Prompt injection (`payloads/prompt.json`)

Every prompt-injection payload uses a unique canary token (`ISITSAFEBRO_*_OK`). The signal fires if the canary appears in the response body AND refusal phrases ("I cannot", "decline", "as an AI") don't.

**Where this can false-positive:** if the chat endpoint echoes the user's input back in the response body (some vibe-coded chat APIs do this — they return the full conversation history with the user message included), the canary will appear regardless of whether the model complied. The signal doesn't currently distinguish "model output" from "echoed user input."

Mitigation today: every prompt payload's `description` warns about this; the `fix_hint` includes a verification step. Future direction: add a JSON-aware predicate that scopes pattern matching to specific paths inside the response (`assistant.content`, not `messages[0].content`).

### IDOR list-endpoint signal

`unauthed-list-endpoint-returns-records` looks for a JSON-array shape (`[{...`) at the start of the response body. A legitimately-public list endpoint (a public directory, a public blog index) will match this signal — by design — and the finding is technically correct ("this endpoint returns rows of data to unauthenticated callers"). Whether that's a bug is up to the user; we surface it, they triage.

The companion `pii-in-list-response` payload narrows by requiring email/phone/SSN/DOB patterns in the response, which catches the actually-private cases.

### list_endpoints coverage

Static analysis covers Next.js (app + pages routers) and Express/Fastify/Hono/koa via the receiver-allowlist regex. Apps using less common frameworks (SvelteKit, Remix, custom routers) only get the HTTP-crawl strategy, which has lower coverage. The attacker compensates by also probing every payload's `endpoints_hint` directly, regardless of discovery.

### Body cap

`probe_endpoint` caps the response body at 1 MiB by default. A signal that depends on content beyond that cap will miss. Configurable per-call.

### Rate limit is per-process

The per-host rate limit (≤20 req/s) lives in the MCP server's process memory. Restarting the server resets it. Fine for our use case (single-user, single-session); not a defense against an actively-misbehaving attacker subagent.

## Why this matters for shipping

If a vibe-coder runs isitsafebro and we cry wolf on three benign endpoints, they ignore the one real critical finding and ship the bug. The product loses immediately. We'd rather miss a real bug than fabricate a fake one — the latter destroys the only thing this tool sells, which is trust.

Every architectural decision in the repo follows from that. Structured signals, multi-line evidence traces, hard server-side validation of payload schemas, hard refusal to load malformed payload files (`loadPayloads` returns `ok: false` rather than serving a partial library), the `verify_clean` step before declaring a fix worked — all of it is paying ongoing cost to keep the false-positive rate near zero.

## How a contributor can help

The single highest-leverage contribution is adding a payload with a tight signal that catches a real bug class without firing on healthy traffic. See [`payloads/SCHEMA.md`](../payloads/SCHEMA.md) for the format and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the workflow.

When you draft a signal, ask yourself: *what does a benign healthy endpoint serving similar content look like? would this signal fire against it?* If yes, the signal needs to be tighter. The vuln-app fixture in `test-fixtures/vuln-app/` deliberately includes healthy counterparts (`/safe-admin`, `/api/safe-users`) for exactly this reason — every payload is exercised against both the bug it targets and a benign route, and the e2e test fails if either assertion is wrong.
