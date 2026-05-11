# isitsafebro — Build Spec

You are building **isitsafebro**, an open-source Claude Code plugin that red-teams vibe-coded apps before deploy. Read this entire file before writing any code. Everything here is a locked decision from prior design work; treat it as ground truth.

---

## TL;DR

isitsafebro is a Claude Code plugin. The user installs it once, then types `/isitsafe` in any project before they ship. A red-team subagent attacks the user's running localhost app (auth bypass, SQL injection, exposed env vars, prompt injection, IDOR), reports findings inline, and the user's coding agent fixes them on a separate git branch the user reviews before merging. Open source, no Docker, no extra API keys, no cloud.

A second command `/snap` does AI-powered logical commit splitting: reads the uncommitted diff, identifies logical chunks, produces N small conventional commits (`feat:`, `fix:`, `refactor:`). It's a wedge feature on its own.

---

## Who it's for

Vibe-coders shipping apps from Lovable, Bolt, v0, Replit Agent, Cursor, Claude Code itself. People who don't write the code by hand, can't read most of it, and have no idea what RLS or IDOR or CSP means. The product hides all the security vocabulary behind one slash command and one question: *is it safe, bro?*

---

## Locked architecture decisions

Do not relitigate these. They have all been argued through. If you think one is wrong, leave a `// TODO open question:` comment and surface it at the end; don't silently change direction.

1. **Distributed as a Claude Code plugin** (bundles skills + custom subagent + MCP server). Published to npm as `isitsafebro`. Install: `npm install -g isitsafebro` then a one-liner to register the plugin with Claude Code.
2. **No Docker.** Isolation is done with `git worktree`, which every developer already has installed and works identically on macOS, Linux, and Windows/WSL.
3. **The attacker is a Claude Code subagent**, not a separate LLM. It uses whatever model the user already has in Claude Code (Sonnet, Opus, Haiku). No extra API keys, no provider rotation, no Groq fallback.
4. **Two slash commands only for v1:** `/isitsafe` and `/snap`. Scoped variants (`/isitsafe auth`, `/isitsafe api`, `/isitsafe prompt`) are arguments to `/isitsafe`, not separate commands.
5. **Fixes land on a separate git branch** named `isitsafebro/scan-{timestamp}`. The user reviews the diff and merges manually by default. An `--auto` flag exists for confident users.
6. **Output is failing tests + diffs**, never a PDF report or a severity matrix. Mental model is Jest: failing test → fix → passing test. Confirmed exploits become permanent regression tests in `.isitsafebro/tests/`.
7. **Everything runs locally.** No cloud, no telemetry, no accounts, no API keys to set up beyond Claude Code itself.

---

## Component map

```
isitsafebro (npm package)
│
├── plugin manifest          → registers everything with Claude Code
├── skill: /isitsafe         → entry point, orchestrates the loop
├── skill: /snap             → AI logical commit splitting
├── subagent: attacker       → red-team agent, custom system prompt
├── MCP server               → tools for worktree, probe, payloads, fixes
└── payloads/                → JSON files of attack patterns by category
```

When the user installs the package and registers the plugin, Claude Code auto-discovers the skills, the subagent, and the MCP server. No further setup.

---

## Repo file structure

```
isitsafebro/
├── package.json
├── README.md
├── LICENSE                          (MIT)
├── bin/
│   └── isitsafebro                  CLI entry, also handles plugin registration
├── plugin/
│   ├── manifest.json                plugin definition
│   ├── skills/
│   │   ├── isitsafe/
│   │   │   └── SKILL.md
│   │   └── snap/
│   │       └── SKILL.md
│   └── agents/
│       └── attacker.md              custom subagent definition
├── mcp/
│   ├── server.ts                    MCP server entry
│   └── tools/
│       ├── snap.ts                  logical commit splitter
│       ├── worktree.ts              create/install/start/cleanup
│       ├── probe.ts                 HTTP probe with structured response
│       ├── payloads.ts              load payloads by category
│       ├── fix.ts                   apply patches to worktree branch
│       ├── verify.ts                re-attack with regression suite
│       └── merge.ts                 merge fix branch into main
├── payloads/
│   ├── auth.json
│   ├── api.json
│   ├── prompt-injection.json
│   ├── secrets.json
│   └── idor.json
├── prompts/
│   ├── attacker.system.md           attacker subagent system prompt
│   ├── snap.system.md               logical commit splitter prompt
│   └── fixer.system.md              fix application prompt
└── scripts/
    └── register-plugin.sh           one-line plugin registration helper
```

