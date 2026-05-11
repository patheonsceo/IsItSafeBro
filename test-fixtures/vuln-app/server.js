// Deliberately-vulnerable test fixture for isitsafebro's attack loop.
//
// Each route below is engineered to make exactly one payload from
// payloads/auth.json fire — independently of the others. This lets the
// e2e attack test assert which specific bugs were found.
//
// Implemented as a hand-rolled mini-router using `app.METHOD(path, handler)`
// so the list_endpoints source regex picks the routes up.
//
// NOT FOR PRODUCTION USE.

import { createServer } from "node:http";
import { Buffer } from "node:buffer";

const routes = [];
const app = {
  get: (path, h) => routes.push({ method: "GET", path, h }),
  post: (path, h) => routes.push({ method: "POST", path, h }),
  put: (path, h) => routes.push({ method: "PUT", path, h }),
  patch: (path, h) => routes.push({ method: "PATCH", path, h }),
  delete: (path, h) => routes.push({ method: "DELETE", path, h }),
  options: (path, h) => routes.push({ method: "OPTIONS", path, h }),
};

/* ─────────────────────────────────────────────────────────────────────── */
/*  VULN-1: unauthenticated admin route                                    */
/* ─────────────────────────────────────────────────────────────────────── */

app.get("/admin", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    "<html><body><h1>admin panel</h1><div>user list: alice, bob, charlie</div><p>settings · manage users</p></body></html>",
  );
});

// HEALTHY counterpart that must NOT trigger the unauth-admin payload.
app.get("/safe-admin", (_req, res) => {
  res.writeHead(401, { "Content-Type": "text/html" });
  res.end("<html><body><h1>please log in</h1><p>unauthorized</p></body></html>");
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  VULN-2: unauthenticated write endpoint                                 */
/* ─────────────────────────────────────────────────────────────────────── */

app.post("/api/users", (_req, res) => {
  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: 42, created: true }));
});

// HEALTHY counterpart
app.post("/api/safe-users", (_req, res) => {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized", message: "please log in" }));
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  VULN-3 + VULN-4: /api/me decodes JWTs without verifying signature      */
/*  This single bug satisfies both jwt-alg-none-bypass and the             */
/*  weak-jwt-secret-guessable payload — neither token's signature is       */
/*  actually checked.                                                      */
/* ─────────────────────────────────────────────────────────────────────── */

app.get("/api/me", (req, res) => {
  const auth = req.headers["authorization"] || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const parts = bearer.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    } catch {
      // fall through
    }
  }
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  VULN-5 + VULN-6: weak default creds AND empty-password acceptance      */
/* ─────────────────────────────────────────────────────────────────────── */

app.post("/login", (req, res) => {
  let body = {};
  try {
    body = JSON.parse(req.__body || "{}");
  } catch {
    // ignore
  }
  const user = body.username ?? body.email;
  const password = body.password;

  const allowed =
    (user === "admin" &&
      (password === "admin" ||
        password === "password" ||
        password === "123456" ||
        password === "admin123")) ||
    password === "" ||
    password === null ||
    password === undefined;

  if (allowed) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "session=loggedin-1234; Path=/",
    });
    res.end(
      JSON.stringify({
        token: "abc.def.ghi",
        user: { id: 1, email: "admin@admin.com", role: "admin" },
      }),
    );
    return;
  }

  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "invalid credentials" }));
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  VULN-8: unprotected debug route                                        */
/* ─────────────────────────────────────────────────────────────────────── */

app.get("/debug", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      env: process.env.NODE_ENV ?? "development",
      version: process.version,
      uptime: process.uptime(),
      config: { debug: true, trace: true },
    }),
  );
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  VULN-9: home page sets a session cookie WITHOUT HttpOnly               */
/* ─────────────────────────────────────────────────────────────────────── */

app.get("/", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Set-Cookie": "session=anon-9999999; Path=/",
  });
  res.end(
    '<html><body><h1>welcome to the vuln app</h1><a href="/admin">admin</a> · <a href="/debug">debug</a></body></html>',
  );
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  Day-8 API category bugs                                                */
/* ─────────────────────────────────────────────────────────────────────── */

function getQuery(req) {
  const idx = req.url.indexOf("?");
  if (idx < 0) return new URLSearchParams();
  return new URLSearchParams(req.url.slice(idx + 1));
}

