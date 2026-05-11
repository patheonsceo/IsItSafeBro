# Security Policy

This file covers security bugs **in isitsafebro itself** — not bugs in the apps it tests.

For bugs in apps you scanned (the whole point of the tool), there's nothing to disclose to us; fix them and move on. The findings are yours.

## Reporting a vulnerability in isitsafebro

If you find a bug that lets an attacker harm a user of isitsafebro — by getting the tool to scan an unintended target, exfiltrate secrets, run arbitrary code on the host, etc. — please report it privately first.

**Where to report:**

- GitHub Security Advisories: [open a private advisory](https://github.com/patheonsceo/IsItSafeBro/security/advisories/new) on this repo.
- Email (fallback): `kxdataanalyst@gmail.com` with subject prefix `[isitsafebro security]`.

**Please include:**

- A short description of the bug and impact.
- A proof-of-concept or steps to reproduce.
- The version (`isitsafebro --version`) and OS.
- Whether you'd like credit in the fix's changelog entry.

**We aim for:**

- Acknowledgement within 3 business days.
- A fix or mitigation plan within 14 days for confirmed high-severity issues.
- A coordinated public disclosure after the fix ships.

isitsafebro is a pre-1.0 single-maintainer project; these are aspirations, not guarantees. We'll communicate as openly as we can.

## In scope

- Path-traversal or file-write issues in `bin/isitsafebro` (the CLI) — especially in `register` / `unregister`.
- The MCP server reading or writing files it shouldn't (outside the user's project directory or the worktree it created).
- The attacker subagent or its tools sending HTTP requests to hosts other than the user-specified target.
- Process-tree leaks (a dev server started by `install_and_start` not being killed by `cleanup_worktree`).
- The signal evaluator misjudging a response in a way that produces a false positive on benign apps in a way an attacker could exploit (e.g., to discredit the tool's output).
- Prompt-injection vulnerabilities in the attacker subagent prompt that could be coaxed by adversarial response bodies into doing something the user didn't sanction.
- Plugin manifest, command files, or subagent files being readable/writable in a way that lets an unprivileged process on the host modify isitsafebro's behavior.

## Out of scope

- Bugs found by isitsafebro in **your** app. Those are yours to fix; we don't track them and we don't need a disclosure.
- Issues that require an attacker to already have root on the user's machine.
- False positives or false negatives from a payload — these are bugs, but normal-priority bugs. File an issue.
- DoS via crafted payload that takes a long time to run (slow scans). Tune limits and file a normal issue.
- Vulnerabilities in transitive dependencies that have a published advisory and don't have a one-line fix available — we track these but prefer to consume upstream patches via `npm audit`.

## Disclosure history

(No vulnerabilities reported or disclosed yet. This section will be updated as advisories are published.)

## A note for security researchers

isitsafebro is itself a security testing tool, and is built by people who appreciate good disclosure work. We'll publicly credit researchers who disclose responsibly (unless you'd rather we didn't). If you find a class of bugs that's worth a writeup, we'd love to link to it from the README.