---

## The `/snap` command

**Purpose:** convert messy uncommitted work into N clean conventional commits. Used standalone for routine work, used automatically by `/isitsafe` before any attack run.

**Flow:**

1. Run `git status` and `git diff` to see all pending changes.
2. Pass the diff to Claude (main session, not a subagent) with the `snap.system.md` prompt asking it to cluster hunks into logical units. Each unit gets:
   - A type tag: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`.
   - A short imperative subject (< 60 chars, lowercase, no period).
   - Optional body if the change deserves explanation.
3. For each unit, use `git add -p` style hunk selection (or file-level if hunks aren't separable) to stage just that unit's changes.
4. Commit with the conventional message.
5. Repeat until working tree is clean.

**Tone of commit messages:** professional conventional commits. The bro voice does NOT apply here. Commit history is the one place we stay clean and conventional.

**Examples of good output:**

```
feat: add password strength check to signup
fix: handle null email on social login
refactor: extract jwt verification into middleware
chore: bump next to 14.2.3
```

**Examples of bad output (do not produce):**

```
yo cleaned up the auth bro
fixed some stuff
wip
```

---

## The `/isitsafe` command

**Purpose:** run the full red-team loop on the user's running localhost app.

**Argument:** optional scope token. Default `all`. Valid: `auth`, `api`, `prompt`, `secrets`, `idor`, `all`.

**Pre-flight checks:**

1. Confirm a dev server is running on localhost (probe common ports: 3000, 3001, 5173, 8080, 4200, 8000). If multiple, ask the user which one.
2. Show a clear confirmation: *"about to attack localhost:3000. confirm you're not connected to production data (real db, billable APIs). [y/N]"*. Default to `N`. Abort if not confirmed.
3. Run `/snap` internally so the user has a clean rollback point before anything touches their code.

**Main flow:**

1. **Create worktree.** `git worktree add ../{project-name}-isitsafebro-{ts} -b isitsafebro/scan-{ts}`. Symlink `node_modules` from main into the worktree to avoid reinstall. Fall back to `npm install` if symlink fails.
2. **Start dev server in worktree** on a free port (use `get-port` package). Wait for the port to respond before continuing. Timeout 60s, give up with a clear error if the app fails to start.
3. **Spawn the attacker subagent.** Pass it the target URL, the scope, and the path to the payloads folder. The subagent runs in its own isolated context (Claude Code subagent fork mode) so it doesn't pollute the main conversation.
4. **Attacker probes for findings.** Hard timeout 5 minutes for the full scan. The attacker returns structured JSON: `{findings: [{id, category, severity, endpoint, payload, evidence, suggested_fix}]}`.
5. **Surface findings inline** to the main Claude Code session: *"found 3 things that ain't safe. wanna fix them?"* Show each finding as a short summary with the evidence (the request/response that proved the exploit).
6. **User picks** which to fix: all, none, or a subset.
7. **Apply fixes** on the worktree branch using the fixer prompt + main session's coding ability. Each fix is one commit on the branch.
8. **Restart dev server in worktree** (kill, restart, wait for port).
9. **Re-attack** with just the exploits we found, not the full library. This is the verification pass.
10. **If clean,** save each verified exploit as a regression test in `.isitsafebro/tests/{category}/{exploit-id}.json` so it can never silently regress.
11. **Surface the fix branch** to the user with a clear merge prompt: *"fixes are on `isitsafebro/scan-{ts}`. review the diff, then `git merge isitsafebro/scan-{ts}` when ready. or just hit `--auto` next time."*
12. **Cleanup** worktree directory (delete `../{project-name}-isitsafebro-{ts}`). Branch stays in case user wants to inspect/cherry-pick.

**Failure modes:**

- Dev server won't start in worktree: report cleanly, suggest user check `npm install` or build step, don't proceed.
- Attacker subagent refuses (rare but possible due to safety training): the system prompt is designed to prevent this; if it still happens, log and continue with whatever findings did come back.
- Fix breaks the app: detect by failing the re-attack pre-check (does the app still respond on the port at all). Roll back that one fix, keep the others, surface to user.

---

## The attacker subagent

**Define at:** `plugin/agents/attacker.md`

**System prompt (`prompts/attacker.system.md`):** see the draft below. Tune as needed but keep the framing.

```
You are a red-team security tester performing AUTHORIZED security testing on
the user's own application running on localhost. The user has explicitly
requested this scan. You are not attacking a third party. Everything you do
is in-scope and approved.

