# CLAUDE.md

This file is loaded into the context of every Claude Code session that opens this repo. Keep it tight — every line costs tokens on every conversation.

## What this project is

isitsafebro is a Claude Code plugin that red-teams a vibe-coded localhost app before the user ships it. Two slash commands:

- `/snap` — splits messy uncommitted work into clean conventional commits.
- `/isitsafe` — runs a full security scan, applies fixes the user accepts on an isolated branch, verifies the fixes work, freezes regression tests, surfaces a merge prompt.

Both run against a long-lived MCP server (`src/mcp/server.ts`) that exposes 13 tools. The signal architecture (structured predicates evaluated server-side) is the keystone of the false-positive prevention story — read [`docs/false-positives.md`](./docs/false-positives.md) if you're about to touch payloads or signals.

## Quickstart commands

```bash
npm install
npm run build         # tsc → dist/
npm run typecheck     # tsc --noEmit
npm test              # vitest unit tests
npm run test:e2e      # snap + worktree + payloads + attack + fix-loop
                      # ~60 seconds wall-clock

# run one e2e suite at a time:
npm run test:e2e:snap
npm run test:e2e:worktree
npm run test:e2e:payloads
npm run test:e2e:attack
npm run test:e2e:fix

# runnable demos (for recording / sharing)
npm run demo            # ~45s, generic fixture
npm run demo:nextjs     # ~2min, real Next.js 15 fixture (VibeNotes)

# manual CLI
node dist/bin/isitsafebro.js --help
node dist/bin/isitsafebro.js status
```

## Locked design decisions — DO NOT RELITIGATE

The spec ([`isitsafeproject.md`](./isitsafeproject.md)) calls these out at the top. If you think one is wrong, leave a `// TODO open question:` comment and surface it; don't silently change direction.

- Distributed as a Claude Code plugin (skills + commands + agents + MCP server). npm package: `isitsafebro`. Install: `npm install -g isitsafebro && isitsafebro register`.
- No Docker. Isolation via `git worktree`.
- The attacker is a **Claude Code subagent**, not a separate LLM. No extra API keys.
- Output is **failing tests + diffs**, not a PDF report. Mental model: Jest.
- Fixes land on a separate `isitsafebro/scan-<ts>` branch. Manual merge by default; `--auto` flag exists.
- Everything runs locally. No telemetry, no accounts.
- **Structured success signals, not natural language.** The LLM picks payloads and crafts variations; the code evaluates the signal. This is the false-positive-prevention design. If you find yourself adding "the AI decides" anywhere in the verdict path, stop.

## Architecture (one-paragraph version)

The MCP server (`src/mcp/server.ts`) registers every tool from the spec. Tools live in `src/mcp/tools/`: `snap.ts` (snap_inspect, snap_commit), `worktree.ts` (create_scan_worktree, install_and_start, restart_dev_server, cleanup_worktree), `endpoints.ts` (list_endpoints), `payloads.ts` (load_payloads), `probe.ts` (probe_endpoint with built-in signal evaluator), `signal-eval.ts` (pure evaluator, used by probe + verify_clean), `fix.ts` (apply_fix, verify_clean, freeze_test, merge_fix_branch). The plugin surface (`commands/`, `agents/`, `.claude-plugin/plugin.json`, `.mcp.json`) is what Claude Code discovers. Full details in [`docs/architecture.md`](./docs/architecture.md).

## Voice rules (the most-violated rule)

| surface | voice |
|---|---|
| README headline + marketing copy | bro voice, lowercase, no em dashes, no corporate words, sparing emojis |
| CLI prompts to the user | same |
| error messages aimed at the user | same |
| **commit messages** | **professional conventional commits**, server-side enforced by `snap_commit` and `apply_fix` |
| internal logs / stderr | matter-of-fact |
| MCP tool output (JSON content) | machine-readable, no voice |
| code comments | tight, no humor, only when the *why* isn't obvious |
| tool descriptions / schemas | clear, clinical |

If unsure: lowercase, no em dashes, no "leverage" / "robust" / "comprehensive" / "industry-leading" / "I hope this finds you well".

## Commits & PRs

- **Conventional commits.** `feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:` / `style:` / `perf:`. Subject lowercase, single line, ≤ 60 chars, no trailing period. The `snap_commit` and `apply_fix` tools reject anything that doesn't conform — that's the rule, not a suggestion.
- **Microcommits over megacommits.** Each commit should compile and pass at least its own tests.
- **NEVER add `Co-Authored-By: Claude` or any AI-coauthor trailer to a commit.** The human contributor gets the credit. Saved as global memory after a real incident in this repo.
- Run `npm run typecheck && npm test && npm run test:e2e` before committing anything non-trivial.

