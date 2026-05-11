---
description: red-team your running localhost app for real, exploitable bugs
argument-hint: [scope: auth | api | prompt | secrets | idor | all]
---

# /isitsafe

scope passed by user: $ARGUMENTS (defaults to `all` if empty).

> **day 2 scaffold.** the full attack loop lands across days 5 to 10 of the build.
> right now this command just exists so claude code loads it. behavior below is a
> placeholder; do not actually run any scan yet.

## what this command will do (when finished)

1. find which localhost port the user's dev server is running on (3000, 5173, 8080, etc.); ask if multiple.
2. confirm with the user, in plain language, that they aren't pointed at a production database or paid API.
3. run `/snap` first so the user has a clean rollback point.
4. create an isolated git worktree on a fresh branch (`isitsafebro/scan-<timestamp>`), boot the dev server inside it on a free port.
5. spawn the `attacker` subagent against that worktree's URL with the requested scope and the payload library.
6. collect structured findings, surface them inline in plain words ("found 3 things that ain't safe..."), and let the user pick which to fix.
7. apply fixes on the worktree branch, restart the server, re-attack just the confirmed findings as a verification pass.
8. freeze each verified exploit as a permanent regression test under `.isitsafebro/tests/`.
9. surface the fix branch to the user with a merge prompt.
10. tear down the worktree directory; leave the branch behind for review.

## current placeholder response

since none of the above is wired yet, simply reply to the user with:

> hey bro, `/isitsafe` is still being wired up. day 2 of the build is just plugin scaffolding. real scans land around day 6 to 10. spec lives in `isitsafeproject.md` if you want to see the plan.

do not invoke any mcp tool yet. do not spawn the `attacker` subagent yet.
