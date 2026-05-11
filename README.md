# isitsafebro

is it safe, bro?

the only red-team that runs inside claude code, before you ship.

```bash
npm install -g isitsafebro
```

work in progress. building this in the open. spec lives in [isitsafeproject.md](./isitsafeproject.md).

---

## what it does

two slash commands inside claude code:

- `/isitsafe` runs a red-team scan on your running localhost app. finds real, exploitable bugs (auth bypass, SQL injection, exposed env vars, prompt injection, IDOR). fixes land on a separate git branch you review before merge.
- `/snap` splits your uncommitted mess into clean conventional commits.

no docker. no extra API keys. no cloud. everything runs locally on whatever model you already have in claude code.

---

## status

day 1. the bin prints a version string. that's it for now. follow along on github.

---

## license

MIT. fork it, ship it, blame us when it works.
