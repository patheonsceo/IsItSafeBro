# VibeNotes — deliberately-vulnerable Next.js fixture

This is **not** a real app. It's a Next.js 15 fixture engineered to exhibit the bug classes in isitsafebro's payload library — for the `demo-nextjs` script and (eventually) for dogfooding.

## DO NOT DEPLOY THIS

Every "feature" of this app contains at least one shipped-by-AI-assistants security bug:

- `/admin` — admin panel with no auth check
- `/login` (POST `/api/login`) — accepts `admin/admin` and empty passwords
- `/api/me` — "verifies" JWTs without checking signatures (alg:none and weak-secret tokens both pass)
- `/api/notes` GET — returns every note with the author's PII; POST creates without auth
- `/api/users/[id]` — IDOR + excessive-data-exposure (returns the password_hash field)
- `/api/users` — admin endpoint, no auth
- `/api/config` — returns server-side secrets to anyone
- `/api/chat` — fake LLM that obediently follows whatever user input asks
- `/search?q=` — uses React's "dangerously set" inner-HTML API on the query string
- `/debug` — exposes env/version/uptime
- `middleware.ts` — echoes Origin + `Access-Control-Allow-Credentials: true` (CORS bug), sets a session cookie without `HttpOnly`
- `components/Footer.tsx` — uses `process.env.NEXT_PUBLIC_STRIPE_SECRET` which gets baked into the client bundle

The bugs are written to look like real vibe-coded mistakes, not pedagogical "// BUG HERE" demos. The fix the demo applies for each is also realistic — what a competent coding agent would actually write.

## What's NOT here (and why)

A `public/.env` file would be the textbook dotenv-served bug. Next.js's default static asset handler refuses to serve `.`-prefixed path segments (responds 400), so this bug class is mitigated by the framework. **That's a real and useful finding**: vibe-coded Next.js apps inherit this protection for free. The generic `vuln-app` fixture exercises this payload through a hand-rolled HTTP server where the bug DOES fire.

## Run it

```bash
npm install
npm run dev    # http://127.0.0.1:3000
```

`npm install` takes ~30-90s the first time, instant after that.

## Scan it

From the repo root, after `npm run build`:

```bash
npm run demo:nextjs
```

The demo script auto-installs this fixture's deps on first run.
