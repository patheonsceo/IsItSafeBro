---
description: split uncommitted changes into clean conventional commits
---

# /snap

> **day 2 scaffold.** the real implementation lands on day 3 of the build.
> the description below is the eventual behavior; the placeholder response
> at the bottom is what to do right now.

## what this command will do (when finished)

1. run `git status` and `git diff` to see all uncommitted work.
2. cluster the diff into logical units (one feature, one fix, one refactor, etc.).
3. for each unit, stage just that unit's hunks and commit with a clean conventional message:
   - type tag: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`
   - short imperative subject under 60 chars, lowercase, no trailing period
   - optional body if the change deserves explanation
4. repeat until the working tree is clean.

commit messages stay **professional and conventional**. the bro voice does NOT apply to commit messages. git history is the one place we stay clean.

good output:

```
feat: add password strength check to signup
fix: handle null email on social login
refactor: extract jwt verification into middleware
```

bad output (do not produce):

```
yo cleaned up the auth bro
fixed some stuff
wip
```

## current placeholder response

reply to the user with:

> `/snap` is being built on day 3. for now, hold tight. follow the repo for updates.

do not invoke any mcp tool yet. do not stage or commit anything.
