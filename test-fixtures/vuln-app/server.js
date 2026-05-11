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
