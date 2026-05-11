# isitsafebro

is it safe, bro?

your AI built you an app. neat. did anyone check if a random person on the internet can log in as the admin, read your whole database, or pull your stripe key out of the page source? probably not.

that's what this does. one command, inside claude code, before you ship.

```bash
npm install -g isitsafebro
```

(install flow is being wired up. follow the repo or check back in a few days.)

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

if it finds nothing, ship. if it finds something, it shows you, fixes it, and saves a little test for that exact bug so it can't quietly come back later.

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

## status

building this in the open, in public, on stream. spec lives in [isitsafeproject.md](./isitsafeproject.md) if you want to see the whole plan.

current day: 2 of 14. plugin scaffolding is in. nothing useful yet. star the repo to get pinged when it works.

---

## license

MIT. fork it, ship it, blame us when it works.