## How to add things

### A new attack payload

1. Read [`payloads/SCHEMA.md`](./payloads/SCHEMA.md) for the structured-signal format. The Zod source is `src/mcp/tools/payload-schema.ts`.
2. Edit the right category file (`payloads/<category>.json`).
3. Validate with the inline one-liner in [`CONTRIBUTING.md`](./CONTRIBUTING.md#adding-a-payload).
4. Add a fixture route to `test-fixtures/vuln-app/server.js` exposing the bug, plus a healthy counterpart that should NOT match.
5. Update `scripts/test-attack.mjs` to include the new payload id in the expected-findings set for that category.
6. Run `npm run test:e2e:attack` and confirm: bug fixture fires; healthy counterpart doesn't.
7. **Sanity-check the Next.js fixture too.** Pattern broadness matters: a string like `unauthorized` matches Next.js's RSC payload metadata (`"unauthorized":"$undefined"`) on every Server Component response, so signals that exclude on `unauthorized` will never fire on any Next.js app. Prefer multi-word phrases that only appear in human-readable copy. Verify by running `npm run demo:nextjs` and checking the payload fires.

### The two test fixtures

- `test-fixtures/vuln-app/` — zero-dep node http server. Fast (no `npm install` needed). Used by `test-attack.mjs` and `test-fix-loop.mjs`. Every payload exercises here.
- `test-fixtures/nextjs-vuln-app/` — **VibeNotes**, a real Next.js 15 + React 19 + TypeScript app. Slower (first run installs ~200 npm deps). Used by `demo-nextjs.mjs`. The "this is a real vibe-coded app" demo target. Bugs are framed through actual Next.js idioms (Server Components, middleware, route handlers, NEXT_PUBLIC env vars).

### A new MCP tool

1. Add a module under `src/mcp/tools/<name>.ts`. Export a `registerXxxTools(server)` function.
2. Use Zod for the input schema. Validate inputs server-side; the LLM is not a sufficient gate.
3. Return `{ok: bool, ...result | error}` — tools NEVER throw. Network errors, validation failures, missing files all return `{ok: false, error: "..."}`.
4. Import and call `registerXxxTools(server)` in `src/mcp/server.ts`.
5. If the tool spawns subprocesses, use `execa` with `detached: true` for tree-killable lifecycles. See `worktree.ts` for the pattern.

### Editing a slash command

`commands/isitsafe.md` and `commands/snap.md` are loaded by Claude Code as the runbook for the slash command. They're written in second person ("you do X") because the reader is a Claude session, not a human. Keep the voice/safety rules in the header so they appear at the top of the loaded context.

## Common pitfalls to avoid

- **Path traversal in `apply_fix`.** The tool already rejects paths that resolve outside the worktree. Don't weaken that check. The same protection applies to any new tool that writes user-supplied filenames.
- **Bypassing the signal evaluator.** If you find yourself adding "the AI decides" to the verdict path of a finding, stop. The whole point is that code evaluates the predicate. The LLM picks payloads, the code says "matched: yes/no."
- **Touching the user's main working tree.** All source mutations during `/isitsafe` go through `apply_fix` against the scan worktree. The user's actual project files are read-only until merge.
- **Auto-pushing.** `merge_fix_branch` stops at the local merge commit. Don't add a push.
- **Hardcoded paths in tests.** E2E tests must use `mkdtempSync` for the user-repo location and resolve internal paths from `import.meta.url`. Tests should pass when run from any directory.
- **Long-running subprocesses without process-group spawn.** `install_and_start` spawns `npm run dev` with `detached: true` so `cleanup_worktree` can kill the whole tree. If you spawn anything that itself spawns children (npm, pnpm, yarn, even an outer node script), follow the same pattern.

## When in doubt

- Read the [spec](./isitsafeproject.md) section relevant to your change. The decisions log at the bottom captures what was argued through and what's locked.
- Read the [CHANGELOG](./CHANGELOG.md) entry for the relevant day to see what landed and how it landed.
- If a tool returns something surprising, look at `scripts/test-<area>.mjs` — there's an e2e for almost every surface.
- If the user's intent is unclear, ASK. This is a small project with a single human owner; clarifying questions cost ~nothing.

## What "done" looks like for a typical change

A typical contribution touches one or two files plus matching tests. The build is green, the relevant e2e suite is green, the commit is a single conventional-commit subject, and the docs are updated if any user-visible behavior changed. No co-author trailer, no "Generated with Claude Code" footnote.
