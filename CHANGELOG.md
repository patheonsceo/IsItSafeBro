# Changelog

All notable changes to isitsafebro. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

isitsafebro is pre-1.0. **Nothing has been published to npm yet.** Entries below describe what's committed to `main` on GitHub during the build sprint. Once the fix loop lands (Day 9-10), we'll cut `0.1.0` and start publishing.

---

## Unreleased

### Day 11 — install + docs

- **Added:** `isitsafebro register` / `unregister` / `status` CLI subcommands. `register` symlinks the plugin into `~/.claude/plugins/isitsafebro` (honors `CLAUDE_HOME`). idempotent; refuses to overwrite a non-symlink.
- **Added:** full README rewrite with honest install/run/uninstall instructions, status section separating what's wired from what's coming, and trimmed real e2e output as a demo until we record an asciinema.
- **Added:** `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `docs/architecture.md`, `docs/false-positives.md`.
- **Changed:** `bin/isitsafebro --help` now lists `register`, `unregister`, `status` instead of the day-2 placeholder text.

---

## 0.0.1 — build sprint

Pre-release build log. One commit-cluster per spec day; not yet published.

### Day 8 — payload library expansion (5 categories, 42 payloads)

- **Added:** `payloads/api.json` — 10 patterns (SQL injection error-based, NoSQL operator injection, command injection, SSRF, open redirect, reflected XSS, GraphQL introspection, stack-trace disclosure, excessive data exposure, path traversal).
- **Added:** `payloads/secrets.json` — 9 patterns (.env / .git / package.json / sourcemap exposure, hardcoded API keys in client bundle, /api/config leak, firebase private key, backup files, robots.txt enumeration).
- **Added:** `payloads/idor.json` — 6 patterns (per-user resource without auth, list endpoint without auth, GraphQL no-auth user query, 401-vs-404 ID enumeration, PII in list response, UUID in error message).
- **Added:** `payloads/prompt.json` — 7 LLM-prompt-injection patterns (direct canary, JSON output takeover, fake system message, data-channel injection, jailbreak via roleplay, fake assistant turn, developer-mode bypass).
- **Changed:** `test-fixtures/vuln-app/` extended with representative bugs from every new category (SQL error on `/api/products?name='`, reflected XSS on `/search?q=`, path traversal on `/api/file`, `.env` served, `/api/config` leaking server secrets, per-user resource on `/api/customers/1`, list endpoint on `/api/users`, prompt fixture on `/api/chat`).
- **Changed:** `scripts/test-attack.mjs` now scans all 5 categories via `load_payloads({category: "all"})` and asserts per-category expected findings (auth 9, api 3, secrets 2, idor 3, prompt 7 = 24 total). Anti-FP checks expanded from 2 to 4.
- **Result:** 24 verified findings across all 5 categories, 0 false positives.

### Day 6 (+ 7) — the attack loop, end-to-end

- **Added:** `src/mcp/tools/signal-eval.ts` — the structured signal evaluator. Takes a `Signal` predicate and an HTTP response context, returns `{matched, explanation}` with a multi-line trace showing which leaves fired. 20 unit tests covering every leaf, both combinators, deep nesting.
- **Added:** `src/mcp/tools/probe.ts` — `probe_endpoint` MCP tool. undici-based HTTP probe with the signal evaluator built in. Per-host rate limit (≤20 req/s), 1 MiB body cap, 5s default timeout. Never throws on network errors.
- **Added:** `src/mcp/tools/endpoints.ts` — `list_endpoints` MCP tool with four discovery strategies merged: Next.js app router (parse method exports from `route.ts`), Next.js pages router (api/), generic source regex for Express/Fastify/Hono/koa, HTTP crawl with HTML attribute and JS path-literal scans.
- **Added:** `test-fixtures/vuln-app/` — deliberately-vulnerable zero-dep Node http fixture exercising every non-destructive auth payload.
- **Added:** `scripts/test-attack.mjs` — the end-to-end attack proof.
- **Added:** real attacker subagent system prompt in `agents/attacker.md` (replaces the day-2 stub). Encodes the structured-signal contract: only emit a finding when `signal.matched === true`.
- **Added:** `undici` as a direct dependency.
- **Result:** 9 verified findings on the auth fixture, 0 false positives — the "first end-to-end moment" the spec called for.

### Day 5 — payload library foundation

