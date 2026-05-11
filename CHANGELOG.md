# Changelog

All notable changes to isitsafebro. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

isitsafebro is pre-1.0. **Nothing has been published to npm yet.** Entries below describe what's committed to `main` on GitHub during the build sprint. Once the fix loop lands (Day 9-10), we'll cut `0.1.0` and start publishing.

---

## Unreleased

### Day 9-10 — the fix loop, end-to-end

- **Added:** `src/mcp/tools/fix.ts` with four MCP tools.
  - `apply_fix` — full-file replacements into the scan worktree, committed on the scan branch with a `validateCommit`-validated conventional message. Reuses snap's subject rules (lowercase, single line, ≤ 60 chars, no trailing period). Resolves file paths and rejects any that escape the worktree (path-traversal protection).
  - `verify_clean` — replays each captured `(request, success_signal)` pair via `probe_endpoint`. Returns per-finding `{stillVulnerable, matched, explanation}` plus aggregate `cleaned[]` and `stillVulnerable[]`. Uses the same signal evaluator as the original detection — one source of truth across detect → fix → verify.
  - `freeze_test` — serializes a verified-and-now-fixed exploit as a self-contained regression test at `<cwd>/.isitsafebro/tests/<category>/<payload_id>--<endpoint-slug>.json` (schema_version 1, with the request + signal + frozen-at timestamp + evidence). Future scans can replay these to catch regressions.
  - `merge_fix_branch` — `git merge --no-ff <scanBranch>` into the user's target branch. Refuses if (a) target ≠ current branch (asks user to checkout first), (b) there are uncommitted M/D/S/R modifications (untracked files are fine — git itself permits merging into a tree with untracked files), (c) the scan branch doesn't exist. On conflict, returns the file list and leaves the merge state in place for manual resolution.
- **Added:** `restart_dev_server` in `src/mcp/tools/worktree.ts`. Looks up the running server in `runningServers`, kills its process group via the shared `killProcessGroup` helper, then re-runs `installAndStart` with the saved script and previous port as `preferredPort` (URL stays stable across restart most of the time).
- **Changed:** `src/mcp/server.ts` dropped the `stub` helper and `z` import. All 13 spec tools are real and registered.
- **Changed:** `commands/isitsafe.md` rewritten from a day-2 stub into the full 14-step orchestration runbook (parse → confirm → snap → worktree → install → list_endpoints → spawn attacker → surface findings → user picks → apply_fix per pick → restart → verify_clean → freeze_test per cleaned → merge_fix_branch or merge-prompt → cleanup). Explicit error handling for every common failure mode (dev server timeout, attacker timeout, fix breaks the app, merge conflict, user abort).
- **Added:** `scripts/test-fix-loop.mjs` end-to-end proof. Seeds a temp git repo from the vuln-app fixture, scans (9 findings), applies hand-crafted patches for 2 specific bugs via `apply_fix` (one commit each), restarts, asserts `verify_clean` correctly puts the fixed two in `cleaned[]` AND leaves the other seven in `stillVulnerable[]`, freezes the two cleaned findings, merges the scan branch into main, asserts the git log contains both fixes plus the merge commit. Exposed as `test:e2e:fix`; chained into `test:e2e`.
- **Result:** the full scan → fix → verify → freeze → merge loop runs end-to-end. The structured-signal architecture pays off: the same predicate that detected each bug is the test the fix has to pass.

### Day 11 — install + docs

- **Added:** `isitsafebro register` / `unregister` / `status` CLI subcommands. `register` symlinks the plugin into `~/.claude/plugins/isitsafebro` (honors `CLAUDE_HOME`). Idempotent; refuses to overwrite a non-symlink.
- **Added:** full README rewrite with honest install/run/uninstall instructions, status section separating what's wired from what's coming, and trimmed real e2e output as a demo until we record an asciinema.
- **Added:** `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `docs/architecture.md`, `docs/false-positives.md`.
- **Added:** `CLAUDE.md` at the repo root. Claude Code auto-loads it on every session opened here. Compact operating manual for AI agents and humans-using-claude: locked design decisions, voice rules (with the no-co-author-trailer rule prominent), build/test commands, how to add a payload or MCP tool, common pitfalls (path traversal in apply_fix, bypassing the signal evaluator, touching the user's main working tree, missing detached spawn for tree-kill), and a "when in doubt — ASK" line.
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
- `0.1.0` will be cut after we've dogfooded the full scan → fix → freeze → merge loop against at least three real vibe-coded apps (Day 12 work).
- `1.0.0` is reserved for the launch tagged in the spec (Day 14).

## Remaining

- **Day 12** — dogfood against three real vibe-coded apps (Lovable / Bolt / a friend's project). Find real bugs, tune payloads.
- **Day 13** — bug bash. Make sure `npm install -g isitsafebro && isitsafebro register && /isitsafe` works in under two minutes from cold install. Smooth the rough edges surfaced by Day 12.
- **Day 14** — launch posts (r/programming, r/ClaudeAI, r/webdev, Hacker News, X).

These are activities, not features. The product is feature-complete: every spec'd tool is implemented and verified end-to-end.