// VULN-API-1: error-based SQL injection on /api/products
app.get("/api/products", (req, res) => {
  const q = getQuery(req);
  const probe = q.get("name") ?? q.get("id") ?? "";
  if (/['"`;]/.test(probe)) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "PrismaClientKnownRequestError: syntax error at or near \"'\" at position 32 in: SELECT * FROM products WHERE name = '" +
          probe +
          "'",
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify([{ id: 1, name: "widget" }]));
});

// VULN-API-2: reflected XSS in /search?q=
app.get("/search", (req, res) => {
  const q = getQuery(req).get("q") ?? "";
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><body><h1>results for: ${q}</h1></body></html>`);
});

// VULN-API-3: path traversal on /api/file
app.get("/api/file", (req, res) => {
  if (
    req.url.includes("../") ||
    req.url.toLowerCase().includes("..%2f") ||
    req.url.includes("/etc/passwd")
  ) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  res.end("fake file content");
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  Day-8 secrets category bugs                                            */
/* ─────────────────────────────────────────────────────────────────────── */

// VULN-SEC-1: .env served
app.get("/.env", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    "DATABASE_URL=postgres://app:redacted@localhost:5432/app\nSTRIPE_SECRET_KEY=sk_live_fake_isitsafebrofixture_DO_NOT_USE\nJWT_SECRET=my-very-secret-key\nNEXT_PUBLIC_APP_URL=http://localhost:3000\n",
  );
});

// VULN-SEC-2: /api/config leaks server secrets
app.get("/api/config", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      public: { stripeKey: "pk_live_fixture", appUrl: "http://localhost:3000" },
      server: {
        STRIPE_SECRET_KEY: "sk_live_fake_isitsafebrofixture_serverdotEXAMPLE",
        JWT_SECRET: "my-very-secret-key",
        DATABASE_URL: "postgres://app:redacted@localhost:5432/app",
        OPENAI_API_KEY: "sk-fakefixtureopenaikeyABCDEFGHIJKLMNOPQRSTUVWXYZ123",
      },
    }),
  );
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  Day-8 IDOR category bugs                                               */
/* ─────────────────────────────────────────────────────────────────────── */

// VULN-IDOR-1: per-user resource without auth
app.get("/api/customers/1", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: 1,
      email: "alice@example.com",
      name: "Alice",
      phone: "+1-555-0001",
      created_at: "2024-01-01T00:00:00Z",
    }),
  );
});

// VULN-IDOR-2a: list endpoint at /api/users (covered by unauthed-list and pii-in-list payloads)
app.get("/api/users", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify([
      { id: 1, name: "Alice", email: "alice@example.com", phone: "+1-555-0001" },
      { id: 2, name: "Bob", email: "bob@example.com", phone: "+1-555-0002" },
      { id: 3, name: "Carol", email: "carol@example.com", phone: "+1-555-0003" },
    ]),
  );
});

// VULN-IDOR-2b: list endpoint exposes records with PII
app.get("/api/members", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify([
      { id: 1, name: "Alice", email: "alice@example.com", phone: "+1-555-0001" },
      { id: 2, name: "Bob", email: "bob@example.com", phone: "+1-555-0002" },
    ]),
  );
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  Day-8 prompt category bug                                              */
/*  Naive "LLM" that scans the request body for any ISITSAFEBRO_*_OK token */
/*  and echoes it back as the assistant message — equivalent to a real    */
/*  model that obediently complies with whatever user content asks for.    */
/* ─────────────────────────────────────────────────────────────────────── */

app.post("/api/chat", (req, res) => {
  const body = req.__body ?? "";
  // Extract user content from common chat-request shapes.
  let userContent = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && Array.isArray(parsed.messages)) {
      userContent = parsed.messages.map((m) => String(m?.content ?? "")).join(" ");
    } else if (parsed && typeof parsed === "object") {
      const k = ["prompt", "message", "input", "text", "content"].find(
        (key) => typeof parsed[key] === "string",
      );
      if (k) userContent = String(parsed[k]);
    }
  } catch {
    // body not JSON; treat as raw user content
  }
  // The bug being modeled: this 'LLM' obeys whatever the user says. If a
  // canary instruction is present, echo the user's content back as the
  // assistant message — that's enough to satisfy any prompt-injection
  // signal that looks for the canary plus contextual phrases like
  // "injection_succeeded".
  const canary = userContent.match(/ISITSAFEBRO_[A-Z0-9_]+_OK/);
  res.writeHead(200, { "Content-Type": "application/json" });
  if (canary) {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: userContent },
          },
        ],
      }),
    );
    return;
  }
  res.end(
    JSON.stringify({
      choices: [
        { message: { role: "assistant", content: "Hello! How can I help you today?" } },
      ],
    }),
  );
});

/* ─────────────────────────────────────────────────────────────────────── */
/*  Dispatcher with VULN-7 CORS leak baked in as a "middleware"            */
/*  Echoes Origin + sets allow-credentials:true on every response, and     */
/*  responds to all OPTIONS preflights with the same.                      */
/* ─────────────────────────────────────────────────────────────────────── */

function dispatch(req, res, body) {
  // Bad CORS middleware (THE bug): reflect Origin + grant credentials.
  const origin = req.headers["origin"];
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url.split("?")[0];
  req.__body = body;
  const route = routes.find((r) => r.path === path && r.method === req.method);
  if (route) {
    try {
      route.h(req, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("error: " + err.message);
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    dispatch(req, res, body);
  });
});

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.error(`vuln-app listening on http://${host}:${port}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
