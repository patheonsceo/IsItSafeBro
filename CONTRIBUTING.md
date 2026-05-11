# contributing to isitsafebro

PRs welcome. read this once; you can do almost everything below in under an hour.

## what helps most

three high-leverage areas:

1. **new payloads.** real bugs vibe-coded apps ship with. one bug class per payload, conservative severity, structured success signal that won't false-positive.
2. **endpoint discovery.** add a parser for a framework `list_endpoints` doesn't cover yet (SvelteKit, Remix, Hono with route prefixes, etc.).
3. **dogfood.** run isitsafebro against an app you own (or have permission to scan), file an issue with the finding or the false-positive or the confusing message.

less leveraged but useful: bug fixes, tests, doc tightening, voice work on user-facing strings.

---

## getting set up

```bash
git clone git@github.com:patheonsceo/IsItSafeBro.git
cd IsItSafeBro
npm install
npm run build
npm test            # unit tests (vitest)
npm run test:e2e    # full pipeline against the live mcp server
```

`npm run test:e2e` chains four end-to-end suites in order: `snap`, `worktree`, `payloads`, `attack`. each spins up real fixtures and drives the compiled MCP server through stdio. expect about 30-60 seconds total wall-clock.

if you only want one suite:

```bash
npm run test:e2e:snap
npm run test:e2e:worktree
npm run test:e2e:payloads
npm run test:e2e:attack
```

run an attack against a different fixture by editing `scripts/test-attack.mjs` (or copy it and aim it at your own running app).

---

## adding a payload

read [`payloads/SCHEMA.md`](./payloads/SCHEMA.md) first — it covers the structured-signal format with a worked example.

once you have a draft:

1. drop it into the right category file (`payloads/auth.json`, `payloads/api.json`, etc.).
2. validate locally:

   ```bash
   npm run build
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { PayloadFileSchema } from './dist/mcp/tools/payload-schema.js'; const f = PayloadFileSchema.safeParse(JSON.parse(readFileSync('./payloads/CATEGORY.json','utf8'))); console.log(f.success ? 'OK' : JSON.stringify(f.error.format(),null,2));"
   ```
3. add a fixture route to `test-fixtures/vuln-app/server.js` that exhibits the bug (and ideally a healthy counterpart that should NOT trigger your signal).
4. update `scripts/test-attack.mjs` to include the new payload id in the expected-findings set for that category.
5. run `npm run test:e2e:attack` and confirm your payload fires against the vuln route and doesn't false-positive against the healthy one.

### rules for writing a good payload

- **one bug class per payload.** don't bundle "missing auth" with "verbose error" — the fixes differ.
- **signal first.** before you write the request, decide what the response would deterministically look like if the bug exists. if you can't describe the signal in a sentence, you can't avoid false positives.
- **conservative severity.** `critical` only when an attacker can take over an account or read all data. `high` for read/write data they shouldn't access. `medium` for real bugs that aren't a takeover. `low` for config hygiene.
- **plain-English fix hint.** a single paragraph a vibe-coder can paste into their AI assistant and act on.
- **destructive payloads need the flag.** if running the payload causes side effects (creates a user, deletes a resource, sends an email), set `is_destructive: true`. the attacker subagent gates these behind an explicit user confirmation.
- **endpoint hints are a SHORT list of the most likely paths.** five to ten is plenty. better to add later than to bloat probes.

### the signal evaluator

every payload's `success_signal` is checked by a structured predicate evaluator (see `src/mcp/tools/signal-eval.ts`). leaves you can use:

- `status_in` / `status_not_in`
- `body_contains_any` / `body_contains_all` / `body_not_contains_any`
- `body_matches_regex` (with optional case-insensitive flag)
- `header_present` / `header_missing`
- `header_value_contains` / `header_value_not_contains`

combinators: `all_of`, `any_of`. nest freely.

the evaluator emits a human-readable trace showing which leaves matched. that trace IS the evidence in the finding output, so prefer signals that read well when explained.

---

## adding an mcp tool

the server lives in `src/mcp/server.ts`. each tool is a module under `src/mcp/tools/<name>.ts` exporting a `registerXxxTools(server)` function. the server's `server.registerTool(...)` call takes a title, description, input schema (zod), and an async handler returning `{ content, structuredContent }`.

convention: every handler returns a typed `*Result` object that includes `ok: boolean` plus either the success payload or an `error` string. tools never throw — they return `ok: false` and let the caller decide what to do.

if your tool runs subprocesses, use `execa` and consider whether it needs `detached: true` for tree-killing (see `worktree.ts` for the pattern).

---

## voice

isitsafebro has a split voice. follow the rules:

| surface | voice |
|---|---|
| README headline + marketing | bro voice, lowercase, sparing emoji (often zero), no corporate words, no em dashes |
| CLI prompts to the user | same |
| error messages aimed at the user | same |
| **commit messages** | **professional conventional commits.** bro voice NEVER appears in git history. |
| internal logs / stderr | matter-of-fact |
| MCP tool output / findings JSON | machine-readable, no voice |
| code comments | tight, no humor, only when the *why* isn't obvious |
| API docs (tool descriptions, schemas) | clear and clinical |

if you're unsure: lowercase by default, no em dashes, no "leverage" / "robust" / "comprehensive" / "industry-leading" / "I hope this finds you well".

---

## commit + PR process

- conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `style:`, `perf:`). subject lowercase, single line, ≤ 60 chars, no trailing period. that's the rule `/snap` enforces server-side too.
- microcommits over megacommits. each commit should compile and pass at least its own tests.
- no `Co-Authored-By: Claude` or similar AI trailers — credit goes to the human author. (if you used an AI assistant, you're still the contributor; the model is a tool, not a coauthor.)
- PR description should explain *why*, not just *what*. a one-line summary plus a couple of bullet points is fine.

before opening a PR, please run:

```bash
npm run typecheck
npm test
npm run test:e2e
```

CI will run the same. green locally is the minimum.

---

## reporting bugs

regular bugs (a finding that's wrong, a tool that crashes, a slow scan): open a github issue with the reproduction.

security bugs in isitsafebro itself (e.g., the attacker tool could be tricked into hitting an external host, a payload causes a crash on the user's machine): follow [SECURITY.md](./SECURITY.md).

---

## license

MIT. by contributing you agree your contribution is MIT-licensed too.