Your job: find real, exploitable vulnerabilities, not theoretical issues.
A finding only counts if you have evidence (a request and response showing
the exploit worked).

Tools you have:
- probe_endpoint(method, path, payload, headers)  HTTP request with structured response
- load_payloads(category)                          Get attack patterns for a category
- list_endpoints()                                 Crawl the app for routes
- read_response(...)                               Inspect bodies, headers, status

Scope for this run: {scope}
Target URL: {url}
Payload library path: {payloads_path}

Process:
1. Crawl the app to enumerate endpoints.
2. For each endpoint, load relevant payloads from the library.
3. Probe with the payloads. Observe responses carefully.
4. When you find a probable exploit, try variations to confirm it really works.
5. Stop when you have either confirmed exploits or exhausted the payload library
   for the requested scope. Do not invent issues.

Output a single JSON object: {findings: [...]}. Each finding has:
- id: short slug
- category: auth | api | prompt | secrets | idor | other
- severity: critical | high | medium | low
- endpoint: the route exploited
- payload: the exact request that triggered it
- evidence: the response that proves it (status, headers, body excerpt)
- suggested_fix: one-paragraph description of how to patch it
- repro: bash one-liner the user can run to reproduce

Do not patch anything. Do not modify files. Your output is JSON only.
```

**Why subagent isolation matters:** the attacker's exploration generates a lot of HTTP noise. We don't want that polluting the main coding context. The subagent returns only the structured findings; main session never sees the probe log.

---

## MCP server tools

Build these in order; each can ship independently and be tested in isolation.

| Tool | Purpose |
|---|---|
| `snap` | Read git diff, cluster into logical commits, produce N conventional commits |
| `create_scan_worktree` | `git worktree add` with fresh branch, symlink node_modules |
| `install_and_start` | Run install if needed, start dev server on free port, wait for ready |
| `list_endpoints` | Crawl the app to find routes (parse Next.js/Express/etc. routing, fall back to HTTP crawling) |
| `probe_endpoint` | HTTP request with structured response; rate-limited, never destructive without confirmation |
| `load_payloads` | Read payload JSON files by category, return as structured list |
| `apply_fix` | Apply a patch to a file in the worktree, commit with descriptive message |
| `restart_dev_server` | Kill running server, restart, wait for port to respond |
| `verify_clean` | Re-run only the found exploits (regression check) |
| `freeze_test` | Save a confirmed exploit as a permanent regression test |
| `merge_fix_branch` | `git merge` the fix branch into main, with `--no-ff` for clean history |
| `cleanup_worktree` | Tear down the worktree directory |

All tools return structured JSON, never raw stdout.

---

## Payload library format

Each category is a JSON file in `payloads/`. Structure:

```json
{
  "category": "auth",
  "version": 1,
  "payloads": [
    {
      "id": "jwt-none-alg",
      "name": "JWT alg:none bypass",
      "description": "Try to bypass JWT verification with alg:none",
      "endpoints_hint": ["/api/auth", "/api/login", "/api/me"],
      "request": {
        "method": "GET",
        "headers": {
          "Authorization": "Bearer <crafted-jwt-with-none-alg>"
        }
      },
      "success_signal": "response status 200 AND response body contains user data",
      "fix_hint": "Use a JWT library that rejects alg:none. Whitelist allowed algorithms explicitly."
    }
  ]
}
```

**Categories to seed for v1:**

- `auth.json` — JWT alg:none, missing auth checks, session fixation, IDOR via predictable IDs, weak default passwords
- `api.json` — SQL injection in query params/body, NoSQL injection, command injection, SSRF, mass assignment
- `prompt-injection.json` — direct injection, indirect via fetched content, jailbreak attempts on AI endpoints, system prompt extraction
- `secrets.json` — env vars exposed in client bundle, API keys in `/api/config`, `.env` files served, source maps revealing secrets
- `idor.json` — predictable resource IDs, missing ownership checks, horizontal privilege escalation

Seed each with 10-20 high-signal payloads from OWASP Top 10, OWASP LLM Top 10, and PortSwigger Web Academy patterns. Quality over quantity. A small library of real exploits beats a huge library of theoretical noise.

---

## Voice and tone

**This matters as much as the code.** The name is `isitsafebro`. The brand is shitpost-adjacent on the marketing surfaces and clean on the technical ones.

### Where the bro voice lives:

- README headline copy
- CLI prompts to the user (confirmations, findings summaries, merge prompts)
- Marketing site copy
- Launch posts
- Error messages aimed at the user

### Where it does NOT live:

- Commit messages (conventional, professional)
- Internal logs
- The attacker subagent's findings JSON
- API/tool documentation
- Code comments
- Anything machine-readable

### Voice rules:

- Lowercase by default in CLI prompts and marketing copy
- Direct, casual, native to vibe-coder discord and X
- No em dashes anywhere (use periods, commas, or colons)
- No corporate words: "solution", "leverage", "robust", "comprehensive", "industry-leading"
- No "I hope this finds you well", no "We are excited to announce"
- Sparing emojis (one per message max, often zero)
- Address the user as "bro" only occasionally; overuse kills it
- Humor is dry, not eager

### Good vs bad examples:

**README headline:**

GOOD:
```
is it safe, bro?
the only red-team that runs inside claude code, before you ship.
npm install -g isitsafebro
```

BAD:
```
🚀 Welcome to isitsafebro - Your Comprehensive AI Security Solution! 🛡️
isitsafebro empowers vibe coders by leveraging cutting-edge AI to deliver 
robust, enterprise-grade security testing.
```

**CLI confirmation:**

GOOD:
```
about to attack localhost:3000.
confirm you're not connected to production data. [y/N]
```

BAD:
```
WARNING: This operation will perform security testing against your local 
development environment. Please confirm that you are not connected to 
production systems before proceeding. Continue? (yes/no)
```

**Findings summary:**

GOOD:
```
found 3 things that ain't safe:

