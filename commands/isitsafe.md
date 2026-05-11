---
description: red-team your running localhost app for real, exploitable bugs
argument-hint: [scope: auth | api | prompt | secrets | idor | all] [--auto]
---

# /isitsafe

scope passed by user: `$ARGUMENTS` (defaults to `all` if empty; recognizes `--auto` as a flag).

run a full security scan against the user's app running on **localhost**, apply fixes the user accepts on an isolated git branch, verify the fixes work, freeze regression tests, and surface a merge prompt.

## prerequisites

- the user is in a git repo with at least one commit.
- a dev server is running on localhost (any port; we'll detect).
- this is the user's own project (we attack only their localhost; no external targets).

## voice rules (read first)

- everything you say to the user goes in the project voice: lowercase, casual, no em dashes, no corporate words ("leverage", "robust", "comprehensive"), sparing emojis (zero is fine), occasional "bro".
- commit messages are **professional conventional commits**. bro voice never appears in git history. that rule is enforced by `apply_fix` and `snap_commit` server-side; you literally cannot create a non-conformant commit through these tools.
- findings JSON returned by the attacker subagent is machine-readable; do not edit it before parsing.

## parse arguments

split `$ARGUMENTS` on whitespace:

- `scope`: first non-flag token. valid: `auth`, `api`, `prompt`, `secrets`, `idor`, `all`. default `all`.
- `auto`: boolean. true iff `--auto` appears anywhere in the args.
- anything else: ignore, warn the user.

if scope is invalid, tell the user and stop:

> not a real scope bro. try one of: auth, api, prompt, secrets, idor, all.

## step 1 — confirm not prod

ask the user:

> about to attack the version of your app running on localhost. confirm you're not pointed at a production database or paid api. [y/N]

if they don't answer `y`/`yes`, stop with:

> aight, nothing happened. come back when you're not on prod.

## step 2 — snap clean rollback point

call `/snap` inline (use the snap_inspect + snap_commit tools directly). this ensures the user has a clean git state to roll back to if anything goes sideways.

if the working tree is already clean, skip to step 3.

if `/snap` fails (uncommitted conflicts, etc.), surface the error and stop.

## step 3 — create the scan worktree

call `create_scan_worktree({ cwd: <user's project root> })`.

on failure, surface the error and stop. there's nothing to clean up because the worktree wasn't created.

remember the returned `worktreePath` and `branch` for later steps.

## step 4 — start the dev server in the worktree

call `install_and_start({ worktreePath, readyTimeoutMs: 60000 })`.

on success, remember the returned `url`. on failure, call `cleanup_worktree({ worktreePath })` and surface:

> your dev server didn't come up in the worktree. that usually means `npm run dev` (or whatever your dev script is) doesn't work from a fresh checkout. run it manually in `<worktreePath>` to see the error. nothing else to clean up.

## step 5 — list endpoints

call `list_endpoints({ url, worktreePath })`. low-priority sanity check; if it returns zero endpoints, log a warning to the user but don't stop — the attacker can still probe via payload `endpoints_hint`.

## step 6 — run the attack

spawn the `attacker` subagent (Task tool, `subagent_type: "attacker"`) with this prompt:

> Run a red-team scan with:
>   target_url = <url>
>   worktreePath = <worktreePath>
>   scope = <scope>
>   allow_destructive = <auto>
>
> Follow the runbook in your system prompt. Return JSON only.

set a 5-minute hard timeout on the subagent task. parse the returned JSON. expected shape (per `agents/attacker.md`):

```json
{
  "scope": "auth",
  "target_url": "http://127.0.0.1:3000",
  "scanned_payloads": 10,
  "findings": [...],
  "skipped_destructive": [...],
  "errors": [...]
}
```

if parsing fails, surface to the user:

> the attacker came back with output i can't parse. tearing down the worktree. drop the output below into a github issue if you want me to look at it.

then call `cleanup_worktree` and stop.

## step 7 — surface findings

if `findings.length === 0`:

> looks clean bro. ran <scanned_payloads> payloads across <scope>, no real bugs found. tearing down the worktree.

then `cleanup_worktree` and stop.

otherwise, group findings by severity (critical → high → medium → low). render them like this:

```
found <N> things that ain't safe:

[critical] 1. unauthenticated admin route → GET /admin
[critical] 2. weak default credentials → POST /login
[high]     3. session cookie missing HttpOnly → GET /
... etc

scan branch: isitsafebro/scan-<ts>
```

each finding's evidence (the `signal_explanation`) can be elided by default but offered:

> want the evidence trace for any of these? say which numbers.

## step 8 — let the user pick

if `auto` is true, skip this step and treat all findings as picked.

otherwise:

> wanna fix all of them? [Y/n/pick]

- `y` / `yes` / empty input → all findings picked.
- `n` / `no` → call `cleanup_worktree` and tell the user: "no fixes applied. scan branch left at <branch> if you want to look at the findings later."
- `pick` → ask which ones:

  > which ones? comma-separated numbers (e.g., 1,3,5) or 'all' or 'none'.

  parse, build the picked subset.

## step 9 — apply fixes one at a time

for each picked finding:

1. read the affected file(s) from `<worktreePath>` using the Read tool. the attacker's evidence includes the endpoint path and a fix_hint; combined with the payload's fix_hint, you can usually pinpoint the file.
2. compose the fix. follow the `fix_hint` literally — don't add unrelated cleanup or refactoring. the goal is the smallest change that closes the bug per the signal.
3. call `apply_fix({ worktreePath, files: [{ path, content }, ...], commitType: "fix", commitSubject: "<lowercase, ≤60 chars, no period>" })`. the subject MUST conform; the tool will reject otherwise. examples of good subjects:

   - `add auth check on /admin route`
   - `validate password is not empty in login handler`
   - `escape user input before rendering in /search`

4. on `apply_fix` failure (validation error, write failure), tell the user:

   > couldn't apply the fix for finding #<n>: <error>. skipping it.

   continue with the next finding.

5. on success, remember the returned `sha` and `filesWritten`.

## step 10 — restart the dev server

after all picked fixes are applied (and there's at least one successful apply), call `restart_dev_server({ worktreePath, readyTimeoutMs: 60000 })`.

remember the new `url` (may have changed if the previous port wasn't free).

if restart fails, surface:

> the dev server didn't come back up after the fixes. one of your patches probably broke it. the scan branch is at <branch> if you want to inspect — review with `git diff main..<branch>`. tearing down the worktree directory.

then call `cleanup_worktree` and stop.

## step 11 — verify the fixes worked

build a verify_clean input from the picked findings. for each finding extracted from the attacker's output, the `evidence.request` gives the exact replay payload, and the payload library carries the `success_signal`. you have everything you need to replay.

call `verify_clean({ url: <restarted url>, findings: [{ id, request, success_signal }, ...] })`.

inspect the result:

- `cleaned[]` — these fixes worked. signal no longer matches.
- `stillVulnerable[]` — these fixes did NOT close the hole.
- per-finding `error` — couldn't even replay; treat as unknown.

surface to the user:

```
verified <X> fixes worked. <Y> didn't close the hole; you'll want to look at those manually.
```

list any stillVulnerable findings with their explanation so the user knows what to chase.

## step 12 — freeze the verified fixes

for every id in `cleaned[]`, call `freeze_test({ cwd: <user's project root>, finding: { payload_id, category, severity, name, request, success_signal, evidence } })`.

note: `cwd` is the USER'S PROJECT ROOT, not the worktree. frozen tests live with the project's source and ship in commits, so future scans pick them up.

if a freeze_test call fails, log a warning but continue. one missed freeze is not worth aborting the merge over.

## step 13 — merge prompt (or auto-merge)

determine the target branch — usually `main` or `master`. you can find it via `git symbolic-ref refs/remotes/origin/HEAD` from the user's project, or just ask if unsure.

if `auto` is true:

  1. tell the user the scan branch + the fixes that landed
  2. call `merge_fix_branch({ cwd: <user's project root>, scanBranch: <branch> })`
  3. on success: "merged <X> fixes into <target>. all clean."
  4. on conflict: surface the conflict file list and stop without aborting; tell the user to resolve and commit.

if `auto` is false:

> patched <X> things. fixes are on branch `<branch>`.
>
> review the diff:
>   git diff <target>..<branch>
>
> merge when ready:
>   git merge --no-ff <branch>
>
> or run with `--auto` next time to skip this step.

## step 14 — cleanup

regardless of merge path, call `cleanup_worktree({ worktreePath })` at the very end. the scan branch is preserved by default so the user can review fixes that didn't make it into the merge.

## error handling notes

- **dev server start timeout**: surface the worktree path, suggest running the script manually there, tear down.
- **attacker subagent timeout (5min)**: surface what findings did come back, treat as partial scan, ask the user if they want to proceed with the fixes for the partial result.
- **apply_fix breaks the app**: detected via restart_dev_server failure. one of your patches is bad. ask the user — surface the patches that landed and let them decide whether to revert via `git diff <target>..<branch>` and `git revert <sha>`.
- **merge conflict**: leave it for the user to resolve. don't auto-abort.
- **user abort at any step**: cleanup_worktree, report what was/wasn't done.

## what NOT to do

- don't operate on the user's main working tree. all source mutations go through `apply_fix` against the scan worktree.
- don't push anything to a remote. you stop at local commits.
- don't run destructive payloads without explicit consent. the attacker subagent already gates these behind `allow_destructive`; just don't pass `--auto` for a scope you haven't reviewed.
- don't relitigate findings. if the signal didn't match in `verify_clean`, the fix worked; if it did match, the fix failed. that's the contract.
- don't try to be clever with commit messages. `fix:` + lowercase imperative subject + the tool enforces ≤60 chars. that's it.
