# isitsafebro

is it safe, bro?

your AI built you an app. neat. did anyone check if a random person on the internet can log in as the admin, read your whole database, or pull your stripe key out of the page source? probably not.

that's what this does. one command, inside claude code, before you ship.

```bash
npm install -g isitsafebro
isitsafebro register
```

then in claude code, type `/isitsafebro:isitsafe`.

---

## who this is for

you. if you built an app with lovable, bolt, v0, replit, cursor, or claude itself, and you can't read most of the code your AI wrote, and you have no idea whether it's safe to put on the internet, this is for you.

you do not need to know what a SQL injection is. you do not need to know what auth means. you do not need to read your code. the whole point is that you don't have to.

---

## what it actually does

while your app is running on localhost (the same way you preview it during dev), you type `/isitsafe` inside claude code. for a few minutes, it pretends to be the worst kind of internet stranger and pokes at your app trying to break in.

when it finds something real (not theoretical, real, with a screenshot of the broken thing), it shows you in plain words what happened. then it puts the fix on a separate git branch so you can look at the change before merging anything into your main code.

things it looks for, in human:

- can someone log in as the admin without a password
- can people read or change data that isn't theirs (your customer #2 viewing customer #1's invoices, for example)
- did your AI accidentally bake api keys or secrets into the page that anyone can view-source
- can someone trick the AI features in your app into ignoring your rules
- can someone read or wreck your whole database with a weird url
- and 30-something more, with new ones added every release

if it finds nothing, ship. if it finds something, it shows you in human language, fixes it, and saves a tiny test for that exact bug so it can't quietly come back later.

---

## /snap (bonus thing)

side feature for everyone, not just for the security scan. type `/snap` and it takes your messy uncommitted changes and splits them into clean little commits with proper messages. so your git history stops looking like `stuff`, `more stuff`, `wip lol`.

useful by itself. used automatically by `/isitsafe` so you have a clean rollback point before anything touches your code.

---

## why this exists

vibe-coded apps ship fast. usually too fast. the AI writes 2,000 lines, you don't read most of it, and the parts that quietly matter (who can log in, who can see what, where the secrets live) often have bugs the AI never thought to mention.

most security tools were built for people who already know what they're looking for. this one is built for people who don't, and don't want to learn just to ship a thing.

---

## things it does NOT do

- it does not phone home. no analytics, no telemetry, no accounts.
- it does not need a separate API key. it uses whatever you already have in claude code.
- it does not need docker or any new install on your machine beyond claude code and node.
- it does not touch your live site or your real users. it only attacks the version running on your laptop.
- it does not auto-merge fixes. it puts them on a branch and lets you decide.

---

## status (be honest)

alpha but feature-complete. the product is whole; we haven't published it to npm yet.

**works end-to-end** (verified live in claude code v2.1.140 on 2026-05-13 — 18 real findings in 5m 53s against the next.js fixture):

- the plugin installs and registers in claude code via `isitsafebro register` (writes the full marketplace + cache + three config-file install, not just a symlink).
- `/snap` runs over the real MCP server. 19 unit tests + 1 e2e against a messy fixture repo.
- `/isitsafe` runs the full scan → fix → verify → freeze → merge loop. when the attacker finds something, the user picks which to fix, fixes land on the scan branch as conventional commits, the dev server restarts, every fix is re-verified with the same signal that detected it, verified fixes get serialized as regression tests under `.isitsafebro/tests/`, and the scan branch merges into main.
- the attack engine: 42 attack patterns across 5 categories (auth, api, secrets, idor, prompt injection), each with a structured success signal that prevents false positives. proven end-to-end against a deliberately-vulnerable fixture: 24 verified findings, 0 false positives.
- all 13 MCP tools real: `snap_inspect`, `snap_commit`, `create_scan_worktree`, `install_and_start`, `restart_dev_server`, `cleanup_worktree`, `list_endpoints` (parses Next.js app/pages routers + Express/Fastify/Hono via regex + HTTP crawl), `load_payloads`, `probe_endpoint` (with the signal evaluator built in), `apply_fix` (with path-traversal protection), `verify_clean`, `freeze_test`, `merge_fix_branch`.
- the attacker subagent has its real system prompt and follows the structured-signal contract (no fabricated findings).
- 5 e2e suites prove the surfaces: `test:e2e:snap`, `test:e2e:worktree`, `test:e2e:payloads`, `test:e2e:attack` (24 findings, 0 FPs), `test:e2e:fix` (full attack→fix→verify→freeze→merge against the vuln fixture).

**not done yet — but it's not code:**

