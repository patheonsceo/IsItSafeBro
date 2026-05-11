# Architecture

How the pieces fit together. This is the contributor-facing doc; the marketing voice lives in [README.md](../README.md), the design philosophy in [false-positives.md](./false-positives.md).

## The four moving parts

1. **The Claude Code plugin layer.** What the user sees: two slash commands (`/isitsafe`, `/snap`) and one subagent (`attacker`). The plugin registers them via `.claude-plugin/plugin.json` and gets loaded when Claude Code finds the package under `~/.claude/plugins/isitsafebro/`.

2. **The MCP server (`src/mcp/server.ts`).** A long-lived child process spawned by Claude Code, talking JSON-RPC over stdio. It registers every tool listed in [the spec's MCP tools table](../isitsafeproject.md#mcp-server-tools). Tools that are implemented today: `snap_inspect`, `snap_commit`, `create_scan_worktree`, `install_and_start`, `cleanup_worktree`, `load_payloads`, `list_endpoints`, `probe_endpoint`. Stubs returning `{ok: true, stub: true}` for the rest pending Day 9-10.

3. **The signal evaluator (`src/mcp/tools/signal-eval.ts`).** A pure function that decides whether a response matches a payload's success predicate. This is what turns "the AI thinks it found a bug" into "the code knows a bug exists." Same evaluator is reused by `probe_endpoint` during the scan and (eventually) by `verify_clean` to confirm fixes.

4. **The attacker subagent (`agents/attacker.md`).** A Claude Code subagent that lives in its own isolated context. Receives target URL, scope, endpoint list, payload library; produces structured JSON findings. The system prompt enforces the rule "only emit a finding when `signal.matched === true`" — the subagent has no judgment over whether something is a finding; it just runs the signal and reports.

## Directory layout

```
isitsafebro/
├── .claude-plugin/
│   └── plugin.json              # Claude Code plugin manifest
├── .mcp.json                    # MCP server registration
├── commands/
│   ├── isitsafe.md              # /isitsafe slash command
│   └── snap.md                  # /snap slash command
├── agents/
│   └── attacker.md              # attacker subagent system prompt
├── src/
│   ├── bin/
│   │   └── isitsafebro.ts       # CLI entry (register / unregister / status / version / help)
│   └── mcp/
│       ├── server.ts            # MCP server entry — registers every tool
│       └── tools/
│           ├── signal-eval.ts   # pure signal evaluator
│           ├── payload-schema.ts # Zod schema for payloads
│           ├── payloads.ts      # load_payloads
│           ├── probe.ts         # probe_endpoint
│           ├── endpoints.ts     # list_endpoints
│           ├── snap.ts          # snap_inspect + snap_commit
│           └── worktree.ts      # create_scan_worktree + install_and_start + cleanup_worktree
├── payloads/
│   ├── SCHEMA.md
│   ├── auth.json                # 10 patterns
│   ├── api.json                 # 10 patterns
│   ├── secrets.json             # 9 patterns
│   ├── idor.json                # 6 patterns
│   └── prompt.json              # 7 patterns
├── test-fixtures/
│   ├── sample-app/              # zero-dep node http for worktree e2e
│   └── vuln-app/                # deliberately-vulnerable for attack e2e
├── scripts/
│   ├── gen-jwts.mjs             # JWT generator for auth.json
│   ├── test-snap.mjs            # e2e: /snap pipeline
│   ├── test-worktree.mjs        # e2e: worktree lifecycle
│   ├── test-payloads.mjs        # e2e: load_payloads over live MCP
│   └── test-attack.mjs          # e2e: full attack loop, 24 verified findings
├── docs/
│   ├── architecture.md          # this file
│   └── false-positives.md
└── dist/                        # tsc output (gitignored)
```

## The /isitsafe flow

When complete (Day 10), the slash command will orchestrate:

```
                    user types /isitsafe in claude code
                                  │
                                  ▼
                         confirm not on prod
                                  │
                                  ▼
                          run /snap inline
                                  │
                                  ▼
                    create_scan_worktree (isolated copy)
                                  │
                                  ▼
                      install_and_start (free port)
                                  │
                                  ▼
                     spawn attacker subagent
                                  │
                                  ▼
              ┌── load_payloads(scope) ──┐
              │                            │
              ▼                            ▼
       list_endpoints              for each payload × hint:
                                       probe_endpoint
                                            │
                                            ▼
                                    structured signal eval
                                            │
                                            ▼
                                  if matched → finding
                                            │
                                            ▼
                                  attacker returns JSON
                                  ◄─────────┘
                                  │
                                  ▼
                       surface findings to main session
                                  │
                                  ▼
                      user picks which to fix
                                  │
                                  ▼
              for each picked: apply_fix → commit on scan branch
                                  │
                                  ▼
                       restart_dev_server
                                  │
                                  ▼
                          verify_clean (replay)
                                  │
                                  ▼
              for each verified-clean: freeze_test
                                  │
                                  ▼
                     show user the merge prompt
                                  │
                                  ▼
                       cleanup_worktree (branch stays)
```

Today the steps above the dashed line work end-to-end (proven by `scripts/test-attack.mjs`). The steps below (apply_fix onwards) are scaffolded but not implemented — that's Day 9-10.

## The /snap flow

Simpler. Lives entirely in `src/mcp/tools/snap.ts`.

```
1. snap_inspect(cwd) → { branch, clean, summary, files: [{path, status, diff}] }
   - the slash command checks clean and bails if there's nothing to commit
2. main session reads the diff, clusters into N logical commits
3. for each planned commit:
   snap_commit({type, subject, body?, files}) → { sha, message, filesCommitted }
   - server-side validates type (enum), subject (lowercase, ≤60, no period, single line),
     resets index, stages listed files, commits
4. snap_inspect(cwd) again to verify clean
   - if not clean, loop a follow-up commit
```

The split between "main session decides what to commit" and "tool deterministically executes" is the same pattern used for the attack loop. The LLM gets to think; the code enforces invariants.

## How the MCP server is reached

Claude Code reads `.mcp.json` and learns where to find the server:

```json
{
  "mcpServers": {
    "isitsafebro": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"]
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is the directory containing the plugin manifest — that's the symlink target created by `isitsafebro register`. Claude Code spawns `node dist/mcp/server.js` as a child, talks JSON-RPC over its stdin/stdout. Every slash command and the attacker subagent route through that one server.

## The signal architecture (in one sentence)

> Every attack payload carries a structured predicate over `{status, headers, body}`; the evaluator runs that predicate against probe responses and returns `{matched: bool, explanation: string}`; the LLM picks payloads and crafts variations, but the verdict is always code, never inference.

Why this matters: see [false-positives.md](./false-positives.md).

## Testing surface

- **Unit tests (vitest):** signal evaluator, payload schema, snap validation. Pure functions.
- **E2E (node scripts driving the live MCP server over stdio):**
  - `test-snap.mjs` — temp git repo with messy diff, three commits land.
  - `test-worktree.mjs` — sample-app fixture, worktree create + install_and_start + http probe + cleanup.
  - `test-payloads.mjs` — load every category, sanity-check structure.
  - `test-attack.mjs` — vuln-app fixture, scan all 5 categories, assert 24 findings + 0 false positives.

Run them all: `npm run test:e2e`.

## Dependencies and why

| dep | used for |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server + tool registration |
| `zod` | input schemas + payload validation |
| `simple-git` | git operations in snap / worktree tools |
| `execa` | subprocess management (npm run dev, with detached process groups) |
| `get-port` | free-port allocation for dev server spawn |
| `undici` | low-level HTTP for probe_endpoint (preserves multi-value headers) |

Dev-only: `typescript`, `tsx`, `vitest`, `@types/node`.

No telemetry, no analytics, no auth libraries (the tool doesn't have its own users), no cloud SDKs.
