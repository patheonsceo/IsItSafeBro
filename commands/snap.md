---
description: split uncommitted changes into clean conventional commits
---

# /snap

split the user's messy uncommitted work into N clean conventional commits.

## voice rule (read first)

commit messages are **professional conventional commits**. the bro voice does **NOT** apply to commit messages or to the commit `body`. git history stays clean and conventional. anything outside the commits themselves (your replies to the user) can use the project voice (lowercase, sparing, casual).

good commit subjects:

```
feat: add password strength check to signup
fix: handle null email on social login
refactor: extract jwt verification into middleware
chore: bump next to 14.2.3
```

bad commit subjects (NEVER produce these):

```
yo cleaned up the auth bro
fixed some stuff
wip
```

## flow

### step 1: inspect

call the mcp tool `snap_inspect`. it returns:

- `branch`: current branch name
- `clean`: boolean
- `summary`: paths grouped by modified / added / deleted / renamed / untracked
- `files`: array of `{path, status, diff}` with the unified diff for each file
- `error`: if not a git repo, or unmerged conflicts present

if `error` is set, surface it to the user and stop. examples:

> not a git repo bro. cd into your project first.

> looks like you have unmerged conflicts. fix those first, then run /snap again.

if `clean` is `true`, tell the user:

> nothing to snap, working tree's clean.

and stop.

### step 2: plan the commits (this part is on you)

read every file's diff. cluster the changes into the smallest set of **logically coherent** commits. one feature, one fix, one refactor, one config bump per commit.

prefer fewer commits over more when changes touch the same logical unit. don't split a single feature across three commits just because it touches three files.

for each planned commit, pick:

- `type`: one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`. pick the most specific. when in doubt:
  - `feat`: new user-facing behavior or capability
  - `fix`: corrects a bug or wrong behavior
  - `refactor`: code change with no behavior change
  - `chore`: deps, build, config, tooling, .gitignore, etc.
  - `docs`: README, comments, markdown only
  - `test`: tests only
  - `style`: formatting, whitespace, no semantic change
  - `perf`: performance improvement, no other behavior change

- `subject`: lowercase, single line, **<= 60 chars**, no trailing period. start with an imperative verb (add, fix, drop, extract, bump, rename, etc.).

- `body` (optional): only include a body if the change has non-obvious **why** behind it. one short paragraph max. if a body is unnecessary, omit it; do not invent filler.

- `files`: the exact files this commit should touch.

every file from the inspect output must end up in exactly one commit. no file split across commits at this layer (the tool stages files whole). no file left behind.

### step 3: execute

for each planned commit, in order, call `snap_commit` with:

```
{ "type": "...", "subject": "...", "body": "..." | null, "files": [...] }
```

the tool will:

- reset the index (any pre-staged work is unstaged; this is documented behavior)
- stage the listed files
- refuse to commit if nothing actually got staged (e.g., file unchanged or ignored)
- refuse the commit if the subject violates the rules
- write the commit and return the sha

if any `snap_commit` returns `{ok: false}`, surface the `error` to the user in their voice and stop. do not silently continue. example:

> snap_commit choked on commit 2: "subject must be lowercase". want me to retry with a fixed message?

### step 4: verify clean

after the last commit, call `snap_inspect` again. if `clean === true`, you're done. tell the user:

> snapped N commits. all clean.

and list them as bullet points with the formatted message and sha (short form, first 7 chars).

if `clean === false`, you missed something. inspect again, plan a follow-up commit, and call `snap_commit` once more. repeat until clean.

## important rules

- do not bypass `snap_commit` validation by calling git via Bash. the validation is the safety net; route through the mcp tool.
- do not amend or rewrite existing commits. always create new commits forward.
- do not push to a remote. /snap stops at local commits.
- if the user has pre-staged changes before invoking /snap, warn them once that the index will be reset before snap takes over, then proceed.
- if the diff is huge (say > 50 files or > 5000 lines), ask the user before producing a commit plan: "this is a big diff, want me to snap it as one chore commit or break it up by directory?"