- dogfood against three real vibe-coded apps (lovable, bolt, a friend's project). this is where payload tuning happens and where the install/run/teardown UX gets bug-bashed.
- launch.

these are tracked in [CHANGELOG.md](./CHANGELOG.md) as Days 12-14 of the build sprint.

---

## install

```bash
# 1. install the package globally
npm install -g isitsafebro

# 2. register the plugin with claude code
isitsafebro register
```

`register` writes the six things claude code needs to discover and enable a plugin: a local marketplace dir, a marketplace.json manifest, a plugin symlink into it, a cache entry symlink, plus entries in `installed_plugins.json`, `known_marketplaces.json`, and `settings.json`. honors `$CLAUDE_HOME` if you've moved it; defaults to `~/.claude`.

**after that, restart claude code (or open a new session)** — the slash commands appear under the plugin's namespace.

verify it's registered:

```bash
isitsafebro status
```

prints a six-line check for every file and config entry it touched.

---

## run

inside claude code, in the working directory of your project:

```
/isitsafebro:snap                   # clean up uncommitted changes
/isitsafebro:isitsafe               # run the full scan
/isitsafebro:isitsafe auth          # scan just one category
/isitsafebro:isitsafe api           # categories: auth, api, prompt, secrets, idor, all
```

claude code namespaces plugin commands as `<plugin>:<command>` so they don't collide with other plugins or built-ins. type `/i` and tab to autocomplete.

the scan only attacks the version of your app running on localhost. it asks you to confirm you're not pointed at production before doing anything.

---

## uninstall

```bash
# 1. remove from claude code
isitsafebro unregister

# 2. uninstall the package
npm uninstall -g isitsafebro
```

`unregister` removes everything `register` created: the marketplace dir, the cache entry, and the three config-file entries. it never touches anything outside its own keys, so other plugins / global settings are untouched.

---

## demo

two self-contained runnable demos. both drive the same MCP server claude code uses for `/isitsafe`, against a deliberately-vulnerable fixture shipped with the repo, all auto.

```bash
npm run demo            # ~45s   generic fixture (zero-dep node http server)
npm run demo:nextjs     # ~2min  real Next.js 15 app (auto-installs deps on first run)
```

the next.js demo (**VibeNotes**) is the more compelling one — it's a real Next.js 15 + React 19 + TypeScript project with the kinds of bugs vibe-coded apps actually ship: a server component admin page with no auth check, a middleware that mis-configures CORS and forgets HttpOnly, a route handler that accepts weak passwords, a search page using react's "dangerously set" HTML API, a client component baking `NEXT_PUBLIC_STRIPE_SECRET` into the bundle. it finds 23 bugs and the demo's coding-agent stand-in patches 5 of them in commits that look like a real engineer wrote them.

trimmed output from a real `npm run demo` run:

trimmed output from a real run:

```
[critical] auth/unauthenticated-admin-route        → GET /admin (status 200)
[critical] auth/jwt-alg-none-bypass                → GET /api/me (status 200)
[critical] auth/weak-default-credentials           → POST /login (status 200)
[critical] auth/login-empty-credentials-accepted   → POST /login (status 200)
[high]     auth/unauthenticated-write-endpoint     → POST /api/users (status 201)
[high]     auth/unprotected-debug-or-internal-route → GET /debug (status 200)
[high]     auth/cors-misconfig-...with-credentials → OPTIONS /api (status 204)
[medium]   auth/session-cookie-without-httponly    → GET / (status 200)
[critical] api/sql-injection-error-based           → GET /api/products?name=' (status 500)
[critical] api/path-traversal-via-filename-param   → GET /api/file?path=../etc/passwd (200)
[high]     api/xss-reflected                       → GET /search?q=<marker> (status 200)
[critical] secrets/dotenv-file-served              → GET /.env (status 200)
[critical] secrets/config-route-leaks-secrets      → GET /api/config (status 200)
[critical] idor/per-user-resource-fetched-without-auth → GET /api/customers/1 (200)
[high]     idor/unauthed-list-endpoint-returns-records → GET /api/users (200)
[high]     idor/pii-in-list-response               → GET /api/users (status 200)
[high]     prompt/prompt-injection-direct-canary   → POST /api/chat (status 200)
[high]     prompt/prompt-injection-fake-assistant-turn → POST /api/chat (200)
... and 6 more

24 verified findings, 0 false positives.
```

every finding ships with a full evidence trace showing exactly which conditions of the signal matched what bytes in the response. you can audit a verdict without re-running the probe.

---

## docs

| doc | what's in it |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | how the plugin, MCP server, signal evaluator, and subagent fit together |
| [docs/false-positives.md](./docs/false-positives.md) | the structured-signal design philosophy — why this scanner doesn't lie |
| [payloads/SCHEMA.md](./payloads/SCHEMA.md) | the attack-pattern format. authoring new payloads. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | tests, voice rules, PR process |
| [CHANGELOG.md](./CHANGELOG.md) | what shipped, when |
| [SECURITY.md](./SECURITY.md) | how to responsibly disclose bugs in isitsafebro itself |
| [isitsafeproject.md](./isitsafeproject.md) | the original build spec |

---

## contributing

PRs welcome — especially new payloads (high-signal real bugs, not theoretical noise) and fixture coverage. read [CONTRIBUTING.md](./CONTRIBUTING.md) before you start.

three high-leverage places to help:

- **payloads.** add a new attack pattern with a tight success signal. one bug class per payload, conservative severity, plain-English fix hint. see [payloads/SCHEMA.md](./payloads/SCHEMA.md).
- **endpoint discovery.** `list_endpoints` covers Next.js app/pages routers and the common Express/Fastify/Hono regex. SvelteKit, Remix, Hono with route-prefix, custom routers — all welcome.
- **dogfood.** run isitsafebro against your own apps (or apps you have permission to scan). file an issue with the bug it found and the fix it suggested — false positives, false negatives, and confusing copy all useful.

---

## license

MIT. fork it, ship it, blame us when it works.