1. auth bypass on /api/admin (no auth header check at all)
2. SQL injection on /api/search (raw query interpolation)
3. exposed env var: NEXT_PUBLIC_STRIPE_SECRET in client bundle

wanna fix all of them? [Y/n/pick]
```

BAD:
```
Security scan complete. 3 vulnerabilities identified:

[CRITICAL] CWE-287: Improper Authentication on endpoint /api/admin
[CRITICAL] CWE-89: SQL Injection on endpoint /api/search  
[HIGH] CWE-200: Information Exposure via Bundle Analysis

Would you like to remediate these issues? (yes/no/select)
```

**Merge prompt:**

GOOD:
```
patched 3 things. fixes are on branch isitsafebro/scan-1736784000.

review the diff:
  git diff main..isitsafebro/scan-1736784000

merge when ready:
  git merge isitsafebro/scan-1736784000

or run with --auto next time to skip this step.
```

BAD:
```
The remediation phase has completed successfully. Please review the proposed 
changes on the dedicated branch and merge at your convenience after appropriate 
code review.
```

---

## Non-goals for v1

Do not build these, even if tempted:

- Mascot art or character. The brand is the name. Tokburn already carries the mascot energy across Kartik's portfolio.
- Hosted dashboard. Everything is local.
- User accounts, auth, login. None.
- Telemetry, analytics, phone-home. None.
- A web UI of any kind.
- Docker, devcontainers, or anything that adds an install dependency.
- Additional LLM providers beyond what Claude Code already has.
- A CLI mode separate from Claude Code (later, maybe; not v1).
- Compliance reports (SOC2, ISO, etc.).
- CVE scoring, CVSS, severity matrices beyond simple critical/high/medium/low.
- Continuous monitoring or scheduled scans. The product is on-demand only.

---

## Tech stack

- **Runtime:** Node 20+
- **Language:** TypeScript (worth the type safety on MCP tool schemas, attacker JSON contract)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Git:** `simple-git` for git operations
- **Ports:** `get-port` for free port detection
- **Processes:** `execa` for child process management
- **HTTP probing:** native `fetch` (Node 20 has it) plus `undici` for advanced cases (custom headers, low-level control)
- **JSON schema validation:** `zod` for parsing attacker output safely
- **Testing:** `vitest`
- **License:** MIT

---

## Build order (two-week sprint)

### Week 1: foundation + /snap

- **Day 1:** Repo init, TypeScript config, package.json, MIT license, empty README placeholder. Get `bin/isitsafebro` printing a version string. Decide on `npm install -g isitsafebro` flow + plugin registration helper.
- **Day 2:** MCP server skeleton. Empty tools that return `{ok: true}`. Verify Claude Code can talk to it via the plugin manifest.
- **Day 3:** `/snap` skill written. `snap` MCP tool implemented. Test by running it on a messy uncommitted diff in a sample repo. This is your wedge feature so make it actually good.
- **Day 4:** Worktree tools: `create_scan_worktree`, `install_and_start`, `cleanup_worktree`. Test with a real Next.js sample app.
- **Day 5:** First payload library: `payloads/auth.json` with 10 high-signal patterns. `load_payloads` tool. Manual testing of payload selection logic.
- **Day 6-7:** Attacker subagent prompt + `probe_endpoint` and `list_endpoints` tools. Get a basic scan working: spawn attacker, hit one endpoint with one payload, get a structured finding back. This is the first end-to-end moment; everything before this is setup.

### Week 2: full loop + polish + launch

- **Day 8:** Expand payload libraries to all 5 categories (api, prompt, secrets, idor). 10-20 payloads each. Quality over quantity.
- **Day 9:** Fix application loop: `apply_fix`, `restart_dev_server`, `verify_clean`, `freeze_test`. The full attack→fix→verify→freeze loop runs end to end on a sample vulnerable app.
- **Day 10:** `merge_fix_branch` tool, `--auto` flag, error handling on all common failure modes (dev server won't start, attacker times out, fix breaks the app).
- **Day 11:** README with the bro voice, a clear install + run + uninstall section, GIF or asciinema demo, basic contributing guide.
- **Day 12:** Internal dogfood: run `/isitsafe` on three real vibe-coded apps (one from Lovable, one from Bolt, one from a friend). Find real bugs. Tune the payloads.
- **Day 13:** Bug bash. Fix the rough edges. Make sure `npm install -g isitsafebro && /isitsafe` works in under two minutes from cold install.
- **Day 14:** Launch. Post to r/programming, r/ClaudeAI, r/webdev, Hacker News, X. Reference the original Furlough discord thread in the X thread for honesty.

---

## Launch surfaces

- **Repo:** `github.com/{handle}/isitsafebro`
- **npm:** `isitsafebro`
- **Domains to grab:** `isitsafebro.com`, `isitsafebro.dev`. Check `isitsafe.bro` if the TLD exists.
- **Tagline:** *is it safe, bro?*
- **Demo:** record a 60-second asciinema or video. Open a Lovable app, type `/isitsafe`, watch three exploits get found and patched on a branch. Show the diff. Show the regression test.

---

## Open decisions (resolve as you build, don't block on them)

- Plugin registration helper: shell script vs. node script vs. just docs. Pick the lowest-friction option that works cross-platform.
- TypeScript or plain JavaScript: leaning TS, but if it slows the first-week build, drop to JS.
- Whether `/snap` should be auto-invoked by `/isitsafe` or just suggested. Default: auto, but log that it ran so user isn't surprised.
- Whether to publish as `isitsafebro` (preferred) or scoped `@something/isitsafebro` if the bare name is taken. Check first.

---

## Reference: prior decisions log

The full design conversation that produced this spec covers: why the attacker is a subagent and not a separate LLM, why git worktree replaced Docker, why MCP server stays in even though the skill could technically work without it, why the name is `isitsafebro` and not Gremlin/Imp/VibeSafe, and why the brand has bro voice on marketing surfaces and clean voice on technical ones. If you find yourself wanting to change one of these, surface the question to the user rather than silently changing direction.

---

End of spec. Start with day 1.