- **Added:** `src/mcp/tools/payload-schema.ts` — the canonical Zod schema for attack payloads. Recursive `Signal` type (status / body / header predicates + `all_of` / `any_of` combinators), per-payload `is_destructive` flag, cross-field invariants (category match, unique ids).
- **Added:** `payloads/SCHEMA.md` — contributor-facing payload format documentation with a worked example.
- **Added:** `payloads/auth.json` — 10 high-signal auth attack patterns (unauthenticated admin route, unauthenticated write, JWT alg:none, weak JWT secret with pre-computed HS256 tokens for 20 common dev secrets, default credentials, empty credentials, CORS misconfig, debug route, cookie missing HttpOnly, mass-assignment-on-signup destructive-gated).
- **Added:** `scripts/gen-jwts.mjs` — reproducible generator for the JWTs baked into auth.json.
- **Added:** `src/mcp/tools/payloads.ts` — `load_payloads` MCP tool with schema validation. Hard-fails on bad JSON or schema violations; soft handling of missing categories for `"all"`.
- **Added:** 16 unit tests for schema validation and loader edge cases.
- **Added:** `scripts/test-payloads.mjs` end-to-end test driving the live MCP server.

### Day 4 — worktree tools

- **Added:** `src/mcp/tools/worktree.ts` with three real MCP tools.
  - `create_scan_worktree` — `git worktree add` on a fresh `isitsafebro/scan-<ts>` branch, places worktree alongside source as `<project>-isitsafebro-<ts>`, symlinks `node_modules` from source (falls back to `npm install` if symlink fails).
  - `install_and_start` — detects dev script (priority `dev` → `start` → `serve`), allocates a free port via `get-port`, spawns the dev server detached (so cleanup can tree-kill the npm + node child), polls the port until it responds (60s default timeout).
  - `cleanup_worktree` — SIGTERM the process group, SIGKILL after 3s grace, then `git worktree remove --force`. Branch is kept by default per spec.
- **Added:** `test-fixtures/sample-app/` — zero-dep node http fixture.
- **Added:** `scripts/test-worktree.mjs` — full lifecycle e2e (create → start → HTTP probe → cleanup → assert dir gone, branch preserved, dev server dead).
- **Added:** `get-port` and `execa` deps.

### Day 3 — /snap (the wedge feature)

- **Added:** `src/mcp/tools/snap.ts` with two real MCP tools.
  - `snap_inspect` — returns branch, cleanliness flag, bucketed path summary (modified / added / deleted / renamed / untracked / conflicted), and per-file unified diff. Refuses if not a git repo or unmerged conflicts present.
  - `snap_commit` — validates type and subject (lowercase, ≤60 chars, no trailing period, single line) and body, resets the index, stages listed files, commits with conventional message. Server-side validation means malformed messages from Claude get rejected.
- **Added:** `simple-git` dependency.
- **Added:** 19 unit tests for conventional-commit validation.
- **Added:** `scripts/test-snap.mjs` — full e2e against a fixture repo. Seeds a 3-feature messy diff, lands 3 conventional commits in the correct order, asserts validation rejects uppercase subjects, asserts `git log` matches expected.
- **Changed:** `commands/snap.md` from a placeholder to a real operational runbook driving the `inspect → plan → loop commit → verify clean` flow with explicit type-selection guidance and a voice rule banning bro voice from commit messages.

### Day 2 — plugin scaffolding

- **Added:** `.claude-plugin/plugin.json` — Claude Code plugin manifest.
- **Added:** `.mcp.json` — registers the isitsafebro MCP server with Claude Code.
- **Added:** `commands/isitsafe.md` and `commands/snap.md` slash command stubs.
- **Added:** `agents/attacker.md` — red-team subagent stub.
- **Added:** `src/mcp/server.ts` — MCP server scaffold using `@modelcontextprotocol/sdk`, registering all 12 tools from the spec (placeholders returning `{ok: true, stub: true}`).
- **Added:** `@modelcontextprotocol/sdk` and `zod` deps.
- **Changed:** README rewritten for vibe-coder audience (replaced jargon with plain-language equivalents, kept bro voice on marketing copy).

### Day 1 — repo scaffold

- **Added:** TypeScript project init (`package.json`, `tsconfig.json`, `.gitignore`).
- **Added:** MIT license.
- **Added:** placeholder README with the project tagline.
- **Added:** `src/bin/isitsafebro.ts` — entry that prints version and a help message (`register` subcommand stubbed with "coming soon").
- **Added:** `isitsafeproject.md` — the full build spec, locked decisions and all.

---

## Versioning

- Pre-1.0: minor bumps for feature additions, patch bumps for fixes.
- `0.1.0` will be cut when `/isitsafe` runs the full scan → fix → freeze → merge loop end-to-end and we've dogfooded against at least three real vibe-coded apps.
- `1.0.0` is reserved for the launch tagged in the spec (Day 14).

## Skipped / postponed

- Days 9-10 (fix loop, `apply_fix`, `restart_dev_server`, `verify_clean`, `freeze_test`, `merge_fix_branch`, `/isitsafe` orchestration, `--auto`) are paused while docs ship. Coming back to them next.
- Days 12-14 (dogfood, bug bash, launch) require the fix loop. Will be addressed after.
